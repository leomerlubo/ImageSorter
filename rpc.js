const { getAdmin, getDb } = require('../lib/firebase-admin');

const CONFIG = {
  totalSkus: 37892,
  minutesPerTask: 2,
  taskCollection: 'tasks',
  settingsCollection: 'settings',
  settingsDoc: 'app',
  userStatsCollection: 'userStats'
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function allowedUser(email) {
  const emails = String(process.env.ALLOWED_EMAILS || '')
    .split(',').map(normalizeEmail).filter(Boolean);
  const domains = String(process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',').map(v => normalizeEmail(v).replace(/^@/, '')).filter(Boolean);

  if (!emails.length && !domains.length) return true;
  return emails.includes(email) || domains.some(domain => email.endsWith('@' + domain));
}

async function authenticate(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Sign in is required.'), { status: 401 });

  const token = header.slice(7);
  const decoded = await getAdmin().auth().verifyIdToken(token);
  const email = normalizeEmail(decoded.email);

  if (!email || !allowedUser(email)) {
    throw Object.assign(new Error('This Google account is not authorized.'), { status: 403 });
  }

  return { email, uid: decoded.uid };
}

async function getSettings(db) {
  const snap = await db.collection(CONFIG.settingsCollection).doc(CONFIG.settingsDoc).get();
  const data = snap.exists ? snap.data() : {};
  return {
    totalSkus: Number(data.totalSkus || CONFIG.totalSkus),
    minutesPerTask: Number(data.minutesPerTask || CONFIG.minutesPerTask)
  };
}

async function releaseExpiredLocks(db) {
  const now = new Date();
  const snap = await db.collection(CONFIG.taskCollection).where('status', '==', 'in_progress').limit(500).get();
  const batch = db.batch();
  let released = 0;

  snap.docs.forEach(doc => {
    const data = doc.data();
    const expiresAt = data.expiresAt && typeof data.expiresAt.toDate === 'function'
      ? data.expiresAt.toDate()
      : data.expiresAt ? new Date(data.expiresAt) : null;
    if (!expiresAt || expiresAt <= now) {
      batch.update(doc.ref, { status: 'available', lockedByEmail: '', lockedAt: null, expiresAt: null });
      released++;
    }
  });

  if (released) await batch.commit();
  return released;
}

async function getNextBatch(args, user) {
  const db = getDb();
  const requested = Math.max(1, Math.min(Number(args[0] || 10), 100));
  await releaseExpiredLocks(db);
  const settings = await getSettings(db);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.minutesPerTask * 60 * 1000);

  return db.runTransaction(async tx => {
    const query = db.collection(CONFIG.taskCollection).where('status', '==', 'available').limit(requested * 4);
    const snap = await tx.get(query);
    const result = [];

    for (const doc of snap.docs) {
      if (result.length >= requested) break;
      const task = doc.data();
      const images = Array.isArray(task.images) ? task.images : [];

      if (!task.sku || images.length < 2) {
        tx.update(doc.ref, {
          status: 'done', skipped: true, completedByEmail: 'system',
          completedAt: now, lockedByEmail: '', lockedAt: null, expiresAt: null
        });
        continue;
      }

      tx.update(doc.ref, {
        status: 'in_progress', lockedByEmail: user.email, lockedAt: now, expiresAt
      });
      result.push({ rowNumber: doc.id, sku: task.sku, description: task.description || '', images });
    }
    return result;
  });
}

