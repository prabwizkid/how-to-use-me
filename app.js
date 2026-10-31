/* How To Use Me — create "how to use" instruction pages for anything,
   store them on the phone, turn them into printable QR labels, scan them back,
   and save/share them through any cloud. No build step, works offline. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const APP = {
  db: null,
  settings: { publicUrl: '' },
  draft: null,        // guide being edited
  viewing: null,      // guide shown in the viewer
  viewingSaved: false,
  scanStream: null,
  scanTimer: null,
};

const QR_MAX_URL = 1200;          // keep codes easy to scan with any phone camera
const IMG_MAX = 1600;             // longest side for stored photos
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ------------------------------------------------------------------ utils */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function newId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(a, b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-3);
}
function slug(s) {
  return (String(s || 'guide').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)) || 'guide';
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function setStatus(el, msg, isErr) {
  el.textContent = msg || '';
  el.classList.toggle('error', !!isErr);
  // Show a spinner while work is still going on ("Reading text… 40%").
  el.classList.toggle('busy', !isErr && /…(\s*\d+%)?$/.test(msg || ''));
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if ($$('script').some(s => s.getAttribute('src') === src)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function packCompact(obj) {
  return b64urlEncode(pako.deflateRaw(new TextEncoder().encode(JSON.stringify(obj)), { level: 9 }));
}
function unpackCompact(str) {
  return JSON.parse(new TextDecoder().decode(pako.inflateRaw(b64urlDecode(str))));
}

/* --------------------------------------------------------------- storage */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('howtouseme', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('guides')) db.createObjectStore('guides', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = APP.db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage aborted (phone storage full?)'));
  });
}
const dbAll = () => tx('guides', 'readonly', s => s.getAll());
const dbGet = id => tx('guides', 'readonly', s => s.get(id));
const dbPut = g => tx('guides', 'readwrite', s => s.put(g));
const dbDel = id => tx('guides', 'readwrite', s => s.delete(id));
const dbClear = () => tx('guides', 'readwrite', s => s.clear());
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));

/* ---------------------------------------------------- text → steps logic */
const MARKER = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):\-]|step\s*\d{1,2}\b|[-•*·▪●►✓]\s+|\(\d{1,2}\)|[a-h][.)]\s)/i;

function cleanLine(l) {
  return l.replace(/\s+/g, ' ').replace(/^[|_~]+|[|_~]+$/g, '').trim();
}
function stripMarker(l) {
  return l.replace(MARKER, '').replace(/^[:.\-\s]+/, '').trim();
}
/** Turns free text (OCR, PDF, typed) into an array of step strings. */
function textToSteps(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanLine)
    .filter(l => l && /[a-z0-9]/i.test(l) && !(l.length < 3 && !/\d/.test(l)));
  if (!lines.length) return [];
  const marked = lines.filter(l => MARKER.test(l)).length;
  const steps = [];
  if (marked >= 2) {
    // numbered/bulleted list: unmarked lines are continuations of the previous step
    for (const l of lines) {
      if (MARKER.test(l) || !steps.length) steps.push(stripMarker(l));
      else steps[steps.length - 1] += ' ' + l;
    }
  } else {
    for (const l of lines) {
      const prev = steps[steps.length - 1];
      // join hard-wrapped sentences: previous line didn't end a sentence and this starts lowercase
      if (prev && !/[.!?:;)]$/.test(prev) && /^[a-z]/.test(l)) steps[steps.length - 1] = prev + ' ' + l;
      else steps.push(stripMarker(l));
    }
  }
  return steps.map(s => s.trim()).filter(Boolean);
}
/** If the first line looks like a heading, return it as title. */
function splitTitle(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (lines.length >= 2 && lines[0].length <= 70 && !MARKER.test(lines[0]) && !/[.;,]$/.test(lines[0])) {
    return { title: lines[0], rest: lines.slice(1).join('\n') };
  }
  return { title: '', rest: lines.join('\n') };
}

/* --------------------------------------------------------- guide → HTML */
// The page people see after scanning a label: clean iOS look, numbered steps on a white card.
const GUIDE_CSS = `
*{box-sizing:border-box}
body{margin:0;font:17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;letter-spacing:-.2px;color:#000;background:#F2F2F7;-webkit-font-smoothing:antialiased}
header{padding:28px 20px 6px}
header .in,main{max-width:680px;margin:0 auto}
h1{margin:0;font:700 30px/1.15 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,sans-serif;letter-spacing:.3px;overflow-wrap:anywhere}
.meta{margin:8px 0 0;padding:0;list-style:none;color:rgba(60,60,67,.6);font-size:15px}
.meta b{font-weight:500;color:#000}
main{padding:14px 16px 32px}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;background:#fff;border-radius:12px;overflow:hidden}
ol.steps>li{counter-increment:s;position:relative;display:grid;grid-template-columns:30px 1fr;gap:12px;padding:14px 16px}
ol.steps>li+li::after{content:"";position:absolute;top:0;left:58px;right:0;height:.5px;background:rgba(60,60,67,.2)}
ol.steps>li::before{content:counter(s);display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#007AFF;color:#fff;font-size:15px;font-weight:600}
ol.steps .tx{align-self:center}
ol.steps img{grid-column:2;display:block;max-width:100%;border-radius:10px;margin-top:4px}
.notes{margin:16px 0 0;padding:14px 16px;background:#fff;border-radius:12px;white-space:pre-wrap;font-size:15px}
.notes b{display:block;font-size:13px;font-weight:600;color:#FF9500;margin-bottom:2px}
.photos{margin-top:22px}.photos h2{font-size:13px;font-weight:400;color:rgba(60,60,67,.6);margin:0 16px 7px}
.photos img{display:block;max-width:100%;border-radius:12px;margin-top:10px}
.empty{color:rgba(60,60,67,.6);padding:16px}
footer{margin:22px 16px 0;color:rgba(60,60,67,.6);font-size:13px}
@media (min-width:640px){h1{font-size:34px}}
@media (prefers-color-scheme:dark){body{background:#000;color:#fff}.meta{color:rgba(235,235,245,.6)}.meta b{color:#fff}ol.steps,.notes{background:#1C1C1E}ol.steps>li+li::after{background:rgba(84,84,88,.65)}ol.steps>li::before{background:#0A84FF}.photos h2,footer,.empty{color:rgba(235,235,245,.6)}}
@media print{body{background:#fff}ol.steps>li{break-inside:avoid}}
`;

