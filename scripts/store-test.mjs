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

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll store + API contract checks pass.\n');
process.exit(fails ? 1 : 0);
