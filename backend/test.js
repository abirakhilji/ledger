/**
 * Smoke tests for the Ledger API. Run with:  npm test
 * Uses a temporary data file, so your real tasks are never touched.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
const dataFile = path.join(tmpDir, 'tasks.json');
process.env.DATA_FILE = dataFile; // must be set before server.js is loaded
process.env.ALLOWED_ORIGIN = '*';

const { server } = require('./server');
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

let idA;
let idB;

test('health check', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('creates a task (text is trimmed, done starts false)', async () => {
  const r = await call('POST', '/api/tasks', { text: '  Buy milk  ', date: '2026-09-24' });
  assert.equal(r.status, 201);
  assert.equal(r.body.text, 'Buy milk');
  assert.equal(r.body.done, false);
  assert.equal(r.body.date, '2026-09-24');
  assert.ok(r.body.id);
  idA = r.body.id;
});

test('rejects bad input', async () => {
  assert.equal((await call('POST', '/api/tasks', {})).status, 400);
  assert.equal((await call('POST', '/api/tasks', { text: '   ' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { text: 'x'.repeat(141) })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { text: 'ok', date: '2026-02-30' })).status, 400);

  const bad = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
});

test('lists tasks, optionally filtered by date', async () => {
  const b = await call('POST', '/api/tasks', { text: 'Read a chapter', date: '2026-09-25' });
  idB = b.body.id;

  const all = await call('GET', '/api/tasks');
  assert.equal(all.body.length, 2);

  const day = await call('GET', '/api/tasks?date=2026-09-24');
  assert.equal(day.body.length, 1);
  assert.equal(day.body[0].id, idA);

  assert.equal((await call('GET', '/api/tasks?date=nope')).status, 400);
});

test('updates a task', async () => {
  const done = await call('PATCH', `/api/tasks/${idA}`, { done: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.done, true);

  const renamed = await call('PATCH', `/api/tasks/${idA}`, { text: 'Buy oat milk' });
  assert.equal(renamed.body.text, 'Buy oat milk');
  assert.equal(renamed.body.done, true); // untouched by the second patch

  assert.equal((await call('PATCH', `/api/tasks/${idA}`, {})).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${idA}`, { done: 'yes' })).status, 400);
  assert.equal((await call('PATCH', '/api/tasks/does-not-exist', { done: true })).status, 404);
});

test('clears closed tasks only for the given day', async () => {
  assert.equal((await call('DELETE', '/api/tasks')).status, 400); // guard against wiping all

  const other = await call('DELETE', '/api/tasks?done=true&date=2026-09-25');
  assert.equal(other.body.deleted, 0); // task B is still open

  const cleared = await call('DELETE', '/api/tasks?done=true&date=2026-09-24');
  assert.equal(cleared.body.deleted, 1);

  const left = await call('GET', '/api/tasks');
  assert.equal(left.body.length, 1);
  assert.equal(left.body[0].id, idB);
});

test('deletes a single task', async () => {
  assert.equal((await call('DELETE', `/api/tasks/${idB}`)).status, 204);
  assert.equal((await call('DELETE', `/api/tasks/${idB}`)).status, 404);
  assert.equal((await call('GET', '/api/tasks')).body.length, 0);
});

test('saves to the data file', async () => {
  const r = await call('POST', '/api/tasks', { text: 'Persist me', date: '2026-09-26' });
  const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, r.body.id);
});

test('answers CORS preflight and unknown routes', async () => {
  const pre = await call('OPTIONS', '/api/tasks');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);

  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/api/whatever')).status, 404);
});
