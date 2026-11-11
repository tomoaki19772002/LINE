const { getDb } = require('./_firebase');
const { encrypt, decrypt } = require('./_cardstore');
const { numberKey } = require('./_docstore');

// 決済の記録（診察券番号ごと）。Stripe の決済ID単位で、受付の請求時と Webhook の両方から更新する。
// Realtime Database は公開読み取りのため、暗号化して保存する。

async function upsertPayment(cardNumber, piId, patch) {
  const ref = getDb().ref(`payments/${numberKey(cardNumber)}/${piId}`);
  const cur = (await ref.once('value')).val();
  const base = cur ? decrypt(cur) : {};
  await ref.set(encrypt(Object.assign(base, patch)));
}

async function listPayments(cardNumber) {
  const snap = await getDb().ref(`payments/${numberKey(cardNumber)}`).once('value');
  const raw = snap.val() || {};
  const items = [];
  for (const [piId, rec] of Object.entries(raw)) {
    try {
      items.push(Object.assign({ piId }, decrypt(rec)));
    } catch (e) {
      // 読めない記録は飛ばす
    }
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  return items;
}

module.exports = { upsertPayment, listPayments };
