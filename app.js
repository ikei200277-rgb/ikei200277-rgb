'use strict';
/* ========== 基本ヘルパー ========== */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const INBOX = 'inbox';
function fmtDate(t) { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', 2400); }
function busy(msg) { const b = $('busy'); if (msg) { b.textContent = msg; b.classList.add('on'); } else b.classList.remove('on'); }
function show(id) { KB.hide(); document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id)); }

/* ========== IndexedDB ========== */
const DB_NAME = 'memo-pwa', DB_VER = 2;
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const d = r.result, t = r.transaction;
      ['memos', 'media', 'folders', 'settings'].forEach(n => {
        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: n === 'settings' ? 'key' : 'id' });
      });
      if (e.oldVersion > 0 && e.oldVersion < 2) {
        t.objectStore('memos').openCursor().onsuccess = ev => {
          const c = ev.target.result; if (!c) return;
          const v = c.value;
          if (!v.folderId) { v.folderId = INBOX; v.rating = v.rating ?? null; v.done = !!v.done; c.update(v); }
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
const p = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const getAll = s => p(store(s).getAll());
const getOne = (s, k) => p(store(s).get(k));
const putOne = (s, v) => p(store(s, 'readwrite').put(v));
const delOne = (s, k) => p(store(s, 'readwrite').delete(k));

/* ========== 状態 ========== */
let folders = [], memos = [];
let nav = { folderId: null };
let activeTag = null, onlyUndone = false;
let cur = null;
let settings = { kbEnabled: true };
let renderToken = 0;

const fById = id => folders.find(f => f.id === id);
const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
const childrenOf = pid => folders.filter(f => (f.parentId || null) === pid).sort(byName);
function pathNames(id) {
  const a = []; let f = fById(id), g = 0;
  while (f && g++ < 100) { a.unshift(f.name); f = f.parentId ? fById(f.parentId) : null; }
  return a;
}
function descendantIds(id) {
  const out = new Set([id]); let ch = true;
  while (ch) { ch = false; for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); ch = true; } }
  return out;
}
const memoCount = id => { const ds = descendantIds(id); return memos.filter(m => ds.has(m.folderId)).length; };

async function loadData() {
  folders = await getAll('folders');
  if (!folders.find(f => f.id === INBOX)) {
    const f = { id: INBOX, name: '未分類', parentId: null, created: Date.now(), updated: Date.now() };
    await putOne('folders', f); folders.push(f);
  }
  memos = await getAll('memos');
  memos.forEach(m => { if (!fById(m.folderId)) m.folderId = INBOX; });
  memos.sort((a, b) => b.updated - a.updated);
}
const allTags = () => {
  const c = new Map();
  memos.forEach(m => m.tags.forEach(t => c.set(t, (c.get(t) || 0) + 1)));
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(e => e[0]);
};
const normTag = s => s.replace(/^[#＃\s]+/, '').replace(/[\s#＃]+/g, '').trim();

/* ========== 画像・動画URL ========== */
const thumbCache = new Map(), fullCache = new Map();
async function thumbURL(id) {
  if (thumbCache.has(id)) return thumbCache.get(id);
  const m = await getOne('media', id); if (!m) return null;
  const b = m.thumb || (m.type.startsWith('image') ? m.blob : null);
  const u = b ? URL.createObjectURL(b) : null;
  thumbCache.set(id, u); return u;
}
async function fullURL(id) {
  if (fullCache.has(id)) return fullCache.get(id);
  const m = await getOne('media', id); if (!m) return null;
  const u = URL.createObjectURL(m.blob); fullCache.set(id, u); return u;
}
function dropURLs(ids) {
  ids.forEach(id => {
    [thumbCache, fullCache].forEach(c => { const u = c.get(id); if (u) URL.revokeObjectURL(u); c.delete(id); });
  });
}
async function makeThumb(file, isVideo) {
  const url = URL.createObjectURL(file);
  try {
    let src, w, h;
    if (isVideo) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 8000); });
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); await new Promise(res => { v.onseeked = res; setTimeout(res, 2000); }); } catch { }
      src = v; w = v.videoWidth; h = v.videoHeight;
    } else {
      const img = new Image(); img.src = url; await img.decode();
      src = img; w = img.naturalWidth; h = img.naturalHeight;
    }
    if (!w || !h) return null;
    const S = 240, c = document.createElement('canvas'); c.width = c.height = S;
    const m = Math.min(w, h), sx = (w - m) / 2, sy = (h - m) / 2;
    c.getContext('2d').drawImage(src, sx, sy, m, m, 0, 0, S, S);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  } catch { return null; }
  finally { URL.revokeObjectURL(url); }
}