function buildGuideHtml(g) {
  const photos = g.photos || [];
  const byStep = {};
  const loose = [];
  photos.forEach(p => {
    if (Number.isInteger(p.step) && p.step >= 0 && p.step < g.steps.length) (byStep[p.step] = byStep[p.step] || []).push(p);
    else loose.push(p);
  });
  const img = p => `<img data-photo-id="${esc(p.id)}" src="${p.src}" alt="Photo">`;
  const meta = [g.item && `<li><b>For:</b> ${esc(g.item)}</li>`, g.location && `<li><b>Where:</b> ${esc(g.location)}</li>`].filter(Boolean).join('');
  const data = {
    app: 'how-to-use-me', v: 1, id: g.id, title: g.title, item: g.item, location: g.location,
    steps: g.steps, notes: g.notes, cloudUrl: g.cloudUrl || '',
    photos: photos.map(p => ({ id: p.id, step: Number.isInteger(p.step) ? p.step : null })),
    createdAt: g.createdAt, updatedAt: g.updatedAt,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const stepsHtml = g.steps.length
    ? `<ol class="steps">${g.steps.map((s, i) => `<li><div class="tx">${esc(s)}</div>${(byStep[i] || []).map(img).join('')}</li>`).join('')}</ol>`
    : '<p class="empty">No steps yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How to use: ${esc(g.title || g.item || 'Instructions')}</title>
<style>${GUIDE_CSS}</style></head>
<body>
<header><div class="in">
<h1>${esc(g.title || g.item || 'Instructions')}</h1>
${meta ? `<ul class="meta">${meta}</ul>` : ''}
</div></header>
<main>
${stepsHtml}
${g.notes ? `<div class="notes"><b>Note</b>${esc(g.notes)}</div>` : ''}
${loose.length ? `<section class="photos"><h2>Photos</h2>${loose.map(img).join('')}</section>` : ''}
<footer>Made with How To Use Me. Updated ${esc(new Date(g.updatedAt || Date.now()).toLocaleDateString())}.</footer>
</main>
<script type="application/json" id="htu-data">${json}</script>
</body></html>`;
}

/** Reads a guide back out of an HTML file made by this app. Returns null if it isn't one. */
function guideFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const node = doc.getElementById('htu-data');
  if (!node) return null;
  let d;
  try { d = JSON.parse(node.textContent); } catch (e) { return null; }
  if (!d || d.app !== 'how-to-use-me') return null;
  const photos = (d.photos || []).map(p => {
    const el = doc.querySelector(`img[data-photo-id="${CSS.escape(String(p.id))}"]`);
    return el ? { id: p.id, src: el.getAttribute('src'), step: Number.isInteger(p.step) ? p.step : null } : null;
  }).filter(Boolean);
  return normalizeGuide({ ...d, photos });
}

function normalizeGuide(d) {
  const now = Date.now();
  return {
    id: String(d.id || newId()),
    title: String(d.title || ''),
    item: String(d.item || ''),
    location: String(d.location || ''),
    steps: Array.isArray(d.steps) ? d.steps.map(String).filter(s => s.trim()) : [],
    notes: String(d.notes || ''),
    cloudUrl: String(d.cloudUrl || ''),
    photos: Array.isArray(d.photos) ? d.photos.filter(p => p && p.src) : [],
    createdAt: d.createdAt || now,
    updatedAt: d.updatedAt || now,
  };
}

/* -------------------------------------------------------------- QR codes */
function appBase() {
  let base = (APP.settings.publicUrl || '').trim();
  if (!base) base = location.origin + location.pathname;
  return base.split('#')[0];
}
function baseIsUsable() {
  const b = appBase();
  if (!/^https?:\/\//i.test(b)) return false;
  if (NATIVE && !(APP.settings.publicUrl || '').trim()) return false;
  return true;
}
/** Builds the text inside the QR code. Short guides travel inside the code itself,
    so they open on ANY phone, even without internet or the app installed. */
function guideQrInfo(g) {
  const base = appBase();
  const mk = params => base + '#' + params.map(([k, v]) => k + '=' + v).join('&');
  const id = ['g', encodeURIComponent(g.id)];
  const cloud = g.cloudUrl ? ['u', encodeURIComponent(g.cloudUrl)] : null;
  const compact = { t: g.title, i: g.item, l: g.location, s: g.steps, n: g.notes, id: g.id };
  const tries = [compact, { ...compact, n: '' }];
  for (const c of tries) {
    const params = [id, ['d', packCompact(c)]];
    if (cloud) params.push(cloud);
    const url = mk(params);
    if (url.length <= QR_MAX_URL) {
      return { url, mode: 'embedded', droppedNotes: c.n === '' && !!g.notes };
    }
  }
  if (cloud) return { url: mk([id, cloud]), mode: 'cloud' };
  return { url: mk([id]), mode: 'local' };
}
function qrModules(text) {
  for (const ecc of ['M', 'L']) {
    try {
      const q = qrcode(0, ecc);
      q.addData(text, 'Byte');
      q.make();
      return q;
    } catch (e) { /* too long for this level, try lower */ }
  }
  throw new Error('This guide is too long for a QR code.');
}
/** Draws a QR (optionally with a label underneath) on a canvas. */
function qrCanvas(text, title, sub) {
  const q = qrModules(text);
  const n = q.getModuleCount();
  const quiet = 4;
  const cell = Math.max(4, Math.floor(1000 / (n + quiet * 2)));
  const size = (n + quiet * 2) * cell;
  const labelH = title ? Math.round(size * 0.2) : 0;
  const c = document.createElement('canvas');
  c.width = size; c.height = size + labelH;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (q.isDark(r, col)) x.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell);
  }
  if (title) {
    const face = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
    x.textAlign = 'center';
    x.fillStyle = '#000';
    x.font = `700 ${Math.round(labelH * 0.34)}px ${face}`;
    x.fillText(fitText(x, title, size * 0.92), size / 2, size + labelH * 0.32);
    x.font = `400 ${Math.round(labelH * 0.24)}px ${face}`;
    x.fillStyle = '#6C6C70';
    x.fillText(fitText(x, sub || 'Scan to see how to use this', size * 0.92), size / 2, size + labelH * 0.72);
  }
  return c;
}
/** Small QR shown on each tag in the library. Cached so scrolling stays smooth. */
const miniQrCache = new Map();
function miniQr(g) {
  const key = g.id + ':' + g.updatedAt + ':' + appBase();
  if (miniQrCache.has(key)) return miniQrCache.get(key);
  let src = '';
  try {
    const q = qrModules(guideQrInfo(g).url);
    const n = q.getModuleCount();
    const c = document.createElement('canvas');
    c.width = c.height = n * 2;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) x.fillRect(col * 2, r * 2, 2, 2);
    src = c.toDataURL('image/png');
  } catch (e) { /* too long: tag shows without a code */ }
  miniQrCache.set(key, src);
  return src;
}
function fitText(ctx, t, w) {
  t = String(t);
  if (ctx.measureText(t).width <= w) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
  return t + '…';
}
const canvasBlob = c => new Promise(r => c.toBlob(r, 'image/png'));

/* ----------------------------------------------------- files: share/save */
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
/** Opens the phone's share sheet (Google Drive, Dropbox, iCloud Files, OneDrive,
    WhatsApp, email, Nearby Share, AirDrop…). Falls back to downloading the file. */
async function shareFile(blob, name, title, text) {
  // Native app (Capacitor): write to cache, then use the native share sheet.
  if (NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem && window.Capacitor.Plugins.Share) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const res = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
    await Share.share({ title, text, files: [res.uri], dialogTitle: title });
    return 'shared';
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.share) {
    let ok = false;
    try { ok = navigator.canShare({ files: [file] }); } catch (e) { ok = false; }
    if (ok) {
      try {
        await navigator.share({ files: [file], title, text });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
  }
  downloadBlob(blob, name);
  toast('Saved "' + name + '" to your downloads. Upload it to any cloud or send it to a friend.');
  return 'downloaded';
}
async function saveFile(blob, name) {
  if (NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
    const { Filesystem } = window.Capacitor.Plugins;
    await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'DOCUMENTS' });
    toast('Saved to Documents/' + name);
    return;
  }
  downloadBlob(blob, name);
  toast('Saved "' + name + '"');
}

/* ----------------------------------------------------- capture / import */
function readAsDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}
/** Shrinks a photo so it's light enough to keep on the phone and inside the page. */
async function resizeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    let img;
    try { img = await loadImage(url); } catch (e) { throw new Error('Could not open image "' + file.name + '" (unsupported format?)'); }
    const scale = Math.min(1, IMG_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

let ocrWorkerP = null;
function getOcrWorker(onProgress) {
  APP.ocrProgress = onProgress;
  if (!ocrWorkerP) {
    ocrWorkerP = (async () => {
      await loadScript('vendor/tess/tesseract.min.js');
      const base = new URL('vendor/', location.href).href;
      return Tesseract.createWorker('eng', 1, {
        workerPath: base + 'tess/worker.min.js',
        corePath: base + 'tess/',
        langPath: base + 'lang',
        gzip: true,
        workerBlobURL: false,
        logger: m => { if (APP.ocrProgress) APP.ocrProgress(m); },
      });
    })();
    ocrWorkerP.catch(() => { ocrWorkerP = null; });
  }
  return ocrWorkerP;
}
async function ocrImage(src, onProgress) {
  const worker = await getOcrWorker(onProgress);
  const { data } = await worker.recognize(src);
  return data.text || '';
}

async function pdfToText(file, onStatus) {
  const pdfjs = await import(new URL('vendor/pdf.min.mjs', location.href).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(pdf.numPages, 20);
  let text = '';
  const images = [];
  for (let i = 1; i <= pages; i++) {
    onStatus && onStatus(`Reading PDF page ${i} of ${pages}…`);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let lastY = null, line = '';
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { text += line.trim() + '\n'; line = ''; }
      line += it.str + (it.hasEOL ? '\n' : (it.str.endsWith(' ') ? '' : ' '));
      if (y !== null) lastY = y;
    }
    text += line.trim() + '\n';
    if (images.length < 5) images.push(page);
  }
  // Scanned PDF (no real text)? Render pages to images so OCR can read them.
  const rendered = [];
  if (text.replace(/\s/g, '').length < 20) {
    for (const page of images) {
      const vp = page.getViewport({ scale: 1.6 });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      rendered.push(c.toDataURL('image/jpeg', 0.85));
    }
  }
  return { text, rendered };
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(n => n.remove());
  doc.querySelectorAll('br,p,div,li,h1,h2,h3,h4,h5,h6,tr,section,article').forEach(n => n.append('\n'));
  doc.querySelectorAll('li').forEach(n => n.prepend('- '));
  return (doc.body ? doc.body.textContent : '').replace(/\n\s*\n+/g, '\n');
}

/** Adds captured text to the draft: first heading → title, rest → steps. */
function addTextToDraft(text) {
  const d = readEditor();
  let { title, rest } = splitTitle(text);
  if (title && !d.title) d.title = title; else rest = title ? title + '\n' + rest : rest;
  const steps = textToSteps(rest);
  compactSteps(d);
  d.steps = d.steps.concat(steps);
  fillEditor(d);
  return steps.length;
}

async function handleCaptureFiles(fileList, source) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const st = $('#capture-status');
  const ocr = $('#ocr-toggle').checked;
  let added = 0, photos = 0;
  const errors = [];
  for (const [n, f] of files.entries()) {
    const name = (f.name || '').toLowerCase();
    const prefix = files.length > 1 ? `(${n + 1}/${files.length}) ` : '';
    try {
      if ((f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(name)) {
        setStatus(st, prefix + 'Adding photo…');
        const src = await resizeImage(f);
        const d = readEditor();
        d.photos.push({ id: newId(), src, step: null });
        fillEditor(d);
        photos++;
        if (ocr) {
          setStatus(st, prefix + 'Reading text from photo…');
          const text = await ocrImage(src, m => {
            if (m.status === 'recognizing text') setStatus(st, `${prefix}Reading text from photo… ${Math.round(m.progress * 100)}%`);
            else if (m.status) setStatus(st, prefix + m.status + '…');
          });
          added += addTextToDraft(text);
        }
      } else if (f.type === 'application/pdf' || name.endsWith('.pdf')) {
        const { text, rendered } = await pdfToText(f, m => setStatus(st, prefix + m));
        if (rendered.length) {
          for (const src of rendered) {
            const d = readEditor(); d.photos.push({ id: newId(), src, step: null }); fillEditor(d); photos++;
            setStatus(st, prefix + 'Scanned PDF — reading text from page image…');
            added += addTextToDraft(await ocrImage(src, () => {}));
          }
        } else added += addTextToDraft(text);
      } else if (/html?$/.test(f.type) || /\.html?$/.test(name)) {
        const html = await f.text();
        const g = guideFromHtml(html);
        if (g) {
          const d = readEditor();
          // An instructions page made by this app: load it in full.
          fillEditor({ ...d, title: d.title || g.title, item: d.item || g.item, location: d.location || g.location,
            notes: [d.notes, g.notes].filter(Boolean).join('\n'), steps: d.steps.concat(g.steps), photos: d.photos.concat(g.photos) });
          added += g.steps.length;
        } else added += addTextToDraft(htmlToText(html));
      } else if ((f.type || '').startsWith('text/') || /\.(txt|md|markdown|csv)$/.test(name) || !f.type) {
        added += addTextToDraft(await f.text());
      } else {
        errors.push(`"${f.name}" isn't a supported file type (use photos, PDF, text or HTML).`);
      }
    } catch (e) {
      console.error(e);
      errors.push(`"${f.name || 'file'}": ${e.message || e}`);
    }
  }
  const parts = [];
  if (photos) parts.push(`${photos} photo${photos > 1 ? 's' : ''} added`);
  if (added) parts.push(`${added} step${added > 1 ? 's' : ''} found`);
  else if (photos && ocr) parts.push('no readable text found — type the steps below');
  setStatus(st, (parts.join(', ') || 'Nothing added') + (errors.length ? '. ' + errors.join(' ') : '.'), errors.length && !added && !photos);
}

