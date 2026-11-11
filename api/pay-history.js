const { verifyIdToken } = require('./_lineauth');
const { loadCards, userPath } = require('./_cardstore');
const { getVerifiedOwner } = require('./_docstore');
const { listPayments } = require('./_payments');

// 患者さん用：自分の診察券（受付で確認済みのもの）でのカード決済の履歴。
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }

  const sub = await verifyIdToken(req);
  if (!sub) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const myOwnerId = userPath(sub).split('/')[1];
    const result = [];
    for (const c of await loadCards(sub)) {
      if ((await getVerifiedOwner(c.cardNumber)) !== myOwnerId) continue;
      const payments = (await listPayments(c.cardNumber))
        .filter(p => p.status === 'succeeded')
        .map(p => ({
          receiptNo: String(p.piId).slice(-8).toUpperCase(),
          at: p.at,
          amount: p.amount,
          refunded: p.refunded || 0,
          brand: p.brand || '',
          last4: p.last4 || ''
        }));
      result.push({ cardNumber: c.cardNumber, name: c.name, payments });
    }
    res.status(200).json({ cards: result });
  } catch (e) {
    console.error('pay-history api error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
};
