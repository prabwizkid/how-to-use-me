/* Library admin: review reports, approve photos, restore/hide/delete guides, ban publishers,
   manage blocked words and limits. Every action is checked by the database with the admin key. */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const CONFIG = window.HTU_CONFIG || {};
const base = CONFIG.libraryRest || String(CONFIG.libraryUrl || '').replace(/\/+$/, '') + '/rest/v1';
let KEY = '';
let TAB = 'review';

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
/** Builds an element; text is always set as text, never as HTML. */
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of [].concat(kids)) if (k) e.append(k);
  return e;
}
async function rpc(fn, body) {
  if (!CONFIG.libraryRest && !CONFIG.libraryUrl) throw new Error('The library isn’t connected (config.js).');
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.libraryKey) {
    headers.apikey = CONFIG.libraryKey;
    if (!/^sb_/.test(CONFIG.libraryKey)) headers.Authorization = 'Bearer ' + CONFIG.libraryKey;
  }
  const res = await fetch(base + '/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify({ p_key: KEY, ...body }) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.message) || `Request failed (${res.status})`);
  return data;
}

async function signIn() {
  KEY = $('#key').value.trim();
  $('#signin-error').textContent = '';
  try {
    await rpc('admin_settings', { p_changes: {} });
  } catch (e) {
    KEY = '';
    $('#signin-error').textContent = e.message;
    return;
  }
  try { sessionStorage.setItem('htu-admin', KEY); } catch (e) { /* private mode */ }
  $('#key').value = '';
  $('#signin').hidden = true;
  $('#panel').hidden = false;
  $('#sign-out').hidden = false;
  showTab('review');
}
function signOut() {
  KEY = '';
  try { sessionStorage.removeItem('htu-admin'); } catch (e) { /* ignore */ }
  location.reload();
}

function showTab(name) {
  TAB = name;
  $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $('#tab-list').hidden = !(name === 'review' || name === 'all');
  $('#tab-words').hidden = name !== 'words';
  $('#tab-limits').hidden = name !== 'limits';
  if (name === 'review' || name === 'all') loadQueue();
  if (name === 'words') loadWords();
  if (name === 'limits') loadLimits();
}

const REASONS = { wrong: 'steps wrong', unsafe: 'unsafe / scam', spam: 'spam', offensive: 'offensive', other: 'other' };
let queueSeq = 0;
async function loadQueue() {
  const seq = ++queueSeq;
  const box = $('#queue');
  let items;
  try {
    items = await rpc('admin_queue', { p_view: TAB, p_q: $('#q').value.trim() });
  } catch (e) { if (seq === queueSeq) box.replaceChildren(el('p', { class: 'empty-note', text: e.message })); return; }
  if (seq !== queueSeq) return;
  box.replaceChildren();
  if (!items.length) {
    box.append(el('p', { class: 'empty-note', text: TAB === 'review' ? 'Nothing needs review.' : 'No guides found.' }));
    return;
  }
  for (const g of items) box.append(card(g));
}
function card(g) {
  const chips = [];
  if (g.hidden) chips.push(el('span', { class: 'chip red', text: 'Hidden' }));
  if (g.reports) {
    const counts = {};
    for (const r of g.reasons) counts[r] = (counts[r] || 0) + 1;
    chips.push(el('span', { class: 'chip red', text: `${g.reports} report${g.reports === 1 ? '' : 's'}: ` + Object.entries(counts).map(([r, n]) => `${REASONS[r] || r}${n > 1 ? ' ×' + n : ''}`).join(', ') }));
  }
  const pending = !g.photos_approved && g.photos.length;
  if (pending) chips.push(el('span', { class: 'chip orange', text: `${g.photos.length} photo${g.photos.length === 1 ? '' : 's'} waiting` }));
  if (g.protected) chips.push(el('span', { class: 'chip green', text: 'Marked as fine' }));
  if (g.publisher_banned) chips.push(el('span', { class: 'chip red', text: 'Publisher banned' }));
  chips.push(el('span', { class: 'chip', text: `Publisher ${g.publisher}… (${g.publisher_guides} guide${g.publisher_guides === 1 ? '' : 's'})` }));

  const act = (label, action, cls, confirmText) => el('button', {
    class: cls || '', text: label, 'data-action': action,
    onclick: async () => {
      if (confirmText && !confirm(confirmText)) return;
      try { await rpc('admin_act', { p_id: g.id, p_action: action }); toast('Done.'); loadQueue(); }
      catch (e) { toast(e.message, 5000); }
    },
  });
  const acts = [];
  if (pending) acts.push(act('Approve Photos', 'approve_photos', 'go'), act('Remove Photos', 'remove_photos', 'danger'));
  if (g.hidden || g.reports) acts.push(act('Restore', 'restore'), act('Mark as Fine', 'protect'));
  else acts.push(act('Hide', 'hide', 'danger'));
  if (g.protected) acts.push(act('Allow Reports Again', 'unprotect'));
  acts.push(act('Delete', 'delete', 'danger', `Delete “${g.title}” from the library? This can’t be undone.`));
  acts.push(g.publisher_banned
    ? act('Unban Publisher', 'unban')
    : act('Ban Publisher', 'ban', 'danger', 'Ban this publisher’s network? Their guides are hidden and they can’t publish or report.'));

  const meta = [g.item, g.location, `${g.downloads} download${g.downloads === 1 ? '' : 's'}`, 'updated ' + new Date(g.updated_at).toLocaleString()].filter(Boolean).join(' · ');
  return el('article', { class: 'card', 'data-id': g.id }, [
    el('h3', { text: g.title }),
    el('p', { class: 'meta', text: meta }),
    el('div', { class: 'chips' }, chips),
    el('ol', {}, g.steps.map(s => el('li', { text: s }))),
    g.notes ? el('p', { class: 'notes', text: 'Notes: ' + g.notes }) : null,
    g.photos.length ? el('div', { class: 'pics' }, g.photos.map(p => {
      const img = el('img', { alt: 'Photo' });
      if (/^data:image\/(jpeg|png|webp);base64,/.test(p.src)) img.src = p.src;
      return img;
    })) : null,
    el('div', { class: 'acts' }, acts),
  ]);
}

