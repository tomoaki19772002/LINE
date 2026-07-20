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

function toHalfWidthDigits(text) {
  return text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

const RESERVATION_URL = 'https://5.mfmb.jp/mobile/index.php?guid=ON&clinic_number=900618';
const RESERVATION_NOTICE = '当院の予約専用サイトへ移動します。LINEと電話番号でログインすることも可能です。';

const INFO_NOTICE =
  '患者様個別のお問い合わせは仕組み上、当院スタッフが見れない状態です。個別のお問い合わせは当院へ直接お電話いただきますようお願いいたします。\n☎059-327-5652';

const FAQ_LIST = [
  {
    label: '①診察医は選べますか？',
    answer:
      '①診察医は選べますか？\n\n受付時・検査時にお申し出頂ければ希望の医師での診察が原則受けられます。ただし、受診後間もない再診の場合状態の変化を確認する必要がある場合には前回診察医での診療を勧めさせて頂く場合があります。'
  },
  {
    label: '②外出できますか？',
    answer:
      '②外出できますか？\n\n受付および検査まで終了している場合、診察までの待ち時間に外出することできます。LINEでの呼び出しになりますので登録が必要になります。'
  },
  {
    label: '③自費診療はどんなものがありますか？',
    answer:
      '③自費診療はどんなものがありますか？\n\n近視進行抑制のリジュセアミニ・眼瞼下垂治療のアップニークミニ・多焦点眼内レンズの取り扱い・コンタクトレンズの取り扱い等があります。ご不明な点があればお電話か直接受付や医師にお聞きいただければと思います。'
  }
];

async function replyMessages(replyToken, messages) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
}

async function replyMessage(replyToken, text) {
  await replyMessages(replyToken, [{ type: 'text', text }]);
}

async function replyReservationGuide(replyToken) {
  await replyMessages(replyToken, [{
    type: 'template',
    altText: RESERVATION_NOTICE,
    template: {
      type: 'buttons',
      text: RESERVATION_NOTICE,
      actions: [{ type: 'uri', label: '予約サイトへ移動', uri: RESERVATION_URL }]
    }
  }]);
}

async function replyFaqMenu(replyToken) {
  await replyMessages(replyToken, [{
    type: 'template',
    altText: 'よくある質問',
    template: {
      type: 'buttons',
      text: '気になる質問を選んでください',
      actions: FAQ_LIST.map((item, i) => ({
        type: 'postback',
        label: item.label,
        data: `faq=${i}`,
        displayText: item.label
      }))
    }
  }]);
}

async function handleEvent(event) {
  if (event.type === 'follow') {
    await replyMessage(
      event.replyToken,
      '友だち追加ありがとうございます。\n外出される際は、受付番号（数字）をこのトークに送信してください。呼び出しの際にLINEでお知らせします。'
    );
    return;
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const faqIndex = Number(params.get('faq'));
    const faqItem = FAQ_LIST[faqIndex];
    if (faqItem) {
      await replyMessage(event.replyToken, faqItem.answer);
    }
    return;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const text = event.message.text.trim();

    if (text === '予約') {
      await replyReservationGuide(event.replyToken);
      return;
    }

    if (text === 'よくある質問') {
      await replyFaqMenu(event.replyToken);
      return;
    }

    if (text === 'お知らせ') {
      await replyMessage(event.replyToken, INFO_NOTICE);
      return;
    }

    const num = Number(toHalfWidthDigits(text));
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
