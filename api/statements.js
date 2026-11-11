const { verifyIdToken } = require('./_lineauth');
const { loadCards, userPath } = require('./_cardstore');
const { getVerifiedOwner, listStatements, issueViewToken } = require('./_docstore');

// 患者さん用：自分の診察券（受付で確認済みのもの）に紐づく診療明細書の一覧と、閲覧用の短時間URL。
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const sub = await verifyIdToken(req);
  if (!sub) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const myOwnerId = userPath(sub).split('/')[1];

    // 受付で確認済みで、かつ自分が持ち主の診察券だけを対象にする
    async function myVerifiedCards() {
      const cards = await loadCards(sub);
      const out = [];
      for (const c of cards) {
        if ((await getVerifiedOwner(c.cardNumber)) === myOwnerId) out.push(c);
      }
      return out;
    }

    if (req.method === 'GET') {
      const result = [];
      for (const c of await myVerifiedCards()) {
        const items = await listStatements(c.cardNumber);
        result.push({
          cardNumber: c.cardNumber,
          name: c.name,
          statements: items.map(i => ({ id: i.id, date: i.date }))
        });
      }
      res.status(200).json({ cards: result });
      return;
    }

    // 閲覧用URLの発行
    if (req.method === 'POST') {
      const body = req.body || {};
      const cardNumber = String(body.cardNumber || '');
      const id = String(body.id || '');
      if (!/^[0-9a-f]{16}$/.test(id)) {
        res.status(400).json({ error: 'invalid input' });
        return;
      }
      const mine = await myVerifiedCards();
      if (!mine.some(c => c.cardNumber === cardNumber)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const exists = (await listStatements(cardNumber)).some(i => i.id === id);
      if (!exists) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const token = await issueViewToken(cardNumber, id);
      res.status(200).json({ url: `/api/statement-file?t=${token}` });
      return;
    }

    res.status(405).end();
  } catch (e) {
    console.error('statements api error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
};
