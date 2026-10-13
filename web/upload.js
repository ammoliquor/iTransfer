'use strict';
/* Upload page: pick files/folders, upload in small retried chunks, then show the finished card
   and a details panel. Shared helpers (icons, thumbnails, the viewer) come from viewer.js. */

const PARALLEL = 3, RETRIES = 6;

// ---------------------------------------------------------------- choosing files

// Each group is one loose file or one whole folder: {label, folder, size, entries: [{file, path}]}.
let groups = [];

function render() {
  $('list').replaceChildren(...groups.map((g, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = g.folder ? g.label + '/ (' + plural(g.entries.length, 'file') + ')' : g.label;
    const right = document.createElement('span'); right.textContent = fmt(g.size) + ' ';
    const x = document.createElement('a'); x.textContent = '×'; x.title = 'Remove';
    x.onclick = () => { groups.splice(i, 1); render(); };
    right.append(x); li.append(name, right);
    return li;
  }));
  $('go').disabled = !groups.length;
}

const sizeOf = entries => entries.reduce((s, e) => s + e.file.size, 0);
const addGroup = (label, folder, entries) => groups.push({ label, folder, size: sizeOf(entries), entries });
const addFiles = list => { for (const f of list) addGroup(f.name, false, [{ file: f, path: f.name }]); render(); };

// Folder chosen through the picker: files carry webkitRelativePath ("folder/sub/a.txt").
function addPickedFolder(list) {
  const byTop = new Map();
  for (const f of list) {
    const path = f.webkitRelativePath || f.name, top = path.split('/')[0];
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push({ file: f, path });
  }
  for (const [label, entries] of byTop) addGroup(label, true, entries);
  render();
}

// Folder dropped onto the page: walk it with the FileSystem entry API.
const readAll = reader => new Promise((resolve, reject) => {
  const all = [];
  const next = () => reader.readEntries(batch => batch.length ? (all.push(...batch), next()) : resolve(all), reject);
  next();
});
async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry.createReader())) await walk(child, out);
  }
}

function showError(text) {
  const s = document.createElement('span'); s.className = 'err'; s.textContent = text;
  $('msg').replaceChildren(s);
}

$('drop').onclick = () => $('file').click();
$('drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
$('pickfolder').onclick = () => $('dir').click();
$('file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('dir').onchange = e => { addPickedFolder(e.target.files); e.target.value = ''; };
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = async e => {
  e.preventDefault(); $('drop').classList.remove('over');
  // Entries must be grabbed synchronously; the event's items are invalid after the first await.
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return addFiles(e.dataTransfer.files);
  $('msg').textContent = 'Reading…';
  try {
    for (const entry of entries) {
      const found = []; await walk(entry, found);
      if (found.length) addGroup(entry.name, entry.isDirectory, found);
      else if (entry.isDirectory) return showError(entry.name + ' has no files in it');
    }
    $('msg').textContent = '';
  } catch (err) { showError('Could not read that folder'); }
  render();
};

// ---------------------------------------------------------------- talking to the server

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const api = (method, url, body, onProgress) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);
  if (body && !(body instanceof Blob)) { xhr.setRequestHeader('Content-Type', 'application/json'); body = JSON.stringify(body); }
  if (onProgress) xhr.upload.onprogress = e => onProgress(e.loaded);
  xhr.onload = () => {
    let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
    const detail = typeof data.detail === 'string' ? data.detail : '';
    xhr.status === 200 ? resolve(data) : reject(new HttpError(xhr.status, detail || 'Request failed (' + xhr.status + ')'));
  };
  xhr.onerror = () => reject(new HttpError(0, 'Network error'));
  xhr.send(body);
});

// Retry transient failures (network, timeouts, 5xx) but not real errors like 403/413.
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const transient = e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
      if (!transient || attempt >= RETRIES) throw e;
      await sleep(Math.min(1000 * attempt, 5000));
    }
  }
}

async function copyText(text, button, doneLabel) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  const before = button.innerHTML; button.textContent = doneLabel;
  setTimeout(() => { button.innerHTML = before; }, 1600);
}

// ---------------------------------------------------------------- uploading

let current = null;  // {id, link, details} of the transfer that was just sent

