import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import fs from 'fs';

// Put the service-account JSON you downloaded from Firebase in this folder:
//   server/firebase-service-account.json
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'))
  ),
  databaseURL: 'https://project1-e7dff-default-rtdb.firebaseio.com/' // ← paste your DB URL
});
const db = admin.database();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Require Firebase ID token (JWT) on every /api/* request
async function authGuard(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.sendStatus(403);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    next();
  } catch {
    res.sendStatus(403);
  }
}
app.use('/api', authGuard);

// REST endpoints
app.get('/api/sessions', async (req, res) => {
  const snap = await db.ref('sessions').orderByChild('ownerUid').equalTo(req.user.uid).once('value');
  const val = snap.val() || {};
  const list = Object.entries(val).map(([id, v]) => ({ id, ...v }))
    .sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  res.json(list);
});

app.post('/api/sessions', async (req, res) => {
  const now = new Date().toISOString();
  const ref = db.ref('sessions').push();
  await ref.set({ ownerUid: req.user.uid, title: req.body?.title || 'New chat', createdAt: now, updatedAt: now });
  res.json({ id: ref.key });
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  const sess = (await db.ref(`sessions/${req.params.id}`).once('value')).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);
  const snap = await db.ref(`messagesBySession/${req.params.id}`).orderByChild('createdAt').once('value');
  const val = snap.val() || {};
  res.json(Object.entries(val).map(([id, v]) => ({ id, ...v })));
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once('value')).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const now = new Date().toISOString();
  await db.ref(`messagesBySession/${req.params.id}`).push()
    .set({ ownerUid: req.user.uid, role:'user', content, createdAt: now });

  // TODO: call your LLM here (keep API key on the server)
  const reply = `You said: ${content}`;

  await db.ref(`messagesBySession/${req.params.id}`).push()
    .set({ ownerUid: req.user.uid, role:'assistant', content: reply, createdAt: new Date().toISOString() });
  await sessRef.update({ updatedAt: new Date().toISOString(), title: sess.title || content.slice(0,40) });

  res.json({ reply });
});

app.listen(8080, () => console.log('API running on http://localhost:8080'));
