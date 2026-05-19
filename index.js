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
      result_json TEXT,
      member_id TEXT,
      member_first_name TEXT
    )
  `);
  // ALTER for already-existing rows (idempotent; ignores "duplicate column" errors).
  // These were added after the initial deploy: per-member invites now scope
  // each invite to a specific team member so the result lands on their record.
  for (const col of ['member_id TEXT', 'member_first_name TEXT']) {
    try {
      await db.execute(`ALTER TABLE invites ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists — Turso/libSQL returns SQLITE_ERROR with msg "duplicate column name"
    }
  }
  await db.execute('CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner_user_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_invites_member ON invites(member_id)');

  // Projekt-Sharing: erlaubt einem Owner, andere Login-User als Admin oder
  // Mitarbeiter:in (collaborator) zu einem Projekt einzuladen. Der Member-
  // User sieht das Projekt anschließend in seiner App neben den eigenen.
  //
  // role = 'admin'        → voller Zugriff (wie der Owner)
  // role = 'collaborator' → eingeschränkter Zugriff (Phase 2, aktuell nicht erzwungen)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_shares (
      share_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      member_user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      invited_email TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(owner_user_id, member_user_id, project_id)
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_shares_member ON project_shares(member_user_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_shares_owner ON project_shares(owner_user_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_shares_project ON project_shares(project_id)');

  // Passwort-Reset-Token (Forgot-Password-Flow). Eine User-facing Variante:
  // Person klickt "Passwort vergessen?", gibt Email ein → Server erzeugt einen
  // einmaligen Token, schickt einen Reset-Link per Mail. Token läuft nach
  // 1 Stunde ab und kann nur einmal verwendet werden.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_reset_email ON password_reset_tokens(email)');
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

// GET /api/userdata/:userId
//   By default returns the user blob WITHOUT projects[].resources[].fileData
//   so the response stays small (assessment+history sync is the hot path).
//   File blobs are 99% of the bytes when the user has uploaded any PDFs/PPTX
//   etc., and on a single Render free-tier dyno the heavy response causes
//   memory restarts + Safari CORS aborts. Pass `?withFiles=1` to opt into
//   the full payload (project context uses this for cross-device sync).
app.get('/api/userdata/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const withFiles = req.query.withFiles === '1' || req.query.withFiles === 'true';
    const result = await db.execute({ sql: 'SELECT data FROM userdata WHERE user_id = ?', args: [userId] });
    if (result.rows.length > 0) {
      const data = JSON.parse(result.rows[0].data || '{}');
      if (!withFiles && Array.isArray(data.projects)) {
        data.projects = data.projects.map((p) => ({
          ...p,
          resources: Array.isArray(p.resources)
            ? p.resources.map(({ fileData, ...rest }) => rest)
            : p.resources,
        }));
      }
      res.json(data);
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
    const { ownerUserId, projectId, projectName, testKind, memberId, memberFirstName } = req.body;
    if (!ownerUserId || !projectId || !testKind) {
      return res.status(400).json({ error: 'ownerUserId, projectId, testKind erforderlich' });
    }
    if (testKind !== '42' && testKind !== '36') {
      return res.status(400).json({ error: "testKind muss '42' oder '36' sein" });
    }
    const token = crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO invites (token, project_id, project_name, owner_user_id, test_kind, created_at, member_id, member_first_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [token, projectId, projectName || '', ownerUserId, testKind, createdAt, memberId || null, memberFirstName || null],
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
      sql: 'SELECT token, project_id, project_name, test_kind, created_at, invitee_name, redeemed_at, member_id, member_first_name FROM invites WHERE token = ?',
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
      memberId: r.member_id,
      memberFirstName: r.member_first_name,
    });
  } catch (error) {
    console.error('Get invite error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// Public: invitee submits completed test result. The name is optional — for
// per-member invites the name is already on the invite row (member_first_name)
// and the invitee never gets a "what's your name?" prompt.
app.post('/api/invites/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { inviteeName, resultJson } = req.body;
    if (!resultJson) {
      return res.status(400).json({ error: 'resultJson erforderlich' });
    }
    const existing = await db.execute({ sql: 'SELECT token, redeemed_at, member_first_name FROM invites WHERE token = ?', args: [token] });
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Einladung nicht gefunden' });
    if (existing.rows[0].redeemed_at) return res.status(409).json({ error: 'Einladung bereits eingelöst' });
    // Prefer the explicit body name (project-level invite case); fall back to
    // the pre-known member name (per-member invite case).
    const nameToStore = (inviteeName && String(inviteeName).trim())
      || existing.rows[0].member_first_name
      || '';
    if (!nameToStore) {
      return res.status(400).json({ error: 'inviteeName erforderlich' });
    }
    const redeemedAt = new Date().toISOString();
    await db.execute({
      sql: 'UPDATE invites SET invitee_name = ?, redeemed_at = ?, result_json = ? WHERE token = ?',
      args: [nameToStore, redeemedAt, JSON.stringify(resultJson), token],
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
      sql: 'SELECT token, project_id, project_name, test_kind, created_at, invitee_name, redeemed_at, result_json, member_id, member_first_name FROM invites WHERE owner_user_id = ? ORDER BY created_at DESC',
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
      memberId: r.member_id,
      memberFirstName: r.member_first_name,
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

// ── Email-Versand (Resend) ─────────────────────────────────
// Wenn RESEND_API_KEY in den ENV-Variablen gesetzt ist, schicken wir
// transaktionale Emails über api.resend.com. Ohne API-Key bleibt das System
// funktionsfähig — der Token landet stattdessen in den Server-Logs, sodass
// der Plattform-Betreiber ihn manuell an die Person weiterleiten kann.
//
// Reply-To-Adresse via RESEND_FROM steuerbar; Default `onboarding@resend.dev`
// (Resend-Testdomain, funktioniert ohne eigenes DNS-Setup).
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Triple Loop <onboarding@resend.dev>';
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://leadership-strategy-research.pages.dev';

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log('[email] (kein RESEND_API_KEY) Würde senden an', to, '·', subject);
    console.log('[email] Text:', text);
    return { delivered: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Resend error', res.status, body);
      return { delivered: false, reason: 'api_error', status: res.status };
    }
    console.log(`[email] sent to ${to}: ${subject}`);
    return { delivered: true };
  } catch (e) {
    console.error('[email] network error', e);
    return { delivered: false, reason: 'network_error' };
  }
}

// ── Forgot-Password / Reset (User-facing) ──────────────────
// Ein Klick auf "Passwort vergessen?" im Login-Formular liefert die Email
// hier ab. Wir erzeugen einen einmaligen Token (1h Gültigkeit), speichern
// ihn und verschicken den Reset-Link per Mail. Aus Privacy-Gründen
// geben wir IMMER 200 zurück — ob die Email existiert, bleibt geheim.

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email erforderlich' });
    const emailLower = String(email).toLowerCase().trim();

    const lookup = await db.execute({
      sql: 'SELECT id, email, name FROM users WHERE email = ?',
      args: [emailLower],
    });

    // Always-200-Pattern: kein Hinweis, ob Email existiert
    if (lookup.rows.length === 0) {
      console.log(`[forgot-password] Versuch für unbekannte Email: ${emailLower}`);
      return res.json({ ok: true });
    }

    const user = lookup.rows[0];
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000); // 1h
    await db.execute({
      sql: `INSERT INTO password_reset_tokens (token, user_id, email, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [token, user.id, user.email, now.toISOString(), expires.toISOString()],
    });

    const resetUrl = `${FRONTEND_BASE_URL}/?reset=${token}`;
    const greeting = user.name ? `Hallo ${user.name}` : 'Hallo';
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0F172A;">
        <h2 style="margin: 0 0 16px 0; color: #4A9EFF;">Passwort zurücksetzen</h2>
        <p>${greeting},</p>
        <p>du hast einen Reset für dein Passwort auf der Triple-Loop-of-Change-Plattform angefordert. Klick auf den folgenden Link, um ein neues Passwort zu setzen:</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: #4A9EFF; color: #FFFFFF; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600;">
            Neues Passwort setzen
          </a>
        </p>
        <p style="font-size: 13px; color: #64748B;">Oder kopiere diesen Link manuell in deinen Browser:<br><span style="word-break: break-all;">${resetUrl}</span></p>
        <p style="font-size: 13px; color: #64748B;">Der Link ist 1 Stunde gültig und kann nur einmal verwendet werden.</p>
        <p style="font-size: 13px; color: #64748B;">Wenn du keinen Reset angefordert hast, kannst du diese Mail ignorieren — dein Passwort bleibt unverändert.</p>
        <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 24px 0;">
        <p style="font-size: 12px; color: #94A3B8;">TU Wien · Institut Leadership & Strategy<br>Triple Loop of Change Plattform</p>
      </div>
    `;
    const text = `${greeting},

du hast einen Reset für dein Passwort auf der Triple-Loop-of-Change-Plattform angefordert.

Setze dein neues Passwort hier:
${resetUrl}

Der Link ist 1 Stunde gültig und kann nur einmal verwendet werden.

Wenn du keinen Reset angefordert hast, kannst du diese Mail ignorieren.

— Triple Loop of Change Plattform, TU Wien Leadership & Strategy`;

    const sendResult = await sendEmail({
      to: emailLower,
      subject: 'Passwort zurücksetzen — Triple Loop of Change',
      html,
      text,
    });
    // Wenn der Email-Versand nicht eingerichtet ist, geben wir den Token
    // hier nur ins Server-Log; trotzdem 200 zurück, damit der Frontend-Flow
    // gleich aussieht (Privacy).
    if (!sendResult.delivered) {
      console.log(`[forgot-password] Fallback-Token für ${emailLower}: ${resetUrl}`);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Forgot-password error:', error);
    res.status(500).json({ error: 'Reset-Anfrage fehlgeschlagen' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token und newPassword erforderlich' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
    }
    const lookup = await db.execute({
      sql: 'SELECT token, user_id, email, expires_at, used_at FROM password_reset_tokens WHERE token = ?',
      args: [token],
    });
    if (lookup.rows.length === 0) {
      return res.status(400).json({ error: 'Reset-Link ist ungültig.' });
    }
    const row = lookup.rows[0];
    if (row.used_at) {
      return res.status(400).json({ error: 'Reset-Link wurde bereits verwendet.' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Reset-Link ist abgelaufen. Bitte neu anfordern.' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password = ? WHERE id = ?',
      args: [hash, row.user_id],
    });
    await db.execute({
      sql: 'UPDATE password_reset_tokens SET used_at = ? WHERE token = ?',
      args: [new Date().toISOString(), token],
    });
    console.log(`✓ Passwort über Token zurückgesetzt: ${row.email}`);
    res.json({ ok: true, email: row.email });
  } catch (error) {
    console.error('Reset-password error:', error);
    res.status(500).json({ error: 'Reset fehlgeschlagen' });
  }
});

// ── Admin: Passwort manuell zurücksetzen ───────────────────
// Da die App aktuell keinen Forgot-Password-Flow hat, kann der Plattform-
// Betreiber Passwörter über diesen Endpoint zurücksetzen. Der adminToken
// ist im Code hartkodiert (Pilot-Stage); für die Produktion sollte er per
// ENV-Variable konfigurierbar werden und zusätzlich rotiert werden.
const ADMIN_RESET_TOKEN = 'tloc-reset-K8XJ9PQ7VbN3FmR4-2026-05-19';

app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { adminToken, email, newPassword } = req.body;
    if (adminToken !== ADMIN_RESET_TOKEN) {
      return res.status(403).json({ error: 'Ungültiger Admin-Token' });
    }
    if (!email || !newPassword) {
      return res.status(400).json({ error: 'email und newPassword erforderlich' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
    }
    const emailLower = String(email).toLowerCase().trim();
    const existing = await db.execute({
      sql: 'SELECT id, email FROM users WHERE email = ?',
      args: [emailLower],
    });
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Kein User mit dieser E-Mail' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password = ? WHERE email = ?',
      args: [hash, emailLower],
    });
    console.log(`✓ Passwort zurückgesetzt für: ${emailLower}`);
    res.json({ ok: true, email: emailLower });
  } catch (error) {
    console.error('Admin reset error:', error);
    res.status(500).json({ error: 'Reset fehlgeschlagen' });
  }
});

// ── Projekt-Sharing (Admin / Co-Worker) ────────────────────
// Erlaubt einem Owner, andere Login-User per Email zu einem seiner Projekte
// einzuladen. Aktuell wird role='admin' (voller Zugriff) primär unterstützt;
// role='collaborator' ist eingeplant für Phase 2 (eingeschränkte Sicht).
//
// Sicherheitshinweis: Aktuell prüft der Server NICHT, ob der anfragende
// User wirklich Owner des Projekts ist — der Client schickt ownerUserId
// im Body und wir vertrauen ihm. Auth-Token + Ownership-Check kommen mit
// dem grundsätzlichen Auth-Hardening (siehe Roadmap).

// POST /api/projects/share — Owner lädt Member per Email zum Projekt ein.
app.post('/api/projects/share', async (req, res) => {
  try {
    const { ownerUserId, projectId, memberEmail, role } = req.body;
    if (!ownerUserId || !projectId || !memberEmail) {
      return res.status(400).json({ error: 'ownerUserId, projectId, memberEmail erforderlich' });
    }
    const validRole = role === 'collaborator' ? 'collaborator' : 'admin';
    const emailLower = String(memberEmail).toLowerCase().trim();
    const userLookup = await db.execute({
      sql: 'SELECT id, name, email FROM users WHERE email = ?',
      args: [emailLower],
    });
    if (userLookup.rows.length === 0) {
      return res.status(404).json({ error: 'Kein User mit dieser E-Mail. Die Person muss sich zuerst registrieren.' });
    }
    const member = userLookup.rows[0];
    if (member.id === ownerUserId) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst einladen.' });
    }
    const shareId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await db.execute({
        sql: `INSERT INTO project_shares (share_id, owner_user_id, member_user_id, project_id, role, invited_email, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [shareId, ownerUserId, member.id, projectId, validRole, emailLower, createdAt],
      });
    } catch (e) {
      // UNIQUE constraint hit → User ist schon eingeladen
      if (String(e?.message || '').includes('UNIQUE')) {
        return res.status(409).json({ error: 'Dieser User hat bereits Zugriff auf das Projekt.' });
      }
      throw e;
    }
    console.log(`✓ Projekt-Share: ${emailLower} → ${projectId} (${validRole})`);
    res.json({
      shareId,
      memberUserId: member.id,
      memberName: member.name,
      memberEmail: member.email,
      role: validRole,
      createdAt,
    });
  } catch (error) {
    console.error('Share project error:', error);
    res.status(500).json({ error: 'Teilen fehlgeschlagen' });
  }
});

// GET /api/users/:userId/shared-projects — alle Projekte, in denen :userId
// eingeladen ist. Inkludiert Owner-Info für die UI.
app.get('/api/users/:userId/shared-projects', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.execute({
      sql: `SELECT s.share_id, s.owner_user_id, s.project_id, s.role, s.created_at,
                   u.name AS owner_name, u.email AS owner_email
            FROM project_shares s
            JOIN users u ON u.id = s.owner_user_id
            WHERE s.member_user_id = ?
            ORDER BY s.created_at DESC`,
      args: [userId],
    });
    const shares = result.rows.map((r) => ({
      shareId: r.share_id,
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
      projectId: r.project_id,
      role: r.role,
      createdAt: r.created_at,
    }));
    res.json({ shares });
  } catch (error) {
    console.error('List shared-projects error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// GET /api/projects/:projectId/shares?ownerUserId=… — Owner sieht die Liste
// aller Personen, die Zugriff auf sein Projekt haben.
app.get('/api/projects/:projectId/shares', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { ownerUserId } = req.query;
    if (!ownerUserId) return res.status(400).json({ error: 'ownerUserId erforderlich' });
    const result = await db.execute({
      sql: `SELECT s.share_id, s.member_user_id, s.role, s.created_at, s.invited_email,
                   u.name AS member_name, u.email AS member_email
            FROM project_shares s
            JOIN users u ON u.id = s.member_user_id
            WHERE s.project_id = ? AND s.owner_user_id = ?
            ORDER BY s.created_at DESC`,
      args: [projectId, ownerUserId],
    });
    const shares = result.rows.map((r) => ({
      shareId: r.share_id,
      memberUserId: r.member_user_id,
      memberName: r.member_name,
      memberEmail: r.member_email,
      invitedEmail: r.invited_email,
      role: r.role,
      createdAt: r.created_at,
    }));
    res.json({ shares });
  } catch (error) {
    console.error('List project shares error:', error);
    res.status(500).json({ error: 'Laden fehlgeschlagen' });
  }
});

// DELETE /api/projects/share/:shareId — Owner entzieht Zugriff.
app.delete('/api/projects/share/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    const { ownerUserId } = req.body;
    if (!ownerUserId) return res.status(400).json({ error: 'ownerUserId erforderlich' });
    const existing = await db.execute({
      sql: 'SELECT owner_user_id FROM project_shares WHERE share_id = ?',
      args: [shareId],
    });
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Share nicht gefunden' });
    if (existing.rows[0].owner_user_id !== ownerUserId) {
      return res.status(403).json({ error: 'Nicht erlaubt — nur der Owner kann Zugriffe entziehen.' });
    }
    await db.execute({ sql: 'DELETE FROM project_shares WHERE share_id = ?', args: [shareId] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete share error:', error);
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
