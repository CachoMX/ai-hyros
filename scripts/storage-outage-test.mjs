import assert from 'node:assert/strict';
import { readConfig, writeConfig, readSnapshot } from '../api/_store.js';
import { getConfig, setPassword, changePassword, hashPassword, verifyPassword } from '../api/_setup.js';
import { checkAccess, deny } from '../api/_auth.js';
import setupHandler from '../api/setup.js';

process.env.KV_REST_API_URL = 'https://storage.example.test';
process.env.KV_REST_API_TOKEN = 'fixture-private-token';
delete process.env.REPORT_PASSWORD;
const mem = new Map();
const commands = [];
const events = [];
const originalFetch = globalThis.fetch;
const originalError = console.error;
let fault = null;
let calls = 0;
console.error = (...parts) => events.push(parts.join(' '));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = async (url, options) => {
  assert.equal(url, process.env.KV_REST_API_URL);
  const command = JSON.parse(options.body);
  commands.push(command[0]);
  calls += 1;
  if (fault) {
    const failed = await fault(command, options);
    if (failed) return failed;
  }
  const [op, key, value, ...flags] = command;
  if (op === 'GET') return json({ result: mem.get(key) ?? null });
  if (op === 'SET') {
    if (flags.includes('NX') && mem.has(key)) return json({ result: null });
    mem.set(key, value);
    return json({ result: 'OK' });
  }
  throw new Error(`Unexpected destructive command: ${op}`);
};
const res = () => ({ code: 200, body: null, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const req = (method = 'GET', body) => ({ url: '/api/setup', method, body, headers: { host: 'app.test', 'x-report-key': 'test-dashboard-password' } });
const cfg = { passwordHash: hashPassword('test-dashboard-password') };

try {
  assert.equal(await readConfig(), null);
  console.log('PASS a successful missing-key result is distinct from a storage failure');
  for (const [status, error, code] of [
    [401, 'invalid token fixture-private-token', 'kv_auth'],
    [403, 'NOPERM write denied secret fixture-private-token', 'kv_permission'],
    [400, 'READONLY replica', 'kv_permission'],
    [429, 'daily request limit exceeded', 'kv_limit'],
    [200, 'ERR max requests limit exceeded', 'kv_limit'],
    [503, 'provider infrastructure error', 'kv_unavailable'],
  ]) {
    fault = () => json({ error }, status);
    await assert.rejects(readConfig(), e => e.code === code && e.status === 503 && !e.message.includes('fixture-private-token'));
    await assert.rejects(writeConfig(cfg), e => e.code === code);
  }
  fault = () => json({});
  await assert.rejects(readConfig(), { code: 'kv_response' });
  fault = () => { throw new Error('network failure: fixture-private-token'); };
  await assert.rejects(readConfig(), { code: 'kv_unavailable' });
  assert.equal(await readSnapshot(), null);
  console.log('PASS REST failures are classified without exposing provider text; snapshot reads still fail soft');

  fault = null;
  for (const bad of ['not-json', 'null', '{}', '[]', '{"passwordHash":"broken"}']) {
    mem.set('aihyros:config', bad);
    await assert.rejects(readConfig(), { code: 'kv_corrupt' });
  }
  mem.set('aihyros:config', JSON.stringify(cfg));
  await getConfig({ fresh: true });
  fault = () => json({ error: 'daily request limit exceeded' }, 429);
  const response = res();
  await setupHandler(req(), response);
  assert.equal(response.code, 503);
  assert.equal(response.body.code, 'kv_limit');
  assert.equal(response.body.state, undefined);
  const access = await checkAccess(req());
  assert.deepEqual(access, { ok: false, unavailable: true });
  const denied = res();
  deny(denied, access);
  assert.equal(denied.code, 503);
  assert.equal(denied.body.error, 'storage_unavailable');
  assert.equal(denied.body.setup, undefined);
  console.log('PASS config outages invalidate cache and block setup/auth without pretending this is a new installation');

  const marker = 'existing-snapshot';
  mem.set('aihyros:snapshot:latest', marker);
  commands.length = 0;
  const failedSetup = res();
  await setupHandler(req('POST', { action: 'setup', password: 'new-dashboard-password' }), failedSetup);
  assert.equal(failedSetup.code, 503);
  assert.equal(mem.get('aihyros:snapshot:latest'), marker);
  assert(commands.every(op => op === 'GET'));
  console.log('PASS setup during an outage performs no writes or deletions');

  fault = ([op]) => op === 'SET' ? json({ error: 'NOPERM fixture-private-token' }, 403) : null;
  await assert.rejects(changePassword('new-dashboard-password'), { code: 'kv_permission' });
  assert.equal(mem.get('aihyros:config'), JSON.stringify(cfg));
  assert(verifyPassword('test-dashboard-password', JSON.parse(mem.get('aihyros:config')).passwordHash));
  console.log('PASS failed password writes preserve the existing password');

  mem.delete('aihyros:config');
  commands.length = 0;
  await assert.rejects(setPassword('new-dashboard-password'), { code: 'kv_permission' });
  assert.equal(mem.get('aihyros:snapshot:latest'), marker);
  assert(!commands.includes('DEL') && !commands.includes('SCAN'));
  console.log('PASS first-run write failures never remove old data');

  fault = null;
  mem.set('aihyros:accounts', JSON.stringify({ accounts: [{ id: 'acc_000000000001' }] }));
  await assert.rejects(setPassword('new-dashboard-password'), { code: 'kv_corrupt' });
  assert(!mem.has('aihyros:config'));
  mem.delete('aihyros:accounts');
  const attempts = await Promise.allSettled([setPassword('first-password-123'), setPassword('second-password-123')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'exists');
  assert.equal(mem.get('aihyros:snapshot:latest'), marker);
  console.log('PASS orphaned accounts block setup and concurrent first-run requests cannot overwrite the winner');

  fault = () => new Promise(() => {});
  const start = Date.now();
  await assert.rejects(readConfig(), { code: 'kv_timeout' });
  assert(Date.now() - start < 9500);
  assert(!events.some(event => /fixture-private-token|test-dashboard-password|existing-snapshot|storage\.example\.test/.test(event)));
  assert(events.every(event => {
    const value = JSON.parse(event);
    return ['storage.error', 'setup.error'].includes(value.evt);
  }));
  console.log('PASS stalled database requests time out and logs contain no tokens, passwords, URLs or record contents');
  console.log(`All storage outage checks passed (${calls} mocked requests).`);
} finally {
  console.error = originalError;
  globalThis.fetch = originalFetch;
}
