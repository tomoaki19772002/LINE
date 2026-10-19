// LIFF ID は公開情報（ページ上で使うもの）。環境変数から渡すだけ。
module.exports = (req, res) => {
  if (!process.env.LIFF_ID) {
    res.status(503).json({ error: 'LIFF_ID is not configured' });
    return;
  }
  res.status(200).json({ liffId: process.env.LIFF_ID });
};
