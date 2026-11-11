const Stripe = require('stripe');
const { upsertPayment } = require('./_payments');

// Stripe からの決済結果の通知を受け取る。
// 受付での請求直後の結果に加えて、あとから確定した結果（失敗・返金など）も、支払い履歴に反映する。

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: 'not configured' });
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await readRawBody(req);

  let event;
  try {
    // 署名を確認して、Stripe 以外からの偽の通知を弾く
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    res.status(400).json({ error: 'invalid signature' });
    return;
  }

  try {
    const obj = event.data.object;

    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
      const cardNumber = obj.metadata && obj.metadata.cardNumber;
      if (cardNumber) {
        await upsertPayment(cardNumber, obj.id, {
          amount: obj.amount,
          status: event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed',
          at: obj.created * 1000
        });
      }
    }

    if (event.type === 'charge.refunded') {
      const pi = obj.payment_intent ? await stripe.paymentIntents.retrieve(obj.payment_intent) : null;
      const cardNumber = pi && pi.metadata && pi.metadata.cardNumber;
      if (cardNumber) {
        await upsertPayment(cardNumber, pi.id, { amount: pi.amount, refunded: obj.amount_refunded });
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe-webhook error:', e.message);
    // Stripe に再送してもらうため 500 を返す
    res.status(500).json({ error: 'server error' });
  }
};

handler.config = { api: { bodyParser: false } };

module.exports = handler;
