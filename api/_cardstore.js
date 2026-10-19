const crypto = require('crypto');
const { getDb } = require('./_firebase');

const MAX_CARDS = 6;

// Realtime Database のルールは公開読み取りのため、個人情報は必ず暗号化して保存する
function deriveKey(label) {
  const hex = process.env.CARD_ENCRYPTION_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('CARD_ENCRYPTION_KEY must be 64 hex characters');
  }
  return crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(label).digest();
}

function userPath(sub) {
  const id = crypto.createHmac('sha256', deriveKey('id')).update(sub).digest('hex');
  return `patientCards/${id}`;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('enc'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function decrypt(record) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey('enc'),
    Buffer.from(record.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plain.toString('utf8'));
}

async function loadCards(sub) {
  const snap = await getDb().ref(userPath(sub)).once('value');
  const record = snap.val();
  return record ? decrypt(record) : [];
}

async function saveCards(sub, cards) {
  const ref = getDb().ref(userPath(sub));
  if (cards.length === 0) {
    await ref.remove();
  } else {
    await ref.set(encrypt(cards));
  }
}

function toHalfWidthDigits(text) {
  return text.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 入力値を検証して正規化する。不正なら null を返す
function parseCardInput(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.cardNumber !== 'string' || typeof input.name !== 'string' || typeof input.birth !== 'string') {
    return null;
  }

  const cardNumber = toHalfWidthDigits(input.cardNumber.trim());
  if (!/^\d{1,12}$/.test(cardNumber)) return null;

  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) return null;

  const birth = input.birth.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null;
  const date = new Date(`${birth}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birth) return null;
  if (date.getUTCFullYear() < 1900 || date.getTime() > Date.now()) return null;

  return { cardNumber, name, birth };
}

module.exports = { MAX_CARDS, loadCards, saveCards, parseCardInput, encrypt, decrypt };
