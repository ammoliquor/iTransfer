'use strict';
/* Shared by the upload page and the transfer page: icons, thumbnails, the file grid and the
   full-screen viewer. A "transfer" is {id, title, files: [{name, size, type}], ...}. */

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const baseName = p => p.split('/').pop();

function fmtLeft(ms) {
  if (ms <= 0) return 'now';
  const minutes = ms / 6e4, hours = minutes / 60;
  if (minutes < 60) return plural(Math.max(1, Math.round(minutes)), 'minute');
  if (hours < 24) return plural(Math.round(hours), 'hour');
  return plural(Math.round(hours / 24), 'day');
}
function fmtAgo(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return Math.round(s) + ' seconds ago';
  if (s < 3600) return plural(Math.round(s / 60), 'minute') + ' ago';
  if (s < 86400) return plural(Math.round(s / 3600), 'hour') + ' ago';
  return plural(Math.round(s / 86400), 'day') + ' ago';
}

const ICONS = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  viewLarge: '<rect x="5" y="4" width="14" height="16" rx="3"/>',
  viewSmall: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  viewList: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  sortUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  sortDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
};
const icon = (name, size) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + (size ? ' width="' + size + '" height="' + size + '"' : '') + '>' + ICONS[name] + '</svg>';

function kind(f) {
  const t = f.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('text/')) return 'text';
  return 'other';
}

// URLs for one transfer. ?thumb=1 is not counted as a preview; ?dl=1 is a download.
const urls = tr => ({
  thumb: i => '/d/' + tr.id + '/f/' + i + '?thumb=1',
  view: i => '/d/' + tr.id + '/f/' + i,
  download: i => '/d/' + tr.id + '/f/' + i + '?dl=1',
  zip: idxs => '/d/' + tr.id + '/zip' + (idxs && idxs.length ? '?files=' + idxs.join(',') : ''),
});
// One file downloads as itself; several come as a zip.
function downloadUrl(tr, idxs) {
  const u = urls(tr), chosen = idxs && idxs.length ? idxs : tr.files.map((_, i) => i);
  return chosen.length === 1 ? u.download(chosen[0]) : u.zip(idxs);
}

function fileIcon(f) {
  const box = document.createElement('div'); box.className = 'ficon';
  box.innerHTML = icon(kind(f) === 'audio' ? 'music' : 'file');
  const label = document.createElement('b');
  label.textContent = baseName(f.name).includes('.') ? baseName(f.name).split('.').pop().slice(0, 4).toUpperCase() : '';
  box.append(label);
  return box;
}

function thumbEl(tr, i) {
  const f = tr.files[i], k = kind(f), u = urls(tr);
  const box = document.createElement('div'); box.className = 'thumb';
  const fallback = () => box.replaceChildren(fileIcon(f));
  if (k === 'image') {
    const img = new Image(); img.loading = 'lazy'; img.alt = ''; img.src = u.thumb(i); img.onerror = fallback;
    box.append(img);
  } else if (k === 'video') {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = u.thumb(i) + '#t=0.1'; v.onerror = fallback;
    const badge = document.createElement('div'); badge.className = 'playbadge'; badge.innerHTML = '<i>' + icon('play', 22) + '</i>';
    box.append(v, badge);
  } else {
    box.append(fileIcon(f));
  }
  return box;
}

/* Fill `container` with one card per file in opt.order.
   opt: {mode: 'large'|'small'|'list', order: [indexes], onOpen(i), selectable, selected: Set, onSelect(), downloadable} */
function renderGrid(container, tr, opt) {
  const u = urls(tr);
  container.className = 'grid ' + opt.mode;
  container.replaceChildren(...opt.order.map(i => {
    const f = tr.files[i];
    const card = document.createElement('div'); card.className = 'file'; card.tabIndex = 0;
    card.onclick = () => opt.onOpen(i);
    card.onkeydown = e => { if (e.key === 'Enter') opt.onOpen(i); };
    if (opt.selectable) {
      const c = document.createElement('span'); c.className = 'check'; c.setAttribute('role', 'checkbox'); c.tabIndex = 0;
      c.setAttribute('aria-checked', opt.selected.has(i)); c.innerHTML = icon('check');
      const toggle = e => {
        e.stopPropagation(); e.preventDefault();
        opt.selected.has(i) ? opt.selected.delete(i) : opt.selected.add(i);
        c.setAttribute('aria-checked', opt.selected.has(i)); opt.onSelect();
      };
      c.onclick = toggle; c.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') toggle(e); };
      card.append(c);
    }
    const info = document.createElement('div'); info.className = 'info';
    const text = document.createElement('div'); text.className = 'text';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = baseName(f.name); name.title = f.name;
    const size = document.createElement('span'); size.className = 'size'; size.textContent = fmt(f.size);
    text.append(name, size); info.append(text);
    if (opt.downloadable) {
      const dl = document.createElement('a'); dl.className = 'icon'; dl.title = 'Download'; dl.innerHTML = icon('download');
      dl.href = u.download(i); dl.setAttribute('download', baseName(f.name)); dl.onclick = e => e.stopPropagation();
      info.append(dl);
    }
    card.append(thumbEl(tr, i), info);
    return card;
  }));
}