$('go').onclick = async () => {
  const all = groups.flatMap(g => g.entries);
  const total = all.reduce((sum, e) => sum + e.file.size, 0);
  if (total > MAXBYTES) return showError('Total size is over the ' + MAXTEXT + ' limit');
  $('go').disabled = true; $('msg').textContent = ''; $('bar').hidden = false; $('bar').value = 0;
  try {
    const cfg = await api('GET', '/api/config');
    const { id } = await api('POST', '/api/transfers?days=' + $('days').value + '&title=' + encodeURIComponent($('title').value));

    // Register every file, then slice them all into chunks and upload a few at a time.
    if (all.length > 50) $('msg').textContent = 'Preparing ' + all.length + ' files…';
    const tasks = [];
    for (const { file, path } of all) {
      const { index } = await api('POST', '/api/transfers/' + id + '/files', { name: path, size: file.size });
      for (let n = 0, off = 0; off < file.size; n++, off += cfg.chunk_size)
        tasks.push({ index, n, blob: file.slice(off, Math.min(off + cfg.chunk_size, file.size)), loaded: 0 });
    }
    $('msg').textContent = '';
    let sent = 0;  // running total, so progress stays cheap with thousands of chunks
    const setLoaded = (t, value) => { sent += value - t.loaded; t.loaded = value; $('bar').value = total ? sent / total * 100 : 100; };
    let next = 0, failure = null;
    const worker = async () => {
      while (!failure && next < tasks.length) {
        const t = tasks[next++];
        try {
          await withRetry(() => api('PUT', '/api/transfers/' + id + '/files/' + t.index + '/chunks/' + t.n, t.blob,
            loaded => setLoaded(t, loaded)));
          setLoaded(t, t.blob.size);
        } catch (e) { failure = failure || e; }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (failure) throw failure;

    $('msg').textContent = 'Finishing…';
    const { path } = await withRetry(() => api('POST', '/api/transfers/' + id + '/finish'));
    const details = await api('GET', '/api/transfers/' + id + '/details');
    current = { id, details, link: (cfg.public_url || location.origin) + path };
    groups = []; render();
    showDone();
  } catch (e) {
    showError(e.message);
  } finally {
    $('go').disabled = !groups.length;
  }
};

// ---------------------------------------------------------------- finished card

const allIndexes = () => current.details.files.map((_, i) => i);
const preview = (start = 0) => Viewer.open(current.details, allIndexes(), start);

function showDone() {
  const d = current.details;
  $('form').hidden = true; $('done').hidden = false;
  // Hero thumbnail: the first file that can be shown as a picture, else the first file.
  const heroIndex = Math.max(0, d.files.findIndex(f => ['image', 'video'].includes(kind(f))));
  const old = $('doneThumb').querySelector('.thumb'); if (old) old.remove();
  $('doneThumb').prepend(thumbEl(d, heroIndex));
  $('doneView').innerHTML = icon('eye') + 'View';
  $('doneView2').innerHTML = icon('eye') + 'View';
  $('doneCopyInline').innerHTML = icon('link') + 'Copy';
  $('doneLink').value = current.link;
  $('doneLink').select();
}

$('doneView').onclick = $('doneView2').onclick = () => preview(0);
$('doneCopy').onclick = () => copyText(current.link, $('doneCopy'), 'Copied');
$('doneCopyInline').onclick = () => copyText(current.link, $('doneCopyInline'), 'Copied');
$('another').onclick = () => {
  $('done').hidden = true; $('form').hidden = false; $('bar').hidden = true; $('msg').textContent = ''; $('title').value = '';
};

// ---------------------------------------------------------------- details panel

let statsTimer = null;

function fillSheet(d) {
  $('sTitle').textContent = d.title || 'Untitled transfer';
  $('sMeta').textContent = plural(d.files.length, 'file') + ' · ' + fmt(d.size) + ' · Sent ' + fmtAgo(Date.now() - d.created_at * 1000);
  $('sLink').value = current.link;
  $('sExpires').textContent = new Date(d.expires_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $('sDownloads').textContent = d.downloads;
  $('sPreviews').textContent = d.previews;
}

async function openSheet() {
  current.details = await api('GET', '/api/transfers/' + current.id + '/details');
  const d = current.details;
  fillSheet(d);
  $('sDownload').innerHTML = icon('download') + 'Download';
  $('sDownload').href = downloadUrl(d);
  $('sPreview').innerHTML = icon('eye') + 'Preview';
  $('sCopy').innerHTML = icon('link') + 'Copy';
  renderGrid($('sGrid'), d, { mode: d.files.length > 6 ? 'small' : 'large', order: allIndexes(), onOpen: i => preview(i) });
  $('scrim').classList.add('show'); $('sheet').classList.add('open'); $('sheet').setAttribute('aria-hidden', 'false');
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {  // keep the counters live while the panel is open
    try { current.details = await api('GET', '/api/transfers/' + current.id + '/details'); fillSheet(current.details); } catch {}
  }, 4000);
}
function closeSheet() {
  clearInterval(statsTimer);
  $('scrim').classList.remove('show'); $('sheet').classList.remove('open'); $('sheet').setAttribute('aria-hidden', 'true');
}

$('closeIcon').innerHTML = icon('close');
$('openDetails').onclick = openSheet;
$('closeSheet').onclick = closeSheet;
$('scrim').onclick = closeSheet;
$('sCopy').onclick = () => copyText(current.link, $('sCopy'), 'Copied');
$('sPreview').onclick = () => preview(0);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('sheet').classList.contains('open') && $('scrim').classList.contains('show')) closeSheet(); });
