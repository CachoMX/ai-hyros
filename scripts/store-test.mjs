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

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll credential cases pass.\n');
process.exit(fails ? 1 : 0);
