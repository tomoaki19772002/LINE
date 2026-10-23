const { getDb } = require('./_firebase');
const { encrypt, decrypt } = require('./_cardstore');

// 読取リスト(診察券番号)と予約PDFの内容を、院内の複数端末で共有する。
// Realtime Database は公開読み取りなので、必ず暗号化して保存する。合言葉なし（URLを知っていれば誰でも操作可）。
const STATE_PATH = 'scanSync/state';
const MAX_ITEMS = 1000;
const MAX_APPT = 2000;

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
      name: v.name.slice(0, 40),
      times: v.times.filter(t => typeof t === 'string').map(t => t.slice(0, 8)).slice(0, 10)
    };
  }
  return out;
}

// 古い保存データにも marks(預かり物の印: 薬=1 保=2 糖=4 他=8 のビット)を持たせる
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
      if (!Number.isInteger(f) || f < 0 || f > 3 || typeof body.on !== 'boolean') return false;
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

  const ref = getDb().ref(STATE_PATH);

  if (req.method === 'GET') {
    const record = (await ref.once('value')).val();
    const state = record ? normalize(decrypt(record)) : { rev: 0, items: [], marks: [], times: [], memos: [], trash: [], appt: null };
    if (String(state.rev) === String(req.query.rev)) { res.status(200).json({ unchanged: true, rev: state.rev }); return; }
    res.status(200).json(state);
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
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
    res.status(200).json(decrypt(result.snapshot.val()));
    return;
  }

  res.status(405).end();
};
