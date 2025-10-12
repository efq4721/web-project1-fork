// server/index.js
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

// ---- Firebase Admin (Render env) ----
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();
const app = express();

// ---- CORS ----
const allowed = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsMw = cors({
  origin: (origin, cb) => cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
  credentials: true
});
app.use(corsMw);

// ✅ Express 5: handle ALL preflight without using '*' path
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Health
app.get('/', (_req, res) => res.send('API is running'));
app.get('/ping', (_req, res) => res.json({ status: 'ok' }));

// ---- Auth guard (single definition)
async function authGuard(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.sendStatus(403);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    next();
  } catch (e) {
    console.error('verifyIdToken error:', e?.message || e);
    res.sendStatus(403);
  }
}

// ---- API router under /api
const api = express.Router();
api.use(authGuard);

api.get('/sessions', async (req, res) => {
  const snap = await db.ref('sessions')
    .orderByChild('ownerUid').equalTo(req.user.uid).once('value');
  const val = snap.val() || {};
  const list = Object.entries(val).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

api.post('/sessions', async (req, res) => {
  const now = new Date().toISOString();
  const ref = db.ref('sessions').push();
  await ref.set({ ownerUid: req.user.uid, title: req.body?.title || 'New chat', createdAt: now, updatedAt: now });
  res.json({ id: ref.key });
});

api.get('/sessions/:id/messages', async (req, res) => {
  const sess = (await db.ref(`sessions/${req.params.id}`).once('value')).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db.ref(`messagesBySession/${req.params.id}`)
    .orderByChild('createdAt').once('value');
  const msgs = [];
  snap.forEach(child => msgs.push({ id: child.key, ...child.val() }));
  res.json(msgs);
});

api.post('/sessions/:id/messages', async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once('value')).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const now = new Date().toISOString();
  await db.ref(`messagesBySession/${req.params.id}`).push()
    .set({ ownerUid: req.user.uid, role:'user', content, createdAt: now });

  const reply = `You said: ${content}`;

  await db.ref(`messagesBySession/${req.params.id}`).push()
    .set({ ownerUid: req.user.uid, role:'assistant', content: reply, createdAt: new Date().toISOString() });

  await sessRef.update({ updatedAt: new Date().toISOString(), title: sess.title || content.slice(0,40) });

  res.json({ reply });
});

app.use('/api', api);

// Debug 404
app.use((req, res) => {
  console.warn('404', req.method, req.path);
  res.status(404).send(`No route for ${req.method} ${req.path}`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
