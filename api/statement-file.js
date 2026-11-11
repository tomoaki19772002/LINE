const { resolveViewToken, readStatementPdf } = require('./_docstore');

// 短時間URL（5分）でPDFを返す。URLは /api/statements で本人確認のうえ発行されたものだけ。
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }

  try {
    const entry = await resolveViewToken(String(req.query.t || ''));
    if (!entry) {
      res.status(404).send('このURLは無効、または有効期限が切れています。診察券の画面からもう一度開いてください。');
      return;
    }
    const pdf = await readStatementPdf(entry.nKey, entry.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="meisai.pdf"');
    res.status(200).send(pdf);
  } catch (e) {
    console.error('statement-file error:', e.message);
    res.status(500).send('表示できませんでした。');
  }
};
