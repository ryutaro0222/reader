(() => {
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const MAX_PX = 10e6;           // per-canvas pixel cap (iPad Safari memory)
  const $ = (s) => document.querySelector(s);
  const stage = $("#stage"), statusEl = $("#status"), slider = $("#slider"), countEl = $("#count");

  if (!window.pdfjsLib) {
    showStatus("PDFライブラリを読み込めませんでした。ネットに接続して再読み込みしてください。", true);
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = CDN + "pdf.worker.min.js";

  // ---------- settings ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const state = {
    doc: null, key: null, sample: true,
    mode: store.get("sr:mode", "auto"),
    cover: store.get("sr:cover", true),
    rtl: store.get("sr:rtl", false),
    double: false, spreads: [], idx: 0,
  };
  let pageCache = new Map(), renderToken = 0, activeTasks = [];

  // ---------- ink (markers) ----------
  // Strokes live in PDF user-space coordinates, so they survive zoom, rotation and layout changes.
  const TOOLS = { marker: { w: 12, a: 0.5 }, pen: { w: 1.6, a: 1 } };
  const NM_PREFIX = "mkr-";
  const ink = {
    strokes: [], undo: [], dirty: false, live: null, erasing: null, draftKey: null,
    tool: store.get("sr:tool", { type: "marker", color: "#FFD83D" }),
    drawMode: store.get("sr:draw", false),
  };
  let pageViews = new Map();       // page number → { canvas, ctx, vp, dpr }
  let origBytes = null, docName = "";

  $("#mode-" + state.mode).checked = true;
  $("#cover").checked = state.cover;
  $("#rtl").checked = state.rtl;
  $("#drawMode").checked = ink.drawMode;
  document.body.classList.toggle("drawing", ink.drawMode);

  // ---------- helpers ----------
  let toastTimer;
  function showStatus(msg, isError) {
    clearTimeout(toastTimer);
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", !!isError);
    statusEl.hidden = !msg;
  }
  function toast(msg, ms = 2600, isError) {
    showStatus(msg, isError);
    toastTimer = setTimeout(() => showStatus(""), ms);
  }
  function getPage(n) {
    if (!pageCache.has(n)) pageCache.set(n, state.doc.getPage(n));
    return pageCache.get(n);
  }
  function currentFirstPage() {
    return state.spreads[state.idx]?.[0] ?? 1;
  }
  function wantDouble() {
    if (state.mode === "double") return true;
    if (state.mode === "single") return false;
    return stage.clientWidth > stage.clientHeight;   // landscape stage → spread
  }
  function buildSpreads(n, dbl, cover) {
    const out = [];
    if (!dbl) { for (let i = 1; i <= n; i++) out.push([i]); return out; }
    let i = 1;
    if (cover) { out.push([1]); i = 2; }
    for (; i <= n; i += 2) out.push(i + 1 <= n ? [i, i + 1] : [i]);
    return out;
  }
  function rebuild(page) {
    if (!state.doc) return;
    state.double = wantDouble();
    state.spreads = buildSpreads(state.doc.numPages, state.double, state.cover);
    state.idx = Math.max(0, state.spreads.findIndex((s) => s.includes(page)));
    slider.max = String(state.spreads.length - 1);
    slider.style.direction = state.rtl ? "rtl" : "ltr";
    updateUI();
    render();
  }
  function updateUI() {
    const s = state.spreads[state.idx] || [];
    const n = state.doc ? state.doc.numPages : 0;
    countEl.innerHTML = `<b>${s.join("–") || "–"}</b> / ${n || "–"}`;
    slider.value = String(state.idx);
    const atStart = state.idx <= 0, atEnd = state.idx >= state.spreads.length - 1;
    $("#btnLeft").disabled = state.rtl ? atEnd : atStart;
    $("#btnRight").disabled = state.rtl ? atStart : atEnd;
    markTocCurrent();
    savePosition();
  }
  function go(delta) {
    const next = Math.min(state.spreads.length - 1, Math.max(0, state.idx + delta));
    if (next === state.idx) return;
    state.idx = next;
    updateUI();
    render();
  }
  function goToPage(p) {
    const i = state.spreads.findIndex((s) => s.includes(p));
    if (i >= 0) go(i - state.idx);
  }
  let posTimer;
  function savePosition() {
    if (!state.doc) return;
    const page = currentFirstPage();
    if (state.bookId) {
      const id = state.bookId;
      clearTimeout(posTimer);
      posTimer = setTimeout(() => bookUpdate(id, { lastPage: page, openedAt: Date.now() }), 1500);
    } else if (state.key) {
      store.set(state.key, page);
    }
  }
  const goLeft = () => go(state.rtl ? 1 : -1);
  const goRight = () => go(state.rtl ? -1 : 1);

  // ---------- rendering ----------
  async function render() {
    if (!state.doc) return;
    const token = ++renderToken;
    activeTasks.forEach((t) => t.cancel());
    activeTasks = [];

    const nums = state.spreads[state.idx];
    let pages;
    try { pages = await Promise.all(nums.map(getPage)); } catch (e) { showStatus("ページを読み込めませんでした。", true); return; }
    if (token !== renderToken) return;

    const pad = stage.clientWidth < 600 ? 8 : 20;
    const availW = Math.max(50, stage.clientWidth - pad * 2);
    const availH = Math.max(50, stage.clientHeight - pad * 2);
    const base = pages.map((p) => p.getViewport({ scale: 1 }));
    const sumRatio = base.reduce((s, v) => s + v.width / v.height, 0);
    const H = Math.floor(Math.min(availH, availW / sumRatio));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const order = pages.map((_, i) => i);
    if (state.rtl) order.reverse();
    const two = pages.length > 1;
    const next = document.createElement("div");
    next.className = "spread" + (two ? " two" : "");
    next.id = "spread";
    const views = new Map();

    const jobs = order.map((i, pos) => {
      const v = base[i];
      const cssW = Math.floor(H * v.width / v.height);
      let scale = (H / v.height) * dpr;
      const px = cssW * H * dpr * dpr;
      if (px > MAX_PX) scale *= Math.sqrt(MAX_PX / px);
      const vp = pages[i].getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      c.style.width = cssW + "px";
      c.style.height = H + "px";
      const wrap = document.createElement("div");
      wrap.className = "page" + (two ? (pos === 0 ? " left" : " right") : "");
      wrap.dataset.page = String(nums[i]);
      wrap.appendChild(c);

      const inkDpr = Math.min(dpr, 2);
      const ic = document.createElement("canvas");
      ic.className = "ink";
      ic.width = Math.floor(cssW * inkDpr);
      ic.height = Math.floor(H * inkDpr);
      ic.style.width = cssW + "px";
      ic.style.height = H + "px";
      wrap.appendChild(ic);
      views.set(nums[i], { canvas: ic, ctx: ic.getContext("2d"), vp: pages[i].getViewport({ scale: H / v.height }), dpr: inkDpr });

      next.appendChild(wrap);
      const task = pages[i].render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp });
      activeTasks.push(task);
      return task.promise;
    });

    try { await Promise.all(jobs); }
    catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error(e);
      showStatus("描画中にエラーが発生しました。", true);
    }
    if (token !== renderToken) return;

    const old = $("#spread");
    old.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.height = 0; });
    old.replaceWith(next);
    pageViews = views;
    views.forEach((_, n) => drawInk(n));
    if (statusEl.textContent === "読み込み中…") showStatus("");

    // warm the neighbours' page objects
    [state.idx - 1, state.idx + 1].forEach((j) => (state.spreads[j] || []).forEach(getPage));
  }

  // ---------- opening ----------
  // Files up to FULL_MAX are read whole (saved marks become editable, PDF export works).
  // Larger files are read in pieces on demand, so a 300MB book never sits in memory.
  const FULL_MAX = 80 * 1024 * 1024;
  class RangeTransport extends pdfjsLib.PDFDataRangeTransport {
    constructor(length, read) { super(length, null); this.read = read; }
    requestDataRange(begin, end) {
      this.read(begin, end).then(
        (buf) => this.onDataRange(begin, new Uint8Array(buf)),
        (e) => {
          console.error(e);
          toast(e && e.auth ? "Googleドライブとの接続が切れました。本棚から再接続して開き直してください。" : "ページの読み込みに失敗しました。開き直してください。", 6000, true);
        });
    }
  }

  // src: { bytes } or { size, read(begin, end) → Promise<ArrayBuffer> }
  async function openSource(src, name, opts = {}) {
    const isSample = !!opts.sample, book = opts.book || null;
    const size = src.bytes ? src.bytes.byteLength : src.size;
    showStatus("読み込み中…");

    let embedded = [], orig = null;
    const params = { cMapUrl: CDN + "cmaps/", cMapPacked: true, standardFontDataUrl: CDN + "standard_fonts/" };
    if (src.bytes) {
      orig = src.bytes.slice();                 // untouched copy for saving later (pdf.js transfers its buffer)
      let renderBytes = src.bytes;
      // Our own ink annotations come back as editable strokes; hide them from pdf.js so they aren't drawn twice.
      if (window.PDFLib && hasBytes(orig, "/NM (" + NM_PREFIX)) {
        try {
          const ldoc = await PDFLib.PDFDocument.load(orig, { ignoreEncryption: true, updateMetadata: false });
          embedded = takeOurInk(ldoc);
          if (embedded.length) renderBytes = await ldoc.save({ useObjectStreams: false });
        } catch (e) { console.warn(e); embedded = []; renderBytes = src.bytes; }
      }
      params.data = renderBytes;
    } else {
      params.range = new RangeTransport(src.size, src.read);
      params.length = src.size;
      params.rangeChunkSize = 512 * 1024;
      params.disableAutoFetch = true;
      params.disableStream = true;
    }

    let doc;
    try {
      doc = await pdfjsLib.getDocument(params).promise;
    } catch (e) {
      const pw = e && e.name === "PasswordException";
      showStatus(pw ? "パスワード付きPDFは開けません。" : "PDFを開けませんでした。ファイルが壊れていないか確認してください。", true);
      return false;
    }

    let driveStrokes = null;
    if (book) {
      try {
        const saved = await readAppJSON(inkName(book.id));
        if (saved && Array.isArray(saved.strokes)) driveStrokes = saved.strokes;
      } catch (e) { console.warn(e); toast("書き込みを読み込めませんでした。", 3000, true); }
    }

    if (state.doc) state.doc.destroy();
    state.doc = doc;
    pageCache = new Map();
    state.sample = isSample;
    state.bookId = book ? book.id : null;
    state.key = isSample || book ? null : `sr:pos:${name}:${size}`;
    origBytes = orig;
    docName = name;
    ink.draftKey = isSample || book ? null : `sr:ink:${name}:${size}`;
    const draft = ink.draftKey ? store.get(ink.draftKey, null) : null;
    if (driveStrokes) ink.strokes = driveStrokes;
    else ink.strokes = draft && Array.isArray(draft.strokes) ? draft.strokes : embedded;
    ink.dirty = !!(draft && draft.dirty);
    ink.unsynced = false;
    ink.undo = []; ink.live = null; ink.erasing = null;
    updateInkUI();
    const title = name.replace(/\.pdf$/i, "");
    $("#docName").textContent = isSample ? "サンプルブック" : title;
    $("#docName").title = name;
    $("#sampleChip").hidden = !isSample;
    document.title = isSample ? "見開きリーダー" : `${title} — 見開きリーダー`;
    showStatus("");
    let start = 1;
    if (book) start = (drive.lib.books[book.id] || {}).lastPage || 1;
    else if (state.key) start = store.get(state.key, 1);
    rebuild(Math.min(doc.numPages, Math.max(1, start)));
    loadOutline(doc);
    requestWakeLock();
    if (book) {
      libPatch(book.id, { openedAt: Date.now() });
      const meta = drive.lib.books[book.id] || {};
      if (!meta.thumb || !meta.pages) fillBookDetails(book.id);
    }
    return true;
  }
  function openData(bytes, name, isSample) { return openSource({ bytes }, name, { sample: isSample }); }

  async function openFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast("PDFファイルを選んでください。", 3000, true);
      return;
    }
    closeShelf();
    const src = file.size <= FULL_MAX
      ? { bytes: new Uint8Array(await file.arrayBuffer()) }
      : { size: file.size, read: (b, e) => file.slice(b, e).arrayBuffer() };

    if (!driveReady()) {
      const ok = await openSource(src, file.name);
      if (ok && configured()) toast("Googleドライブに接続すると、本棚に保存されます", 4000);
      return;
    }
    // Already on the shelf → reuse that book (keeps its marks and position).
    const existing = drive.books.find((b) => b.name === file.name && Number(b.size) === file.size);
    if (existing) { openSource(src, file.name, { book: existing }); return; }

    const ok = await openSource(src, file.name);
    if (ok) uploadAndAttach(file);
  }

  // ---------- ink: drawing ----------
  const r2 = (n) => Math.round(n * 100) / 100;
  let inkRaf = 0;
  const inkQueue = new Set();
  function queueInk(n) {
    inkQueue.add(n);
    if (!inkRaf) inkRaf = requestAnimationFrame(() => { inkRaf = 0; inkQueue.forEach(drawInk); inkQueue.clear(); });
  }
  function drawInk(n) {
    const v = pageViews.get(n);
    if (!v) return;
    const { ctx, canvas, vp, dpr } = v;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const list = ink.strokes.filter((s) => s.page === n);
    if (ink.live && ink.live.page === n) list.push(ink.live);
    for (const s of list) {
      ctx.globalAlpha = s.a;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w * vp.scale;
      ctx.beginPath();
      for (let i = 0; i < s.pts.length; i += 2) {
        const [x, y] = vp.convertToViewportPoint(s.pts[i], s.pts[i + 1]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        if (s.pts.length === 2) ctx.lineTo(x + 0.01, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function redrawAllInk() { pageViews.forEach((_, n) => drawInk(n)); }
  function pointToPdf(v, clientX, clientY) {
    const r = v.canvas.getBoundingClientRect();
    const x = (clientX - r.left) * (parseFloat(v.canvas.style.width) / r.width);
    const y = (clientY - r.top) * (parseFloat(v.canvas.style.height) / r.height);
    return v.vp.convertToPdfPoint(x, y);
  }
  function pageAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const wrap = el && el.closest ? el.closest(".page") : null;
    return wrap ? Number(wrap.dataset.page) : null;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function eraseAt(clientX, clientY) {
    const n = pageAt(clientX, clientY);
    const v = n && pageViews.get(n);
    if (!v) return;
    const [px, py] = pointToPdf(v, clientX, clientY);
    const radius = 10 / v.vp.scale;
    const hit = new Set();
    for (const s of ink.strokes) {
      if (s.page !== n) continue;
      const p = s.pts;
      for (let i = 0; i < p.length; i += 2) {
        const j = i + 2 < p.length ? i + 2 : i;
        if (segDist(px, py, p[i], p[i + 1], p[j], p[j + 1]) <= radius + s.w / 2) { hit.add(s); break; }
      }
    }
    if (!hit.size) return;
    ink.strokes = ink.strokes.filter((s) => !hit.has(s));
    ink.erasing.removed += hit.size;
    queueInk(n);
  }
  function pushUndo() {
    ink.undo.push(ink.strokes.slice());
    if (ink.undo.length > 100) ink.undo.shift();
  }
  function undo() {
    if (!ink.undo.length) return;
    ink.strokes = ink.undo.pop();
    markDirty();
    redrawAllInk();
  }
  let draftTimer;
  function markDirty() {
    if (state.bookId) { updateInkUI(); scheduleInkSync(); return; }   // shelf books sync on their own
    ink.dirty = true;
    updateInkUI();
    if (!ink.draftKey) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => store.set(ink.draftKey, { strokes: ink.strokes, dirty: ink.dirty }), 400);
  }
  function updateInkUI() {
    document.querySelectorAll(".tool").forEach((b) => {
      const on = b.dataset.tool === ink.tool.type && (b.dataset.tool !== "marker" || b.dataset.color === ink.tool.color);
      b.setAttribute("aria-pressed", String(on));
    });
    $("#undo").disabled = !ink.undo.length;
    $("#save").classList.toggle("dirty", ink.dirty);
  }

  // ---------- ink: PDF annotations ----------
  function hasBytes(bytes, needle) {
    const nb = Array.from(needle, (ch) => ch.charCodeAt(0));
    const first = nb[0], last = bytes.length - nb.length;
    outer: for (let i = 0; i <= last; i++) {
      if (bytes[i] !== first) continue;
      for (let k = 1; k < nb.length; k++) if (bytes[i + k] !== nb[k]) continue outer;
      return true;
    }
    return false;
  }
  const rgbToHex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("");
  const hexToRgb = (h) => [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) / 255 * 1000) / 1000);

  // Removes this viewer's Ink annotations from a pdf-lib document and returns them as strokes.
  function takeOurInk(ldoc) {
    const { PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
    const num = (o) => (o instanceof PDFNumber ? o.asNumber() : 0);
    const out = [];
    ldoc.getPages().forEach((page, idx) => {
      const annots = page.node.Annots();
      if (!annots) return;
      for (let i = annots.size() - 1; i >= 0; i--) {
        const d = annots.lookup(i);
        if (!(d instanceof PDFDict)) continue;
        const nm = d.lookup(PDFName.of("NM"));
        const nmText = nm && nm.decodeText ? nm.decodeText() : "";
        if (String(d.get(PDFName.of("Subtype"))) !== "/Ink" || !nmText.startsWith(NM_PREFIX)) continue;
        const tool = nmText.includes("-pen-") ? "pen" : "marker";
        const c = d.lookup(PDFName.of("C"));
        const color = c instanceof PDFArray ? rgbToHex(c.asArray().map((_, k) => num(c.lookup(k)))) : "#FFD83D";
        const ca = d.lookup(PDFName.of("CA"));
        const bs = d.lookup(PDFName.of("BS"));
        const w = bs instanceof PDFDict ? num(bs.lookup(PDFName.of("W"))) : TOOLS[tool].w;
        const list = d.lookup(PDFName.of("InkList"));
        if (list instanceof PDFArray) {
          for (let j = 0; j < list.size(); j++) {
            const path = list.lookup(j);
            if (!(path instanceof PDFArray)) continue;
            const pts = path.asArray().map((_, k) => r2(num(path.lookup(k))));
            if (pts.length >= 2) out.push({ page: idx + 1, tool, color, w: w || TOOLS[tool].w, a: ca instanceof PDFNumber ? ca.asNumber() : TOOLS[tool].a, pts });
          }
        }
        annots.remove(i);
      }
    });
    return out;
  }

  function addInkAnnots(ldoc, strokes) {
    const { PDFHexString, PDFString } = PDFLib;
    const ctx = ldoc.context;
    const pages = ldoc.getPages();
    const stamp = Date.now().toString(36);
    strokes.forEach((s, k) => {
      const page = pages[s.page - 1];
      if (!page || s.pts.length < 2) return;
      const pad = s.w / 2 + 1;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < s.pts.length; i += 2) {
        x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]);
        y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]);
      }
      const rect = [r2(x0 - pad), r2(y0 - pad), r2(x1 + pad), r2(y1 + pad)];
      const [r, g, b] = hexToRgb(s.color);
      let path = "";
      for (let i = 0; i < s.pts.length; i += 2) path += `${s.pts[i]} ${s.pts[i + 1]} ${i ? "l" : "m"}\n`;
      if (s.pts.length === 2) path += `${s.pts[0] + 0.01} ${s.pts[1]} l\n`;
      const content = `/GS0 gs ${r} ${g} ${b} RG ${s.w} w 1 J 1 j\n${path}S\n`;
      const ap = ctx.flateStream(content, {
        Type: "XObject", Subtype: "Form", BBox: rect,
        Resources: { ExtGState: { GS0: { Type: "ExtGState", CA: s.a, ca: s.a, BM: s.tool === "marker" ? "Multiply" : "Normal" } } },
      });
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Ink", Rect: rect, F: 4,
        InkList: [s.pts], C: [r, g, b], CA: s.a, BS: { W: s.w, S: "S" },
        NM: PDFString.of(`${NM_PREFIX}${s.tool}-${stamp}-${k}`),
        T: PDFHexString.fromText("見開きリーダー"),
        M: PDFString.fromDate(new Date()),
        P: page.ref,
        AP: { N: ctx.register(ap) },
      });
      page.node.addAnnot(ctx.register(annot));
    });
  }

  let saving = false;
  async function savePdf() {
    if (saving || !state.doc) return;
    if (!origBytes) {
      toast(`${FULL_MAX / 1048576}MBを超えるPDFは書き込み入りPDFの書き出しに対応していません（書き込みはドライブに保存されています）`, 5000, true);
      return;
    }
    if (!window.PDFLib) { toast("保存用ライブラリを読み込めませんでした。再読み込みしてください。", 4000, true); return; }
    saving = true;
    showStatus("保存用のPDFを作成中…");
    try {
      const ldoc = await PDFLib.PDFDocument.load(origBytes, { ignoreEncryption: true, updateMetadata: false });
      if (ldoc.isEncrypted) { toast("保護されたPDFには書き込みを保存できません。", 4000, true); return; }
      takeOurInk(ldoc);                      // replace whatever we wrote last time
      addInkAnnots(ldoc, ink.strokes);
      const out = await ldoc.save({ useObjectStreams: false });
      let base = docName.replace(/\.pdf$/i, "");
      if (!/_marked$/.test(base)) base += "_marked";
      const result = await deliverFile(out, base + ".pdf");
      if (result === "saved") {
        ink.dirty = false;
        updateInkUI();
        if (ink.draftKey) store.set(ink.draftKey, { strokes: ink.strokes, dirty: false });
        toast(`「${base}.pdf」を保存しました`);
      } else if (result === "declined") {
        toast("保存をキャンセルしました");
      } else {
        toast("保存を開始できませんでした。少し待ってからもう一度押してください。", 4000, true);
      }
    } catch (e) {
      console.error(e);
      toast("PDFの作成に失敗しました。", 4000, true);
    } finally {
      saving = false;
    }
  }
  async function deliverFile(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return "saved";
  }

  // ---------- Google Drive: bookshelf ----------
  // Books  = PDFs in the Drive folder (CFG.shelfFolderName).
  // Marks  = appDataFolder/ink-<fileId>.json (hidden app storage in the same Drive).
  // Shelf metadata (position, thumbnail, page count) = appDataFolder/library.json.
  const CFG = window.READER_CONFIG || {};
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",   // see PDFs put in the shelf folder from any Drive app
    "https://www.googleapis.com/auth/drive.file",       // create the folder, upload books
    "https://www.googleapis.com/auth/drive.appdata",    // marks and shelf metadata
  ];
  const drive = { client: null, token: null, exp: 0, folderId: store.get("sr:folder", null), books: [], lib: { books: {} }, appIds: new Map(), loading: false };
  const shelfEl = $("#shelf"), shelfGrid = $("#shelfGrid");
  const inkName = (id) => `ink-${id}.json`;
  const configured = () => !!CFG.googleClientId && !/ここに/.test(CFG.googleClientId);
  const driveReady = () => !!drive.token && Date.now() < drive.exp;
  const q = (s) => encodeURIComponent(s);
  const quoteQ = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

  function waitForGis() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error("gis"));
        setTimeout(check, 100);
      })();
    });
  }
  async function requestToken() {
    await waitForGis();
    if (!drive.client) {
      drive.client = google.accounts.oauth2.initTokenClient({ client_id: CFG.googleClientId, scope: SCOPES.join(" "), callback: () => {} });
    }
    return new Promise((resolve, reject) => {
      drive.client.callback = (r) => {
        if (r.error) return reject(r);
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES)) {
          const e = new Error("scopes"); e.scopes = true; return reject(e);
        }
        drive.token = r.access_token;
        drive.exp = Date.now() + (Number(r.expires_in) - 60) * 1000;
        resolve(r.access_token);
      };
      drive.client.error_callback = (e) => reject(e);
      drive.client.requestAccessToken({ prompt: "" });
    });
  }
  // Tokens last an hour. Renew on a tap shortly before expiry, since the popup needs a user gesture.
  let renewing = false;
  document.addEventListener("pointerup", () => {
    if (!drive.token || renewing || drive.exp - Date.now() > 10 * 60 * 1000) return;
    renewing = true;
    requestToken().then(() => { if (ink.unsynced) syncInk(); }, () => {}).finally(() => { renewing = false; });
  }, true);

  async function gfetch(url, opts = {}) {
    if (!driveReady()) { const e = new Error("auth"); e.auth = true; throw e; }
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + drive.token } });
    if (res.status === 401) { drive.token = null; const e = new Error("auth"); e.auth = true; throw e; }
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res;
  }

  async function ensureFolder() {
    if (drive.folderId) {
      try {
        const r = await gfetch(`${API}/files/${drive.folderId}?fields=id,trashed`);
        const j = await r.json();
        if (!j.trashed) return drive.folderId;
      } catch (e) { if (e.auth) throw e; }
    }
    const name = CFG.shelfFolderName || "見開きリーダー";
    const query = `name = ${quoteQ(name)} and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`;
    const r = await gfetch(`${API}/files?q=${q(query)}&fields=files(id)&spaces=drive`);
    const j = await r.json();
    let id = j.files && j.files[0] && j.files[0].id;
    if (!id) {
      const c = await gfetch(`${API}/files?fields=id`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
      });
      id = (await c.json()).id;
    }
    drive.folderId = id;
    store.set("sr:folder", id);
    return id;
  }
  async function listFolder() {
    const out = [];
    let token = "";
    const query = `${quoteQ(drive.folderId)} in parents and mimeType = 'application/pdf' and trashed = false`;
    do {
      const r = await gfetch(`${API}/files?q=${q(query)}&pageSize=1000&fields=nextPageToken,files(id,name,size,modifiedTime)` + (token ? `&pageToken=${q(token)}` : ""));
      const j = await r.json();
      out.push(...(j.files || []));
      token = j.nextPageToken || "";
    } while (token);
    return out;
  }

  // appDataFolder JSON files
  async function appFileId(name) {
    if (drive.appIds.has(name)) return drive.appIds.get(name);
    const r = await gfetch(`${API}/files?spaces=appDataFolder&q=${q(`name = ${quoteQ(name)}`)}&fields=files(id)`);
    const j = await r.json();
    const id = (j.files && j.files[0] && j.files[0].id) || null;
    if (id) drive.appIds.set(name, id);
    return id;
  }
  async function readAppJSON(name) {
    if (!driveReady()) return null;
    const id = await appFileId(name);
    if (!id) return null;
    const r = await gfetch(`${API}/files/${id}?alt=media`);
    return r.json();
  }
  async function writeAppJSON(name, obj) {
    const body = JSON.stringify(obj);
    const id = await appFileId(name);
    if (id) {
      await gfetch(`${UPLOAD}/files/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
      return;
    }
    const b = "srb" + Date.now().toString(36);
    const multipart =
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ["appDataFolder"] })}\r\n` +
      `--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body: multipart,
    });
    drive.appIds.set(name, (await r.json()).id);
  }
  async function deleteAppFile(name) {
    const id = await appFileId(name);
    if (!id) return;
    await gfetch(`${API}/files/${id}`, { method: "DELETE" }).catch(() => {});
    drive.appIds.delete(name);
  }

  // library.json — merged on every write so the iPad and the PC don't overwrite each other's books
  const libPending = new Map();
  let libTimer, libWriting = false;
  function libPatch(id, patch) {
    drive.lib.books[id] = { ...(drive.lib.books[id] || {}), ...patch };
    const prev = libPending.get(id);
    libPending.set(id, patch === null ? null : { ...(prev || {}), ...patch });
    clearTimeout(libTimer);
    libTimer = setTimeout(flushLib, 2000);
  }
  function libRemove(id) {
    delete drive.lib.books[id];
    libPending.set(id, null);
    clearTimeout(libTimer);
    libTimer = setTimeout(flushLib, 500);
  }
  const bookUpdate = (id, data) => libPatch(id, data);
  async function flushLib() {
    if (libWriting || !libPending.size || !driveReady()) return;
    libWriting = true;
    const pending = new Map(libPending);
    libPending.clear();
    try {
      const latest = (await readAppJSON("library.json")) || {};
      latest.books = latest.books || {};
      for (const [id, p] of pending) {
        if (p === null) delete latest.books[id];
        else latest.books[id] = { ...(latest.books[id] || {}), ...p };
      }
      await writeAppJSON("library.json", latest);
      for (const [id, p] of libPending) if (p) latest.books[id] = { ...(latest.books[id] || {}), ...p };
      drive.lib = latest;
    } catch (e) {
      console.warn(e);
      for (const [id, p] of pending) if (!libPending.has(id)) libPending.set(id, p);
    } finally {
      libWriting = false;
      if (libPending.size) { clearTimeout(libTimer); libTimer = setTimeout(flushLib, 3000); }
    }
  }

  // marks
  let inkTimer, inkWriting = false, inkAgain = false;
  function scheduleInkSync() {
    if (!state.bookId) return;
    clearTimeout(inkTimer);
    inkTimer = setTimeout(syncInk, 1200);
  }
  async function syncInk() {
    const id = state.bookId;
    if (!id) return;
    if (inkWriting) { inkAgain = true; return; }
    inkWriting = true;
    try {
      await writeAppJSON(inkName(id), {
        strokes: ink.strokes.map((s) => ({ page: s.page, tool: s.tool, color: s.color, w: s.w, a: s.a, pts: s.pts })),
        updatedAt: Date.now(),
      });
      if (state.bookId === id) ink.unsynced = false;
    } catch (e) {
      console.warn(e);
      ink.unsynced = true;
      toast(e.auth ? "接続が切れたため書き込みをドライブに保存できません。本棚から再接続してください。" : "書き込みをドライブに保存できませんでした。", 5000, true);
    } finally {
      inkWriting = false;
      if (inkAgain) { inkAgain = false; scheduleInkSync(); }
    }
  }
  // Leaving the page (iPad app switch, tab close): write right away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    if (libPending.size) { clearTimeout(libTimer); flushLib(); }
    if (inkTimer && state.bookId) { clearTimeout(inkTimer); inkTimer = null; syncInk(); }
  });

  // downloads / uploads
  async function downloadFull(id, size, onProgress) {
    const res = await gfetch(`${API}/files/${id}?alt=media`);
    if (!res.body || !res.body.getReader || !size) return new Uint8Array(await res.arrayBuffer());
    const out = new Uint8Array(size);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) throw new Error("size mismatch");
      out.set(value, got);
      got += value.length;
      onProgress(got / size);
    }
    return got === size ? out : out.slice(0, got);
  }
  async function readRange(id, begin, end) {
    const res = await gfetch(`${API}/files/${id}?alt=media`, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    const buf = await res.arrayBuffer();
    return res.status === 200 && buf.byteLength > end - begin ? buf.slice(begin, end) : buf;
  }
  // Opening a big book makes pdf.js walk every page object one request at a time (hundreds of round trips).
  // Read in 1MB blocks and fetch the next few in parallel, so the walk isn't bound by Drive's latency.
  function blockReader(size, fetchRange, onProgress) {
    const BLOCK = 1 << 20, AHEAD = 8, KEEP = 48;
    const n = Math.ceil(size / BLOCK);
    const blocks = new Map();
    let got = 0;
    const load = (i) => {
      let p = blocks.get(i);
      if (!p) {
        p = fetchRange(i * BLOCK, Math.min(size, (i + 1) * BLOCK));
        if (onProgress) p.then((b) => { got += b.byteLength; onProgress(got, size); }, () => {});
        p.catch(() => blocks.delete(i));
        blocks.set(i, p);
        if (blocks.size > KEEP) for (const k of blocks.keys()) { if (blocks.size <= KEEP) break; if (Math.abs(k - i) > AHEAD) blocks.delete(k); }
      } else { blocks.delete(i); blocks.set(i, p); }   // keep recently used blocks
      return p;
    };
    return async (begin, end) => {
      const first = Math.floor(begin / BLOCK), last = Math.floor((end - 1) / BLOCK);
      const need = [];
      for (let i = first; i <= last; i++) need.push(load(i));
      for (let i = last + 1; i <= Math.min(n - 1, last + AHEAD); i++) load(i);
      const parts = await Promise.all(need);
      const out = new Uint8Array(end - begin);
      parts.forEach((b, k) => {
        const off = (first + k) * BLOCK;
        const s = Math.max(begin, off), e = Math.min(end, off + b.byteLength);
        out.set(new Uint8Array(b, s - off, e - s), s - begin);
      });
      return out.buffer;
    };
  }

  // ---------- books kept on this device ----------
  // A book opened once is saved whole in Cache Storage, so the next open skips Drive entirely.
  // sr:local = { fileId: { key, size, at } } — `at` is the last open, used to evict the oldest first.
  const LOCAL = "sr-books-v1";
  const hasLocal = () => "caches" in window;
  const localKey = (b) => new URL(`__book/${b.id}?s=${b.size}&m=${q(b.modifiedTime || "")}`, location.href).href;
  const localIdx = () => store.get("sr:local", {});
  const localSaving = new Set();
  async function localGet(b) {
    if (!hasLocal()) return null;
    try {
      const c = await caches.open(LOCAL);
      const r = await c.match(localKey(b));
      if (!r) return null;
      const blob = await r.blob();
      if (blob.size !== Number(b.size)) { await localDrop(b.id); return null; }
      const idx = localIdx();
      if (idx[b.id]) { idx[b.id].at = Date.now(); store.set("sr:local", idx); }
      return blob;
    } catch (e) { console.warn(e); return null; }
  }
  async function localDrop(id) {
    const idx = localIdx();
    if (!idx[id]) return;
    try { await (await caches.open(LOCAL)).delete(idx[id].key); } catch (e) { console.warn(e); }
    delete idx[id];
    store.set("sr:local", idx);
  }
  async function localRoom(size) {
    if (!navigator.storage || !navigator.storage.estimate) return true;
    let { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return true;
    const old = Object.entries(localIdx()).sort((a, b) => a[1].at - b[1].at);
    while (usage + size > quota * 0.8 && old.length) {
      const [id, e] = old.shift();
      await localDrop(id);
      usage -= e.size;
    }
    return usage + size <= quota * 0.8;
  }
  // body: a Blob already in hand (small books, freshly added files), or omitted to download it in the background
  async function localSave(b, body) {
    const size = Number(b.size || 0);
    if (!hasLocal() || !size || localSaving.has(b.id)) return;
    localSaving.add(b.id);
    try {
      if (!(await localRoom(size))) return;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await localDrop(b.id);                     // an older copy of the same book
      if (!body) {
        const res = await gfetch(`${API}/files/${b.id}?alt=media`);
        body = res.body || (await res.blob());
      }
      const key = localKey(b);
      await (await caches.open(LOCAL)).put(key, new Response(body, { headers: { "Content-Type": "application/pdf" } }));
      const idx = localIdx();
      idx[b.id] = { key, size, at: Date.now() };
      store.set("sr:local", idx);
      if (!shelfEl.hidden) renderShelf();
    } catch (e) {
      console.warn(e);
    } finally { localSaving.delete(b.id); }
  }
  async function localClear() {
    store.set("sr:local", {});
    try { if (hasLocal()) await caches.delete(LOCAL); } catch {}
  }
  async function uploadToDrive(file, onProgress) {
    const init = await gfetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,size,modifiedTime`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name: file.name, parents: [drive.folderId], mimeType: "application/pdf" }),
    });
    const session = init.headers.get("Location");
    if (!session) throw new Error("no upload session");
    const CHUNK = 8 * 1024 * 1024;              // multiple of 256 KiB, as Drive requires
    let off = 0;
    for (;;) {
      const end = Math.min(off + CHUNK, file.size);
      const res = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${off}-${end - 1}/${file.size}` },
        body: file.slice(off, end),
      });
      if (res.status === 308) {
        const r = res.headers.get("Range");
        off = r ? Number(r.split("-")[1]) + 1 : end;
        onProgress(off / file.size);
        continue;
      }
      if (res.ok) { onProgress(1); return res.json(); }
      throw new Error("upload " + res.status);
    }
  }
  async function uploadAndAttach(file) {
    const name = file.name;
    try {
      await ensureFolder();
      const meta = await uploadToDrive(file, (p) => showStatus(`Googleドライブに保存中… ${Math.floor(p * 100)}%`));
      drive.books.push(meta);
      localSave(meta, file);
      if (docName === name && !state.bookId && !state.sample) {
        // still reading the same file: attach it to the new shelf entry
        state.bookId = meta.id;
        state.key = null;
        ink.draftKey = null;
        ink.dirty = false;
        updateInkUI();
        if (ink.strokes.length) scheduleInkSync();
        libPatch(meta.id, { lastPage: currentFirstPage(), openedAt: Date.now() });
        fillBookDetails(meta.id);
      }
      toast("本棚に追加しました");
      renderShelf();
    } catch (e) {
      console.warn(e);
      toast(e.auth ? "接続が切れたため本棚に保存できませんでした。再接続してもう一度追加してください。"
        : e.status === 403 ? "Googleドライブの容量が足りないか、保存が許可されていません。"
        : "本棚に保存できませんでした。", 6000, true);
    }
  }

  async function makeThumb() {
    const page = await state.doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 220 / v1.width });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp }).promise;
    const url = c.toDataURL("image/jpeg", 0.72);
    c.width = 0; c.height = 0;
    return url;
  }
  async function fillBookDetails(id) {
    const doc = state.doc;
    try {
      const thumb = await makeThumb();
      if (state.doc !== doc) return;
      libPatch(id, { pages: doc.numPages, thumb });
    } catch (e) { console.warn(e); }
  }

  // ---------- bookshelf UI ----------
  const fmtSize = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + "GB" : Math.max(0.1, b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + "MB";
  function updateShelfChrome() {
    const ready = driveReady();
    $("#connectBox").hidden = ready;
    $("#connectBtn").hidden = !configured();
    $("#connectMsg").textContent = !configured()
      ? "Googleドライブを使うには、config.js にクライアントIDを設定してください（セットアップ手順を参照）。"
      : store.get("sr:gauth", false)
        ? "Googleドライブとの接続が切れています。ボタンを押すと再接続します。"
        : "Googleドライブに接続すると、ドライブの「" + (CFG.shelfFolderName || "見開きリーダー") + "」フォルダが本棚になります。iPadとPCで同じ本・マーカー・読んでいた位置が使えます。";
    $("#shelfAdd").hidden = !ready;
    $("#shelfRefresh").hidden = !ready;
    $("#disconnectBtn").hidden = !ready;
    shelfGrid.hidden = !ready;
    if (!ready) { $("#shelfEmpty").hidden = true; $("#shelfMeter").textContent = ""; $("#acctNote").textContent = ""; }
  }
  async function connectDrive() {
    const btn = $("#connectBtn");
    btn.disabled = true;
    try {
      await requestToken();
      store.set("sr:gauth", true);
    } catch (e) {
      console.warn(e);
      toast(e && e.scopes
        ? "Googleドライブへのアクセスをすべて許可してください（チェックボックスを全部オンに）。"
        : "Googleへの接続がキャンセルされたか、失敗しました。", 5000, true);
      return;
    } finally { btn.disabled = false; }
    updateShelfChrome();
    await loadShelf();
    if (ink.unsynced) syncInk();
    if (libPending.size) flushLib();
  }
  async function loadShelf() {
    if (!driveReady() || drive.loading) return;
    drive.loading = true;
    $("#shelfMeter").textContent = "読み込み中…";
    try {
      await ensureFolder();
      const [files, lib] = await Promise.all([listFolder(), readAppJSON("library.json")]);
      drive.books = files;
      drive.lib = lib && lib.books ? lib : { books: {} };
      for (const [id, p] of libPending) if (p) drive.lib.books[id] = { ...(drive.lib.books[id] || {}), ...p };
      renderShelf();
      refreshMeter();
    } catch (e) {
      console.warn(e);
      $("#shelfMeter").textContent = "";
      if (e.auth) updateShelfChrome();
      toast(e.auth ? "接続の有効期限が切れました。もう一度接続してください。" : "本棚を読み込めませんでした。", 4000, true);
    } finally { drive.loading = false; }
  }
  async function refreshMeter() {
    const total = drive.books.reduce((s, b) => s + Number(b.size || 0), 0);
    $("#shelfMeter").textContent = `${drive.books.length}冊 ・ ${fmtSize(total)}`;
    try {
      const r = await gfetch(`${API}/about?fields=storageQuota,user(emailAddress)`);
      const j = await r.json();
      const sq = j.storageQuota || {};
      if (sq.limit) $("#shelfMeter").textContent += ` ・ ドライブ ${fmtSize(Number(sq.usage))} / ${fmtSize(Number(sq.limit))}`;
      if (j.user && j.user.emailAddress) $("#acctNote").textContent = `接続中: ${j.user.emailAddress}`;
    } catch {}
  }
  function renderShelf() {
    if (!driveReady()) { updateShelfChrome(); return; }
    updateShelfChrome();
    const meta = (b) => drive.lib.books[b.id] || {};
    const books = drive.books.slice().sort((a, b) =>
      (meta(b).openedAt || Date.parse(b.modifiedTime) || 0) - (meta(a).openedAt || Date.parse(a.modifiedTime) || 0));
    $("#shelfEmpty").hidden = books.length > 0;
    shelfGrid.replaceChildren(...books.map((b) => {
      const m = meta(b);
      const title = b.name.replace(/\.pdf$/i, "");
      const el = document.createElement("div");
      el.className = "book";
      const cover = document.createElement("button");
      cover.type = "button";
      cover.className = "cover" + (b.id === state.bookId ? " reading" : "");
      cover.setAttribute("aria-label", `${title}を開く`);
      if (m.thumb) {
        const img = document.createElement("img");
        img.src = m.thumb; img.alt = "";
        cover.appendChild(img);
      } else {
        const ph = document.createElement("span");
        ph.className = "ph"; ph.textContent = title;
        cover.appendChild(ph);
      }
      cover.addEventListener("click", () => openBook(b));
      const t = document.createElement("div");
      t.className = "title"; t.textContent = title; t.title = b.name;
      const info = document.createElement("div");
      info.className = "meta";
      const pct = m.pages ? Math.min(100, Math.round((m.lastPage || 1) / m.pages * 100)) : 0;
      info.innerHTML = `<span class="bar-track"><i style="width:${pct}%"></i></span><span class="num">${m.lastPage || 1} / ${m.pages || "–"} ・ ${fmtSize(Number(b.size || 0))}${localIdx()[b.id] ? " ・ 端末に保存済み" : ""}</span>`;
      const del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.textContent = "ゴミ箱へ";
      let armTimer;
      del.addEventListener("click", () => {
        if (!del.classList.contains("armed")) {
          del.classList.add("armed"); del.textContent = "本当に移動";
          armTimer = setTimeout(() => { del.classList.remove("armed"); del.textContent = "ゴミ箱へ"; }, 4000);
          return;
        }
        clearTimeout(armTimer);
        del.disabled = true; del.textContent = "移動中…";
        trashBook(b);
      });
      el.append(cover, t, info, del);
      return el;
    }));
  }
  async function openBook(b) {
    closeShelf();
    if (b.id === state.bookId) return;
    const size = Number(b.size || 0);
    try {
      const local = await localGet(b);
      if (local) {
        const src = size <= FULL_MAX
          ? { bytes: new Uint8Array(await local.arrayBuffer()) }
          : { size, read: (s, e) => local.slice(s, e).arrayBuffer() };
        if (await openSource(src, b.name, { book: b })) return;
        await localDrop(b.id);                   // unreadable copy: fall back to Drive
      }
      if (size && size <= FULL_MAX) {
        showStatus("ダウンロード中…");
        const bytes = await downloadFull(b.id, size, (p) => showStatus(`ダウンロード中… ${Math.floor(p * 100)}%`));
        const copy = new Blob([bytes]);          // pdf.js takes over `bytes`
        if (await openSource({ bytes }, b.name, { book: b })) localSave(b, copy);
      } else {
        let opening = true;
        const read = blockReader(size, (s, e) => readRange(b.id, s, e),
          (got, total) => { if (opening) showStatus(`読み込み中… ${fmtSize(got)} / ${fmtSize(total)}（大きい本は最初に時間がかかります）`); });
        let ok;
        try { ok = await openSource({ size, read }, b.name, { book: b }); } finally { opening = false; }
        if (ok) localSave(b);                    // background download, so the next open is instant
      }
    } catch (e) {
      console.warn(e);
      toast(e.auth ? "接続の有効期限が切れました。本棚から再接続してください。" : "この本を読み込めませんでした。", 5000, true);
    }
  }
  async function trashBook(b) {
    try {
      await gfetch(`${API}/files/${b.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
      });
    } catch (e) {
      console.warn(e);
      toast(e.status === 403 || e.status === 404
        ? "このPDFはGoogleドライブのアプリから削除してください（ここから入れた本だけ削除できます）。"
        : "ゴミ箱に移動できませんでした。", 6000, true);
      renderShelf();
      return;
    }
    drive.books = drive.books.filter((x) => x.id !== b.id);
    libRemove(b.id);
    deleteAppFile(inkName(b.id)).catch(() => {});
    localDrop(b.id);
    if (state.bookId === b.id) { state.bookId = null; ink.dirty = ink.strokes.length > 0; updateInkUI(); }
    toast(`「${b.name.replace(/\.pdf$/i, "")}」をゴミ箱に移動しました（ドライブのゴミ箱から戻せます）`, 4000);
    renderShelf();
    refreshMeter();
  }
  function openShelf() {
    shelfEl.hidden = false;
    renderShelf();
    if (driveReady() && !drive.books.length) loadShelf();
    $("#shelfClose").focus();
  }
  function closeShelf() { shelfEl.hidden = true; }
  function disconnectDrive() {
    try { if (drive.token) google.accounts.oauth2.revoke(drive.token, () => {}); } catch {}
    drive.token = null; drive.exp = 0; drive.books = []; drive.lib = { books: {} }; drive.appIds.clear();
    store.set("sr:gauth", false);
    localClear();
    if (state.bookId) { state.bookId = null; updateInkUI(); }
    updateShelfChrome();
    toast("Googleドライブとの接続を解除しました");
  }

  function initCloud() {
    $("#shelfBtn").hidden = false;
    $("#connectBtn").addEventListener("click", connectDrive);
    $("#shelfRefresh").addEventListener("click", loadShelf);
    $("#disconnectBtn").addEventListener("click", disconnectDrive);
    updateShelfChrome();
    if (store.get("sr:gauth", false) && configured()) openShelf();   // one tap to reconnect
    if (configured()) waitForGis().catch(() => {});
  }

  // ---------- table of contents (PDF outline) ----------
  const tocEl = $("#toc"), tocList = $("#tocList"), tocBtn = $("#tocBtn");
  let tocFlat = [];
  const narrow = () => window.innerWidth <= 800;
  function setToc(open, persist = true) {
    tocEl.hidden = !open;
    tocBtn.setAttribute("aria-pressed", String(open));
    if (persist) store.set("sr:toc", open);
    if (open) markTocCurrent();
  }
  async function resolvePage(doc, dest) {
    try {
      let d = dest;
      if (typeof d === "string") d = await doc.getDestination(d);
      if (!Array.isArray(d)) return null;
      const ref = d[0];
      if (typeof ref === "number") return ref + 1;
      if (ref && typeof ref === "object") return (await doc.getPageIndex(ref)) + 1;
    } catch {}
    return null;
  }
  async function buildToc(doc, items, depth) {
    const ul = document.createElement("ul");
    const pages = await Promise.all(items.map((it) => resolvePage(doc, it.dest)));
    for (let i = 0; i < items.length; i++) {
      const it = items[i], page = pages[i];
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "toc-row";
      row.style.paddingLeft = depth * 14 + "px";
      const kids = it.items && it.items.length ? it.items : null;
      let caret;
      if (kids) {
        caret = document.createElement("button");
        caret.type = "button"; caret.className = "caret";
        caret.setAttribute("aria-label", "開く/閉じる");
        caret.innerHTML = "<span>▶</span>";
      } else {
        caret = document.createElement("span");
        caret.className = "spacer";
      }
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "toc-item";
      const t = document.createElement("span");
      t.className = "t"; t.textContent = (it.title || "").trim() || "（無題）";
      btn.appendChild(t);
      if (page) {
        btn.dataset.page = String(page);
        const pg = document.createElement("span");
        pg.className = "pg"; pg.textContent = String(page);
        btn.appendChild(pg);
      }
      row.append(caret, btn);
      li.appendChild(row);
      if (page) tocFlat.push({ page, el: btn });
      if (kids) {
        const sub = await buildToc(doc, kids, depth + 1);
        const open = depth < 1;
        sub.hidden = !open;
        caret.setAttribute("aria-expanded", String(open));
        li.appendChild(sub);
        if (!page) btn.dataset.toggle = "1";
      }
      ul.appendChild(li);
    }
    return ul;
  }
  async function loadOutline(doc) {
    tocFlat = [];
    tocList.replaceChildren();
    let items = null;
    try { items = await doc.getOutline(); } catch {}
    if (doc !== state.doc) return;
    const has = !!(items && items.length);
    tocBtn.disabled = !has;
    tocBtn.title = has ? "目次を表示/隠す (T)" : "このPDFには目次がありません";
    if (!has) { setToc(false, false); return; }
    const ul = await buildToc(doc, items, 0);
    if (doc !== state.doc) return;
    tocList.replaceChildren(ul);
    setToc(store.get("sr:toc", true) && !narrow(), false);
    markTocCurrent();
  }
  function markTocCurrent() {
    if (!tocFlat.length) return;
    const shown = state.spreads[state.idx] || [1];
    const cur = Math.max(...shown);
    let best = null;
    for (const it of tocFlat) if (it.page <= cur && (!best || it.page >= best.page)) best = it;
    tocFlat.forEach((it) => it.el.classList.toggle("current", it === best));
    if (!best) return;
    // make sure its section is expanded
    let ul = best.el.closest("ul");
    while (ul && ul !== tocList) {
      if (ul.hidden) {
        ul.hidden = false;
        const c = ul.parentElement.querySelector(":scope > .toc-row > .caret");
        if (c) c.setAttribute("aria-expanded", "true");
      }
      ul = ul.parentElement.closest("ul");
    }
    if (!tocEl.hidden) best.el.scrollIntoView({ block: "nearest" });
  }
  tocList.addEventListener("click", (e) => {
    const caret = e.target.closest(".caret");
    const item = e.target.closest(".toc-item");
    const toggleOf = (li) => {
      const sub = li.querySelector(":scope > ul");
      const c = li.querySelector(":scope > .toc-row > .caret");
      if (!sub || !c) return;
      sub.hidden = !sub.hidden;
      c.setAttribute("aria-expanded", String(!sub.hidden));
    };
    if (caret) { toggleOf(caret.closest("li")); return; }
    if (!item) return;
    if (item.dataset.page) {
      goToPage(Number(item.dataset.page));
      if (narrow()) setToc(false, false);
    } else if (item.dataset.toggle) {
      toggleOf(item.closest("li"));
    }
  });
  tocBtn.addEventListener("click", () => setToc(tocEl.hidden));
  $("#tocClose").addEventListener("click", () => setToc(false));
  $("#shelfBtn").addEventListener("click", openShelf);
  $("#shelfClose").addEventListener("click", closeShelf);

  // ---------- sample book (generated in-page) ----------
  function makeSamplePdf() {
    const W = 595, H = 842, N = 10;
    const heads = ["Opening", "The Harbor", "Morning Tide", "Two Lighthouses", "Salt and Iron", "Fog Signals", "The Long Pier", "Night Crossing"];
    const rnd = (seed) => () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    function content(p) {
      if (p === 1 || p === N) {
        const title = p === 1 ? "SAMPLE BOOK" : "THE END";
        const sub = p === 1 ? "Spread Reader demo - open your own PDF" : "Back cover";
        return [
          "0.114 0.42 0.455 rg 0 0 595 842 re f",
          "1 1 1 rg BT /F2 46 Tf 60 520 Td (" + title + ") Tj ET",
          "0.83 0.9 0.91 rg BT /F1 16 Tf 60 486 Td (" + sub + ") Tj ET",
          "0.83 0.9 0.91 RG 2 w 60 460 m 300 460 l S",
          "1 1 1 rg BT /F1 11 Tf " + (p === 1 ? 520 : 60) + " 40 Td (" + p + ") Tj ET",
        ].join("\n");
      }
      const r = rnd(p * 7 + 3);
      const ops = [
        "0.9 0.925 0.935 rg BT /F2 260 Tf " + (p % 2 ? 300 : 60) + " 90 Td (" + p + ") Tj ET",
        "0.114 0.42 0.455 rg BT /F2 12 Tf 60 772 Td (CHAPTER " + (p - 1) + ") Tj ET",
        "0.1 0.13 0.15 rg BT /F2 30 Tf 60 732 Td (" + heads[(p - 2) % heads.length] + ") Tj ET",
        "0.72 0.76 0.79 rg",
      ];
      let y = 690;
      for (let i = 0; i < 26; i++) {
        const para = i % 7 === 6;
        const w = para ? 120 + r() * 200 : 440 + r() * 35;
        ops.push("60 " + y + " " + w.toFixed(1) + " 7 re f");
        y -= para ? 30 : 17;
      }
      ops.push("0.35 0.4 0.44 rg BT /F1 11 Tf " + (p % 2 ? 520 : 60) + " 40 Td (" + p + ") Tj ET");
      return ops.join("\n");
    }
    const objs = [];
    objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
    const kids = [];
    for (let p = 1; p <= N; p++) {
      const pageObj = 5 + (p - 1) * 2, contentObj = pageObj + 1;
      const s = content(p);
      kids.push(pageObj + " 0 R");
      objs[pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
      objs[contentObj - 1] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${N} >>`;
    let out = "%PDF-1.4\n";
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }

  // ---------- controls ----------
  $("#file").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => { state.mode = r.value; store.set("sr:mode", state.mode); rebuild(currentFirstPage()); }));
  $("#cover").addEventListener("change", (e) => { state.cover = e.target.checked; store.set("sr:cover", state.cover); rebuild(currentFirstPage()); });
  $("#rtl").addEventListener("change", (e) => { state.rtl = e.target.checked; store.set("sr:rtl", state.rtl); rebuild(currentFirstPage()); });
  $("#btnLeft").addEventListener("click", goLeft);
  $("#btnRight").addEventListener("click", goRight);
  slider.addEventListener("input", () => { go(Number(slider.value) - state.idx); });
  document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => {
    ink.tool = { type: b.dataset.tool, color: b.dataset.color };
    store.set("sr:tool", ink.tool);
    updateInkUI();
  }));
  $("#drawMode").addEventListener("change", (e) => {
    ink.drawMode = e.target.checked;
    store.set("sr:draw", ink.drawMode);
    document.body.classList.toggle("drawing", ink.drawMode);
  });
  $("#undo").addEventListener("click", undo);
  $("#save").addEventListener("click", savePdf);

  // fullscreen (optional — hidden where unsupported)
  const fsBtn = $("#fs");
  const root = document.documentElement;
  const reqFs = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!reqFs) fsBtn.hidden = true;
  function toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      const p = fsEl ? (document.exitFullscreen || document.webkitExitFullscreen).call(document) : reqFs.call(root);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  fsBtn.addEventListener("click", toggleFullscreen);

  // keyboard
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "s") { e.preventDefault(); savePdf(); }
      return;
    }
    if (!shelfEl.hidden) { if (e.key === "Escape") closeShelf(); return; }
    if (e.target === slider || e.altKey) return;
    const k = e.key;
    if (k === "ArrowLeft") goLeft();
    else if (k === "ArrowRight") goRight();
    else if (k === "PageDown" || (k === " " && !e.shiftKey)) go(1);
    else if (k === "PageUp" || (k === " " && e.shiftKey)) go(-1);
    else if (k === "Home") go(-state.idx);
    else if (k === "End") go(state.spreads.length);
    else if (k === "f" || k === "F") toggleFullscreen();
    else if (k === "h" || k === "H") document.body.classList.toggle("immersive");
    else if ((k === "t" || k === "T") && !tocBtn.disabled) setToc(tocEl.hidden);
    else if (k === "Escape" && !tocEl.hidden) setToc(false);
    else return;
    e.preventDefault();
  });

  // mouse wheel (PC)
  let wheelLock = 0;
  stage.addEventListener("wheel", (e) => {
    if (e.ctrlKey) return;               // let pinch-zoom / ctrl+wheel through
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;
    wheelLock = now + 280;
    go((Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) > 0 ? 1 : -1);
  }, { passive: false });

  // Apple Pencil always draws; mouse / finger draw only with「指・マウスで書く」on. Otherwise: swipe & tap zones.
  const pointers = new Map();
  let start = null, penRecent = 0;
  const isPalm = (e) => e.pointerType === "touch" && (Date.now() - penRecent < 800 || (ink.live && ink.live.pointerType === "pen"));

  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen") { penRecent = Date.now(); start = null; }
    if (isPalm(e)) return;
    const wantsDraw = e.pointerType === "pen" ||
      (ink.drawMode && (e.pointerType === "touch" || (e.pointerType === "mouse" && e.button === 0)));
    if (wantsDraw) {
      if (e.pointerType === "touch" && pointers.size > 0) {   // second finger → pinch, not a stroke
        ink.live = null; ink.erasing = null; redrawAllInk();
        pointers.set(e.pointerId, e);
        return;
      }
      const n = pageAt(e.clientX, e.clientY);
      const v = n && pageViews.get(n);
      if (e.pointerType === "touch") pointers.set(e.pointerId, e);
      if (!v) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch {}
      if (ink.tool.type === "eraser") {
        ink.erasing = { pointerId: e.pointerId, before: ink.strokes.slice(), removed: 0 };
        eraseAt(e.clientX, e.clientY);
        return;
      }
      const t = TOOLS[ink.tool.type];
      const [px, py] = pointToPdf(v, e.clientX, e.clientY);
      ink.live = {
        pointerId: e.pointerId, pointerType: e.pointerType, lastX: e.clientX, lastY: e.clientY,
        page: n, tool: ink.tool.type, color: ink.tool.color, w: t.w, a: t.a, pts: [r2(px), r2(py)],
      };
      queueInk(n);
      return;
    }
    pointers.set(e.pointerId, e);
    start = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
  });

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "pen") penRecent = Date.now();
    const L = ink.live;
    if (L && e.pointerId === L.pointerId) {
      const v = pageViews.get(L.page);
      if (!v) return;
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      for (const ev of evs.length ? evs : [e]) {
        if (Math.hypot(ev.clientX - L.lastX, ev.clientY - L.lastY) < 1.5) continue;
        L.lastX = ev.clientX; L.lastY = ev.clientY;
        const [px, py] = pointToPdf(v, ev.clientX, ev.clientY);
        L.pts.push(r2(px), r2(py));
      }
      queueInk(L.page);
      return;
    }
    if (ink.erasing && e.pointerId === ink.erasing.pointerId) eraseAt(e.clientX, e.clientY);
  });

  // Keep iOS from turning Pencil drags into selection / scrolling.
  stage.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && (e.touches[0].touchType === "stylus" || ink.live)) e.preventDefault();
  }, { passive: false });

  const endPointer = (e) => {
    const L = ink.live;
    if (L && e.pointerId === L.pointerId) {
      ink.live = null;
      pointers.delete(e.pointerId);
      if (e.type === "pointerup" && (L.pts.length > 2 || L.tool === "pen")) {
        pushUndo();
        ink.strokes.push({ page: L.page, tool: L.tool, color: L.color, w: L.w, a: L.a, pts: L.pts });
        markDirty();
      }
      queueInk(L.page);
      return;
    }
    if (ink.erasing && e.pointerId === ink.erasing.pointerId) {
      if (ink.erasing.removed) { ink.undo.push(ink.erasing.before); markDirty(); }
      ink.erasing = null;
      pointers.delete(e.pointerId);
      return;
    }
    pointers.delete(e.pointerId);
    if (!start || e.type === "pointercancel") { start = null; return; }
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
    start = null;
    const zoomed = window.visualViewport && window.visualViewport.scale > 1.02;
    if (zoomed) return;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      dx < 0 ? goRight() : goLeft();       // content follows the finger
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 400) {
      const r = stage.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (fx < 1 / 3) goLeft();
      else if (fx > 2 / 3) goRight();
      else document.body.classList.toggle("immersive");
    }
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  // drag & drop (PC)
  const drop = $("#drop");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; drop.hidden = true;
    openFile(e.dataTransfer.files[0]);
  });

  // resize / rotation
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.doc) return;
      if (wantDouble() !== state.double) rebuild(currentFirstPage());
      else render();
    }, 120);
  }).observe(stage);

  // keep the screen awake while reading (ignored where refused)
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch {}
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.doc) requestWakeLock(); });

  initCloud();
  openData(makeSamplePdf(), "サンプルブック", true)
    .then(() => toast("Apple Pencilでなぞると書き込めます（PCは「指・マウスで書く」をON）", 5000));
})();
