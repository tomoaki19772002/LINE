const { getDb } = require('./_firebase');

// 受付スタッフ用：LINE登録の強制クリア（患者さんにはLINEを一切送らない）と、直前1回分の復元。
// 復元用の控えは lineClearBackup に1件だけ保持し、新しくクリアするたびに上書きする。
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const body = req.body || {};
  const db = getDb();
  const backupRef = db.ref('lineClearBackup');

  // ── 直前のクリアを元に戻す ──
  if (body.action === 'undo') {
    const backup = (await backupRef.once('value')).val();
    if (!backup || !backup.registration) {
      res.status(200).json({ restored: false, reason: 'nothing' });
      return;
    }

    const num = backup.number;
    // 同じ番号が再登録されていたら、新しい登録を上書きしない
    const tx = await db.ref(`lineRegistrations/${num}`).transaction(current =>
      current === null ? backup.registration : undefined
    );

    if (!tx.committed) {
      res.status(200).json({ restored: false, reason: 'occupied', number: num });
      return;
    }

    await backupRef.remove(); // 戻れるのは1回だけ
    res.status(200).json({ restored: true, number: num });
    return;
  }

  // ── 強制クリア ──
  const num = Number(body.number);
  if (!Number.isInteger(num) || num < 1 || num > 100) {
    res.status(400).json({ error: 'invalid number' });
    return;
  }

  const ref = db.ref(`lineRegistrations/${num}`);
  const registration = (await ref.once('value')).val();
  if (!registration) {
    res.status(200).json({ cleared: false });
    return;
  }

  await backupRef.set({ number: num, registration, clearedAt: Date.now() });
  await ref.remove();

  res.status(200).json({ cleared: true, number: num });
};
