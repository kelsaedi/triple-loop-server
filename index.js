const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Groq = require('groq-sdk').default;
const { createClient } = require('@libsql/client');

const app = express();
app.use(cors());
// 50 MB so users can upload PDFs and PPTX decks with embedded images.
// Storage cost: a single Turso row holds the entire userdata blob, so this
// is also the practical upper bound per user account.
app.use(express.json({ limit: '50mb' }));

// ── Turso Cloud Database ────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS userdata (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}'
    )
  `);
  // Invitations table — lets a project owner generate a one-time link for an
  // employee (Mitarbeiter:in) to take a single mindset test. The invitee does
  // not get an account; their result is stored directly on the invite row.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_name TEXT,
      owner_user_id TEXT NOT NULL,
      test_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      invitee_name TEXT,
      redeemed_at TEXT,
      result_json TEXT
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner_user_id)');
  console.log('✓ Datenbank initialisiert');
}

// ── Auth Endpoints ──────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
    }
    const emailLower = email.toLowerCase().trim();
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [emailLower] });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' });
    }
    const hash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO users (id, email, name, password, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [id, emailLower, name.trim(), hash, createdAt],
    });
    await db.execute({
      sql: 'INSERT INTO userdata (user_id, data) VALUES (?, ?)',
      args: [id, '{}'],
    });
    console.log(`✓ Neuer Benutzer: ${emailLower}`);
    res.json({ id, email: emailLower, name: name.trim(), createdAt });
  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
    }
    const emailLower = email.toLowerCase().trim();
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [emailLower] });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Ungültige E-Mail oder Passwort' });
    }
    const user = result.rows[0];
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Ungültige E-Mail oder Passwort' });
    }
    console.log(`✓ Login: ${user.email}`);
    res.json({ id: user.id, email: user.email, name: user.name, createdAt: user.created_at });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
  }
});

// ── User Data Endpoints ─────────────────────────────────────

app.post('/api/userdata/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const newData = req.body;
    if (!userId || !newData) {
      return res.status(400).json({ error: 'UserId und Daten erforderlich' });
    }
    const existing = await db.execute({ sql: 'SELECT data FROM userdata WHERE user_id = ?', args: [userId] });
    let merged = {};
    if (existing.rows.length > 0) {
      merged = JSON.parse(existing.rows[0].data || '{}');
    }
    Object.assign(merged, newData);
    const json = JSON.stringify(merged);
    if (existing.rows.length > 0) {
      await db.execute({ sql: 'UPDATE userdata SET data = ? WHERE user_id = ?', args: [json, userId] });
    } else {
      await db.execute({ sql: 'INSERT INTO userdata (user_id, data) VALUES (?, ?)', args: [userId, json] });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Save userdata error:', error);
    res.status(500).json({ error: 'Speichern fehlgeschlagen' });
  }
});

app.get('/api/userdata/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.execute({ sql: 'SELECT data FROM userdata WHERE user_id = ?', args: [userId] });
    if (result.rows.length > 0) {
      res.json(JSON.parse(result.rows[0].data || '{}'));
    } else {
      res.json({});
    }
  } catch (error) {
    console.error('Load userdata error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// ── Invitation Endpoints ────────────────────────────────────
// Project owners generate one-time invite links so employees can take a
// single mindset test without creating an account. The invitee identifies
// themselves by name; their result is stored directly on the invite row.

app.post('/api/invites', async (req, res) => {
  try {
    const { ownerUserId, projectId, projectName, testKind } = req.body;
    if (!ownerUserId || !projectId || !testKind) {
      return res.status(400).json({ error: 'ownerUserId, projectId, testKind erforderlich' });
    }
    if (testKind !== '42' && testKind !== '36') {
      return res.status(400).json({ error: "testKind muss '42' oder '36' sein" });
    }
    const token = crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO invites (token, project_id, project_name, owner_user_id, test_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [token, projectId, projectName || '', ownerUserId, testKind, createdAt],
    });
    res.json({ token, createdAt });
  } catch (error) {
    console.error('Create invite error:', error);
    res.status(500).json({ error: 'Einladung erstellen fehlgeschlagen' });
  }
});

// Public: invitee fetches what the invite is about (project + test kind).
app.get('/api/invites/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await db.execute({
      sql: 'SELECT token, project_id, project_name, test_kind, created_at, invitee_name, redeemed_at FROM invites WHERE token = ?',
      args: [token],
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Einladung nicht gefunden' });
    const r = result.rows[0];
    res.json({
      token: r.token,
      projectId: r.project_id,
      projectName: r.project_name,
      testKind: r.test_kind,
      createdAt: r.created_at,
      inviteeName: r.invitee_name,
      redeemedAt: r.redeemed_at,
      isRedeemed: !!r.redeemed_at,
    });
  } catch (error) {
    console.error('Get invite error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// Public: invitee submits name + completed test result.
app.post('/api/invites/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { inviteeName, resultJson } = req.body;
    if (!inviteeName || !resultJson) {
      return res.status(400).json({ error: 'inviteeName und resultJson erforderlich' });
    }
    const existing = await db.execute({ sql: 'SELECT token, redeemed_at FROM invites WHERE token = ?', args: [token] });
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Einladung nicht gefunden' });
    if (existing.rows[0].redeemed_at) return res.status(409).json({ error: 'Einladung bereits eingelöst' });
    const redeemedAt = new Date().toISOString();
    await db.execute({
      sql: 'UPDATE invites SET invitee_name = ?, redeemed_at = ?, result_json = ? WHERE token = ?',
      args: [String(inviteeName).trim(), redeemedAt, JSON.stringify(resultJson), token],
    });
    res.json({ ok: true, redeemedAt });
  } catch (error) {
    console.error('Submit invite error:', error);
    res.status(500).json({ error: 'Speichern fehlgeschlagen' });
  }
});

// Owner: list all invites + their (optional) results.
app.get('/api/users/:userId/invites', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.execute({
      sql: 'SELECT token, project_id, project_name, test_kind, created_at, invitee_name, redeemed_at, result_json FROM invites WHERE owner_user_id = ? ORDER BY created_at DESC',
      args: [userId],
    });
    const invites = result.rows.map((r) => ({
      token: r.token,
      projectId: r.project_id,
      projectName: r.project_name,
      testKind: r.test_kind,
      createdAt: r.created_at,
      inviteeName: r.invitee_name,
      redeemedAt: r.redeemed_at,
      isRedeemed: !!r.redeemed_at,
      result: r.result_json ? JSON.parse(r.result_json) : null,
    }));
    res.json({ invites });
  } catch (error) {
    console.error('List invites error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// Owner: delete an invite (only the creator can).
app.delete('/api/invites/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { ownerUserId } = req.body;
    if (!ownerUserId) return res.status(400).json({ error: 'ownerUserId erforderlich' });
    const existing = await db.execute({ sql: 'SELECT owner_user_id FROM invites WHERE token = ?', args: [token] });
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Einladung nicht gefunden' });
    if (existing.rows[0].owner_user_id !== ownerUserId) return res.status(403).json({ error: 'Nicht erlaubt' });
    await db.execute({ sql: 'DELETE FROM invites WHERE token = ?', args: [token] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete invite error:', error);
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

// ── Groq / Chat ─────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error('⚠️  GROQ_API_KEY Umgebungsvariable nicht gesetzt!');
}
const groq = new Groq({ apiKey: GROQ_API_KEY });

let knowledgeChunks = [];

function loadKnowledgeBase() {
  try {
    const kbPath = path.join(__dirname, 'knowledge_base.txt');
    const content = fs.readFileSync(kbPath, 'utf-8');
    knowledgeChunks = [];
    const chunkSize = 2000;
    for (let i = 0; i < content.length; i += chunkSize) {
      let chunk = content.slice(i, i + chunkSize);
      if (i + chunkSize < content.length) {
        const lastPeriod = chunk.lastIndexOf('. ');
        const lastNewline = chunk.lastIndexOf('\n');
        const cutPoint = Math.max(lastPeriod, lastNewline);
        if (cutPoint > chunkSize * 0.5) {
          chunk = chunk.slice(0, cutPoint + 1);
          i = i - (chunkSize - cutPoint - 1);
        }
      }
      if (chunk.trim().length > 100) {
        knowledgeChunks.push(chunk.trim());
      }
    }
    console.log(`✓ Knowledge Base geladen: ${knowledgeChunks.length} Chunks`);
  } catch (error) {
    console.error('Fehler beim Laden der Knowledge Base:', error.message);
  }
}

function findRelevantChunks(query, maxChunks = 4) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);
  const frameworkKeywords = [
    'loop', 'loop 1', 'loop 2', 'loop 3',
    'planung', 'aktivierung', 'verankerung',
    'enhancement', 'engagement', 'execution', 'enforcement',
    'enh', 'eng', 'exe', 'enf',
    'wirkung', 'akzeptanz', 'inhalt',
    'change', 'veränderung', 'führung', 'leadership',
    'stratege', 'kommunikator', 'enabler',
    'schritt', 'dimension', 'phase'
  ];
  const scored = knowledgeChunks.map((chunk, index) => {
    const chunkLower = chunk.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (chunkLower.includes(word)) score += 3;
    }
    for (const keyword of frameworkKeywords) {
      if (queryLower.includes(keyword) && chunkLower.includes(keyword)) score += 5;
    }
    if (queryLower.includes('loop 1') && chunkLower.includes('loop 1')) score += 10;
    if (queryLower.includes('loop 2') && chunkLower.includes('loop 2')) score += 10;
    if (queryLower.includes('loop 3') && chunkLower.includes('loop 3')) score += 10;
    if (queryLower.includes('planung') && chunkLower.includes('planung')) score += 10;
    if (queryLower.includes('aktivierung') && chunkLower.includes('aktivierung')) score += 10;
    if (queryLower.includes('verankerung') && chunkLower.includes('verankerung')) score += 10;
    return { chunk, score, index };
  });
  const topChunks = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, maxChunks).map(s => s.chunk);
  return topChunks.length === 0 ? knowledgeChunks.slice(0, 3) : topChunks;
}

const SYSTEM_PROMPT = `Du bist ein erfahrener Change Management Experte und Berater, spezialisiert auf das Triple Loop of Change Framework von Prof. Wolfgang Güttel und Dr. Katharina Kleinhanns-Rollé (TU Wien).

