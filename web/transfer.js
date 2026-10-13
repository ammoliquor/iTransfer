'use strict';
/* Receiving end: title, expiry, Open/Download, and a sortable, selectable file gallery. */

const tr = JSON.parse($('data').textContent);
const selected = new Set();
let mode = 'large', sortKey = 'name', sortAsc = true;

$('title').textContent = tr.title || 'Untitled transfer';
const left = fmtLeft(tr.expires_at * 1000 - Date.now());
$('meta').innerHTML = '<span>expires in <b></b></span><span>contains <b></b></span><span><b></b></span>';
const bolds = $('meta').querySelectorAll('b');
bolds[0].textContent = left;
bolds[1].textContent = plural(tr.files.length, 'file');
bolds[2].textContent = fmt(tr.size);

$('sortdir').innerHTML = icon('sortUp');
document.querySelectorAll('#modes .icon').forEach(b => {
  b.innerHTML = icon({ large: 'viewLarge', small: 'viewSmall', list: 'viewList' }[b.dataset.mode]);
});

function order() {
  const cmp = {
    name: (a, b) => tr.files[a].name.localeCompare(tr.files[b].name, undefined, { numeric: true }),
    size: (a, b) => tr.files[a].size - tr.files[b].size,
    type: (a, b) => (tr.files[a].type || '').localeCompare(tr.files[b].type || '') || cmp.name(a, b),
  }[sortKey];
  const idx = tr.files.map((_, i) => i).sort(cmp);
  return sortAsc ? idx : idx.reverse();
}

function updateButtons() {
  const n = selected.size;
  const first = n ? [...selected].sort((a, b) => a - b)[0] : order()[0];
  $('open').innerHTML = icon('eye') + '<span>' + (n > 1 ? 'Open ' + n + ' selected' : 'Open') + '</span>';
  $('open').onclick = () => Viewer.open(tr, n > 1 ? order().filter(i => selected.has(i)) : order(), first);
  const chosen = [...selected].sort((a, b) => a - b);
  const label = n ? 'Download ' + n + ' selected' : (tr.files.length > 1 ? 'Download all' : 'Download');
  $('download').innerHTML = icon('download') + '<span>' + label + '</span>';
  $('download').href = downloadUrl(tr, chosen);
}

function render() {
  renderGrid($('grid'), tr, {
    mode, order: order(), selectable: true, selected, downloadable: true,
    onSelect: updateButtons,
    onOpen: i => Viewer.open(tr, order(), i),
  });
  updateButtons();
}

$('sortkey').onchange = e => { sortKey = e.target.value; render(); };
$('sortdir').onclick = () => { sortAsc = !sortAsc; $('sortdir').innerHTML = icon(sortAsc ? 'sortUp' : 'sortDown'); render(); };
document.querySelectorAll('#modes .icon').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll('#modes .icon').forEach(x => x.setAttribute('aria-pressed', x === b));
  render();
});
render();
