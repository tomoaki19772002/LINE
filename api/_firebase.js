const admin = require('firebase-admin');

const DATABASE_URL = 'https://kawagoeasahi-72e5d-default-rtdb.firebaseio.com';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'kawagoeasahi-72e5d.firebasestorage.app';

function ensureApp() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DATABASE_URL,
      storageBucket: STORAGE_BUCKET
    });
  }
}

function getDb() {
  ensureApp();
  return admin.database();
}

function getBucket() {
  ensureApp();
  return admin.storage().bucket();
}

module.exports = { getDb, getBucket };
