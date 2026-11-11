// LIFF ID は公開情報（ページ上で使うもの）。環境変数から渡すだけ。
// PAY_PUBLIC=1 にすると、カード決済・診療明細書の欄を、全員に表示する（未設定の間は ?pay=1 のURLの人だけ）。
module.exports = (req, res) => {
  if (!process.env.LIFF_ID) {
    res.status(503).json({ error: 'LIFF_ID is not configured' });
    return;
  }
  res.status(200).json({ liffId: process.env.LIFF_ID, payPublic: process.env.PAY_PUBLIC === '1' });
};
