/**
 * Credential resolution for the snapshot store.
 *
 * Vercel names the Redis REST variables differently depending on how the
 * database was provisioned, and forces a custom prefix when a name is already
 * taken. These cases cover every shape we can be handed.
 */
const mod = new URL('../api/_store.js', import.meta.url);
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
  if (!ok) fails++;
};

async function withEnv(vars, fn) {
  for (const k of Object.keys(process.env)) {
    if (k.includes('REST_API') || k.includes('UPSTASH')) delete process.env[k];
  }
  Object.assign(process.env, vars);
  // bust the module cache so top-level state re-evaluates
  const m = await import(`${mod.href}?t=${Math.random()}`);
  return fn(m);
}

console.log('\nCredential resolution');

await withEnv({ KV_REST_API_URL: 'u1', KV_REST_API_TOKEN: 't1' },
  (m) => check('canonical KV pair', m.storeCredentials()?.via, 'KV_REST_API_URL'));

await withEnv({ UPSTASH_REDIS_REST_URL: 'u2', UPSTASH_REDIS_REST_TOKEN: 't2' },
  (m) => check('marketplace Upstash pair', m.storeCredentials()?.via, 'UPSTASH_REDIS_REST_URL'));

await withEnv({ STORAGE_REST_API_URL: 'u3', STORAGE_REST_API_TOKEN: 't3' },
  (m) => check('custom prefix (STORAGE_)', m.storeCredentials()?.via, 'STORAGE_REST_API_URL'));

await withEnv({ KV_REST_API_URL: 'u4', KV_REST_API_READ_ONLY_TOKEN: 'ro' },
  (m) => check('read-only token is NOT accepted', m.storeCredentials(), null));

await withEnv({ KV_REST_API_URL: '' , KV_REST_API_TOKEN: '' },
  (m) => check('empty placeholders ignored', m.storeCredentials(), null));

await withEnv({}, (m) => check('nothing configured', m.storeCredentials(), null));

await withEnv({ KV_REST_API_URL: 'u5', KV_REST_API_TOKEN: 't5', STORAGE_REST_API_URL: 'x', STORAGE_REST_API_TOKEN: 'y' },
  (m) => check('canonical wins over prefixed', m.storeCredentials()?.via, 'KV_REST_API_URL'));

/* ------------------------------------------------------------------ *
 * API route contracts (setup / health / data) — pure helpers and handlers
 * driven with fake req/res objects. No store, no MCP needed unless noted.
 * ------------------------------------------------------------------ */
console.log('\nAPI route contracts');
const ok = (name, cond, extra = '') => check(name, Boolean(cond), true) || (cond ? null : console.log(`        ${extra}`));

{
  const { errorBody } = await import('../api/setup.js');
  const mcp = (code, message = 'boom') => Object.assign(new Error(message), { name: 'McpError', code });
  const auth = errorBody(mcp('auth', 'MCP rejected the API key (HTTP 401)'));
  ok('setup error: auth keeps error=bad_key and carries code=auth', auth.ok === false && auth.error === 'bad_key' && auth.code === 'auth', JSON.stringify(auth));
  ok('setup error: auth message tells the user to re-copy the key', /Settings → API/.test(auth.message), auth.message);
  const forb = errorBody(mcp('forbidden', 'Missing role'));
  ok('setup error: forbidden is not "bad key" — points at HYROS support', forb.code === 'forbidden' && /HYROS support/.test(forb.message) && !/rejected that key/.test(forb.message), JSON.stringify(forb));
  const rl = errorBody(mcp('rate_limited', 'request limit'));
  ok('setup error: rate_limited says wait and retry', rl.code === 'rate_limited' && /wait/.test(rl.message), JSON.stringify(rl));
  const nc = errorBody(Object.assign(new Error('No HYROS API key is available for this account'), { name: 'McpNotConfigured', code: 'NOT_CONFIGURED' }));
  ok('setup error: NOT_CONFIGURED travels as its own code', nc.code === 'NOT_CONFIGURED' && nc.error === 'NOT_CONFIGURED', JSON.stringify(nc));
  const raw = errorBody(mcp(undefined, 'hyros_get_user_info: MCP is not enabled for this account'));
  ok('setup error: an MCP error without a code keeps the server text as detail', raw.error === 'bad_key' && raw.detail === 'hyros_get_user_info: MCP is not enabled for this account', JSON.stringify(raw));
  const weak = errorBody(Object.assign(new Error('Use at least 8 characters.'), { status: 400, code: 'weak' }));
  ok('setup error: plain coded errors pass through unchanged', weak.error === 'weak' && weak.code === 'weak' && weak.message === 'Use at least 8 characters.', JSON.stringify(weak));
}

