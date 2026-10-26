const { getDb } = require('./_firebase');
const { encrypt, decrypt } = require('./_cardstore');

// 読取リスト(診察券番号)と予約PDFの内容を、院内の複数端末で共有する。
// Realtime Database は公開読み取りなので、必ず暗号化して保存する。合言葉なし（URLを知っていれば誰でも操作可）。
const STATE_PATH = 'scanSync/state';
const MAX_ITEMS = 1000;
const MAX_APPT = 2000;
const HISTORY_PATH = 'scanSync/history';
const HISTORY_SLOTS = 300; // 直近300操作ぶんを循環して保存（rev % 300 の位置に上書き）
const LIST_LIMIT = 60;
const SNAP_FIELDS = ['items', 'marks', 'times', 'memos', 'trash']; // 予約PDFは含めない(復元しても今のPDFを保つ)

function cleanAppt(input) {
  if (!input || typeof input !== 'object') return null;
  const keys = Object.keys(input);
  if (keys.length > MAX_APPT) return null;
  const out = {};
  for (const k of keys) {
    const v = input[k];
    if (!/^\d{1,12}$/.test(k) || !v || typeof v.name !== 'string' || !Array.isArray(v.times)) return null;
    out[k] = {
      inf: v.inf === true,
      infWhy: typeof v.infWhy === 'string' ? v.infWhy.slice(0, 12) : '',
      first: v.first === true,
      name: v.name.slice(0, 40),
      times: v.times.filter(t => typeof t === 'string').map(t => t.slice(0, 8)).slice(0, 10)
    };
  }
  return out;
}

// 古い保存データにも marks(印のビット: 薬=1 保=2 糖=4 他=8 変わりない=16 よくなった=32 1診=64)を持たせる
function normalize(state) {
  if (!Array.isArray(state.marks)) state.marks = [];
  if (!Array.isArray(state.times)) state.times = []; // スキャン時刻(日本時間 HH:mm)
  if (!Array.isArray(state.memos)) state.memos = []; // 行ごとのメモ
  if (!Array.isArray(state.trash)) state.trash = []; // 削除済みの番号(復活用): trash[i] = { code, mark, time, memo }
  return state;
}

const JST_TIME = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
const MAX_MEMO = 200;