/* --------------------------------------------------------------- editor */
function emptyDraft() {
  return { id: newId(), title: '', item: '', location: '', steps: [], notes: '', cloudUrl: '', photos: [], createdAt: Date.now(), updatedAt: Date.now(), _new: true };
}
/** Pulls what's on screen into APP.draft. Empty step rows are kept while editing. */
function readEditor() {
  const d = APP.draft || emptyDraft();
  d.title = $('#f-title').value.trim();
  d.item = $('#f-item').value.trim();
  d.location = $('#f-location').value.trim();
  if ($('#step-list').dataset.rendered === '1') d.steps = $$('#step-list .step-text').map(t => t.value.trim());
  d.notes = $('#f-notes').value.trim();
  d.cloudUrl = $('#f-cloud').value.trim();
  $$('#photo-list .photo').forEach(div => {
    const p = d.photos.find(x => x.id === div.dataset.id);
    if (p) { const v = $('select', div).value; p.step = v === '' ? null : Number(v); }
  });
  APP.draft = d;
  return d;
}
function fillEditor(d) {
  APP.draft = d;
  $('#f-title').value = d.title;
  $('#f-item').value = d.item;
  $('#f-location').value = d.location;
  $('#f-notes').value = d.notes;
  $('#f-cloud').value = d.cloudUrl || '';
  renderSteps();
  renderPhotoList();
}
function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
function renderSteps(focusIndex) {
  const d = APP.draft;
  const ol = $('#step-list');
  ol.innerHTML = '';
  d.steps.forEach((text, i) => {
    const li = document.createElement('li');
    li.className = 'step-row';
    const thumbs = d.photos.filter(p => p.step === i).map(p => `<img src="${p.src}" alt="">`).join('');
    li.innerHTML = `<textarea class="step-text" rows="1" aria-label="Step ${i + 1}" placeholder="Describe this step"></textarea>
      <div class="step-ctl">
        <button type="button" data-act="up" aria-label="Move step ${i + 1} up"${i === 0 ? ' disabled' : ''}><svg class="ico"><use href="#i-up"/></svg></button>
        <button type="button" data-act="down" aria-label="Move step ${i + 1} down"${i === d.steps.length - 1 ? ' disabled' : ''}><svg class="ico"><use href="#i-down"/></svg></button>
        <button type="button" data-act="del" aria-label="Delete step ${i + 1}"><svg class="ico"><use href="#i-minus"/></svg></button>
      </div>${thumbs ? `<div class="step-thumbs">${thumbs}</div>` : ''}`;
    const ta = $('textarea', li);
    ta.value = text;
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', e => {
      // Enter at the end of a step starts a new one, like a checklist app.
      if (e.key === 'Enter' && !e.shiftKey && ta.selectionStart === ta.value.length) {
        e.preventDefault();
        readEditor();
        insertStep(i + 1);
      }
    });
    li.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      readEditor();
      if (b.dataset.act === 'del') deleteStep(i);
      else moveStep(i, b.dataset.act === 'up' ? -1 : 1);
    });
    ol.appendChild(li);
  });
  ol.dataset.rendered = '1';
  $('#steps-empty').hidden = d.steps.length > 0;
  // Focus right away so the first letters typed aren't lost; size rows once laid out.
  if (Number.isInteger(focusIndex)) { const t = $$('#step-list .step-text')[focusIndex]; if (t) t.focus(); }
  requestAnimationFrame(() => $$('#step-list .step-text').forEach(autosize));
}
// Photos are attached to steps by index, so they move with their step.
function remapPhotoSteps(d, map) {
  d.photos.forEach(p => { if (Number.isInteger(p.step)) p.step = map(p.step); });
}
function insertStep(at) {
  const d = APP.draft;
  d.steps.splice(at, 0, '');
  remapPhotoSteps(d, s => (s >= at ? s + 1 : s));
  renderSteps(at); renderPhotoList();
}
function deleteStep(i) {
  const d = APP.draft;
  d.steps.splice(i, 1);
  remapPhotoSteps(d, s => (s === i ? null : s > i ? s - 1 : s));
  renderSteps(); renderPhotoList();
}
function moveStep(i, dir) {
  const d = APP.draft;
  const j = i + dir;
  if (j < 0 || j >= d.steps.length) return;
  [d.steps[i], d.steps[j]] = [d.steps[j], d.steps[i]];
  remapPhotoSteps(d, s => (s === i ? j : s === j ? i : s));
  renderSteps(j); renderPhotoList();
}
/** Drops empty steps and keeps photos pointing at the right step. */
function compactSteps(d) {
  const map = [];
  const kept = [];
  d.steps.forEach((s, i) => { if (s.trim()) { map[i] = kept.length; kept.push(s.trim()); } else map[i] = null; });
  d.steps = kept;
  remapPhotoSteps(d, s => (map[s] === undefined ? null : map[s]));
  return d;
}
function renderPhotoList() {
  const d = APP.draft;
  const box = $('#photo-list');
  box.innerHTML = '';
  $('#photos-section').hidden = d.photos.length === 0;
  d.photos.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'photo';
    div.dataset.id = p.id;
    const opts = ['<option value="">Show at the End</option>']
      .concat(d.steps.map((s, i) => `<option value="${i}"${p.step === i ? ' selected' : ''}>Step ${i + 1}${s ? ': ' + esc(s.slice(0, 28)) : ''}</option>`));
    div.innerHTML = `<img src="${p.src}" alt="Photo ${idx + 1}"><select aria-label="Where to show photo ${idx + 1}">${opts.join('')}</select><button type="button" class="rm">Remove</button>`;
    $('.rm', div).onclick = () => { readEditor(); d.photos = d.photos.filter(x => x.id !== p.id); renderSteps(); renderPhotoList(); };
    $('select', div).onchange = () => { readEditor(); renderSteps(); };
    box.appendChild(div);
  });
}
function openEditor(g) {
  stopScan();
  const d = g ? JSON.parse(JSON.stringify(g)) : emptyDraft();
  fillEditor(d);
  $('#edit-heading').textContent = g ? 'Edit Guide' : 'New Guide';
  setStatus($('#capture-status'), '');
  $('#preview-frame').hidden = true;
  show('edit');
}
async function saveDraft() {
  const d = compactSteps(readEditor());
  if (!d.title && !d.item && !d.steps.length) {
    toast('Add a title or at least one step before saving.');
    renderSteps();
    return;
  }
  if (d.cloudUrl && !/^https?:\/\//i.test(d.cloudUrl)) {
    toast('The cloud link has to start with https://');
    return;
  }
  if (!d.title) d.title = d.item ? 'How to use the ' + d.item : (d.steps[0] || 'Instructions').slice(0, 60);
  d.updatedAt = Date.now();
  delete d._new;
  const g = normalizeGuide(d);
  g.html = buildGuideHtml(g);
  try {
    await dbPut(g);
  } catch (e) {
    toast('Could not save — the phone may be out of storage. ' + (e.message || ''));
    return;
  }
  APP.draft = null;
  toast('Saved. Here’s your label.');
  await showGuide(g, true);
  showQrPanel();
}