async function saveBatchResults(args, user) {
  const db = getDb();
  const payload = args[0] || {};
  const results = Array.isArray(payload.results) ? payload.results.slice(0, 400) : [];
  let completed = 0;

  await db.runTransaction(async tx => {
    const validResults = results
      .map(item => ({ item, taskId: String(item.rowNumber || item.sku || '').trim() }))
      .filter(entry => entry.taskId);
    const refs = validResults.map(entry => db.collection(CONFIG.taskCollection).doc(entry.taskId));
    const snapshots = refs.length ? await tx.getAll(...refs) : [];

    for (let index = 0; index < validResults.length; index++) {
      const { item } = validResults[index];
      const ref = refs[index];
      const snap = snapshots[index];
      if (!snap.exists) continue;
      const task = snap.data();
      if (task.status === 'done') continue;
      if (normalizeEmail(task.lockedByEmail) && normalizeEmail(task.lockedByEmail) !== user.email) continue;

      const selectedImages = Array.isArray(item.selectedImages) ? item.selectedImages.filter(Boolean) : [];
      const skipped = item.skipped === true;
      if (skipped || selectedImages.length) {
        tx.update(ref, {
          status: 'done', completedByEmail: user.email, completedAt: new Date(),
          selectedImages, skipped, lockedByEmail: '', lockedAt: null, expiresAt: null
        });
        completed++;
      } else {
        tx.update(ref, { status: 'available', lockedByEmail: '', lockedAt: null, expiresAt: null });
      }
    }

    if (completed) {
      const statsRef = db.collection(CONFIG.userStatsCollection).doc(user.email);
      tx.set(statsRef, {
        email: user.email,
        completedCount: getAdmin().firestore.FieldValue.increment(completed),
        updatedAt: new Date()
      }, { merge: true });
    }
  });
  return true;
}

async function releaseSessionLocks(args, user) {
  const db = getDb();
  const snap = await db.collection(CONFIG.taskCollection).where('lockedByEmail', '==', user.email).limit(1000).get();
  const locked = snap.docs.filter(doc => doc.data().status === 'in_progress');
  for (let offset = 0; offset < locked.length; offset += 450) {
    const batch = db.batch();
    locked.slice(offset, offset + 450).forEach(doc => {
      batch.update(doc.ref, { status: 'available', lockedByEmail: '', lockedAt: null, expiresAt: null });
    });
    await batch.commit();
  }
  return true;
}

async function getProgressReport() {
  const db = getDb();
  const [settings, snap] = await Promise.all([
    getSettings(db),
    db.collection(CONFIG.userStatsCollection).limit(500).get()
  ]);
  let totalCompleted = 0;
  const users = snap.docs.map(doc => {
    const data = doc.data();
    const completedCount = Number(data.completedCount || 0);
    totalCompleted += completedCount;
    return {
      email: data.email || doc.id,
      alias: data.alias || '',
      displayName: data.alias || data.email || doc.id,
      uniqueSkuCount: completedCount,
      contributionPercent: settings.totalSkus ? completedCount / settings.totalSkus * 100 : 0
    };
  }).sort((a, b) => b.uniqueSkuCount - a.uniqueSkuCount || a.displayName.localeCompare(b.displayName));

  return {
    totalSkus: settings.totalSkus,
    totalCompletedUniqueSkus: totalCompleted,
    overallCompletionPercent: settings.totalSkus ? totalCompleted / settings.totalSkus * 100 : 0,
    users
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

async function exportCompletedTasksCsv() {
  const db = getDb();
  const snap = await db.collection(CONFIG.taskCollection).where('status', '==', 'done').limit(50000).get();
  const rows = [['Handle', 'Image Src', 'Image Position', 'Created By Email']];
  snap.docs.forEach(doc => {
    const task = doc.data();
    const sku = String(task.sku || doc.id || '').trim();
    const email = normalizeEmail(task.completedByEmail);
    const images = Array.isArray(task.selectedImages) ? task.selectedImages : [];
    if (!sku || !email) return;
    images.forEach((url, index) => { if (url) rows.push([sku, url, index + 1, email]); });
  });
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

const actions = { getNextBatch, saveBatchResults, releaseSessionLocks, getProgressReport, exportCompletedTasksCsv };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const user = await authenticate(req);
    const action = String(req.body?.action || '');
    const args = Array.isArray(req.body?.args) ? req.body.args : [];
    if (!actions[action]) return res.status(404).json({ error: 'Unknown server action.' });
    const result = await actions[action](args, user);
    return res.status(200).json({ result });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.message || 'Server error.' });
  }
};
