const crypto = require('crypto');
const Stripe = require('stripe');
const { getDb } = require('./_firebase');
const { verifyIdToken } = require('./_lineauth');
const { encrypt, decrypt, deriveKey } = require('./_cardstore');

// 支払い用クレジットカードの登録（Stripe SetupIntent）。
// カード番号は Stripe の埋め込みフォームから Stripe へ直接送られ、当院のサーバーには届かない。
// 保存するのは Stripe の顧客ID・支払い方法ID・カードの下4桁など。Firebase は公開読み取りのため暗号化して保存する。

function recordRef(sub) {
  const id = crypto.createHmac('sha256', deriveKey('stripe-id')).update(sub).digest('hex');
  return getDb().ref(`stripeCustomers/${id}`);
}

async function loadRecord(sub) {
  const snap = await recordRef(sub).once('value');
  const raw = snap.val();
  return raw ? decrypt(raw) : null;
}

async function saveRecord(sub, record) {
  await recordRef(sub).set(encrypt(record));
}

// 画面に返してよい項目だけ
function publicView(record) {
  if (!record || !record.paymentMethodId) return null;
  return {
    brand: record.brand,
    last4: record.last4,
    expMonth: record.expMonth,
    expYear: record.expYear,
    consentAt: record.consentAt
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    res.status(503).json({ error: 'payments not configured' });
    return;
  }

  const sub = await verifyIdToken(req);
  if (!sub) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    let record = await loadRecord(sub);

    // 登録状況の確認
    if (req.method === 'GET') {
      res.status(200).json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        card: publicView(record)
      });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // 1) カード登録の準備：SetupIntent を作って clientSecret を返す
      if (body.action === 'setup') {
        if (!record || !record.customerId) {
          const customer = await stripe.customers.create({ description: 'LINE診察券' });
          record = Object.assign({}, record, { customerId: customer.id });
          await saveRecord(sub, record);
        }
        const si = await stripe.setupIntents.create({
          customer: record.customerId,
          usage: 'off_session', // 会計後に後日請求するため
          payment_method_types: ['card']
        });
        res.status(200).json({ clientSecret: si.client_secret });
        return;
      }

      // 2) 登録の完了：Stripe 側で認証まで済んだ SetupIntent を確認して保存する
      if (body.action === 'complete') {
        if (body.consent !== true) {
          res.status(400).json({ error: 'consent required' });
          return;
        }
        if (typeof body.setupIntentId !== 'string' || !record || !record.customerId) {
          res.status(400).json({ error: 'invalid input' });
          return;
        }
        const si = await stripe.setupIntents.retrieve(body.setupIntentId);
        // クライアントの申告は信用せず、自分の顧客に紐づく成功済みの登録だけ受け付ける
        if (si.customer !== record.customerId || si.status !== 'succeeded' || !si.payment_method) {
          res.status(400).json({ error: 'setup not completed' });
          return;
        }
        const pm = await stripe.paymentMethods.retrieve(si.payment_method);
        const card = pm.card || {};

        const oldPm = record.paymentMethodId;
        record = Object.assign({}, record, {
          paymentMethodId: pm.id,
          brand: card.brand || '',
          last4: card.last4 || '',
          expMonth: card.exp_month || null,
          expYear: card.exp_year || null,
          consentAt: Date.now()
        });
        await saveRecord(sub, record);

        if (oldPm && oldPm !== pm.id) {
          await stripe.paymentMethods.detach(oldPm).catch(() => {});
        }
        res.status(200).json({ card: publicView(record) });
        return;
      }

      res.status(400).json({ error: 'invalid action' });
      return;
    }

    // カードの削除
    if (req.method === 'DELETE') {
      if (record && record.paymentMethodId) {
        await stripe.paymentMethods.detach(record.paymentMethodId).catch(() => {});
        delete record.paymentMethodId;
        delete record.brand;
        delete record.last4;
        delete record.expMonth;
        delete record.expYear;
        delete record.consentAt;
        await saveRecord(sub, record);
      }
      res.status(200).json({ card: null });
      return;
    }

    res.status(405).end();
  } catch (e) {
    // カード情報・個人情報をログに残さないため、メッセージのみ出力する
    console.error('pay-card api error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
};
