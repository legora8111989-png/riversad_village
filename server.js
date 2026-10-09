'use strict';

/*
 * Riverside Village — multiplayer mini-server.
 *
 * No WebSocket: plain Node.js HTTP + JSON. The game client polls the server.
 *
 * Storage:
 *   - If DATABASE_URL is set (Neon/Supabase Postgres) the server is persistent:
 *     data survives restarts and redeploys. This is the recommended mode.
 *   - If DATABASE_URL is NOT set it falls back to a local ./data.json file,
 *     which is handy for a quick local test but is wiped on Render restarts.
 *
 * Set the connection string in the environment:
 *   Windows (PowerShell):  $env:DATABASE_URL="postgresql://..."
 *   Render:                Environment -> Add Environment Variable
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GAME_DIR = path.resolve(__dirname, '..'); // the folder with index.html
const MAX_BODY = 4 * 1024 * 1024;               // 4 MB is plenty for a save

// Reads simple KEY=VALUE lines from a local .env file (no external package).
// Handy locally: put DATABASE_URL there instead of typing it in PowerShell.
// Real environment variables always win over .env. Render uses its own env vars.
function loadDotEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch (e) { /* ignore */ }
}
loadDotEnv();

const DATABASE_URL = process.env.DATABASE_URL || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() { return Date.now(); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
const LOGIN_RE = /^[A-Za-z0-9_\-]{3,16}$/;
function validLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

// ---------------------------------------------------------------------------
// Simple rate limit (per IP) for login/register attempts
// ---------------------------------------------------------------------------
const rate = new Map();
function rateLimited(ip) {
  const t = now();
  let rec = rate.get(ip);
  if (!rec || t - rec.start > 60000) { rec = { start: t, count: 0 }; rate.set(ip, rec); }
  rec.count++;
  return rec.count > 30; // 30 attempts per minute
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

// ===========================================================================
// Storage — file fallback (data.json)
// ===========================================================================
function emptyData() {
  return { accounts: [], sessions: {}, players: {}, plots: {} };
}
let db = emptyData();
let writeTimer = null;

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign(emptyData(), parsed);
    if (!Array.isArray(db.accounts)) db.accounts = [];
    if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
    if (!db.players || typeof db.players !== 'object') db.players = {};
    if (!db.plots || typeof db.plots !== 'object') db.plots = {};
  } catch (e) {
    db = emptyData();
  }
}
// writes are batched and atomic so a crash never leaves a half-written file
function saveData() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('saveData failed:', e.message);
    }
  }, 150);
}
function flushDataSync() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { /* ignore */ }
}

function makeFileStore() {
  return {
    kind: 'file',
    async init() { loadData(); },
    async close() { flushDataSync(); },
    async findAccountByLogin(login) {
      const low = String(login).toLowerCase();
      return db.accounts.find((a) => a.login_lower === low) || null;
    },
    async createAccount(account) {
      db.accounts.push(account);
      saveData();
    },
    async accountById(id) {
      return db.accounts.find((a) => a.id === id) || null;
    },
    async createSession(token, accountId) {
      db.sessions[token] = accountId;
      saveData();
    },
    async sessionAccount(token) {
      return db.sessions[token] || null;
    },
    async getPlayer(accountId) {
      return db.players[accountId] || null;
    },
    async setPlayer(accountId, save, ts) {
      db.players[accountId] = { account_id: accountId, save: save || null, updated_at: ts };
      saveData();
    },
    async getOwnedPlotId(accountId) {
      for (const pid in db.plots) if (db.plots[pid].account_id === accountId) return Number(pid);
      return null;
    },
    async getPlot(plotId) {
      return db.plots[plotId] || null;
    },
    async updatePlotSnapshot(accountId, snapshot, name, ts) {
      for (const pid in db.plots) {
        if (db.plots[pid].account_id === accountId) {
          db.plots[pid].snapshot = snapshot;
          db.plots[pid].name = name;
          db.plots[pid].updated_at = ts;
          saveData();
          return true;
        }
      }
      return false;
    },
    async claimPlot(plotId, accountId, name, ts) {
      const own = await this.getOwnedPlotId(accountId);
      if (own != null) return own === plotId ? { result: 'ok', plotId } : { result: 'have', plotId: own };
      if (db.plots[plotId]) return { result: 'taken' };
      db.plots[plotId] = { plot_id: plotId, account_id: accountId, name, snapshot: null, updated_at: ts };
      saveData();
      return { result: 'ok', plotId };
    },
    async listPlots(since) {
      const list = [];
      for (const pid in db.plots) {
        const p = db.plots[pid];
        if (since && p.updated_at <= since) continue;
        list.push({ accountId: p.account_id, name: p.name || 'Home', plotId: Number(pid), snapshot: p.snapshot || null, updatedAt: p.updated_at });
      }
      return list;
    },
  };
}

