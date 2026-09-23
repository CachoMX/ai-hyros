/**
 * Snapshot persistence via Upstash Redis / Vercel KV REST.
 * No npm dependency — plain fetch, same pattern the lander uses.
 * Snapshot reads may fail soft. Setup/auth reads must distinguish an outage
 * from a missing record so an unavailable database never starts first-run setup.
 */
import { logEvent } from './_log.js';

const KEY = 'aihyros:snapshot:latest';
const HISTORY_PREFIX = 'aihyros:snapshot:';
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/**
 * Multi-account layout. The PRIMARY account (the HYROS_API_KEY from the
 * environment, id "env") keeps the original keys so existing deployments
 * carry on untouched; every added account gets its own namespace.
 */
export const PRIMARY_ID = 'env';
const ACCOUNTS_KEY = 'aihyros:accounts';
const snapKey = (id) => (!id || id === PRIMARY_ID ? KEY : `aihyros:acct:${id}:snapshot`);
const histKey = (id, day) => (!id || id === PRIMARY_ID ? `${HISTORY_PREFIX}${day}` : `aihyros:acct:${id}:snapshot:${day}`);
const acctPrefsKey = (id) => `aihyros:acct:${id}:prefs`;

/**
 * Resolve the Redis REST credentials whatever Vercel decided to call them.
 *
 * Vercel names these differently depending on how the database was
 * provisioned, and if a variable name is already taken it forces a CUSTOM
 * PREFIX on the whole set (STORAGE_REST_API_URL, and so on). Rather than make
 * anyone rename variables by hand, try the two canonical pairs and then fall
 * back to discovering any `<PREFIX>_REST_API_URL` that has a matching
 * `<PREFIX>_REST_API_TOKEN` beside it.
 */
const EXPLICIT_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
];

export function storeCredentials() {
  for (const [urlKey, tokenKey] of EXPLICIT_PAIRS) {
    const url = process.env[urlKey];
    const token = process.env[tokenKey];
    if (url && token) return { url, token, via: urlKey };
  }

  // Prefixed set, e.g. STORAGE_REST_API_URL + STORAGE_REST_API_TOKEN.
  // The _URL -> _TOKEN swap deliberately never matches
  // KV_REST_API_READ_ONLY_TOKEN, which is a different credential.
  for (const [key, url] of Object.entries(process.env)) {
    if (!key.endsWith('_REST_API_URL') || !url) continue;
    const token = process.env[`${key.slice(0, -4)}_TOKEN`];
    if (token) return { url, token, via: key };
  }
  return null;
}

export function storeConfigured() {
  return storeCredentials() !== null;
}

const STORAGE_MESSAGES = {
  auth: 'Database authentication failed. Check the Redis REST URL and token in Vercel, then redeploy.',
  permission: 'Database write permission was denied. Use the standard read/write REST token, not a read-only token, then redeploy.',
  limit: 'The database has reached a usage or storage limit. Check its limits and status in Upstash.',
  timeout: 'The database request timed out. Retry after checking the database status.',
  unavailable: 'The database is temporarily unavailable. Retry later; do not reset this dashboard.',
  config: 'Database REST configuration is missing or invalid. Check the REST URL and token in Vercel, then redeploy.',
  response: 'The database returned an invalid response. Check the database connection; do not reset this dashboard.',
  corrupt: 'The stored dashboard configuration could not be read safely. Restore the configuration from a database backup; do not run setup again.',
};

function storageError(kind, operation, httpStatus = null) {
  const code = `kv_${kind}`;
  const method = ['GET', 'SET', 'DEL', 'SCAN', 'EVAL', 'PING'].includes(operation) ? operation : 'OTHER';
  logEvent('storage.error', { operation: method, code, httpStatus });
  return Object.assign(new Error(STORAGE_MESSAGES[kind] || STORAGE_MESSAGES.unavailable), { name: 'StorageError', code, status: 503 });
}

function storageFailure(status, message) {
  const text = String(message || '').slice(0, 1000);
  if (/READONLY|NOPERM|read.only|permission|not allowed/i.test(text)) return 'permission';
  if (status === 401 || /WRONGPASS|unauthorized|invalid token|authentication/i.test(text)) return 'auth';
  if (status === 429 || /quota|limit exceeded|exceeded.*limit|max.*(?:size|requests)|OOM/i.test(text)) return 'limit';
  return status === 403 ? 'permission' : 'unavailable';
}