// 操作を状態に適用する。不正なら false
function applyOp(state, body) {
  switch (body.op) {
    case 'add': {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^[\w-]{1,24}$/.test(code) || state.items.length >= MAX_ITEMS) return false;
      state.items.push(code);
      const n = state.items.length - 1;
      state.marks[n] = 0;
      state.memos[n] = '';
      state.times[n] = JST_TIME.format(new Date());
      return true;
    }
    case 'del': {
      const i = body.index;
      if (!Number.isInteger(i) || i < 0 || i >= state.items.length) return false;
      state.trash[i] = { code: state.items[i], mark: state.marks[i] | 0, time: state.times[i] || '', memo: state.memos[i] || '' };
      state.items[i] = null; // 削除した位置は空欄のまま残す
      state.marks[i] = 0;
      state.memos[i] = '';
      state.times[i] = '';
      return true;
    }
    case 'restore': {
      const i = body.index;
      const t = state.trash[i];
      if (!Number.isInteger(i) || i < 0 || i >= state.items.length || state.items[i] !== null || !t) return false;
      state.items[i] = t.code;
      state.marks[i] = t.mark | 0;
      state.times[i] = t.time || '';
      state.memos[i] = t.memo || '';
      state.trash[i] = null;
      return true;
    }
    case 'memo': {
      const i = body.index;
      if (!Number.isInteger(i) || i < 0 || i >= state.items.length || state.items[i] === null) return false;
      if (typeof body.text !== 'string') return false;
      state.memos[i] = body.text.slice(0, MAX_MEMO);
      return true;
    }
    case 'mark': {
      const i = body.index, f = body.flag;
      if (!Number.isInteger(i) || i < 0 || i >= state.items.length || state.items[i] === null) return false;
      if (!Number.isInteger(f) || f < 0 || f > 6 || typeof body.on !== 'boolean') return false;
      const cur = state.marks[i] | 0;
      state.marks[i] = body.on ? (cur | (1 << f)) : (cur & ~(1 << f));
      return true;
    }
    case 'reset':
      state.items = [];
      state.marks = [];
      state.times = [];
      state.memos = [];
      state.trash = [];
      return true;
    case 'move': {
      // from の行を to の位置へ移動（空欄の行も含め、並び全体が1つずつずれる）
      const n = state.items.length, a = body.from, b = body.to;
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n || a === b) return false;
      const fill = { items: null, marks: 0, times: '', memos: '', trash: null };
      Object.keys(fill).forEach(k => {
        const arr = state[k];
        while (arr.length < n) arr.push(fill[k]);
        arr.length = n;
        arr.splice(b, 0, arr.splice(a, 1)[0]);
      });
      return true;
    }
    case 'rollback': {
      const snap = body._snap;
      if (!snap) return false;
      SNAP_FIELDS.forEach(k => { state[k] = Array.isArray(snap[k]) ? snap[k] : []; });
      return true;
    }
    case 'appt': {
      const appt = cleanAppt(body.appt);
      if (!appt) return false;
      state.appt = appt;
      return true;
    }
    default:
      return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const db = getDb();
  const ref = db.ref(STATE_PATH);

  if (req.method === 'GET' && req.query.history) {
    // 履歴の一覧（操作の種類・時刻・件数だけ。中身は暗号化されたまま）
    const all = (await db.ref(HISTORY_PATH).once('value')).val() || {};
    const list = Object.values(all).map(e => ({ rev: e.rev, t: e.t, op: e.op, n: e.n }))
      .sort((a, b) => b.rev - a.rev).slice(0, LIST_LIMIT);
    res.status(200).json(list);
    return;
  }

  if (req.method === 'GET') {
    const record = (await ref.once('value')).val();
    const state = record ? normalize(decrypt(record)) : { rev: 0, items: [], marks: [], times: [], memos: [], trash: [], appt: null };
    if (String(state.rev) === String(req.query.rev)) { res.status(200).json({ unchanged: true, rev: state.rev }); return; }
    res.status(200).json(state);
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.op === 'rollback') {
      // 履歴の該当時点を読み、その内容に戻す（操作自体も新しい履歴として残る）
      const rev = body.rev;
      const entry = Number.isInteger(rev) ? (await db.ref(`${HISTORY_PATH}/${rev % HISTORY_SLOTS}`).once('value')).val() : null;
      if (!entry || entry.rev !== rev) { res.status(404).json({ error: 'history not found' }); return; }
      body._snap = decrypt(entry.data);
    }
    let valid = true;
    const result = await ref.transaction(current => {
      const state = current ? normalize(decrypt(current)) : { rev: 0, items: [], marks: [], times: [], memos: [], trash: [], appt: null };
      valid = applyOp(state, body);
      if (!valid) {
        // 初回は current が null(未取得)で呼ばれることがある。ここで中止すると
        // 実データでの再試行が行われないため、空の状態を返してサーバー側と照合させる。
        if (current === null) return encrypt(state);
        return; // 実データに対して不正な操作なら中止
      }
      state.rev += 1;
      return encrypt(state);
    });
    if (!valid || !result.committed) { res.status(400).json({ error: 'invalid operation' }); return; }
    const next = decrypt(result.snapshot.val());
    // 履歴を残す（失敗しても本処理は成功扱い）
    try {
      const snap = {};
      SNAP_FIELDS.forEach(k => { snap[k] = next[k]; });
      await db.ref(`${HISTORY_PATH}/${next.rev % HISTORY_SLOTS}`).set({
        rev: next.rev, t: Date.now(), op: body.op, n: next.items.filter(v => v !== null).length, data: encrypt(snap)
      });
    } catch (e) { console.error('history write failed', e); }
    res.status(200).json(next);
    return;
  }

  res.status(405).end();
};
