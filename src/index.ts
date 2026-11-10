import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';

import { hashPassword, optionalUser, requireUser, signToken, verifyGoogleIdToken, verifyPassword, type Authed } from './auth';
import { connectDb, dbReady, requireDb } from './db';
import { compareRecitation } from './arabic';
import { Bookmark, Goal, Mistake, PracticeSession, TestRun, User } from './models';
import { warmLocalAsr } from './transcribe';
import { ensureQuran, quranReady, rangeText, searchTranscript } from './quran';
import { computeStats } from './stats';
import { AsrNotConfiguredError, asrStatus, transcribe } from './transcribe';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const route = (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown> | unknown) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

type AuthedRequest = express.Request & { user: Authed };

function dayStamp(value?: string) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

async function publicUser(id: string) {
  const row = await User.findById(id).lean();
  if (!row) return null;
  return {
    id: row._id,
    email: row.email,
    name: row.name,
    provider: row.googleSub ? 'google' : 'email',
    premium: Boolean(row.premium),
  };
}

async function loadSync(userId: string) {
  const [user, bookmarks, goals, sessions, mistakes, tests] = await Promise.all([
    User.findById(userId).lean(),
    Bookmark.find({ userId }).sort({ surah: 1, ayah: 1 }).lean(),
    Goal.find({ userId }).lean(),
    PracticeSession.find({ userId }).sort({ day: 1 }).lean(),
    Mistake.find({ userId }).sort({ createdAt: -1 }).lean(),
    TestRun.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const stats = computeStats(
    sessions.map((row) => ({ day: row.day, minutes: row.minutes, surah_id: row.surahId ?? null, kind: row.kind })),
    mistakes.map((row) => ({ surah: row.surah, resolved: row.resolved })),
  );
  stats.badges = stats.badges.map((badge) => (badge.id === 'goal' ? { ...badge, earned: goals.length > 0 } : badge));
  return {
    premium: Boolean(user?.premium),
    settings: user?.settings ?? {},
    bookmarks: bookmarks.map((row) => ({
      id: row._id,
      surah: row.surah,
      ayah: row.ayah,
      note: row.note || undefined,
      createdLabel: row.createdLabel || 'Saved',
    })),
    goals: goals.map((row) => ({
      id: row._id,
      type: row.type,
      title: row.title,
      detail: row.detail,
      progress: Number(row.progress) || 0,
      surahId: row.surahId,
      frequency: row.frequency,
      reminder: row.reminder,
    })),
    sessions: sessions.map((row) => ({
      id: row._id,
      day: row.day,
      minutes: row.minutes,
      surahId: row.surahId,
      kind: row.kind,
    })),
    mistakes: mistakes.map((row) => ({
      id: row._id,
      surah: row.surah,
      ayah: row.ayah,
      kind: row.kind,
      said: row.said,
      correct: row.correct,
      note: row.note,
      count: row.count,
      resolved: row.resolved,
      when: row.createdAt ? new Date(row.createdAt).toLocaleDateString() : 'Saved',
    })),
    tests: tests.map((row) => ({
      id: row._id,
      range_label: row.rangeLabel,
      minutes: row.minutes,
      accuracy: row.accuracy,
      correct_count: row.correctCount,
      mistake_count: row.mistakeCount,
      review: row.review,
      created_at: row.createdAt,
    })),
    stats,
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, db: dbReady, quran: quranReady(), asr: asrStatus() });
});

app.post('/api/auth/register', route(async (req, res) => {
  requireDb();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim() || email.split('@')[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: 'Use a password of at least 4 characters.' });
    return;
  }
  if (await User.exists({ email })) {
    res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
    return;
  }
  const created = await User.create({ email, name, passwordHash: await hashPassword(password) });
  const user = await publicUser(created.id);
  res.status(201).json({ token: signToken(created.id, email), user });
}));

app.post('/api/auth/login', route(async (req, res) => {
  requireDb();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const row = await User.findOne({ email });
  if (!row?.passwordHash || !(await verifyPassword(password, row.passwordHash))) {
    res.status(401).json({ error: 'Email or password is incorrect.' });
    return;
  }
  const user = await publicUser(row.id);
  res.json({ token: signToken(row.id, email), user });
}));