/* --------------------------------------------------------------- viewer */
function frameFit(frame) {
  try {
    const doc = frame.contentDocument;
    if (doc && doc.documentElement) frame.style.height = Math.max(300, doc.documentElement.scrollHeight + 20) + 'px';
  } catch (e) { /* cross-origin, ignore */ }
}
function renderInFrame(frame, html, embedded) {
  // In the guide screen the app already shows the title, so the page drops its own header
  // and background and its steps sit directly on the screen.
  if (embedded) html = html.replace('</head>', '<style>:root{color-scheme:light dark}header{display:none}body{background:transparent!important}main{padding:0 0 4px}</style></head>');
  frame.onload = () => {
    frameFit(frame);
    try { $$('img', frame.contentDocument).forEach(i => i.addEventListener('load', () => frameFit(frame))); } catch (e) { /* ignore */ }
  };
  frame.srcdoc = html;
}
async function showGuide(g, saved) {
  stopScan();
  if (!g.html) g.html = buildGuideHtml(g);
  APP.viewing = g;
  APP.viewingSaved = !!saved;
  $('#unsaved-banner').hidden = !!saved;
  $('#act-edit').hidden = !saved;
  $('#act-delete').hidden = !saved;
  $('#guide-manage').hidden = !saved;
  $('#qr-panel').hidden = true;
  $('#act-qr').classList.remove('open');
  $('#guide-title').textContent = g.title;
  $('#guide-nav-title').textContent = g.title;
  $('#guide-sub').textContent = [g.item, g.location].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  renderInFrame($('#guide-frame'), g.html, true);
  show('guide');
}
function showQrPanel() {
  const g = APP.viewing;
  if (!g) return;
  const info = guideQrInfo(g);
  APP.qrInfo = info;
  let c;
  try { c = qrCanvas(info.url); } catch (e) { toast(e.message); return; }
  $('#qr-img').src = c.toDataURL('image/png');
  $('#qr-img').dataset.url = info.url;
  $('#lp-title').textContent = g.title;
  $('#lp-sub').textContent = g.location || g.item || '';
  const notes = {
    embedded: 'The steps are stored inside the code itself, so it works on any phone, even without this app or internet.' +
      (info.droppedNotes ? ' Notes only appear on the full page.' : ''),
    cloud: 'This guide is too long to fit inside a QR code, so the label opens it from your cloud link. Phones that have it saved open their own copy.',
    local: 'This guide is too long to fit inside a QR code. It opens on phones that have it saved. Add a cloud link in Edit so any phone can open it.',
  };
  let note = notes[info.mode];
  if (!baseIsUsable()) note += ' Other phones’ cameras can’t open it yet: set the app’s web address in Settings.';
  $('#qr-note').textContent = note;
  $('#qr-panel').hidden = false;
  $('#act-qr').classList.add('open');
}
function printLabels(guides) {
  const area = $('#print-area');
  area.innerHTML = '<div class="label-grid"></div>';
  const grid = $('.label-grid', area);
  for (const g of guides) {
    let src;
    try { src = qrCanvas(guideQrInfo(g).url).toDataURL('image/png'); } catch (e) { console.warn('label failed', g.id, e); continue; }
    const div = document.createElement('div');
    div.className = 'label';
    div.innerHTML = `<img src="${src}" alt="QR code"><div class="lt">${esc(g.title)}</div>${g.location || g.item ? `<div class="ls">${esc(g.location || g.item)}</div>` : ''}<div class="lc">Scan to see how to use this</div>`;
    grid.appendChild(div);
  }
  const imgs = $$('img', area);
  Promise.all(imgs.map(i => i.decode().catch(() => {}))).then(() => window.print());
}

