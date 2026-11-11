const crypto = require('crypto');
const Stripe = require('stripe');
const { getDb } = require('./_firebase');
const { encrypt, decrypt } = require('./_cardstore');
const { loadAllRecords, loadRecordById, saveRecordById, loadCardsOf } = require('./_paystore');

// 受付スタッフ用：カードの本人確認、診察券番号での請求、請求履歴。
// お金が動くため、スタッフ用の合言葉（環境変数 STAFF_PIN）がないと一切使えない。

const MAX_AMOUNT = 200000; // 1回の請求の上限（円）。誤入力の事故防止
const PIN_FAIL_LIMIT = 10;
const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000;

function pinMatches(given) {
  const expected = process.env.STAFF_PIN || '';
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// 合言葉の総当たり対策：失敗が続いたら一定時間ロックする（全員共通の記録）
async function pinLocked() {
  const snap = await getDb().ref('staffPinFails').once('value');
  const fails = (snap.val() || []).filter(t => Date.now() - t < PIN_FAIL_WINDOW_MS);
  return fails.length >= PIN_FAIL_LIMIT;
}

async function recordPinFail() {
  const ref = getDb().ref('staffPinFails');
  const snap = await ref.once('value');
  const fails = (snap.val() || []).filter(t => Date.now() - t < PIN_FAIL_WINDOW_MS);
  fails.push(Date.now());
  await ref.set(fails);
}

function parseCardNumber(value) {
  const s = String(value || '').trim().replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return /^\d{1,12}$/.test(s) ? s : null;
}

// 受付が確認済みにした診察券番号から、請求先を探す
async function findVerified(cardNumber) {
  const all = await loadAllRecords();
  for (const { id, record } of all) {
    if (record.verifiedCardNumber !== cardNumber || !record.paymentMethodId) continue;
    const cards = await loadCardsOf(record);
    const card = cards.find(c => c.cardNumber === cardNumber);
    if (!card) continue; // 本人が診察券を削除していたら請求しない
    return { id, record, card };
  }
  return null;
}

async function writeLog(entry) {
  await getDb().ref('payLog').push(encrypt(Object.assign({ at: Date.now() }, entry)));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STAFF_PIN) {
    res.status(503).json({ error: 'not configured' });
    return;
  }

  try {
    if (await pinLocked()) {
      res.status(429).json({ error: 'locked' });
      return;
    }
    if (!pinMatches(req.headers['x-staff-pin'])) {
      await recordPinFail();
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = req.body || {};

    // 合言葉の確認だけ
    if (body.action === 'ping') {
      res.status(200).json({ ok: true });
      return;
    }

    // 受付の確認待ちの登録一覧：自己申告の診察券と、カードの種類・下4桁
    if (body.action === 'pending') {
      const all = await loadAllRecords();
      const verifiedNumbers = new Set(all.map(a => a.record.verifiedCardNumber).filter(Boolean));
      const items = [];
      for (const { id, record } of all) {
        if (!record.paymentMethodId || record.verifiedCardNumber) continue;
        const cards = await loadCardsOf(record);
        items.push({
          ref: id,
          brand: record.brand,
          last4: record.last4,
          registeredAt: record.consentAt,
          // taken: すでに別の人のカードが、この診察券番号で確認済み
          cards: cards.map(c => ({
            cardNumber: c.cardNumber, name: c.name, birth: c.birth, taken: verifiedNumbers.has(c.cardNumber)
          }))
        });
      }
      items.sort((a, b) => b.registeredAt - a.registeredAt);
      res.status(200).json({ items });
      return;
    }

    // 確認済みにする：受付で本人と診察券を確かめたあとに押す
    if (body.action === 'verify') {
      const ref = String(body.ref || '');
      const cardNumber = parseCardNumber(body.cardNumber);
      if (!/^[0-9a-f]{64}$/.test(ref) || !cardNumber) {
        res.status(400).json({ error: 'invalid input' });
        return;
      }
      const record = await loadRecordById(ref);
      if (!record || !record.paymentMethodId) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const cards = await loadCardsOf(record);
      if (!cards.some(c => c.cardNumber === cardNumber)) {
        res.status(400).json({ error: 'card number not registered' });
        return;
      }
      // 同じ診察券番号を別の人が確認済みにしていたら、そちらは取り消す（請求先は1人だけ）
      const all = await loadAllRecords();
      for (const other of all) {
        if (other.id !== ref && other.record.verifiedCardNumber === cardNumber) {
          delete other.record.verifiedCardNumber;
          delete other.record.verifiedAt;
          await saveRecordById(other.id, other.record);
        }
      }
      record.verifiedCardNumber = cardNumber;
      record.verifiedAt = Date.now();
      await saveRecordById(ref, record);
      res.status(200).json({ ok: true });
      return;
    }

    // 請求先の確認：診察券番号から、確認済みのカードを探す
    if (body.action === 'lookup') {
      const cardNumber = parseCardNumber(body.cardNumber);
      if (!cardNumber) {
        res.status(400).json({ error: 'invalid input' });
        return;
      }
      const found = await findVerified(cardNumber);
      if (!found) {
        res.status(200).json({ found: false });
        return;
      }
      res.status(200).json({
        found: true,
        name: found.card.name,
        brand: found.record.brand,
        last4: found.record.last4
      });
      return;
    }

    // 請求
    if (body.action === 'charge') {
      const cardNumber = parseCardNumber(body.cardNumber);
      const amount = body.amount;
      const key = String(body.idempotencyKey || '');
      if (!cardNumber || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !/^[\w-]{16,64}$/.test(key)) {
        res.status(400).json({ error: 'invalid input' });
        return;
      }
      const found = await findVerified(cardNumber);
      if (!found) {
        res.status(200).json({ ok: false, reason: 'not_verified' });
        return;
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      let intent;
      try {
        intent = await stripe.paymentIntents.create({
          amount,
          currency: 'jpy',
          customer: found.record.customerId,
          payment_method: found.record.paymentMethodId,
          off_session: true,
          confirm: true,
          description: '診療費',
          metadata: { cardNumber }
        }, { idempotencyKey: key });
      } catch (e) {
        // カード会社に断られた場合（残高不足・認証が必要など）
        if (e && e.type === 'StripeCardError') {
          const reason = e.code === 'authentication_required' ? 'authentication_required' : (e.code || 'declined');
          await writeLog({ cardNumber, amount, ok: false, reason, piId: e.payment_intent && e.payment_intent.id });
          res.status(200).json({ ok: false, reason });
          return;
        }
        throw e;
      }

      const ok = intent.status === 'succeeded';
      await writeLog({ cardNumber, amount, ok, reason: ok ? null : intent.status, piId: intent.id });
      res.status(200).json({ ok, reason: ok ? null : intent.status });
      return;
    }

    // 直近の請求履歴
    if (body.action === 'recent') {
      const snap = await getDb().ref('payLog').orderByKey().limitToLast(30).once('value');
      const raw = snap.val() || {};
      const items = Object.values(raw).map(r => {
        try { return decrypt(r); } catch (e) { return null; }
      }).filter(Boolean);
      items.sort((a, b) => b.at - a.at);
      res.status(200).json({ items });
      return;
    }

    res.status(400).json({ error: 'invalid action' });
  } catch (e) {
    console.error('staff-pay api error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
};
