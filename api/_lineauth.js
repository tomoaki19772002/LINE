// LIFF の ID は「<LINEログインチャネルID>-<ランダム文字列>」の形式
function getChannelId() {
  const liffId = process.env.LIFF_ID || '';
  return liffId.split('-')[0];
}

// Authorization: Bearer <IDトークン> を LINE に検証してもらい、LINEユーザーID(sub)を返す。
// クライアントが申告したユーザーIDは信用しない。
async function verifyIdToken(req) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  const channelId = getChannelId();
  if (!match || !channelId) return null;

  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: match[1], client_id: channelId })
  });
  if (!res.ok) return null;

  const data = await res.json();
  return data.sub || null;
}

module.exports = { verifyIdToken };
