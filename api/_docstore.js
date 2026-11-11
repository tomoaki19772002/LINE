const crypto = require('crypto');
const { getDb } = require('./_firebase');
const { encrypt, decrypt, deriveKey } = require('./_cardstore');

// 診療明細書（PDF）の保管。
// ・PDFは暗号化して Realtime Database に置く（公開読み取りでも、鍵がなければ読めない）
// ・見られるのは「受付で本人確認済みの診察券」を持つ、その本人（LINEアカウント）だけ
// ・診察券番号は、保存先の名前にそのまま使わず HMAC で伏せる

const MAX_PDF_BYTES = 3 * 1024 * 1024;

function numberKey(cardNumber) {
  return crypto.createHmac('sha256', deriveKey('doc-num')).update(cardNumber).digest('hex');
}

// ── 受付で確認済みの診察券（番号ごとに、持ち主は1人だけ）──
async function getVerifiedOwner(cardNumber) {
  const snap = await getDb().ref(`verifiedCards/${numberKey(cardNumber)}`).once('value');
  const raw = snap.val();
  return raw ? decrypt(raw).ownerId : null;
}

async function setVerifiedOwner(cardNumber, ownerId) {
  await getDb().ref(`verifiedCards/${numberKey(cardNumber)}`).set(encrypt({ ownerId, at: Date.now() }));
}

// ── 明細書 ──
// PDF本体は statementBlobs に、AES-256-GCMで暗号化して置く（一覧用の情報は statements に別に置く）。
// 暗号鍵はサーバーだけが持つため、データベースが公開読み取りでも、中身は読めない。
async function saveStatement(cardNumber, date, pdfBuffer) {
  const nKey = numberKey(cardNumber);
  const id = crypto.randomBytes(8).toString('hex');
  await getDb().ref(`statementBlobs/${nKey}/${id}`).set(encrypt({ pdf: pdfBuffer.toString('base64') }));
  await getDb().ref(`statements/${nKey}/${id}`).set(encrypt({ date, size: pdfBuffer.length, at: Date.now() }));
  return id;
}

async function listStatements(cardNumber) {
  const snap = await getDb().ref(`statements/${numberKey(cardNumber)}`).once('value');
  const raw = snap.val() || {};
  const items = [];
  for (const [id, rec] of Object.entries(raw)) {
    try {
      const m = decrypt(rec);
      items.push({ id, date: m.date, at: m.at });
    } catch (e) {
      // 読めない記録は飛ばす
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.at - a.at));
  return items;
}

async function deleteStatement(cardNumber, id) {
  const nKey = numberKey(cardNumber);
  await getDb().ref(`statementBlobs/${nKey}/${id}`).remove();
  await getDb().ref(`statements/${nKey}/${id}`).remove();
}

async function readStatementPdf(nKey, id) {
  const raw = (await getDb().ref(`statementBlobs/${nKey}/${id}`).once('value')).val();
  if (!raw) throw new Error('statement not found');
  return Buffer.from(decrypt(raw).pdf, 'base64');
}

// ── 閲覧用の短時間URL（LINEの中でPDFを開くため、ログイン情報をヘッダーで渡せない代わりに使う）──
const TOKEN_TTL_MS = 5 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueViewToken(cardNumber, id) {
  const token = crypto.randomBytes(24).toString('hex');
  await getDb().ref(`statementTokens/${tokenHash(token)}`).set({
    nKey: numberKey(cardNumber), id, exp: Date.now() + TOKEN_TTL_MS
  });
  return token;
}

async function resolveViewToken(token) {
  if (!/^[0-9a-f]{48}$/.test(token || '')) return null;
  const ref = getDb().ref(`statementTokens/${tokenHash(token)}`);
  const v = (await ref.once('value')).val();
  if (!v) return null;
  if (Date.now() > v.exp) {
    await ref.remove();
    return null;
  }
  return v;
}

module.exports = {
  MAX_PDF_BYTES, numberKey, getVerifiedOwner, setVerifiedOwner,
  saveStatement, listStatements, deleteStatement, readStatementPdf,
  issueViewToken, resolveViewToken
};