// ===========================================================================
// Storage — PostgreSQL (Neon / Supabase)
// ===========================================================================
function pgNeedsSSL(url) {
  if (!url) return false;
  if (/sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  return true;
}

function makePgStore() {
  let pool = null;
  return {
    kind: 'postgres',
    async init() {
      let Pool;
      try { ({ Pool } = require('pg')); }
      catch (e) {
        throw new Error("Модуль 'pg' не установлен. Выполните: npm install pg  (или npm.cmd install pg)");
      }
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: pgNeedsSSL(DATABASE_URL) ? { rejectUnauthorized: false } : false,
        max: 5,
      });
      await pool.query('SELECT 1');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          login TEXT NOT NULL,
          login_lower TEXT NOT NULL UNIQUE,
          pass_hash TEXT NOT NULL,
          pass_salt TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS players (
          account_id TEXT PRIMARY KEY,
          save JSONB,
          updated_at BIGINT NOT NULL
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS plots (
          plot_id INTEGER PRIMARY KEY,
          account_id TEXT NOT NULL,
          name TEXT NOT NULL,
          snapshot JSONB,
          updated_at BIGINT NOT NULL
        )`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS plots_account_unique ON plots(account_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id)');
    },
    async close() { if (pool) await pool.end().catch(() => {}); },
    async findAccountByLogin(login) {
      const r = await pool.query('SELECT * FROM accounts WHERE login_lower=$1', [String(login).toLowerCase()]);
      return r.rows[0] || null;
    },
    async createAccount(a) {
      await pool.query(
        'INSERT INTO accounts(id,login,login_lower,pass_hash,pass_salt,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [a.id, a.login, a.login_lower, a.pass_hash, a.pass_salt, a.created_at]);
    },
    async accountById(id) {
      const r = await pool.query('SELECT * FROM accounts WHERE id=$1', [id]);
      return r.rows[0] || null;
    },
    async createSession(token, accountId) {
      await pool.query('INSERT INTO sessions(token,account_id,created_at) VALUES($1,$2,$3)', [token, accountId, now()]);
    },
    async sessionAccount(token) {
      const r = await pool.query('SELECT account_id FROM sessions WHERE token=$1', [token]);
      return r.rows[0] ? r.rows[0].account_id : null;
    },
    async getPlayer(accountId) {
      const r = await pool.query('SELECT account_id,save,updated_at FROM players WHERE account_id=$1', [accountId]);
      return r.rows[0] || null;
    },
    async setPlayer(accountId, save, ts) {
      await pool.query(
        'INSERT INTO players(account_id,save,updated_at) VALUES($1,$2::jsonb,$3) ' +
        'ON CONFLICT (account_id) DO UPDATE SET save=$2::jsonb, updated_at=$3',
        [accountId, JSON.stringify(save === undefined ? null : save), ts]);
    },
    async getOwnedPlotId(accountId) {
      const r = await pool.query('SELECT plot_id FROM plots WHERE account_id=$1', [accountId]);
      return r.rows[0] ? Number(r.rows[0].plot_id) : null;
    },
    async getPlot(plotId) {
      const r = await pool.query('SELECT * FROM plots WHERE plot_id=$1', [plotId]);
      return r.rows[0] || null;
    },
    async updatePlotSnapshot(accountId, snapshot, name, ts) {
      const r = await pool.query(
        'UPDATE plots SET snapshot=$2::jsonb, name=$3, updated_at=$4 WHERE account_id=$1',
        [accountId, JSON.stringify(snapshot === undefined ? null : snapshot), name, ts]);
      return r.rowCount > 0;
    },
    async claimPlot(plotId, accountId, name, ts) {
      const own = await this.getOwnedPlotId(accountId);
      if (own != null) return own === plotId ? { result: 'ok', plotId } : { result: 'have', plotId: own };
      try {
        const r = await pool.query(
          'INSERT INTO plots(plot_id,account_id,name,snapshot,updated_at) VALUES($1,$2,$3,NULL,$4) ' +
          'ON CONFLICT (plot_id) DO NOTHING',
          [plotId, accountId, name, ts]);
        if (r.rowCount === 1) return { result: 'ok', plotId };
        return { result: 'taken' };
      } catch (e) {
        if (e && e.code === '23505') { // race: this account already owns another plot
          const cur = await this.getOwnedPlotId(accountId);
          return { result: 'have', plotId: cur };
        }
        throw e;
      }
    },
    async listPlots(since) {
      const r = since
        ? await pool.query('SELECT * FROM plots WHERE updated_at > $1', [since])
        : await pool.query('SELECT * FROM plots');
      return r.rows.map((p) => ({
        accountId: p.account_id,
        name: p.name || 'Home',
        plotId: Number(p.plot_id),
        snapshot: p.snapshot || null,
        updatedAt: Number(p.updated_at),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Store selection
// ---------------------------------------------------------------------------
let store = null;
async function initStore() {
  if (DATABASE_URL) {
    store = makePgStore();
    await store.init();
    console.log('Storage: PostgreSQL (persistent)');
  } else {
    store = makeFileStore();
    await store.init();
    console.log('Storage: data.json (temporary — set DATABASE_URL for persistent storage)');
  }
}

// ---------------------------------------------------------------------------
// Sessions / auth
// ---------------------------------------------------------------------------
function tokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.indexOf('Bearer ') === 0) return auth.slice(7).trim();
  const u = new URL(req.url, 'http://localhost');
  return u.searchParams.get('token') || '';
}
async function authAccount(req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const accountId = await store.sessionAccount(token);
  if (!accountId) return null;
  return store.accountById(accountId);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname, query) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  const ip = (req.socket.remoteAddress || 'unknown');

  if (pathname === '/api/register' && req.method === 'POST') {
    if (rateLimited(ip)) { sendJSON(res, 429, { error: 'too_many_requests' }); return true; }
    let body;
    try { body = await readBody(req); }
    catch (e) { sendJSON(res, 400, { error: e.message }); return true; }
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    if (!validLogin(login)) { sendJSON(res, 400, { error: 'bad_login' }); return true; }
    if (password.length < 4 || password.length > 64) { sendJSON(res, 400, { error: 'weak_password' }); return true; }
    if (await store.findAccountByLogin(login)) { sendJSON(res, 409, { error: 'login_taken' }); return true; }
    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      id: crypto.randomBytes(8).toString('hex'),
      login,
      login_lower: login.toLowerCase(),
      pass_hash: hashPassword(password, salt),
      pass_salt: salt,
      created_at: now(),
    };
    await store.createAccount(account);
    const token = newToken();
    await store.createSession(token, account.id);
    sendJSON(res, 200, { token, login: account.login, accountId: account.id });
    return true;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (rateLimited(ip)) { sendJSON(res, 429, { error: 'too_many_requests' }); return true; }
    let body;
    try { body = await readBody(req); }
    catch (e) { sendJSON(res, 400, { error: e.message }); return true; }
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    const account = await store.findAccountByLogin(login);
    if (!account) { sendJSON(res, 401, { error: 'bad_credentials' }); return true; }
    const hashed = hashPassword(password, account.pass_salt);
    if (hashed !== account.pass_hash) { sendJSON(res, 401, { error: 'bad_credentials' }); return true; }
    const token = newToken();
    await store.createSession(token, account.id);
    sendJSON(res, 200, { token, login: account.login, accountId: account.id });
    return true;
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const account = await authAccount(req);
    if (!account) { sendJSON(res, 401, { error: 'unauthorized' }); return true; }
    const plotId = await store.getOwnedPlotId(account.id);
    const player = await store.getPlayer(account.id);
    sendJSON(res, 200, {
      login: account.login,
      accountId: account.id,
      plotId,
      save: player ? player.save : null,
    });
    return true;
  }

  if (pathname === '/api/save' && req.method === 'POST') {
    const account = await authAccount(req);
    if (!account) { sendJSON(res, 401, { error: 'unauthorized' }); return true; }
    let body;
    try { body = await readBody(req); }
    catch (e) { sendJSON(res, 400, { error: e.message }); return true; }
    await store.setPlayer(account.id, body.save || null, now());
    if (body.snapshot) await store.updatePlotSnapshot(account.id, body.snapshot, account.login, now());
    sendJSON(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/claim-plot' && req.method === 'POST') {
    const account = await authAccount(req);
    if (!account) { sendJSON(res, 401, { error: 'unauthorized' }); return true; }
    let body;
    try { body = await readBody(req); }
    catch (e) { sendJSON(res, 400, { error: e.message }); return true; }
    const plotId = Number(body.plotId);
    if (!Number.isInteger(plotId) || plotId < 0 || plotId > 48) {
      sendJSON(res, 400, { error: 'bad_plot' }); return true;
    }
    const out = await store.claimPlot(plotId, account.id, account.login, now());
    if (out.result === 'ok') { sendJSON(res, 200, { ok: true, plotId }); return true; }
    if (out.result === 'have') { sendJSON(res, 409, { error: 'already_have_plot', plotId: out.plotId }); return true; }
    sendJSON(res, 409, { error: 'plot_taken' });
    return true;
  }

  if (pathname === '/api/village' && req.method === 'GET') {
    const since = Number(query.get('since') || 0) || 0;
    const list = await store.listPlots(since);
    sendJSON(res, 200, list);
    return true;
  }

  sendJSON(res, 404, { error: 'not_found' });
  return true;
}

// ---------------------------------------------------------------------------
// Static files (only what the game needs, for local testing)
// ---------------------------------------------------------------------------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/three.js': ['three.js', 'text/javascript; charset=utf-8'],
};
function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  const file = path.join(GAME_DIR, entry[0]);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
  return true;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  if (pathname.indexOf('/api/') === 0) {
    handleApi(req, res, pathname, u.searchParams).catch((e) => {
      console.error('API error:', e && e.message);
      try { sendJSON(res, 500, { error: 'server_error' }); } catch (err) {}
    });
    return;
  }
  if (req.method === 'GET' && serveStatic(res, pathname)) return;
  if (req.method === 'GET' && pathname === '/health') { sendJSON(res, 200, { ok: true }); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (store) await store.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initStore().then(() => {
  server.listen(PORT, () => {
    console.log('Riverside Village server on http://localhost:' + PORT);
  });
}).catch((e) => {
  console.error('Failed to start:', e && e.message);
  process.exit(1);
});