WICHTIG: Dein Wissen basiert AUSSCHLIESSLICH auf dem Buch "Leadership" und "Change Management" der Autoren. Antworte IMMER basierend auf den bereitgestellten Buchinhalten.

Kernprinzipien:
- Die KERNFORMEL: Wirkung = Inhalt × Akzeptanz
- Die 3 Loops: Planung (Stratege), Aktivierung (Kommunikator), Verankerung (Enabler)
- Die 4 Dimensionen: Enhancement (ENH), Engagement (ENG), Execution (EXE), Enforcement (ENF)
- Die 12 Schritte des Change-Prozesses

Regeln für deine Antworten:
1. Beziehe dich KONKRET auf die Buchinhalte und Konzepte
2. Verwende die FACHBEGRIFFE aus dem Buch (Loops, Dimensionen, Schritte)
3. Gib PRAKTISCHE und SPEZIFISCHE Ratschläge basierend auf dem Framework
4. Erkläre Zusammenhänge zwischen den verschiedenen Elementen
5. Antworte auf Deutsch und sieze die Nutzer

Du erhältst relevante Auszüge aus dem Buch, die du für deine Antwort verwenden sollst.`;

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Nachricht fehlt' });
    const relevantChunks = findRelevantChunks(message);
    const context = relevantChunks.join('\n\n---\n\n');
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `RELEVANTE BUCHAUSZÜGE:\n\n${context}\n\n---\n\nFRAGE DES NUTZERS: ${message}\n\nBitte antworte basierend auf den obigen Buchauszügen und deinem Wissen über das Triple Loop of Change Framework.` }
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });
    const response = completion.choices[0]?.message?.content || 'Entschuldigung, ich konnte keine Antwort generieren.';
    res.json({ response });
  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten: ' + error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', chunks: knowledgeChunks.length });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Triple Loop of Change API',
    knowledgeChunks: knowledgeChunks.length,
    endpoints: { chat: 'POST /api/chat', health: 'GET /api/health', auth: 'POST /api/auth/login | /api/auth/register' }
  });
});

// ── Start ───────────────────────────────────────────────────
loadKnowledgeBase();

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✓ Server läuft auf Port ${PORT}`);
  });
}).catch(err => {
  console.error('DB Init Fehler:', err);
  // Start anyway without DB
  app.listen(PORT, () => {
    console.log(`⚠️ Server läuft auf Port ${PORT} (ohne Datenbank)`);
  });
});