async function loadWords(add, remove) {
  try {
    const words = await rpc('admin_blocklist', { p_add: add || null, p_remove: remove || null });
    $('#words').replaceChildren(...words.map(w => el('span', { class: 'chip' }, [
      w, el('button', { 'aria-label': 'Unblock ' + w, text: '×', onclick: () => loadWords(null, w) }),
    ])));
    if (add) { $('#new-word').value = ''; toast('Blocked.'); }
  } catch (e) { toast(e.message, 5000); }
}

const LIMITS = [
  ['publish_per_client_hour', 'Guides per network per hour'],
  ['publish_global_hour', 'Guides per hour, everyone'],
  ['publish_global_day', 'Guides per day, everyone'],
  ['report_per_client_day', 'Reports per network per day'],
  ['hide_after_reports', 'Hide after this many reports'],
  ['max_photos', 'Photos per guide'],
  ['max_photo_kb', 'Photo size limit (KB)'],
  ['max_library_mb', 'Stop publishing at (MB)'],
  ['pow_bits', 'Puzzle difficulty (bits)'],
];
async function loadLimits(changes) {
  try {
    const s = await rpc('admin_settings', { p_changes: changes || {} });
    $('#limits').replaceChildren(...LIMITS.map(([k, label]) => el('li', { class: 'row field' }, [
      el('span', { class: 'row-label', text: label, style: 'flex:1' }),
      el('input', { type: 'number', min: '0', step: '1', value: String(s[k]), 'data-key': k, 'aria-label': label }),
    ])));
    $('#usage').textContent = `${s.guides} guide${s.guides === 1 ? '' : 's'} using ${s.library_mb} MB.`;
    if (changes) toast('Limits saved.');
  } catch (e) { toast(e.message, 5000); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#signin-btn').addEventListener('click', signIn);
  $('#key').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
  $('#sign-out').addEventListener('click', signOut);
  $$('.seg button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  let t;
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadQueue, 250); });
  $('#add-word').addEventListener('click', () => { const w = $('#new-word').value.trim(); if (w) loadWords(w); });
  $('#save-limits').addEventListener('click', () => {
    const changes = {};
    $$('#limits input').forEach(i => { changes[i.dataset.key] = Math.max(0, Math.round(Number(i.value) || 0)); });
    loadLimits(changes);
  });
  $('#whoami').addEventListener('click', async () => {
    try { $('#whoami-out').textContent = JSON.stringify(await rpc('admin_whoami', {}), null, 2); $('#whoami-out').hidden = false; }
    catch (e) { toast(e.message, 5000); }
  });
  let saved = '';
  try { saved = sessionStorage.getItem('htu-admin') || ''; } catch (e) { /* ignore */ }
  if (saved) { $('#key').value = saved; signIn(); }
});