async function kv(command, { strict = false } = {}) {
  const creds = storeCredentials();
  if (!creds) {
    if (strict) throw storageError('config', command[0]);
    return null;
  }
  const controller = new AbortController();
  let timer;
  try {
    const operation = async () => {
      const res = await fetch(creds.url.trim(), {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${creds.token.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
      });
      let body;
      try { body = await res.json(); }
      catch { throw storageError(res.ok ? 'response' : storageFailure(res.status), command[0], res.status); }
      if (!res.ok || body?.error) throw storageError(storageFailure(res.status, body?.error), command[0], res.status);
      if (!body || !Object.hasOwn(body, 'result')) throw storageError('response', command[0], res.status);
      return body.result;
    };
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(storageError('timeout', command[0])); }, 8000);
    })]);
  } catch (err) {
    const failure = err?.name === 'StorageError' ? err : storageError('unavailable', command[0]);
    if (strict) throw failure;
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const PREFS_KEY = 'aihyros:prefs';
const CONFIG_KEY = 'aihyros:config';

/** Raw KV command for the few callers that need one (setup, cron lock). */
export async function kvRaw(command) {
  return kv(command);
}

/** Self-serve setup config: password hash + generated secrets (see _setup.js). */
export async function readConfig() {
  const cfg = await readJson(CONFIG_KEY, { strict: true });
  if (cfg !== null && (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)
    || !/^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(cfg.passwordHash || ''))) throw storageError('corrupt', 'GET');
  return cfg;
}

export async function writeConfig(cfg, { onlyIfMissing = false } = {}) {
  const result = await kv(['SET', CONFIG_KEY, JSON.stringify(cfg), ...(onlyIfMissing ? ['NX'] : [])], { strict: true });
  if (onlyIfMissing && result === null) return false;
  if (result !== 'OK') throw storageError('response', 'SET');
  return true;
}

/**
 * Factory reset: delete EVERY key this app owns (config, accounts registry,
 * every snapshot + history copy, prefs). SCAN + DEL so nothing is missed —
 * dated history keys cannot be enumerated any other way.
 */
export async function wipeAll() {
  let cursor = '0';
  let deleted = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const r = await kv(['SCAN', cursor, 'MATCH', 'aihyros:*', 'COUNT', '200']);
    if (!Array.isArray(r)) break;
    const [next, keys] = r;
    if (Array.isArray(keys) && keys.length) {
      await kv(['DEL', ...keys]);
      deleted += keys.length;
    }
    cursor = String(next);
    if (cursor === '0') break;
  }
  return deleted;
}

async function readJson(key, { strict = false } = {}) {
  const raw = await kv(['GET', key], { strict });
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (strict && value === null) throw new Error('Unexpected stored null');
    return value;
  } catch {
    if (strict) throw storageError('corrupt', 'GET');
    return null;
  }
}

/**
 * Prefs: column loadout is GLOBAL (one saved view for the dashboard); report
 * settings are PER ACCOUNT (attribution window / stage ranking differ by
 * business). The primary account's settings live in the global object for
 * backward compatibility.
 */
export async function readPrefs(accountId = PRIMARY_ID) {
  const global = (await readJson(PREFS_KEY)) || null;
  if (!accountId || accountId === PRIMARY_ID) return global;
  const own = (await readJson(acctPrefsKey(accountId))) || {};
  return { ...(global || {}), settings: own.settings, savedAt: own.savedAt || global?.savedAt };
}

export async function writePrefs(prefs, accountId = PRIMARY_ID) {
  if (!accountId || accountId === PRIMARY_ID) {
    return (await kv(['SET', PREFS_KEY, JSON.stringify(prefs)])) !== null;
  }
  // Split: cols → global, settings → this account.
  const ok = [];
  if (prefs.cols) {
    const global = (await readJson(PREFS_KEY)) || {};
    ok.push(await kv(['SET', PREFS_KEY, JSON.stringify({ ...global, cols: prefs.cols, savedAt: prefs.savedAt })]));
  }
  if (prefs.settings) {
    ok.push(await kv(['SET', acctPrefsKey(accountId), JSON.stringify({ settings: prefs.settings, savedAt: prefs.savedAt })]));
  }
  return ok.every((r) => r !== null);
}

export async function readSnapshot(accountId = PRIMARY_ID) {
  return readJson(snapKey(accountId));
}

export async function writeSnapshot(snapshot, accountId = PRIMARY_ID) {
  const payload = JSON.stringify(snapshot);
  const day = (snapshot.generatedAt || new Date().toISOString()).slice(0, 10);
  const ok = await kv(['SET', snapKey(accountId), payload]);
  // Keep a dated copy so a bad refresh can be compared against yesterday.
  await kv(['SET', histKey(accountId, day), payload, 'EX', String(TTL_SECONDS)]);
  return ok !== null;
}

export async function deleteAccountData(accountId) {
  if (!accountId || accountId === PRIMARY_ID) return false;
  await kv(['DEL', snapKey(accountId), acctPrefsKey(accountId)]);
  return true;
}

/** The added-accounts registry (encrypted keys — see _accounts.js). */
export async function readAccounts({ strict = false } = {}) {
  const registry = await readJson(ACCOUNTS_KEY, { strict });
  if (strict && registry !== null && (!registry || !Array.isArray(registry.accounts))) throw storageError('corrupt', 'GET');
  return registry?.accounts || [];
}

export async function writeAccounts(accounts) {
  return (await kv(['SET', ACCOUNTS_KEY, JSON.stringify({ accounts, savedAt: new Date().toISOString() })])) !== null;
}
