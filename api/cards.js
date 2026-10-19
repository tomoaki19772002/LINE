const { verifyIdToken } = require('./_lineauth');
const { MAX_CARDS, loadCards, saveCards, parseCardInput } = require('./_cardstore');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const sub = await verifyIdToken(req);
  if (!sub) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const cards = await loadCards(sub);

    if (req.method === 'GET') {
      res.status(200).json({ cards });
      return;
    }

    if (req.method === 'POST') {
      const card = parseCardInput(req.body);
      if (!card) {
        res.status(400).json({ error: 'invalid input' });
        return;
      }
      const others = cards.filter(c => c.cardNumber !== card.cardNumber);
      if (others.length >= MAX_CARDS) {
        res.status(400).json({ error: 'too many cards' });
        return;
      }
      const updated = [...others, card];
      await saveCards(sub, updated);
      res.status(200).json({ cards: updated });
      return;
    }

    if (req.method === 'DELETE') {
      const cardNumber = String(req.query.cardNumber || '');
      const updated = cards.filter(c => c.cardNumber !== cardNumber);
      await saveCards(sub, updated);
      res.status(200).json({ cards: updated });
      return;
    }

    res.status(405).end();
  } catch (e) {
    // 個人情報をログに残さないため、メッセージのみ出力する
    console.error('cards api error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
};
