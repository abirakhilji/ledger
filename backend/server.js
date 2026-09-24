/**
 * Ledger backend — a tiny REST API for the Ledger to-do app.
 *
 * Zero dependencies: only Node's built-in modules (nothing to `npm install`).
 * Tasks are kept in memory and written to a JSON file after every change,
 * so they survive restarts.
 *
 * Task shape (same as the frontend already uses):
 *   { id: string, text: string, done: boolean, createdAt: number, date: 'YYYY-MM-DD' }
 *
 * Endpoints:
 *   GET    /api/health
 *   GET    /api/tasks?date=YYYY-MM-DD      list tasks (date is optional)
 *   POST   /api/tasks                      body: { text, date? }
 *   PATCH  /api/tasks/:id                  body: { text?, done? }
 *   DELETE /api/tasks/:id                  delete one task
 *   DELETE /api/tasks?done=true[&date=..]  clear closed tasks
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------------------------------------------------------------------- */
/* Config (all optional, set via environment variables)                    */
/* ---------------------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'tasks.json');

// Which websites may call this API from a browser. Comma separated.
// Example: ALLOWED_ORIGIN=https://todoled.netlify.app,http://localhost:5500
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const MAX_TEXT = 140; // same limit as the input box in index.html
const MAX_TASKS = 5000; // safety cap so the data file can't grow forever
const MAX_BODY_BYTES = 10 * 1024;

/* ---------------------------------------------------------------------- */
/* Storage                                                                 */
/* ---------------------------------------------------------------------- */

function loadTasks() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return []; // first run, no file yet
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    // Don't silently overwrite a damaged file — keep it for inspection.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(DATA_FILE, backup);
    console.error(`Data file was unreadable. Moved it to ${backup} and started empty.`);
    return [];
  }
}

// Write to a temp file first, then rename, so a crash can never leave a
// half-written tasks.json behind.
function saveTasks(next) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let tasks = loadTasks();

/** Save first, then swap the in-memory list, so memory never gets ahead of disk. */
function commit(next) {
  saveTasks(next);
  tasks = next;
}

/* ---------------------------------------------------------------------- */
/* Small helpers                                                           */
/* ---------------------------------------------------------------------- */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readJsonObject(req) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY_BYTES) {
    req.resume(); // discard the body
    return Promise.reject(httpError(413, 'Request body too large'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return; // stop storing, keep draining
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooBig) return reject(httpError(413, 'Request body too large'));

      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        return reject(httpError(400, 'Body must be valid JSON'));
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reject(httpError(400, 'Body must be a JSON object'));
      }
      resolve(body);
    });

    req.on('error', reject);
  });
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects things like 2026-02-30 that JS would silently roll over.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function queryDate(url) {
  const date = url.searchParams.get('date');
  if (date !== null && !isValidDateStr(date)) {
    throw httpError(400, '"date" must be a real date like 2026-09-24');
  }
  return date;
}

function cleanText(value) {
  if (typeof value !== 'string') throw httpError(400, '"text" must be a string');
  const text = value.trim();
  if (!text) throw httpError(400, '"text" cannot be empty');
  if (text.length > MAX_TEXT) throw httpError(400, `"text" must be at most ${MAX_TEXT} characters`);
  return text;
}

/* ---------------------------------------------------------------------- */
/* Routes                                                                  */
/* ---------------------------------------------------------------------- */

async function handleCollection(req, res, url) {
  switch (req.method) {
    case 'GET': {
      const date = queryDate(url);
      const list = tasks
        .filter((t) => date === null || t.date === date)
        .sort((a, b) => b.createdAt - a.createdAt); // newest first, like the UI
      return send(res, 200, list);
    }

    case 'POST': {
      const body = await readJsonObject(req);
      const text = cleanText(body.text);

      // Best to always send `date` from the browser: the server's "today"
      // (UTC) can differ from the user's local day.
      const date = body.date === undefined ? new Date().toISOString().slice(0, 10) : body.date;
      if (!isValidDateStr(date)) throw httpError(400, '"date" must be a real date like 2026-09-24');

      if (tasks.length >= MAX_TASKS) throw httpError(429, 'Task limit reached');

      const task = {
        id: crypto.randomUUID(),
        text,
        done: false,
        createdAt: Date.now(),
        date,
      };
      commit([...tasks, task]);
      return send(res, 201, task);
    }

    case 'DELETE': {
      // Guard: never wipe everything by accident.
      if (url.searchParams.get('done') !== 'true') {
        throw httpError(400, 'To clear tasks use ?done=true (optionally with &date=YYYY-MM-DD)');
      }
      const date = queryDate(url);
      const next = tasks.filter((t) => !(t.done && (date === null || t.date === date)));
      const deleted = tasks.length - next.length;
      if (deleted > 0) commit(next);
      return send(res, 200, { deleted });
    }

    default:
      throw httpError(405, 'Method not allowed');
  }
}

async function handleItem(req, res, id) {
  const index = tasks.findIndex((t) => t.id === id);

  switch (req.method) {
    case 'GET': {
      if (index === -1) throw httpError(404, 'Task not found');
      return send(res, 200, tasks[index]);
    }

    case 'PATCH': {
      if (index === -1) throw httpError(404, 'Task not found');
      const body = await readJsonObject(req);

      const patch = {};
      if ('text' in body) patch.text = cleanText(body.text);
      if ('done' in body) {
        if (typeof body.done !== 'boolean') throw httpError(400, '"done" must be true or false');
        patch.done = body.done;
      }
      if (Object.keys(patch).length === 0) {
        throw httpError(400, 'Nothing to update: send "text" and/or "done"');
      }

      const updated = { ...tasks[index], ...patch };
      const next = tasks.slice();
      next[index] = updated;
      commit(next);
      return send(res, 200, updated);
    }

    case 'DELETE': {
      if (index === -1) throw httpError(404, 'Task not found');
      commit(tasks.filter((t) => t.id !== id));
      return send(res, 204);
    }

    default:
      throw httpError(405, 'Method not allowed');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api', 'tasks', '<id>']

  if (parts[0] !== 'api') throw httpError(404, 'Not found');

  if (parts.length === 2 && parts[1] === 'health') {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    return send(res, 200, { status: 'ok', tasks: tasks.length });
  }

  if (parts[1] !== 'tasks' || parts.length > 3) throw httpError(404, 'Not found');

  if (parts.length === 2) return handleCollection(req, res, url);

  let id;
  try {
    id = decodeURIComponent(parts[2]);
  } catch {
    throw httpError(400, 'Bad task id');
  }
  return handleItem(req, res, id);
}

/* ---------------------------------------------------------------------- */
/* Server                                                                  */
/* ---------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  // Browsers send this "preflight" request before PATCH/DELETE/JSON calls.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    await handle(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ledger API running on http://localhost:${PORT}`);
    console.log(`Data file: ${DATA_FILE}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}

module.exports = { server };
