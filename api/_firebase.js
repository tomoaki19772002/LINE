const admin = require('firebase-admin');

const DATABASE_URL = 'https://kawagoeasahi-72e5d-default-rtdb.firebaseio.com';

function getDb() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DATABASE_URL
    });
  }
  return admin.database();
}

module.exports = { getDb };