/* Handlers end to end: an in-memory KV (same stub the pipeline test uses) and the mock MCP. */
{
  const mem = new Map();
  globalThis.fetch = ((orig) => async (url, opts) => {
    if (String(url).startsWith('http://kv.local')) {
      const [cmd, k, v, ...rest] = JSON.parse(opts.body);
      if (cmd === 'GET') return new Response(JSON.stringify({ result: mem.get(k) ?? null }));
      if (cmd === 'SET') { mem.set(k, v); return new Response(JSON.stringify({ result: 'OK' })); }
      if (cmd === 'DEL') { let n = 0; for (const key of [k, v, ...rest].filter(Boolean)) n += mem.delete(key) ? 1 : 0; return new Response(JSON.stringify({ result: n })); }
      if (cmd === 'SCAN') { const prefix = String(rest[0] || '').replace(/\*$/, ''); return new Response(JSON.stringify({ result: ['0', [...mem.keys()].filter((key) => key.startsWith(prefix))] })); }
    }
    return orig(url, opts);
  })(globalThis.fetch);
  const PORT = 4323;
  process.env.KV_REST_API_URL = 'http://kv.local'; process.env.KV_REST_API_TOKEN = 't';
  process.env.HYROS_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
  process.env.ACCOUNT_KEY_SECRET = 'test-secret';
  delete process.env.REPORT_PASSWORD; delete process.env.HYROS_API_KEY;
  const { startMock } = await import('./mock-mcp.mjs');
  const server = await startMock(PORT);
  const fakeRes = () => ({ code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const req = (url, headers = {}, method = 'GET', body = undefined) => ({ url, method, headers: { host: 'x', ...headers }, body });
  const PW = 'correct-horse-battery';
  try {
    const { TEMPLATE_VERSION } = await import('../api/_version.js');
    const setupMod = await import('../api/_setup.js');
    await setupMod.setPassword(PW);
    const acc = await import('../api/_accounts.js');
    const added = await acc.addAccount('client-key-XYZ');

    const health = await import('../api/health.js');
    ok('health: REQUIRED_TOOLS lists the 15 tools the app needs', Array.isArray(health.REQUIRED_TOOLS) && health.REQUIRED_TOOLS.length === 15 && health.REQUIRED_TOOLS.includes('hyros_get_marginal_cac_curve'));
    ok('health: missingTools() returns what the list lacks', JSON.stringify(health.missingTools(['hyros_get_user_info', 'hyros_get_leads'])) === JSON.stringify(health.REQUIRED_TOOLS.filter((t) => !['hyros_get_user_info', 'hyros_get_leads'].includes(t))));
    ok('health: missingTools() is empty for a complete list', health.missingTools(health.REQUIRED_TOOLS).length === 0);
    let res = fakeRes();
    await health.default(req('/api/health', { 'x-report-key': PW }), res);
    ok('health: answers with templateVersion', res.body?.templateVersion === TEMPLATE_VERSION, JSON.stringify(res.body));
    ok('health: missingTools names the tools the mock MCP does not expose', Array.isArray(res.body?.missingTools) && res.body.missingTools.includes('hyros_get_lead_journey') && res.body.missingTools.includes('hyros_get_lead_clicks') && !res.body.missingTools.includes('hyros_get_user_info'), JSON.stringify(res.body?.missingTools));
    ok('health: still reports toolCount and the account email', res.body?.toolCount > 0 && res.body?.accountEmail === 'mock@hyros.test' && res.body?.account === added.account.id, JSON.stringify(res.body));

    const data = await import('../api/data.js');
    res = fakeRes();
    await data.default(req('/api/data', { 'x-report-key': PW }), res);
    ok('data: answers with templateVersion', res.body?.ok === true && res.body?.templateVersion === TEMPLATE_VERSION, JSON.stringify(res.body));
  } finally {
    server.close();
  }
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll store + API contract checks pass.\n');
process.exit(fails ? 1 : 0);
