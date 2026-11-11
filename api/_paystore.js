const crypto = require('crypto');
const { getDb } = require('./_firebase');
const { encrypt, decrypt, deriveKey, userPath } = require('./_cardstore');

// 支払い用カードの保存。Firebase は公開読み取りのため、すべて暗号化して保存する。
// stripeCustomers/{HMAC(LINEユーザー)} に、顧客ID・支払い方法ID・カード表示用の情報・受付の確認結果を持つ。

function recordId(sub) {
  return crypto.createHmac('sha256', deriveKey('stripe-id')).update(sub).digest('hex');
}

function recordRef(id) {
  return getDb().ref(`stripeCustomers/${id}`);
}

async function loadRecordById(id) {
  const snap = await recordRef(id).once('value');
  const raw = snap.val();
  return raw ? decrypt(raw) : null;
}

async function loadRecord(sub) {
  return loadRecordById(recordId(sub));
}

async function saveRecordById(id, record) {
  await recordRef(id).set(encrypt(record));
}

async function saveRecord(sub, record) {
  // 受付用の画面から、この人の診察券（patientCards）を引けるようにしておく
  await saveRecordById(recordId(sub), Object.assign({}, record, { cardsPath: userPath(sub) }));
}

// その人が自己登録している診察券の一覧
async function loadCardsOf(record) {
  if (!record || typeof record.cardsPath !== 'string' || !record.cardsPath.startsWith('patientCards/')) return [];
  const snap = await getDb().ref(record.cardsPath).once('value');
  const raw = snap.val();
  return raw ? decrypt(raw) : [];
}

// 全員分の記録を読む（クリニックの規模なら十分に小さい）
async function loadAllRecords() {
  const snap = await getDb().ref('stripeCustomers').once('value');
  const all = snap.val() || {};
  const out = [];
  for (const [id, raw] of Object.entries(all)) {
    try {
      out.push({ id, record: decrypt(raw) });
    } catch (e) {
      // 復号できない記録は読み飛ばす
    }
  }
  return out;
}

// 患者さん本人の画面に返してよい項目だけ
function publicView(record) {
  if (!record || !record.paymentMethodId) return null;
  return {
    brand: record.brand,
    last4: record.last4,
    expMonth: record.expMonth,
    expYear: record.expYear,
    consentAt: record.consentAt,
    verified: !!record.verifiedCardNumber
  };
}

module.exports = {
  recordId, loadRecord, saveRecord, loadRecordById, saveRecordById,
  loadCardsOf, loadAllRecords, publicView
};
