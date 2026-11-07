/* かな漢字変換エンジン（辞書: Mozc オープンソース辞書の一部 / 学習機能つき） */
(function (root) {
  'use strict';
  const MAXW = 10, UNK = 10000;
  let SEGPEN = 1000;
  function setSegPen(v) { SEGPEN = v; }
  let dict = null;                 // reading -> raw "surface@cost@lg[@rg]|..."
  let parsed = new Map();
  let learn = { uni: {}, bi: {} }; // uni: "reading\tsurface" -> n, bi: "prev\tsurface" -> n
  let byReading = new Map();
  let ready = false;
  let conn = null, G = 0, BOS = 0, NOUN = 0;

  function rebuildIndex() {
    byReading = new Map();
    for (const k in learn.uni) {
      const i = k.indexOf('\t');
      const r = k.slice(0, i), s = k.slice(i + 1);
      let m = byReading.get(r);
      if (!m) { m = new Map(); byReading.set(r, m); }
      m.set(s, learn.uni[k]);
    }
  }
  function setLearn(o) {
    learn = (o && o.uni) ? o : { uni: {}, bi: {} };
    if (!learn.bi) learn.bi = {};
    rebuildIndex();
  }
  function getLearn() { return learn; }
  function parseRaw(raw) {
    return raw.split('|').map(x => {
      const f = x.split('@');
      const lg = +f[2], rg = f.length > 3 ? +f[3] : lg;
      return [f[0], (+f[1]) * 10, lg, rg];
    });
  }
  function setConn(buf) {
    const u = new Uint16Array(buf);
    G = u[0]; BOS = u[1]; NOUN = u[2];
    conn = u.subarray(3);
  }
  function parseDict(txt) {
    const m = new Map();
    let p = 0;
    while (p < txt.length) {
      let e = txt.indexOf('\n', p); if (e < 0) e = txt.length;
      const t = txt.indexOf('\t', p);
      if (t > 0 && t < e) m.set(txt.slice(p, t), txt.slice(t + 1, e));
      p = e + 1;
    }
    dict = m; ready = !!conn;
  }
  async function load(dictUrl, connUrl) {
    const [cb, dt] = await Promise.all([
      fetch(connUrl).then(r => r.arrayBuffer()),
      fetch(dictUrl).then(r => r.text())
    ]);
    setConn(cb); parseDict(dt);
  }
  function loadFromData(txt, buf) { setConn(buf); parseDict(txt); }
  function lookup(r) {
    let base = parsed.get(r);
    if (!base) {
      const raw = dict && dict.get(r);
      base = raw ? parseRaw(raw) : [];
      if (parsed.size > 30000) parsed.clear();
      parsed.set(r, base);
    }
    const lm = byReading.get(r);
    if (!lm) return base;
    const out = new Map(base.map(e => [e[0], e]));
    for (const [s, n] of lm) {
      const e = out.get(s);
      const c0 = e ? e[1] : 7000;
      out.set(s, [s, Math.max(0, c0 - 2500 - 400 * Math.min(n, 8)), e ? e[2] : NOUN, e ? e[3] : NOUN]);
    }
    return [...out.values()].sort((a, b) => a[1] - b[1]);
  }

  function toKatakana(s) {
    return s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }

  // 文全体の最良変換（ビタビ法＋品詞接続コスト）。segs: [[reading, surface], ...]
  function convertSentence(r, prevSurface) {
    const n = r.length;
    const states = new Array(n + 1);
    for (let i = 0; i <= n; i++) states[i] = new Map();
    states[0].set(BOS, { cost: 0, back: null, s: prevSurface || '', seg: '', rg: BOS });
    const relax = (j, rg, node) => {
      const cur = states[j].get(rg);
      if (!cur || node.cost < cur.cost) states[j].set(rg, node);
    };
    for (let i = 0; i < n; i++) {
      if (!states[i].size) continue;
      const jmax = Math.min(n, i + MAXW);
      for (let j = i + 1; j <= jmax; j++) {
        const sub = r.slice(i, j);
        const ents = lookup(sub);
        const lim = Math.min(ents.length, 14);
        for (let k = 0; k < lim; k++) {
          const [s, wc, lg, rg] = ents[k];
          for (const node of states[i].values()) {
            let cost = node.cost + wc + SEGPEN + (conn ? conn[node.rg * G + lg] : 0);
            const bg = learn.bi[node.s + '\t' + s];
            if (bg) cost -= 1500 + 300 * Math.min(bg, 5);
            relax(j, rg, { cost, back: node, s, seg: sub, rg });
          }
        }
      }
      for (const node of states[i].values()) {
        const ch = r[i];
        const cost = node.cost + UNK + SEGPEN + (conn ? conn[node.rg * G + NOUN] : 0);
        relax(i + 1, NOUN, { cost, back: node, s: ch, seg: ch, rg: NOUN });
      }
    }
    let bestNode = null, bestCost = Infinity;
    for (const node of states[n].values()) {
      const c = node.cost + (conn ? conn[node.rg * G + BOS] : 0);
      if (c < bestCost) { bestCost = c; bestNode = node; }
    }
    const segs = [];
    for (let x = bestNode; x && x.back; x = x.back) segs.unshift([x.seg, x.s]);
    return segs;
  }

  // 候補一覧。各候補: {s: 表示, len: 消費する読みの長さ, segs?: 学習用}
  function candidates(r, prevSurface) {
    const n = r.length;
    const out = [], seen = new Set();
    const add = (s, len, segs) => {
      const key = s + '\t' + len;
      if (seen.has(key)) return;
      seen.add(key); out.push({ s, len, segs: segs || [[r.slice(0, len), s]] });
    };
    if (!n) return out;
    if (ready) {
      const segs = convertSentence(r, prevSurface);
      if (segs.length > 1) add(segs.map(x => x[1]).join(''), n, segs);
      for (const [s] of lookup(r).slice(0, 12)) add(s, n);
    }
    add(r, n);
    add(toKatakana(r), n);
    if (ready) {
      for (let k = n - 1; k >= 1 && out.length < 40; k--) {
        for (const [s] of lookup(r.slice(0, k)).slice(0, 3)) add(s, k);
      }
    }
    return out;
  }

  // 確定した変換を学習する
  function learnCommit(segs, prevSurface) {
    let prev = prevSurface || '';
    for (const [r, s] of segs) {
      if (!r || !s) continue;
      if (r !== s) { const k = r + '\t' + s; learn.uni[k] = (learn.uni[k] || 0) + 1; }
      if (prev) { const k = prev + '\t' + s; learn.bi[k] = (learn.bi[k] || 0) + 1; }
      prev = s;
    }
    rebuildIndex();
    return prev;
  }
  function resetLearn() { setLearn({ uni: {}, bi: {} }); }

  root.IME = { setSegPen, load, loadFromData, candidates, convertSentence, learnCommit, setLearn, getLearn, resetLearn, toKatakana, isReady: () => ready };
  if (typeof module !== 'undefined') module.exports = root.IME;
})(typeof self !== 'undefined' ? self : globalThis);