/* ========== 星表示 ========== */
const starsHTML = v => `<span class="stars" style="--v:${v / 5 * 100}%">★★★★★</span>`;

/* ========== ホーム ========== */
function matches(m, q) {
  if (onlyUndone && m.done) return false;
  if (activeTag && !m.tags.includes(activeTag)) return false;
  if (!q) return true;
  return q.split(/[\s　]+/).filter(Boolean).every(w => {
    if (/^[#＃]/.test(w)) { const k = normTag(w).toLowerCase(); return !k || m.tags.some(t => t.toLowerCase().includes(k)); }
    const k = w.toLowerCase();
    return (m.title + '\n' + m.body + '\n' + m.tags.join(' ')).toLowerCase().includes(k);
  });
}
function renderChips() {
  const box = $('chips'); box.innerHTML = '';
  const u = document.createElement('button');
  u.className = 'chip' + (onlyUndone ? ' on' : ''); u.textContent = '☐ 未完了のみ';
  u.onclick = () => { onlyUndone = !onlyUndone; renderHome(); };
  box.appendChild(u);
  allTags().forEach(t => {
    const b = document.createElement('button');
    b.className = 'chip' + (activeTag === t ? ' on' : ''); b.textContent = '#' + t;
    b.onclick = () => { activeTag = activeTag === t ? null : t; renderHome(); };
    box.appendChild(b);
  });
}
function renderCrumb() {
  const box = $('crumb'); box.innerHTML = '';
  if (nav.folderId === null) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const chain = []; let f = fById(nav.folderId), g = 0;
  while (f && g++ < 100) { chain.unshift(f); f = f.parentId ? fById(f.parentId) : null; }
  const mkBtn = (label, id, cur) => {
    const b = document.createElement('button'); b.textContent = label; if (cur) b.className = 'cur';
    b.onclick = () => { nav.folderId = id; clearSearch(); renderHome(); }; return b;
  };
  box.appendChild(mkBtn('ホーム', null, false));
  chain.forEach((c, i) => { const s = document.createElement('span'); s.textContent = '›'; box.appendChild(s); box.appendChild(mkBtn(c.name, c.id, i === chain.length - 1)); });
}
function cardHTML(m, showPath) {
  const media = m.media.slice(0, 3);
  const thumbs = media.length
    ? `<div class="thr">${media.map(x => `<div class="th${x.type.startsWith('video') ? ' v' : ''}" data-tid="${x.id}"></div>`).join('')}${m.media.length > 3 ? `<div class="more">+${m.media.length - 3}</div>` : ''}</div>` : '';
  const rating = m.rating != null ? `${starsHTML(m.rating)}<span class="rate-num">${m.rating.toFixed(1)}</span>` : '';
  const title = m.title || m.body.split('\n')[0] || '(無題)';
  return `<div class="card${m.done ? ' done' : ''}" data-memo="${m.id}">
    <div class="top"><div class="t">${esc(title)}</div>${m.done ? '<span class="badge-done">✓ 完了</span>' : ''}</div>
    ${m.body ? `<div class="b">${esc(m.body)}</div>` : ''}
    ${(rating || m.tags.length) ? `<div class="meta">${rating}<span class="tags">${m.tags.map(t => `<span>#${esc(t)}</span>`).join('')}</span></div>` : ''}
    ${thumbs}
    <div class="meta">${showPath ? `<span class="path">📁 ${esc(pathNames(m.folderId).join(' › '))}</span>` : ''}<span class="d">${fmtDate(m.updated)}</span></div>
  </div>`;
}
async function renderHome() {
  const token = ++renderToken;
  const q = $('q').value.trim();
  const searching = !!(q || activeTag);
  const inFolder = nav.folderId !== null;
  $('homeBack').hidden = !inFolder;
  $('homeTitle').textContent = inFolder ? (fById(nav.folderId) ? fById(nav.folderId).name : '') : 'メモ帳';
  $('homeMenu').textContent = inFolder ? '⋯' : '⚙';
  $('qClr').hidden = !q;
  renderCrumb(); renderChips();
  let html = '';
  if (searching) {
    const res = memos.filter(m => matches(m, q));
    html += `<div class="lab">検索結果 ${res.length}件（全フォルダ）</div>`;
    html += res.length ? res.map(m => cardHTML(m, true)).join('') : '<div class="empty">該当するメモがありません</div>';
  } else {
    const subs = childrenOf(nav.folderId);
    if (subs.length) {
      html += '<div class="lab">フォルダ</div>';
      html += subs.map(f => `<div class="folder" data-fid="${f.id}"><span class="ic">📁</span><span class="n">${esc(f.name)}</span><span class="c">${memoCount(f.id)} ›</span></div>`).join('');
    }
    if (inFolder) {
      const ms = memos.filter(m => m.folderId === nav.folderId && matches(m, ''));
      if (ms.length) { html += '<div class="lab">メモ</div>' + ms.map(m => cardHTML(m, false)).join(''); }
      if (!subs.length && !ms.length) html += '<div class="empty">このフォルダは空です<br>右下の ＋ からメモやフォルダを作れます</div>';
    } else if (!subs.length) html += '<div class="empty">フォルダがありません<br>右下の ＋ から作成できます</div>';
  }
  if (token !== renderToken) return;
  $('list').innerHTML = html;
  $('list').querySelectorAll('[data-tid]').forEach(el => {
    thumbURL(el.dataset.tid).then(u => { if (u) el.innerHTML = `<img src="${u}" alt="">`; });
  });
}
function clearSearch() { $('q').value = ''; activeTag = null; }

/* --- 一覧の操作（タップ・長押し） --- */
let lp = null, lpFired = false;
const listEl = $('list');
listEl.addEventListener('pointerdown', e => {
  const t = e.target.closest('[data-fid],[data-memo]'); if (!t) return;
  lpFired = false;
  lp = { sx: e.clientX, sy: e.clientY, timer: setTimeout(() => { lpFired = true; itemMenu(t); }, 520) };
});
['pointerup', 'pointercancel'].forEach(ev => listEl.addEventListener(ev, () => { if (lp) clearTimeout(lp.timer); }));
listEl.addEventListener('pointermove', e => { if (lp && Math.hypot(e.clientX - lp.sx, e.clientY - lp.sy) > 10) clearTimeout(lp.timer); });
listEl.addEventListener('contextmenu', e => e.preventDefault());
listEl.addEventListener('click', e => {
  if (lpFired) { lpFired = false; return; }
  const f = e.target.closest('[data-fid]');
  if (f) { nav.folderId = f.dataset.fid; clearSearch(); renderHome(); listEl.scrollTop = 0; return; }
  const m = e.target.closest('[data-memo]');
  if (m) openEditor(m.dataset.memo);
});

function sheet(title, items) {
  const box = $('sheetIn'); box.innerHTML = title ? `<h5>${esc(title)}</h5>` : '';
  items.forEach(it => {
    const b = document.createElement('button'); b.textContent = it.label; if (it.danger) b.className = 'dg';
    b.onclick = () => { $('sheet').classList.remove('on'); if (it.fn) it.fn(); };
    box.appendChild(b);
  });
  const c = document.createElement('button'); c.textContent = '閉じる'; c.onclick = () => $('sheet').classList.remove('on'); box.appendChild(c);
  $('sheet').classList.add('on');
}
$('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('sheet').classList.remove('on'); });

function itemMenu(el) {
  if (el.dataset.fid) {
    const id = el.dataset.fid, f = fById(id);
    sheet('📁 ' + f.name, [
      { label: '名前を変更', fn: () => renameFolder(id) },
      { label: '別のフォルダへ移動', fn: () => moveFolder(id) },
      ...(id === INBOX ? [] : [{ label: '削除', danger: true, fn: () => deleteFolder(id) }])
    ]);
  } else {
    const id = el.dataset.memo, m = memos.find(x => x.id === id);
    sheet('📝 ' + (m.title || m.body.split('\n')[0] || '(無題)'), [
      { label: '開く', fn: () => openEditor(id) },
      { label: m.done ? '未完了に戻す' : '完了にする', fn: async () => { m.done = !m.done; m.updated = Date.now(); await putOne('memos', m); await loadData(); renderHome(); } },
      { label: '別のフォルダへ移動', fn: () => moveMemo(id) },
      { label: '削除', danger: true, fn: () => deleteMemo(id) }
    ]);
  }
}

/* --- テキスト入力ダイアログ --- */
let askDone = null;
function askText(title, initial = '') {
  return new Promise(res => {
    $('askTitle').textContent = title;
    const inp = $('askInput'); inp.value = initial;
    $('askModal').classList.add('on'); KB.applyEnabled();
    askDone = v => { askDone = null; $('askModal').classList.remove('on'); KB.hide(); res(v); };
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}
$('askOk').onclick = () => askDone && askDone($('askInput').value.trim() || null);
$('askCancel').onclick = () => askDone && askDone(null);
$('askInput').addEventListener('kbenter', e => { e.preventDefault(); askDone && askDone($('askInput').value.trim() || null); });
$('askInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); askDone && askDone($('askInput').value.trim() || null); } });

/* --- フォルダ選択ダイアログ --- */
let pickState = null;
function pickFolder({ title = '保存先を選ぶ', exclude = new Set(), allowRoot = false, current }) {
  return new Promise(res => {
    pickState = { sel: current === undefined ? '__none__' : current, exclude, allowRoot, res };
    $('pickTitle').textContent = title;
    renderPicker(); $('picker').classList.add('on');
  });
}
function renderPicker() {
  const st = pickState, box = $('pickList'); box.innerHTML = '';
  const row = (id, label, depth, dis) => {
    const d = document.createElement('div');
    d.className = 'it' + (st.sel === id ? ' sel' : '') + (dis ? ' dis' : '');
    d.style.paddingLeft = (8 + depth * 18) + 'px';
    d.textContent = label; d.onclick = () => { st.sel = id; renderPicker(); };
    box.appendChild(d);
  };
  if (st.allowRoot) row(null, '🏠 ホーム（最上位）', 0, false);
  const walk = (pid, depth) => childrenOf(pid).forEach(f => { row(f.id, '📁 ' + f.name, depth + (st.allowRoot ? 1 : 0), st.exclude.has(f.id)); walk(f.id, depth + 1); });
  walk(null, 0);
}
function closePicker(v) { const st = pickState; pickState = null; $('picker').classList.remove('on'); KB.hide(); st.res(v); }
$('pickCancel').onclick = () => closePicker(undefined);
$('pickOk').onclick = () => { if (pickState.sel === '__none__') { toast('フォルダを選んでください'); return; } closePicker({ id: pickState.sel }); };
$('pickNew').onclick = async () => {
  const parent = (pickState.sel === '__none__' || pickState.sel === null) ? null : pickState.sel;
  const name = await askText(parent ? `「${fById(parent).name}」の中に新しいフォルダ` : '新しいフォルダ名');
  if (!name) return;
  const f = await createFolder(name, parent);
  pickState.sel = f.id; renderPicker();
};

/* --- フォルダ・メモ操作 --- */
async function createFolder(name, parentId) {
  const f = { id: uid(), name, parentId: parentId || null, created: Date.now(), updated: Date.now() };
  await putOne('folders', f); folders.push(f); return f;
}
async function renameFolder(id) {
  const f = fById(id); const name = await askText('フォルダ名を変更', f.name);
  if (!name) return; f.name = name; f.updated = Date.now(); await putOne('folders', f); renderHome();
}
async function moveFolder(id) {
  const r = await pickFolder({ title: '移動先のフォルダ', exclude: descendantIds(id), allowRoot: true, current: fById(id).parentId || null });
  if (!r) return; const f = fById(id); f.parentId = r.id; f.updated = Date.now(); await putOne('folders', f); renderHome(); toast('移動しました');
}
async function deleteFolder(id) {
  const ds = descendantIds(id), n = memos.filter(m => ds.has(m.folderId)).length;
  if (!confirm(`フォルダ「${fById(id).name}」を削除します。\n中のサブフォルダ ${ds.size - 1} 個とメモ ${n} 件、添付の画像・動画もすべて削除されます。よろしいですか？`)) return;
  busy('削除中…');
  for (const m of memos.filter(m => ds.has(m.folderId))) await removeMemoData(m);
  for (const fid of ds) await delOne('folders', fid);
  if (ds.has(nav.folderId)) nav.folderId = fById(id).parentId || null;
  await loadData(); busy(null); renderHome(); toast('削除しました');
}
async function removeMemoData(m) {
  for (const x of m.media) await delOne('media', x.id);
  dropURLs(m.media.map(x => x.id));
  await delOne('memos', m.id);
}
async function moveMemo(id) {
  const m = memos.find(x => x.id === id);
  const r = await pickFolder({ title: '移動先のフォルダ', allowRoot: false, current: m.folderId });
  if (!r) return; m.folderId = r.id; m.updated = Date.now(); await putOne('memos', m); await loadData(); renderHome(); toast('移動しました');
}
async function deleteMemo(id) {
  const m = memos.find(x => x.id === id);
  if (!confirm('このメモと添付ファイルを削除しますか？')) return;
  await removeMemoData(m); await loadData(); renderHome(); toast('削除しました');
}

/* --- ホームのボタン --- */
$('homeBack').onclick = () => { const f = fById(nav.folderId); nav.folderId = f ? (f.parentId || null) : null; clearSearch(); renderHome(); };
$('homeMenu').onclick = () => {
  if (nav.folderId === null) { openSettings(); return; }
  const id = nav.folderId;
  sheet('📁 ' + fById(id).name, [
    { label: '名前を変更', fn: () => renameFolder(id) },
    { label: '別のフォルダへ移動', fn: () => moveFolder(id) },
    ...(id === INBOX ? [] : [{ label: '削除', danger: true, fn: () => deleteFolder(id) }]),
    { label: '設定・バックアップ', fn: openSettings }
  ]);
};
$('fab').onclick = e => { e.stopPropagation(); $('fabMenu').classList.toggle('on'); };
document.addEventListener('click', e => { if (!e.target.closest('#fabMenu') && e.target.id !== 'fab') $('fabMenu').classList.remove('on'); });
$('fabFolder').onclick = async () => {
  $('fabMenu').classList.remove('on');
  const name = await askText(nav.folderId ? `「${fById(nav.folderId).name}」の中に新しいフォルダ` : '新しいフォルダ名');
  if (!name) return; await createFolder(name, nav.folderId); renderHome();
};
$('fabMemo').onclick = async () => {
  $('fabMenu').classList.remove('on');
  let fid = nav.folderId;
  if (fid === null) {
    const r = await pickFolder({ title: '新規メモの保存先', allowRoot: false, current: INBOX });
    if (!r) return; fid = r.id;
  }
  openEditor(null, fid);
};
$('q').addEventListener('input', renderHome);
$('qClr').onclick = () => { $('q').value = ''; renderHome(); };

/* ========== 編集画面 ========== */
let saveTimer = null, dirty = false;
const setStatus = s => $('status').textContent = s;
function scheduleSave() { dirty = true; setStatus('編集中…'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
async function saveNow() {
  clearTimeout(saveTimer);
  if (!cur || !dirty) return;
  cur.title = $('title').value; cur.body = $('text').value; cur.updated = Date.now();
  const rec = { ...cur }; delete rec._new;
  await putOne('memos', rec); cur._saved = true; dirty = false; setStatus('保存済み');
}
async function openEditor(id, folderId) {
  if (id) cur = structuredClone(memos.find(m => m.id === id));
  else cur = { id: uid(), folderId: folderId || nav.folderId || INBOX, title: '', body: '', tags: [], media: [], rating: null, done: false, created: Date.now(), updated: Date.now(), _new: true };
  $('title').value = cur.title; $('text').value = cur.body;
  setStatus(cur._new ? '' : '保存済み'); dirty = false;
  renderTagBox(); renderRating(); renderDone(); renderLoc(); await renderMedia();
  show('editor'); autoGrow(); $('editor').querySelector('.body').scrollTop = 0;
  if (cur._new) setTimeout(() => $('title').focus(), 80);
}
async function closeEditor() {
  commitTagInput();
  await saveNow();
  cur = null; await loadData(); show('home'); await renderHome();
}
function autoGrow() { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.max(160, t.scrollHeight) + 'px'; }
$('title').addEventListener('input', scheduleSave);
$('text').addEventListener('input', () => { autoGrow(); scheduleSave(); });
$('title').addEventListener('kbenter', e => { e.preventDefault(); $('text').focus(); });
$('backBtn').onclick = closeEditor;
$('delBtn').onclick = async () => {
  if (!cur) return;
  if (!confirm('このメモと添付ファイルを削除しますか？')) return;
  clearTimeout(saveTimer); dirty = false;
  await removeMemoData(cur).catch(() => { });
  cur = null; await loadData(); show('home'); await renderHome(); toast('削除しました');
};

/* --- 完了 --- */
function renderDone() { const b = $('doneBtn'); b.classList.toggle('on', !!cur.done); b.textContent = cur.done ? '✓ 完了済み' : '✓ 完了にする'; }
$('doneBtn').onclick = () => { cur.done = !cur.done; renderDone(); scheduleSave(); toast(cur.done ? '完了にしました' : '未完了に戻しました'); };

/* --- 評価（0.1刻み） --- */
function renderRating() {
  const v = cur.rating;
  $('bigStars').style.setProperty('--v', (v ? v / 5 * 100 : 0) + '%');
  const n = $('rateNum');
  if (v == null) { n.textContent = '未評価'; n.className = 'num none'; } else { n.textContent = v.toFixed(1); n.className = 'num'; }
  $('rateRange').value = v || 0;
}
function setRating(v) {
  v = Math.round(Math.max(0, Math.min(5, v)) * 10) / 10;
  cur.rating = v; renderRating(); scheduleSave();
}
$('rateRange').addEventListener('input', e => setRating(parseFloat(e.target.value)));
$('rateMinus').onclick = () => setRating((cur.rating ?? 0) - 0.1);
$('ratePlus').onclick = () => setRating((cur.rating ?? 0) + 0.1);
$('rateClr').onclick = () => { cur.rating = null; renderRating(); scheduleSave(); };
(() => {
  const el = $('bigStars'); let drag = false;
  const at = e => { const r = el.getBoundingClientRect(); setRating(((e.clientX - r.left) / r.width) * 5); };
  el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); at(e); });
  el.addEventListener('pointermove', e => { if (drag) at(e); });
  ['pointerup', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => drag = false));
})();

/* --- 保存先 --- */
function renderLoc() { $('locText').innerHTML = '📁 <b>' + esc(pathNames(cur.folderId).join(' › ')) + '</b>'; }
$('locBtn').onclick = async () => {
  const r = await pickFolder({ title: '保存先を選ぶ', allowRoot: false, current: cur.folderId });
  if (!r) return; cur.folderId = r.id; renderLoc(); scheduleSave();
};

/* --- タグ --- */
function renderTagBox() {
  const box = $('tagBox');
  box.querySelectorAll('.chip').forEach(e => e.remove());
  cur.tags.forEach(t => {
    const c = document.createElement('span'); c.className = 'chip tag';
    c.innerHTML = `#${esc(t)}<span class="x">✕</span>`;
    c.onclick = () => { cur.tags = cur.tags.filter(x => x !== t); renderTagBox(); scheduleSave(); };
    box.insertBefore(c, $('tagIn'));
  });
  const sg = $('suggest'); sg.innerHTML = '';
  allTags().filter(t => !cur.tags.includes(t)).slice(0, 12).forEach(t => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = '#' + t;
    b.onclick = () => addTag(t); sg.appendChild(b);
  });
}
function addTag(raw) {
  const t = normTag(raw); if (!t) return;
  if (!cur.tags.includes(t)) { cur.tags.push(t); scheduleSave(); }
  $('tagIn').value = ''; renderTagBox();
}
function commitTagInput() {
  if (!cur) return;
  const v = $('tagIn').value.trim(); if (!v) return;
  v.split(/[\s　,、，]+/).forEach(addTag); $('tagIn').value = '';
}
$('tagIn').addEventListener('kbenter', e => { e.preventDefault(); commitTagInput(); });
$('tagIn').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitTagInput(); }
  else if (e.key === 'Backspace' && !$('tagIn').value && cur.tags.length) { cur.tags.pop(); renderTagBox(); scheduleSave(); }
});
$('tagIn').addEventListener('input', e => {
  if (!e.isComposing && /[\s　,、，]$/.test($('tagIn').value)) commitTagInput();
});