app.post('/api/auth/google', route(async (req, res) => {
  requireDb();
  try {
    const profile = await verifyGoogleIdToken(String(req.body?.idToken || ''));
    let row = await User.findOne({ googleSub: profile.sub });
    if (!row) row = await User.findOne({ email: profile.email });
    if (row) {
      row.googleSub = profile.sub;
      if (!row.name) row.name = profile.name;
      await row.save();
    } else {
      row = await User.create({ email: profile.email, name: profile.name, googleSub: profile.sub });
    }
    const user = await publicUser(row.id);
    res.json({ token: signToken(row.id, profile.email), user });
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Google sign-in failed.' });
  }
}));

app.get('/api/me', requireUser, route(async (req, res) => {
  const user = await publicUser((req as AuthedRequest).user.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  res.json({ user });
}));

app.get('/api/sync', requireUser, route(async (req, res) => {
  res.json(await loadSync((req as AuthedRequest).user.id));
}));

app.put('/api/sync', requireUser, route(async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const body = req.body ?? {};
  const settings = { ...(body.settings ?? {}) };
  delete settings.serverUrl;
  await User.updateOne({ _id: userId }, { $set: { settings } });
  await Bookmark.deleteMany({ userId });
  if (body.bookmarks?.length) {
    await Bookmark.insertMany(
      body.bookmarks.map((bookmark: { id?: string; surah: number; ayah: number; note?: string; createdLabel?: string }) => ({
        _id: String(bookmark.id || randomUUID()),
        userId,
        surah: Number(bookmark.surah),
        ayah: Number(bookmark.ayah),
        note: bookmark.note,
        createdLabel: bookmark.createdLabel || 'Saved',
      })),
    );
  }
  await Goal.deleteMany({ userId });
  if (body.goals?.length) {
    await Goal.insertMany(
      body.goals.map((goal: { id?: string; type: string; title: string; detail: string; progress?: number; surahId: number; frequency: string; reminder: string }) => ({
        _id: String(goal.id || randomUUID()),
        userId,
        type: goal.type,
        title: goal.title,
        detail: goal.detail,
        progress: Number(goal.progress) || 0,
        surahId: Number(goal.surahId),
        frequency: goal.frequency,
        reminder: goal.reminder,
      })),
    );
  }
  await PracticeSession.deleteMany({ userId });
  if (body.sessions?.length) {
    await PracticeSession.insertMany(
      body.sessions.map((session: { id?: string; day?: string; minutes?: number; surahId?: number; kind?: string }) => ({
        _id: String(session.id || randomUUID()),
        userId,
        day: dayStamp(session.day),
        minutes: Number(session.minutes) || 1,
        surahId: session.surahId ? Number(session.surahId) : undefined,
        kind: session.kind || 'read',
      })),
    );
  }
  await Mistake.deleteMany({ userId });
  if (body.mistakes?.length) {
    await Mistake.insertMany(
      body.mistakes.map((mistake: { id?: string; surah: number; ayah: number; kind?: string; said?: string; correct?: string; note?: string; count?: number; resolved?: boolean }) => ({
        _id: String(mistake.id || randomUUID()),
        userId,
        surah: Number(mistake.surah),
        ayah: Number(mistake.ayah),
        kind: mistake.kind || 'Word error',
        said: mistake.said || '',
        correct: mistake.correct || '',
        note: mistake.note || '',
        count: Number(mistake.count) || 1,
        resolved: Boolean(mistake.resolved),
      })),
    );
  }
  res.json(await loadSync(userId));
}));

app.post('/api/recite', upload.single('audio'), route(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Attach an audio file in the audio field.' });
    return;
  }
  const surah = Number(req.body?.surah);
  const from = Number(req.body?.from || req.body?.ayah || 1);
  const to = Number(req.body?.to || from);
  if (!surah || !from) {
    res.status(400).json({ error: 'Send surah and ayah numbers with the recording.' });
    return;
  }
  try {
    await ensureQuran();
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Quran text could not be loaded.' });
    return;
  }
  const expected = rangeText(surah, from, to);
  if (!expected) {
    res.status(404).json({ error: 'That ayah range is not in the Quran text cache.' });
    return;
  }
  let transcript: string;
  let provider: string;
  try {
    const result = await transcribe(req.file.buffer, req.file.originalname || 'recite.m4a');
    transcript = result.text;
    provider = result.provider;
  } catch (error) {
    const status = error instanceof AsrNotConfiguredError ? 503 : 502;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Transcription failed.' });
    return;
  }
  const scored = compareRecitation(expected, transcript);
  const user = optionalUser(req);
  const stored = [];
  if (user && dbReady) {
    for (const word of scored.words.filter((item) => !item.ok)) {
      const id = randomUUID();
      const row = {
        id,
        surah,
        ayah: from,
        kind: word.heard ? 'Word error' : 'Missed word',
        said: word.heard,
        correct: word.expected,
        note: word.heard ? `Heard “${word.heard}” for “${word.expected}”.` : `Missed “${word.expected}”.`,
        count: 1,
        resolved: false,
        when: 'Just now',
      };
      await Mistake.create({
        _id: id,
        userId: user.id,
        surah,
        ayah: from,
        kind: row.kind,
        said: row.said,
        correct: row.correct,
        note: row.note,
        count: 1,
      });
      stored.push(row);
    }
    await PracticeSession.create({ userId: user.id, day: dayStamp(), minutes: 1, surahId: surah, kind: 'recite' });
  }
  res.json({
    transcript,
    provider,
    expected,
    accuracy: scored.accuracy,
    correct: scored.correct,
    total: scored.total,
    words: scored.words,
    mistakes: stored,
  });
}));

