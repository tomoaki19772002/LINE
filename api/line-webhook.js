const crypto = require('crypto');
const { getDb } = require('./_firebase');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isValidSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return signature === expected;
}

async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

async function handleEvent(event) {
  if (event.type === 'follow') {
    await replyMessage(
      event.replyToken,
      '友だち追加ありがとうございます。\n外出される際は、受付番号（数字）をこのトークに送信してください。呼び出しの際にLINEでお知らせします。'
    );
    return;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const num = Number(event.message.text.trim());
    const userId = event.source && event.source.userId;

    if (Number.isInteger(num) && num >= 1 && num <= 100 && userId) {
      const db = getDb();
      await db.ref(`lineRegistrations/${num}`).set({ userId, timestamp: Date.now() });
      await replyMessage(event.replyToken, `${num}番で登録しました。呼び出しの際にLINEでお知らせします。`);
    } else {
      await replyMessage(event.replyToken, '受付番号を数字だけで送信してください。（例：23）');
    }
  }
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);

  if (!isValidSignature(rawBody, req.headers['x-line-signature'])) {
    res.status(403).json({ error: 'invalid signature' });
    return;
  }

  const body = JSON.parse(rawBody.toString('utf8'));
  const events = body.events || [];

  await Promise.all(events.map(event => handleEvent(event)));

  res.status(200).json({ ok: true });
};

handler.config = { api: { bodyParser: false } };

module.exports = handler;