/* --------------------------------------------------------------- scanner */
async function startScan() {
  const st = $('#scan-status');
  $('#scan-result').innerHTML = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(st, 'This browser can’t use the camera. Use Scan from Photo.', true);
    return;
  }
  stopScan();
  try {
    APP.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    setStatus(st, 'Camera blocked or not found. Allow camera access in Settings, or use Scan from Photo.', true);
    return;
  }
  const v = $('#scan-video');
  v.srcObject = APP.scanStream;
  $('#viewfinder').classList.add('live');
  try { await v.play(); } catch (e) { /* autoplay quirks; frames still arrive */ }
  setStatus(st, 'Point the camera at a label');
  const c = $('#scan-canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!APP.scanStream) return;
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) {
        stopScan();
        if (navigator.vibrate) navigator.vibrate(80);
        handleScanned(code.data);
        return;
      }
    }
    APP.scanTimer = setTimeout(tick, 150);
  };
  tick();
}
function stopScan() {
  clearTimeout(APP.scanTimer);
  if (APP.scanStream) APP.scanStream.getTracks().forEach(t => t.stop());
  APP.scanStream = null;
  const v = $('#scan-video');
  if (v) v.srcObject = null;
  const vf = $('#viewfinder');
  if (vf) vf.classList.remove('live');
}
async function scanFromFile(file) {
  const st = $('#scan-status');
  setStatus(st, 'Looking for a QR code in the photo…');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    for (const max of [1200, 800, 1800, 500]) {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      const code = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) { setStatus(st, ''); return handleScanned(code.data); }
    }
    setStatus(st, 'No QR code found in that photo. Try a closer, sharper picture.', true);
  } catch (e) {
    setStatus(st, 'Could not read that photo.', true);
  } finally { URL.revokeObjectURL(url); }
}
function parseGuideLink(text) {
  let u;
  try { u = new URL(text); } catch (e) { return null; }
  const hash = u.hash.replace(/^#/, '');
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  if (!p.get('g')) return null;
  return { id: p.get('g'), d: p.get('d'), u: p.get('u') };
}
/** Opens whatever a QR code (or link) points to. Returns true if it was one of ours. */
async function handleScanned(text, fromLink) {
  const info = parseGuideLink(text);
  const st = $('#scan-status');
  if (!info) {
    show('scan');
    setStatus(st, 'That QR code isn’t a How To Use Me label.');
    const r = $('#scan-result');
    r.innerHTML = '<p class="small"></p>';
    $('p', r).textContent = 'It contains: ' + text;
    if (/^https?:\/\//i.test(text)) {
      const a = document.createElement('a');
      a.href = text; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open this link';
      r.appendChild(a);
    }
    return false;
  }
  const local = await dbGet(info.id);
  if (local) { await showGuide(local, true); return true; }
  if (info.d) {
    try {
      const c = unpackCompact(info.d);
      const g = normalizeGuide({ id: c.id || info.id, title: c.t, item: c.i, location: c.l, steps: c.s, notes: c.n, cloudUrl: info.u || '' });
      await showGuide(g, false);
      return true;
    } catch (e) { console.error(e); }
  }
  if (info.u) {
    show('scan');
    setStatus(st, 'This guide is stored in the owner’s cloud.');
    const r = $('#scan-result');
    r.innerHTML = '<a class="btn filled" id="open-cloud" target="_blank" rel="noopener">Open Instructions</a><p>To keep it, download the page there and import it in Guides.</p>';
    $('#open-cloud').href = info.u;
    if (!fromLink) window.open(info.u, '_blank', 'noopener');
    return true;
  }
  show('scan');
  setStatus(st, 'This guide isn’t saved on this phone and is too long to fit in the QR code. Ask the owner to share it with you (or add a cloud link), then import it.', true);
  return true;
}

/* ------------------------------------------------------ library & backup */
let libRenderSeq = 0;
async function renderLibrary() {
  const seq = ++libRenderSeq;
  const q = $('#search').value.trim().toLowerCase();
  const all = (await dbAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  if (seq !== libRenderSeq) return; // a newer search started; don't show stale results
  const list = all.filter(g => !q || [g.title, g.item, g.location, g.notes, ...g.steps].join(' ').toLowerCase().includes(q));
  const ul = $('#guide-list');
  ul.innerHTML = '';
  for (const g of list) {
    const li = document.createElement('li');
    li.className = 'guide-row';
    li.dataset.id = g.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const qr = miniQr(g);
    const where = g.location || g.item;
    const sub = `${g.steps.length} step${g.steps.length === 1 ? '' : 's'}${where ? ' · ' + where : ''}`;
    li.innerHTML = `${qr ? `<span class="thumb"><img src="${qr}" alt=""></span>` : `<span class="thumb none"><svg class="ico"><use href="#i-guides"/></svg></span>`}<span class="txt"><span class="t">${esc(g.title)}</span><span class="s" style="display:block">${esc(sub)}</span></span><svg class="ico chev"><use href="#i-chev"/></svg>`;
    li.onclick = () => showGuide(g, true);
    li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showGuide(g, true); } };
    ul.appendChild(li);
  }
  $('#lib-count').textContent = list.length ? `${list.length} guide${list.length === 1 ? '' : 's'}` : '';
  $('.search').hidden = all.length === 0;
  $('#print-all-row').hidden = all.length === 0;
  const empty = $('#empty-library');
  empty.hidden = all.length > 0 && list.length > 0;
  $('#empty-actions').hidden = all.length > 0;
  $('.empty-icon', empty).hidden = all.length > 0;
  if (!all.length) {
    $('#empty-title').textContent = 'No Guides Yet';
    $('#empty-text').textContent = 'Take a photo of any instructions. The text becomes steps you can print as a QR label.';
  } else if (!list.length) {
    $('#empty-title').textContent = 'Nothing matches “' + q + '”';
    $('#empty-text').textContent = 'Check the spelling or try a shorter word.';
  }
}
async function makeBackupBlob() {
  const guides = (await dbAll()).map(g => { const { html, ...rest } = g; return rest; });
  const data = { app: 'how-to-use-me', kind: 'backup', v: 1, exportedAt: new Date().toISOString(), guides };
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), count: guides.length };
}
/** Imports guide pages (.html) and backups (.json). Newer copy wins. */
async function importFiles(fileList) {
  let imported = 0, skipped = 0;
  const bad = [];
  let last = null;
  for (const f of Array.from(fileList || [])) {
    try {
      const text = await f.text();
      let guides = [];
      if (/\.json$/i.test(f.name) || /json/.test(f.type) || /^\s*\{/.test(text)) {
        const data = JSON.parse(text);
        if (data && data.app === 'how-to-use-me' && Array.isArray(data.guides)) guides = data.guides.map(normalizeGuide);
        else if (data && data.app === 'how-to-use-me') guides = [normalizeGuide(data)];
        else throw new Error('not a How To Use Me backup');
      } else {
        const g = guideFromHtml(text);
        if (!g) throw new Error('not a page made with How To Use Me. To turn another page into a guide, tap New, then Import PDF or File');
        guides = [g];
      }
      for (const g of guides) {
        const existing = await dbGet(g.id);
        if (existing && existing.updatedAt >= g.updatedAt) { skipped++; continue; }
        g.html = buildGuideHtml(g);
        await dbPut(g);
        imported++; last = g;
      }
    } catch (e) {
      bad.push(`${f.name}: ${e.message}`);
    }
  }
  await renderLibrary();
  const msg = [`Imported ${imported} guide${imported === 1 ? '' : 's'}`];
  if (skipped) msg.push(`${skipped} already up to date`);
  if (bad.length) msg.push('Problem with ' + bad.join('; '));
  toast(msg.join('. ') + '.', 6000);
  return { imported, skipped, bad, last };
}

/* ---------------------------------------------------------- confirm box */
function askConfirm(text, okLabel, title) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title || 'Are you sure?';
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel || 'Delete';
  dlg.returnValue = '';
  return new Promise(res => {
    dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}

/* ----------------------------------------------------------- navigation */
function show(name) {
  if (name !== 'scan') stopScan();
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  $$('[data-nav]').forEach(b => {
    const on = b.dataset.nav === name || (name === 'guide' && b.dataset.nav === 'library');
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('editing', name === 'edit');
  document.body.classList.remove('scrolled');
  if (name === 'library') renderLibrary();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
async function renderSettings() {
  $('#set-url').value = APP.settings.publicUrl || '';
  const w = $('#url-warning');
  if (!baseIsUsable()) {
    w.hidden = false;
    w.textContent = NATIVE
      ? 'Enter the web address where this app is hosted, so other phones’ cameras can open your labels.'
      : 'This app isn’t running from a public web address, so other phones can’t open your labels. Enter the public address.';
  } else w.hidden = true;
  const n = (await dbAll()).length;
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    try { const e = await navigator.storage.estimate(); usage = `, ${(e.usage / 1048576).toFixed(1)} MB`; } catch (e) { /* ignore */ }
  }
  $('#storage-info').textContent = `${n} guide${n === 1 ? '' : 's'}${usage}`;
}

/* ------------------------------------------------------------------ wire */
function wire() {
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.nav === 'edit') openEditor(null); else show(b.dataset.nav);
  }));
  $('#search').addEventListener('input', renderLibrary);
  $('#import-input').addEventListener('change', async e => { const r = await importFiles(e.target.files); e.target.value = ''; if (r.imported === 1 && r.last) showGuide(r.last, true); });
  $('#print-all-labels').addEventListener('click', async () => {
    const all = await dbAll();
    if (!all.length) return toast('No guides yet.');
    printLabels(all);
  });

  for (const id of ['#in-camera', '#in-images', '#in-file']) {
    $(id).addEventListener('change', async e => { await handleCaptureFiles(e.target.files, id); e.target.value = ''; });
  }
  document.addEventListener('paste', async e => {
    if ($('#view-edit').hidden) return;
    const items = Array.from(e.clipboardData ? e.clipboardData.items : []);
    const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); await handleCaptureFiles(files, 'paste'); }
  });
  $('#add-step').addEventListener('click', () => { readEditor(); insertStep(APP.draft.steps.length); });
  $('#bulk-open').addEventListener('click', () => {
    const d = readEditor();
    $('#f-steps').value = d.steps.filter(Boolean).join('\n');
    $('#bulk-dialog').showModal();
    $('#f-steps').focus();
  });
  $('#bulk-apply').addEventListener('click', () => {
    const d = readEditor();
    d.steps = $('#f-steps').value.split('\n').map(l => stripMarker(cleanLine(l))).filter(Boolean);
    d.photos.forEach(p => { if (Number.isInteger(p.step) && p.step >= d.steps.length) p.step = null; });
    renderSteps(); renderPhotoList();
  });
  $$('[data-start]').forEach(b => b.addEventListener('click', () => {
    openEditor(null);
    $(b.dataset.start === 'camera' ? '#in-camera' : '#in-images').click();
  }));
  $('#guide-back').addEventListener('click', () => show('library'));
  $('#lib-add').addEventListener('click', () => openEditor(null));
  // Like iOS: the small title fades into the bar once the large title scrolls away.
  window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', window.scrollY > 36), { passive: true });
  $('#save-guide').addEventListener('click', saveDraft);
  $('#preview-guide').addEventListener('click', () => {
    const d = normalizeGuide(readEditor());
    const f = $('#preview-frame');
    f.hidden = false;
    renderInFrame(f, buildGuideHtml(d));
    f.scrollIntoView({ behavior: 'smooth' });
  });
  $('#cancel-edit').addEventListener('click', () => { APP.draft = null; show('library'); });

  $('#act-qr').addEventListener('click', () => {
    if ($('#qr-panel').hidden) { showQrPanel(); $('#qr-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    else { $('#qr-panel').hidden = true; $('#act-qr').classList.remove('open'); }
  });
  $('#act-share').addEventListener('click', async () => {
    const g = APP.viewing;
    await shareFile(new Blob([g.html], { type: 'text/html' }), slug(g.title) + '.html', g.title, 'How to use: ' + g.title);
  });
  $('#act-download').addEventListener('click', () => { const g = APP.viewing; saveFile(new Blob([g.html], { type: 'text/html' }), slug(g.title) + '.html'); });
  $('#act-print').addEventListener('click', () => {
    const f = $('#guide-frame');
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { window.print(); }
  });
  $('#act-edit').addEventListener('click', () => openEditor(APP.viewing));
  $('#act-delete').addEventListener('click', async () => {
    if (!(await askConfirm('“' + APP.viewing.title + '” will be removed from this phone. Labels that hold their steps inside the code still work.', 'Delete', 'Delete Guide?'))) return;
    await dbDel(APP.viewing.id);
    toast('Guide deleted.');
    show('library');
  });
  $('#save-scanned').addEventListener('click', async () => {
    const g = APP.viewing;
    g.html = buildGuideHtml(g);
    await dbPut(g);
    toast('Saved to your guides.');
    showGuide(g, true);
  });

  $('#qr-print').addEventListener('click', () => printLabels([APP.viewing]));
  $('#qr-download').addEventListener('click', async () => {
    const g = APP.viewing;
    const c = qrCanvas(guideQrInfo(g).url, g.title, g.location || g.item || 'Scan to see how to use this');
    saveFile(await canvasBlob(c), slug(g.title) + '-qr.png');
  });
  $('#qr-share').addEventListener('click', async () => {
    const g = APP.viewing;
    const c = qrCanvas(guideQrInfo(g).url, g.title, g.location || g.item || 'Scan to see how to use this');
    shareFile(await canvasBlob(c), slug(g.title) + '-qr.png', g.title, 'Scan this to see how to use: ' + g.title);
  });
  $('#qr-copy-link').addEventListener('click', async () => {
    const g = APP.viewing;
    const info = guideQrInfo(g);
    if (info.mode === 'local') {
      toast('This guide is too long for a link. Use Share to send the page instead.', 5000);
      return;
    }
    if (navigator.share) {
      try { await navigator.share({ title: g.title, text: 'How to use: ' + g.title, url: info.url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(info.url); toast('Link copied. Paste it in any chat or email.'); }
    catch (e) { prompt('Copy this link:', info.url); }
  });

  $('#scan-start').addEventListener('click', startScan);
  $('#scan-stop').addEventListener('click', () => { stopScan(); setStatus($('#scan-status'), 'Camera off.'); });
  $('#scan-file').addEventListener('change', async e => { if (e.target.files[0]) await scanFromFile(e.target.files[0]); e.target.value = ''; });

  $('#backup-share').addEventListener('click', async () => {
    const { blob, count } = await makeBackupBlob();
    if (!count) return toast('Nothing to back up yet.');
    await shareFile(blob, 'how-to-use-me-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'How To Use Me backup', count + ' guides');
  });
  $('#backup-download').addEventListener('click', async () => {
    const { blob, count } = await makeBackupBlob();
    if (!count) return toast('Nothing to back up yet.');
    saveFile(blob, 'how-to-use-me-backup-' + new Date().toISOString().slice(0, 10) + '.json');
  });
  $('#restore-input').addEventListener('change', async e => { await importFiles(e.target.files); e.target.value = ''; renderSettings(); });
  $('#set-save').addEventListener('click', async () => {
    const v = $('#set-url').value.trim();
    if (v && !/^https?:\/\//i.test(v)) return toast('The address must start with https://');
    APP.settings.publicUrl = v && !/[/#?]$/.test(v) && !/\.[a-z0-9]+$/i.test(v.split('/').pop()) ? v + '/' : v;
    await kvSet('settings', APP.settings);
    toast('Address saved.');
    renderSettings();
  });
  $('#clear-all').addEventListener('click', async () => {
    const n = (await dbAll()).length;
    if (!n) return toast('There are no guides to delete.');
    if (!(await askConfirm(`All ${n} guides will be removed from this phone. Back up first if you want to keep them.`, 'Delete All', 'Delete All Guides?'))) return;
    await dbClear();
    toast('All guides deleted.');
    renderSettings();
  });
  window.addEventListener('hashchange', handleIncomingLink);
}

async function handleIncomingLink() {
  if (!parseGuideLink(location.href)) return false;
  const href = location.href;
  history.replaceState(null, '', location.pathname + location.search);
  return handleScanned(href, true);
}

async function main() {
  wire();
  try {
    APP.db = await openDB();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="color:#b42318;padding:12px">This browser blocked storage (private mode?). Guides can’t be saved.</p>');
    throw e;
  }
  APP.settings = Object.assign({ publicUrl: '' }, (await kvGet('settings')) || {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const opened = await handleIncomingLink();
  if (!opened) show('library');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !NATIVE) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__htuReady = true;
}

// Expose for tests / debugging
window.HTU = { textToSteps, splitTitle, buildGuideHtml, guideFromHtml, guideQrInfo, unpackCompact, handleScanned, dbAll, readEditor, APP };
main();