/* Full-screen preview with previous/next, keyboard and swipe support. */
const Viewer = (() => {
  const root = document.createElement('div');
  root.className = 'viewer'; root.hidden = true;
  root.innerHTML = '<div class="vbar"><div class="vtitle"></div><span class="vcount"></span>'
    + '<a class="icon" id="vdl" title="Download">' + icon('download') + '</a>'
    + '<button class="icon" id="vclose" type="button" title="Close">' + icon('close') + '</button></div>'
    + '<div class="vstage"></div>'
    + '<button class="icon vnav prev" type="button" title="Previous">' + icon('prev') + '</button>'
    + '<button class="icon vnav next" type="button" title="Next">' + icon('next') + '</button>';
  document.body.append(root);
  const stage = root.querySelector('.vstage'), prev = root.querySelector('.prev'), next = root.querySelector('.next');
  let tr = null, order = [], pos = 0, token = 0, touchX = null;

  async function show() {
    const i = order[pos], f = tr.files[i], u = urls(tr), k = kind(f), mine = ++token;
    root.querySelector('.vtitle').textContent = f.name;
    root.querySelector('.vcount').textContent = order.length > 1 ? (pos + 1) + ' / ' + order.length : '';
    const dl = $('vdl'); dl.href = u.download(i); dl.setAttribute('download', baseName(f.name));
    prev.hidden = next.hidden = order.length < 2;
    stage.replaceChildren();
    const unsupported = () => {
      const m = document.createElement('div'); m.className = 'vmsg';
      const a = document.createElement('a'); a.className = 'btn primary'; a.textContent = 'Download'; a.href = u.download(i);
      const p = document.createElement('div'); p.textContent = 'No preview available for this file';
      m.append(fileIcon(f), p, a); stage.replaceChildren(m);
    };
    if (k === 'image') {
      const img = new Image(); img.alt = f.name; img.src = u.view(i); img.onerror = unsupported; stage.append(img);
    } else if (k === 'video') {
      const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = u.view(i); v.onerror = unsupported;
      stage.append(v); v.play().catch(() => {});
    } else if (k === 'audio') {
      const wrap = document.createElement('div'); wrap.className = 'vmsg';
      const a = document.createElement('audio'); a.controls = true; a.src = u.view(i); a.onerror = unsupported;
      wrap.append(fileIcon(f), a); stage.append(wrap);
    } else if (k === 'pdf') {
      const fr = document.createElement('iframe'); fr.src = u.view(i); fr.title = f.name; stage.append(fr);
    } else if (k === 'text') {
      try {
        const r = await fetch(u.view(i), { headers: { Range: 'bytes=0-200000' } });
        const text = await r.text();
        if (mine !== token) return;
        const pre = document.createElement('pre'); pre.textContent = text + (f.size > 200001 ? '\n\n… (preview truncated)' : '');
        stage.replaceChildren(pre);
      } catch { if (mine === token) unsupported(); }
    } else {
      unsupported();
    }
  }
  const step = d => { if (order.length > 1) { pos = (pos + d + order.length) % order.length; show(); } };
  function close() { root.hidden = true; stage.replaceChildren(); token++; document.body.style.overflow = ''; }
  function open(transfer, indexes, startIndex) {
    tr = transfer; order = indexes; pos = Math.max(0, indexes.indexOf(startIndex));
    root.hidden = false; document.body.style.overflow = 'hidden'; show();
  }
  $('vclose').onclick = close;
  prev.onclick = () => step(-1); next.onclick = () => step(1);
  root.addEventListener('click', e => { if (e.target === stage || e.target === root) close(); });
  document.addEventListener('keydown', e => {
    if (root.hidden) return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
  });
  root.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  root.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) > 70) step(dx < 0 ? 1 : -1);
  });
  return { open, close };
})();