/* --- 画像・動画 --- */
async function renderMedia() {
  const box = $('media'); box.innerHTML = '';
  for (const m of cur.media) {
    const isV = m.type.startsWith('video');
    const d = document.createElement('div'); d.className = 'm';
    d.innerHTML = `<span class="ph"></span>${isV ? '<div class="play">▶</div>' : ''}<button class="del" aria-label="削除">✕</button>`;
    d.onclick = e => { if (e.target.classList.contains('del')) return; openViewer(m.id, isV); };
    d.querySelector('.del').onclick = async e => {
      e.stopPropagation();
      if (!confirm('この' + (isV ? '動画' : '画像') + 'を削除しますか？')) return;
      cur.media = cur.media.filter(x => x.id !== m.id);
      await delOne('media', m.id); dropURLs([m.id]);
      dirty = true; await saveNow(); renderMedia();
    };
    box.appendChild(d);
    thumbURL(m.id).then(u => { if (u) d.querySelector('.ph').outerHTML = `<img src="${u}" alt="">`; });
  }
}
$('addMedia').onclick = () => $('file').click();
$('file').onchange = async e => {
  const files = [...e.target.files]; e.target.value='';
  if (!files.length) return;
  busy('追加中…（動画は少し時間がかかります）');
  let ng = 0;
  for (const f of files) {
    const id = uid();
    const type = f.type || (/\.(mp4|mov|m4v)$/i.test(f.name) ? 'video/mp4' : 'image/jpeg');
    try {
      const thumb = await makeThumb(f, type.startsWith('video'));
      await putOne('media', { id, blob: f, thumb, type, name: f.name, size: f.size });
      cur.media.push({ id, type, name: f.name });
    } catch (err) { ng++; console.error(err); }
  }
  dirty = true; await saveNow(); await renderMedia(); busy(null);
  if (ng) toast('保存できないファイルがありました（容量不足の可能性）');
};
async function openViewer(id, isV) {
  const u = await fullURL(id); if (!u) return;
  $('vBody').innerHTML = isV ? `<video src="${u}" controls autoplay playsinline></video>` : `<img src="${u}" alt="">`;
  $('viewer').classList.add('on');
}
$('vClose').onclick = () => { $('viewer').classList.remove('on'); $('vBody').innerHTML = ''; };
$('viewer').onclick = e => { if (e.target.id === 'viewer') $('vClose').click(); };

