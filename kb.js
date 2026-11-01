/* アプリ内キーボード（フリック入力・かな漢字変換・英数・記号） */
(function (root) {
  'use strict';
  const IME = root.IME;

  const FLICK = {
    'あ': ['あ', 'い', 'う', 'え', 'お'], 'か': ['か', 'き', 'く', 'け', 'こ'], 'さ': ['さ', 'し', 'す', 'せ', 'そ'],
    'た': ['た', 'ち', 'つ', 'て', 'と'], 'な': ['な', 'に', 'ぬ', 'ね', 'の'], 'は': ['は', 'ひ', 'ふ', 'へ', 'ほ'],
    'ま': ['ま', 'み', 'む', 'め', 'も'], 'や': ['や', '（', 'ゆ', '）', 'よ'], 'ら': ['ら', 'り', 'る', 'れ', 'ろ'],
    'わ': ['わ', 'を', 'ん', 'ー', '〜'], '、': ['、', '。', '？', '！', '…']
  };
  const CYCLES = ['かが', 'きぎ', 'くぐ', 'けげ', 'こご', 'さざ', 'しじ', 'すず', 'せぜ', 'そぞ', 'ただ', 'ちぢ', 'つっづ', 'てで', 'とど',
    'はばぱ', 'ひびぴ', 'ふぶぷ', 'へべぺ', 'ほぼぽ', 'うぅゔ', 'あぁ', 'いぃ', 'えぇ', 'おぉ', 'やゃ', 'ゆゅ', 'よょ', 'わゎ'];
  function cycleNext(ch) {
    for (const c of CYCLES) { const i = c.indexOf(ch); if (i >= 0) return c[(i + 1) % c.length]; }
    return null;
  }

  let kb, barEl, gridEl, popEl;
  let target = null, mode = 'kana', shift = false, symPage = 1;
  let comp = '', cands = [], candIdx = -1, cs = 0, curLen = 0, prevSurface = '';
  let enabled = true, touching = false, lastSel = [0, 0];
  let opts = { onLearn() { }, dictUrl: 'data/dict.txt', connUrl: 'data/conn.bin' };
  let dictState = 'none';
  let labelEnter = null;

  const isTextEl = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/.test(el.type)));
  const fire = el => el.dispatchEvent(new Event('input', { bubbles: true }));
  const mk = (cls, txt) => { const d = document.createElement('div'); d.className = cls; if (txt != null) d.textContent = txt; return d; };

  /* ---------- 入力中テキスト ---------- */
  function inlineText() {
    if (!comp) return '';
    if (candIdx >= 0) { const c = cands[candIdx]; return c.s + comp.slice(c.len); }
    return comp;
  }
  function render() {
    if (!target) return;
    const t = inlineText();
    target.setRangeText(t, cs, cs + curLen, 'end');
    curLen = t.length;
    lastSel = [target.selectionStart, target.selectionEnd];
    fire(target);
    renderBar(); updateEnterLabel(); ensureVisible();
  }
  function refreshCands() {
    cands = comp ? IME.candidates(comp, prevSurface) : [];
    candIdx = -1;
  }
  function begin() {
    if (comp) return;
    const s = target.selectionStart, e = target.selectionEnd;
    if (e > s) target.setRangeText('', s, e, 'end');
    cs = target.selectionStart; curLen = 0;
  }
  function commitCand(c) {
    const rest = comp.slice(c.len);
    target.setRangeText(c.s, cs, cs + curLen, 'end');
    cs += c.s.length; curLen = 0;
    if (c.segs) { prevSurface = IME.learnCommit(c.segs, prevSurface); opts.onLearn(); }
    else prevSurface = c.s;
    comp = rest; candIdx = -1;
    if (comp) { target.setRangeText(comp, cs, cs, 'end'); curLen = comp.length; refreshCands(); }
    else cands = [];
    lastSel = [target.selectionStart, target.selectionEnd];
    fire(target); renderBar(); updateEnterLabel(); ensureVisible();
  }
  function commitAll() {
    if (!comp) return;
    if (candIdx >= 0) commitCand(cands[candIdx]);
    while (comp) commitCand({ s: comp, len: comp.length, segs: null });
  }
  function endComposition() { if (comp) { candIdx = -1; commitAll(); } }
  function resetContext() { endComposition(); prevSurface = ''; }

  /* ---------- 入力動作 ---------- */
  function inputKana(ch) {
    if (!target) return;
    if (candIdx >= 0) commitCand(cands[candIdx]);
    begin();
    comp += ch;
    refreshCands(); render();
  }
  function insertDirect(t) {
    if (!target) return;
    endComposition();
    const s = target.selectionStart, e = target.selectionEnd;
    target.setRangeText(t, s, e, 'end');
    lastSel = [target.selectionStart, target.selectionEnd];
    fire(target); ensureVisible();
    prevSurface = '';
  }
  function backspace() {
    if (!target) return;
    if (comp) {
      if (candIdx >= 0) { candIdx = -1; render(); return; }
      comp = Array.from(comp).slice(0, -1).join('');
      if (!comp) { render(); cands = []; renderBar(); updateEnterLabel(); return; }
      refreshCands(); render(); return;
    }
    let s = target.selectionStart, e = target.selectionEnd;
    if (s === e) {
      if (s === 0) return;
      const before = target.value.slice(0, s);
      const ch = Array.from(before).pop();
      s -= ch.length;
    }
    target.setRangeText('', s, e, 'end');
    lastSel = [target.selectionStart, target.selectionEnd];
    fire(target); ensureVisible();
  }
  function dakuten() {
    if (!comp) return;
    if (candIdx >= 0) { candIdx = -1; }
    const arr = Array.from(comp); const last = arr[arr.length - 1];
    const nx = cycleNext(last);
    if (!nx) return;
    arr[arr.length - 1] = nx; comp = arr.join('');
    refreshCands(); render();
  }
  function space() {
    if (!target) return;
    if (comp) {
      if (!cands.length) return;
      candIdx = (candIdx + 1) % cands.length;
      render();
    } else insertDirect(mode === 'kana' ? '　' : ' ');
  }
  function enter() {
    if (!target) return;
    if (comp) { commitAll(); return; }
    const ev = new CustomEvent('kbenter', { cancelable: true, bubbles: true });
    if (target.dispatchEvent(ev)) {
      if (target.tagName === 'TEXTAREA') insertDirect('\n'); else hide();
    }
  }
  function moveCaret(d) {
    if (!target) return;
    endComposition();
    let p = d < 0 ? target.selectionStart : target.selectionEnd;
    if (target.selectionStart !== target.selectionEnd) p = d < 0 ? target.selectionStart : target.selectionEnd;
    else p = Math.max(0, Math.min(target.value.length, p + d));
    target.setSelectionRange(p, p);
    lastSel = [p, p];
    prevSurface = ''; ensureVisible();
  }

  /* ---------- 表示 ---------- */
  function renderBar() {
    barEl.innerHTML = '';
    if (!comp) {
      const m = mk('kb-hint', dictState === 'loading' ? '辞書を読み込み中…' : dictState === 'error' ? '辞書を読み込めませんでした（かな入力のみ）' : '');
      barEl.appendChild(m);
      return;
    }
    cands.forEach((c, i) => {
      const b = mk('cand' + (i === candIdx ? ' on' : ''), c.s);
      b.addEventListener('click', () => {
        if (!comp) return;
        commitCand(c);
      });
      barEl.appendChild(b);
    });
    if (candIdx >= 0) {
      const el = barEl.children[candIdx]; if (el) el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    } else barEl.scrollLeft = 0;
  }
  function updateEnterLabel() {
    if (!labelEnter) return;
    let t = '改行';
    if (comp) t = '確定';
    else if (target && target.tagName !== 'TEXTAREA') {
      const k = target.dataset.enter;
      t = k === 'next' ? '次へ' : k === 'submit' ? '決定' : k === 'tag' ? '追加' : '完了';
    }
    labelEnter.textContent = t;
  }
  function kbHeight() { return kb.offsetHeight || 0; }
  function ensureVisible() {
    if (!target || kb.style.display === 'none') return;
    const sc = target.closest('.scroller'); if (!sc) return;
    let y = target.getBoundingClientRect().top;
    if (target.tagName === 'TEXTAREA') y += caretTop(target) - target.scrollTop;
    const lineH = 34, kbTop = window.innerHeight - kbHeight();
    if (y + lineH > kbTop - 8) sc.scrollTop += y + lineH - (kbTop - 8);
    const sTop = sc.getBoundingClientRect().top;
    if (y < sTop + 8) sc.scrollTop -= (sTop + 8 - y);
  }
  function caretTop(ta) {
    const cs0 = getComputedStyle(ta);
    const m = document.createElement('div');
    ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'boxSizing', 'borderLeftWidth', 'borderRightWidth', 'whiteSpace', 'wordWrap', 'overflowWrap']
      .forEach(k => m.style[k] = cs0[k]);
    m.style.position = 'absolute'; m.style.visibility = 'hidden'; m.style.width = ta.clientWidth + 'px';
    m.style.whiteSpace = 'pre-wrap'; m.style.wordWrap = 'break-word';
    m.textContent = ta.value.slice(0, ta.selectionStart);
    const sp = document.createElement('span'); sp.textContent = '​'; m.appendChild(sp);
    document.body.appendChild(m);
    const top = sp.offsetTop; document.body.removeChild(m);
    return top;
  }

  /* ---------- キー生成 ---------- */
  function press(el, fn, repeat) {
    let timer = null, rep = null;
    const stop = () => { clearTimeout(timer); clearInterval(rep); el.classList.remove('active'); };
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.classList.add('active');
      fn();
      if (repeat) { timer = setTimeout(() => { rep = setInterval(fn, 70); }, 400); }
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, stop));
  }
  function key(label, o = {}) {
    const b = mk('key ' + (o.cls || ''), label);
    if (o.w) b.style.flex = o.w;
    if (o.fn) press(b, o.fn, o.repeat);
    return b;
  }
  function flickKey(label) {
    const set = FLICK[label];
    const b = mk('key flick', label);
    let st = null;
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); b.setPointerCapture(e.pointerId);
      st = { x: e.clientX, y: e.clientY, dir: 0 };
      showPop(b, set, 0);
    });
    b.addEventListener('pointermove', e => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      let d = 0;
      if (Math.hypot(dx, dy) > 24) d = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 3) : (dy < 0 ? 2 : 4);
      if (d !== st.dir) { st.dir = d; updatePop(d); }
    });
    const end = commit => {
      if (!st) return;
      const ch = set[st.dir]; st = null; hidePop();
      if (commit && ch) inputKana(ch);
    };
    b.addEventListener('pointerup', () => end(true));
    b.addEventListener('pointercancel', () => end(false));
    return b;
  }
  function showPop(keyEl, set, dir) {
    const r = keyEl.getBoundingClientRect(), k = kb.getBoundingClientRect();
    popEl.innerHTML = '';
    const pos = [[1, 1], [0, 1], [1, 0], [2, 1], [1, 2]];
    set.forEach((ch, i) => {
      const s = mk('pc' + (i === 0 ? ' c' : ''), ch);
      s.style.gridColumn = pos[i][0] + 1; s.style.gridRow = pos[i][1] + 1;
      popEl.appendChild(s);
    });
    popEl.style.display = 'grid';
    const w = r.width * 3, h = r.height * 3;
    popEl.style.width = w + 'px'; popEl.style.height = h + 'px';
    popEl.style.left = Math.max(2, Math.min(k.width - w - 2, r.left - r.width - k.left)) + 'px';
    popEl.style.top = (r.top - r.height - k.top) + 'px';
    updatePop(dir);
  }
  function updatePop(d) { [...popEl.children].forEach((c, i) => c.classList.toggle('sel', i === d)); }
  function hidePop() { popEl.style.display = 'none'; }

  function row(keys) { const r = mk('krow'); keys.forEach(k => r.appendChild(k)); return r; }

  function build() {
    gridEl.innerHTML = '';
    labelEnter = null;
    const enterKey = (w) => { const k = key('改行', { cls: 'fn accent', w, fn: enter }); labelEnter = k; return k; };
    const bs = () => key('⌫', { cls: 'fn', fn: backspace, repeat: true, w: mode === 'kana' ? 1 : 1.4 });
    if (mode === 'kana') {
      gridEl.appendChild(row([key('☆123', { cls: 'fn', fn: () => setMode('num') }), flickKey('あ'), flickKey('か'), flickKey('さ'), bs()]));
      gridEl.appendChild(row([key('←', { cls: 'fn', fn: () => moveCaret(-1) }), flickKey('た'), flickKey('な'), flickKey('は'), key('空白', { cls: 'fn', fn: space })]));
      gridEl.appendChild(row([key('→', { cls: 'fn', fn: () => moveCaret(1) }), flickKey('ま'), flickKey('や'), flickKey('ら'), enterKey(1)]));
      gridEl.appendChild(row([key('ABC', { cls: 'fn', fn: () => setMode('abc') }), key('小 ゛゜', { fn: dakuten }), flickKey('わ'), flickKey('、'), key('⌄', { cls: 'fn', fn: hide })]));
    } else if (mode === 'abc') {
      const L = r => r.split('').map(c => key(shift ? c.toUpperCase() : c, { fn: () => { insertDirect(shift ? c.toUpperCase() : c); if (shift && !shiftLock) { shift = false; build(); } } }));
      gridEl.appendChild(row(L('qwertyuiop')));
      const r2 = row(L('asdfghjkl')); r2.style.padding = '0 5%'; gridEl.appendChild(r2);
      gridEl.appendChild(row([key('⇧', { cls: 'fn' + (shift ? ' on' : ''), w: 1.4, fn: () => { shift = !shift; build(); } }), ...L('zxcvbnm'), bs()]));
      gridEl.appendChild(row([key('☆123', { cls: 'fn', w: 1.4, fn: () => setMode('num') }), key('かな', { cls: 'fn', w: 1.4, fn: () => setMode('kana') }), key('空白', { w: 4, fn: space }), key('@', { fn: () => insertDirect('@') }), key('.', { fn: () => insertDirect('.') }), enterKey(1.6), key('⌄', { cls: 'fn', fn: hide })]));
    } else {
      const sets = symPage === 1
        ? ['1234567890', '-/:;()¥&@"', '.,?!\'~…']
        : ['[]{}#%^*+=', '_\\|~<>$€£•', '.,?!\'「」']
      const L = r => Array.from(r).map(c => key(c, { fn: () => insertDirect(c) }));
      gridEl.appendChild(row(L(sets[0])));
      gridEl.appendChild(row(L(sets[1])));
      gridEl.appendChild(row([key(symPage === 1 ? '#+=' : '123', { cls: 'fn', w: 1.4, fn: () => { symPage = symPage === 1 ? 2 : 1; build(); } }), ...L(sets[2]), bs()]));
      gridEl.appendChild(row([key('ABC', { cls: 'fn', w: 1.4, fn: () => setMode('abc') }), key('かな', { cls: 'fn', w: 1.4, fn: () => setMode('kana') }), key('空白', { w: 4, fn: space }), enterKey(1.6), key('⌄', { cls: 'fn', fn: hide })]));
    }
    updateEnterLabel();
  }
  let shiftLock = false;
  function setMode(m) { endComposition(); mode = m; shift = false; symPage = 1; build(); }

  /* ---------- 表示・非表示 ---------- */
  function show() {
    kb.style.display = 'block';
    document.body.classList.add('kbopen');
    document.documentElement.style.setProperty('--kbh', kbHeight() + 'px');
    ensureVisible();
  }
  function hide() {
    endComposition();
    kb.style.display = 'none'; hidePop();
    document.body.classList.remove('kbopen');
    document.documentElement.style.setProperty('--kbh', '0px');
    if (target) { target.blur(); target = null; }
  }
  function attach(el) {
    if (!enabled) return;
    if (target !== el) { endComposition(); prevSurface = ''; target = el; comp = ''; cands = []; candIdx = -1; }
    if (dictState === 'none') loadDict();
    if (el.dataset.kbmode && mode !== el.dataset.kbmode) { mode = el.dataset.kbmode; build(); }
    renderBar(); updateEnterLabel();
    show();
  }
  function loadDict() {
    dictState = 'loading';
    IME.load(opts.dictUrl, opts.connUrl).then(() => { dictState = 'ready'; if (comp) { refreshCands(); render(); } else renderBar(); })
      .catch(() => { dictState = 'error'; renderBar(); });
  }
  function applyEnabled() {
    document.querySelectorAll('[data-kb]').forEach(el => {
      if (enabled) el.setAttribute('inputmode', 'none'); else el.removeAttribute('inputmode');
    });
  }
  function setEnabled(b) { enabled = b; if (!b) hide(); applyEnabled(); }

  function init(o) {
    Object.assign(opts, o || {});
    kb = document.getElementById('kb');
    kb.innerHTML = '<div class="kb-bar" id="kbBar"></div><div class="kb-grid" id="kbGrid"></div><div class="kb-pop" id="kbPop"></div>';
    barEl = document.getElementById('kbBar'); gridEl = document.getElementById('kbGrid'); popEl = document.getElementById('kbPop');
    kb.style.display = 'none';
    build(); renderBar();

    kb.addEventListener('pointerdown', () => { touching = true; }, true);
    document.addEventListener('pointerup', () => setTimeout(() => { touching = false; }, 400), true);
    kb.addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('focusin', e => {
      const el = e.target;
      if (enabled && el.matches && el.matches('[data-kb]') && isTextEl(el)) attach(el);
      else if (kb.style.display !== 'none' && !kb.contains(el) && !(el.closest && el.closest('.modal')) && !(el.matches && el.matches('button,[role=button]'))) hide();
    });
    document.addEventListener('focusout', e => {
      if (e.target !== target) return;
      if (touching) {
        const el = target;
        setTimeout(() => { if (target === el && document.activeElement !== el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(lastSel[0], lastSel[1]); } catch { } } }, 0);
        return;
      }
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a.closest && a.closest('.modal')) return;
        if (a && a.matches && a.matches('button,[role=button]')) return;
        if (!(a && a.matches && a.matches('[data-kb]')) && !kb.contains(a)) hide();
      }, 60);
    });
    // タップでカーソルを動かしたら、入力中の文字列を確定
    document.addEventListener('selectionchange', () => {
      if (!target || !comp) return;
      if (document.activeElement !== target) return;
      if (target.selectionStart !== cs + curLen || target.selectionEnd !== cs + curLen) {
        const s0 = target.selectionStart, e0 = target.selectionEnd;
        const oldEnd = cs + curLen;
        candIdx = -1; commitAll();
        // 位置は利用者のタップ位置を尊重（確定で文字数が変わった分は補正しない）
        const delta = target.value.length; void delta; void oldEnd;
        try { target.setSelectionRange(Math.min(s0, target.value.length), Math.min(e0, target.value.length)); } catch { }
        lastSel = [target.selectionStart, target.selectionEnd];
        prevSurface = '';
      } else lastSel = [target.selectionStart, target.selectionEnd];
    });
    window.addEventListener('resize', () => { if (kb.style.display !== 'none') document.documentElement.style.setProperty('--kbh', kbHeight() + 'px'); });
    applyEnabled();
  }

  root.KB = { init, setEnabled, hide, applyEnabled, isOpen: () => kb && kb.style.display !== 'none', isEnabled: () => enabled, dictState: () => dictState };
})(self);