app.post('/api/search/voice', upload.single('audio'), route(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Attach an audio file in the audio field.' });
    return;
  }
  try {
    await ensureQuran();
    const result = await transcribe(req.file.buffer, req.file.originalname || 'search.m4a');
    res.json({ transcript: result.text, provider: result.provider, matches: searchTranscript(result.text) });
  } catch (error) {
    const status = error instanceof AsrNotConfiguredError ? 503 : 502;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Voice search failed.' });
  }
}));

app.post('/api/tests', requireUser, route(async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const account = await User.findById(userId).lean();
  if (!account?.premium) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const used = await TestRun.countDocuments({ userId, createdAt: { $gte: start } });
    if (used >= 3) {
      res.status(402).json({ error: 'No free tests left today. Premium removes the daily limit.' });
      return;
    }
  }
  const created = await TestRun.create({
    userId,
    rangeLabel: String(req.body?.range || 'Test'),
    minutes: Number(req.body?.minutes) || 1,
    accuracy: Number(req.body?.accuracy) || 0,
    correctCount: Number(req.body?.correct) || 0,
    mistakeCount: Number(req.body?.mistakes) || 0,
    review: req.body?.review ?? [],
  });
  res.status(201).json({ id: created.id });
}));

app.post('/api/webhooks/revenuecat', route(async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret) {
    const header = req.header('authorization') || '';
    if (header !== `Bearer ${secret}` && header !== secret) {
      res.status(401).json({ error: 'Invalid webhook authorization.' });
      return;
    }
  }
  if (!dbReady) {
    res.status(503).json({ error: 'Database is not configured. Set MONGODB_URI.' });
    return;
  }
  const event = req.body?.event ?? req.body ?? {};
  const type = String(event.type || '');
  const appUserId = String(event.app_user_id || '');
  const entitlement = process.env.REVENUECAT_ENTITLEMENT || 'premium';
  const ids: string[] = event.entitlement_ids || [];
  const grants = ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED'];
  const revokes = ['EXPIRATION'];
  let premium: boolean | null = null;
  if (grants.includes(type) && (ids.length === 0 || ids.includes(entitlement))) premium = true;
  if (revokes.includes(type)) premium = false;
  if (premium === null || !appUserId) {
    res.json({ ok: true, ignored: true });
    return;
  }
  const updated = await User.updateMany({ $or: [{ _id: appUserId }, { email: appUserId }] }, { $set: { premium } });
  res.json({ ok: true, updated: updated.modifiedCount, premium });
}));

app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Something went wrong on the server.' });
});

const port = Number(process.env.PORT) || 8787;
warmLocalAsr();
app.listen(port, '0.0.0.0', () => {
  console.log(`Tilawah API listening on 0.0.0.0:${port}`);
  connectDb()
    .then(() => console.log(dbReady ? 'MongoDB ready' : 'MONGODB_URI not set; account routes will return 503'))
    .catch((error) => console.error('MongoDB connection failed', error));
  ensureQuran()
    .then(() => console.log('Quran text cached'))
    .catch((error) => console.error('Quran prefetch failed', error));
});

// Keep the free Render instance (and the ASR Space) awake by pinging through the public URLs.
const keepAwakeUrls = [process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/health` : '', process.env.SELFHOST_ASR_URL || '']
  .filter(Boolean);
if (keepAwakeUrls.length) {
  setInterval(() => {
    for (const url of keepAwakeUrls) fetch(url).catch(() => {});
  }, 10 * 60 * 1000);
}