/* ========== ZIP（バックアップ形式） ========== */
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crc32Blob(blob) {
  let c = 0xFFFFFFFF;
  for (let o = 0; o < blob.size; o += 4194304) {
    const buf = new Uint8Array(await blob.slice(o, o + 4194304).arrayBuffer());
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function buildZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), size = f.blob.size, crc = await crc32Blob(f.blob);
    if (size >= 0xFFFFFFFF) throw new Error('4GBを超えるファイルは書き出せません');
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
    h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, f.blob);
    central.push({ name, size, crc, offset }); offset += 30 + name.length + size;
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true);
    h.setUint16(14, 0x21, true); h.setUint32(16, c.crc, true); h.setUint32(20, c.size, true); h.setUint32(24, c.size, true);
    h.setUint16(28, c.name.length, true); h.setUint32(42, c.offset, true);
    parts.push(h.buffer, c.name); offset += 46 + c.name.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
  e.setUint32(12, offset - cdStart, true); e.setUint32(16, cdStart, true);
  parts.push(e.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
async function readZip(file) {
  const tail = await file.slice(Math.max(0, file.size - 70000)).arrayBuffer();
  const dv = new DataView(tail); let pos = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { pos = i; break; }
  if (pos < 0) throw new Error('ZIPファイルとして読み込めません');
  const n = dv.getUint16(pos + 10, true), cdSize = dv.getUint32(pos + 12, true), cdOff = dv.getUint32(pos + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder();
  const entries = new Map(); let q = 0;
  for (let i = 0; i < n; i++) {
    if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('ZIPが壊れています');
    const method = cd.getUint16(q + 10, true), csize = cd.getUint32(q + 20, true);
    const nl = cd.getUint16(q + 28, true), el = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true), lo = cd.getUint32(q + 42, true);
    entries.set(dec.decode(new Uint8Array(cd.buffer, q + 46, nl)), { method, csize, lo });
    q += 46 + nl + el + cl;
  }
  return { file, entries };
}
async function zipBlob(z, name, type) {
  const e = z.entries.get(name); if (!e) return null;
  const lh = new DataView(await z.file.slice(e.lo, e.lo + 30).arrayBuffer());
  const start = e.lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  let b = z.file.slice(start, start + e.csize);
  if (e.method === 8) b = await new Response(b.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  else if (e.method !== 0) throw new Error('未対応の圧縮形式です');
  return type ? b.slice(0, b.size, type) : b;
}

/* ========== バックアップ書き出し・読み込み ========== */
async function exportBackup() {
  busy('書き出し中…\n（画像・動画が多いと時間がかかります）');
  try {
    const [ms, fs, media] = await Promise.all([getAll('memos'), getAll('folders'), getAll('media')]);
    const meta = { app: 'memo-pwa', version: 2, exported: Date.now(), folders: fs, memos: ms, learn: IME.getLearn(),
      media: media.map(m => ({ id: m.id, type: m.type, name: m.name, size: m.blob.size, hasThumb: !!m.thumb })) };
    const files = [{ name: 'data.json', blob: new Blob([JSON.stringify(meta)], { type: 'application/json' }) }];
    for (const m of media) { files.push({ name: 'media/' + m.id, blob: m.blob }); if (m.thumb) files.push({ name: 'thumbs/' + m.id + '.jpg', blob: m.thumb }); }
    const zip = await buildZip(files);
    const fname = `memo-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const file = new File([zip], fname, { type: 'application/zip' });
    busy(null);
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); toast('書き出しました'); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast('書き出しました');
  } catch (err) { busy(null); alert('書き出しに失敗しました: ' + err.message); }
}
async function importBackup(file) {
  try {
    busy('読み込み中…');
    const z = await readZip(file);
    const meta = JSON.parse(await (await zipBlob(z, 'data.json')).text());
    if (meta.app !== 'memo-pwa') throw new Error('このアプリのバックアップではありません');
    busy(null);
    if (!confirm(`フォルダ ${meta.folders.length} 個・メモ ${meta.memos.length} 件・画像/動画 ${meta.media.length} 件を読み込みます。\n同じ内容（同じID）は上書きされ、今ある他のメモはそのまま残ります。`)) return;
    busy('読み込み中…');
    for (const m of meta.media) {
      const blob = await zipBlob(z, 'media/' + m.id, m.type);
      if (!blob) continue;
      let thumb = m.hasThumb ? await zipBlob(z, 'thumbs/' + m.id + '.jpg', 'image/jpeg') : null;
      if (!thumb) thumb = await makeThumb(blob, m.type.startsWith('video'));
      await putOne('media', { id: m.id, type: m.type, name: m.name, size: m.size, blob, thumb });
    }
    for (const f of meta.folders) await putOne('folders', f);
    for (const m of meta.memos) await putOne('memos', m);
    if (meta.learn) {
      const L = IME.getLearn();
      for (const part of ['uni', 'bi']) for (const k in (meta.learn[part] || {})) L[part][k] = Math.max(L[part][k] || 0, meta.learn[part][k]);
      IME.setLearn(L); await saveLearn();
    }
    thumbCache.clear(); fullCache.clear();
    await loadData(); busy(null); show('home'); nav.folderId = null; await renderHome(); toast('読み込みました');
  } catch (err) { busy(null); alert('読み込みに失敗しました: ' + err.message); }
}

/* ========== 設定 ========== */
async function openSettings() {
  show('settings');
  $('kbSwitch').checked = KB.isEnabled();
  updateDictState();
  try {
    const est = await navigator.storage.estimate();
    const mb = n => (n / 1048576).toFixed(1) + 'MB';
    $('usageText').textContent = `使用量: ${mb(est.usage || 0)} / 利用可能の目安: ${mb(est.quota || 0)}`;
    $('usageBar').style.width = Math.min(100, (est.usage || 0) / (est.quota || 1) * 100) + '%';
  } catch { $('usageText').textContent = ''; }
}
function updateDictState() {
  const s = KB.dictState();
  $('dictState').textContent = '変換辞書: ' + ({ none: 'キーボード初回使用時に読み込み', loading: '読み込み中…', ready: '読み込み済み', error: '読み込み失敗（オフライン初回など）' }[s]);
}
$('setBack').onclick = () => { show('home'); renderHome(); };
$('exportBtn').onclick = exportBackup;
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
$('kbSwitch').onchange = async e => {
  settings.kbEnabled = e.target.checked; KB.setEnabled(settings.kbEnabled);
  await putOne('settings', { key: 'kbEnabled', value: settings.kbEnabled });
  toast(settings.kbEnabled ? 'アプリ内キーボードをオンにしました' : '標準キーボードを使います');
};
$('resetLearn').onclick = async () => {
  if (!confirm('変換の学習データをすべて消去しますか？')) return;
  IME.resetLearn(); await saveLearn(); toast('リセットしました');
};
let learnTimer = null;
async function saveLearn() { await putOne('settings', { key: 'learn', value: IME.getLearn() }); }
function scheduleSaveLearn() { clearTimeout(learnTimer); learnTimer = setTimeout(() => saveLearn().catch(() => { }), 1200); }

/* ========== 起動 ========== */
(async () => {
  db = await openDB();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { }
  const sKb = await getOne('settings', 'kbEnabled'); if (sKb) settings.kbEnabled = !!sKb.value;
  const sLearn = await getOne('settings', 'learn'); if (sLearn) IME.setLearn(sLearn.value);
  await loadData();
  KB.init({ onLearn: scheduleSaveLearn });
  KB.setEnabled(settings.kbEnabled);
  await renderHome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveNow(); saveLearn().catch(() => { }); } });
window.addEventListener('pagehide', () => { saveNow(); });
