/**
 * POST|GET /api/refresh -> rebuild the snapshot from the MCP and persist it.
 *
 * Triggered by Vercel Cron daily (Authorization: Bearer $CRON_SECRET) or
 * on demand from the dashboard's Refresh button (password-gated).
 *
 * Every outcome is a structured log line (api/_log.js): `refresh.ok` with
 * the timing and warning count, `refresh.failed` with the error code — the
 * only trace a template owner has when a user reports "it failed".
 */
import { checkAccess, isCron, deny } from './_auth.js';
import { buildSnapshot } from './_snapshot.js';
import { writeSnapshot, readSnapshot, readPrefs, storeConfigured, kvRaw, snapshotPersistenceError } from './_store.js';
import { McpNotConfigured } from './_mcp.js';
import { accountFromReq, asAccount, listAccounts, markKeyStatus, noteRefresh, syncClients } from './_accounts.js';
import { logEvent } from './_log.js';
import { readWebhookConfig, readWebhookDirty, clearWebhookDirty } from './_webhook.js';
import { REFRESH_MAX_S, REFRESH_BUDGET_MS, CRON_BUDGET_MS, CRON_MIN_ACCOUNT_MS, cronAccountBudgetMs } from './_budget.js';

/**
 * Vercel function limit (seconds). Also declared in vercel.json so the
 * platform honours it; both derive from api/_budget.js REFRESH_MAX_S. Hobby
 * projects without Fluid compute must lower it to 60 there.
 */
export const maxDuration = REFRESH_MAX_S;

const dependencies = {
  buildSnapshot, writeSnapshot, readSnapshot, readPrefs, storeConfigured, kvRaw,
  checkAccess, isCron, deny, accountFromReq, asAccount, listAccounts, markKeyStatus,
  noteRefresh, syncClients, logEvent, readWebhookDirty, clearWebhookDirty,
  now: Date.now,
  webhookConfiguration: () => process.env.HYROS_WEBHOOK_ACCOUNTS,
  cronSecret: () => process.env.CRON_SECRET,
};

function webhookWarning(deps, operation, accountId, code = 'storage_unavailable') {
  // Storage exceptions can contain response bodies or credentials. Log fixed codes only.
  deps.logEvent('refresh.webhook_warning', { level: 'warning', operation, accountId, code });
}

function configuredWebhookAccounts(deps) {
  const raw = deps.webhookConfiguration();
  if (!raw) return new Set();
  try { return new Set([...readWebhookConfig(raw).values()].map((entry) => entry.accountId)); }
  catch { webhookWarning(deps, 'configuration', undefined, 'invalid_configuration'); return new Set(); }
}

async function captureWebhookMarker(accountId, deps) {
  try { return await deps.readWebhookDirty(accountId); }
  catch { webhookWarning(deps, 'read', accountId); return undefined; }
}

/** A saved partial snapshot must not acknowledge an event whose data was never fetched. */
export function snapshotFreshForWebhook(snapshot, startedAt, completedAt = Date.now()) {
  const clean = (block) => block && typeof block === 'object' && !Array.isArray(block)
    && !block.stale && !block.skipped && !block.error && !block.partial
    && ['warnings', 'errors'].every((field) => block[field] === undefined
      || (Array.isArray(block[field]) && block[field].length === 0));
  const current = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && Date.parse(value) >= startedAt && Date.parse(value) <= completedAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || !clean(snapshot)
    || snapshot.origin !== 'mcp' || !current(snapshot.generatedAt)
    || !Array.isArray(snapshot.warnings) || snapshot.warnings.length
    || snapshot.sourcesTruncated !== false || snapshot.truncated) return false;
  const crm = snapshot.crm;
  const sync = crm?.sync;
  const lists = ['leads', 'sales', 'calls', 'subscriptions'];
  if (!clean(crm) || !clean(sync) || crm.truncated || !current(sync.syncedAt)
    || !lists.every((name) => Array.isArray(crm[name]) && sync.truncated?.[name] === false)) return false;
  if (!['today', 'yesterday', '7d', '30d'].every((name) => {
    const range = snapshot.ranges?.[name];
    return clean(range) && !range.truncated
      && ['account', 'adset', 'ad'].every((level) => Array.isArray(range.levels?.[level]));
  })) return false;
  const attribution = snapshot.attribution;
  return Boolean(clean(attribution) && current(attribution.checkedAt)
    && Array.isArray(attribution.conversions) && Array.isArray(attribution.errors)
    && attribution.coverage?.complete === true && attribution.coverage?.truncated === false);
}

/** Build + persist one account's snapshot under its own key. */
export async function refreshAccount(accountId, steps, budgetMs, overrides = {}) {
  const deps = { ...dependencies, ...overrides };
  const { buildSnapshot, writeSnapshot, readSnapshot, readPrefs, storeConfigured,
    asAccount, markKeyStatus, noteRefresh, logEvent, now } = deps;
  const webhookAccounts = deps.webhookAccounts ?? configuredWebhookAccounts(deps);
  const started = now();
  const marker = webhookAccounts.has(accountId) ? await captureWebhookMarker(accountId, deps) : null;
  if (deps.dirtyOnly && !marker) {
    return { skipped: marker === undefined ? 'webhook marker unavailable' : 'webhook already consumed' };
  }
  const [prefs, previous] = storeConfigured()
    ? await Promise.all([readPrefs(accountId), readSnapshot(accountId)])
    : [null, null];
  let snapshot;
  const buildStarted = now();
  try {
    snapshot = await asAccount(accountId, () =>
      buildSnapshot({ onProgress: (s) => steps.push(`${accountId}: ${s}`), prefs, previous, budgetMs }));
  } catch (err) {
    logEvent('refresh.failed', { accountId, code: err.code || err.name || 'error', message: err.message, ms: now() - started });
    // Only a rejected key (401) marks the account (or its agency) invalid so
    // the selector can say so instead of 40 clients failing one by one. A
    // 403 (missing role, client not authorized) is recorded as the last
    // error but never flips the key status.
    if (storeConfigured()) {
      if (err.code === 'auth') await markKeyStatus(accountId, 'invalid', err.message);
      await noteRefresh(accountId, false, err.message);
    }
    throw err;
  }
  let persistence = { persisted: false };
  if (storeConfigured()) {
    try {
      const result = await writeSnapshot(snapshot, accountId, { details: true });
      persistence = typeof result === 'boolean' ? { persisted: result } : result;
      if (!persistence?.persisted && !persistence?.persistenceError) {
        persistence = { persisted: false, persistenceError: snapshotPersistenceError() };
      }
    } catch (error) {
      persistence = { persisted: false, persistenceError: snapshotPersistenceError(error) };
    }
  }
  const { persisted, persistenceError, persistenceWarning } = persistence;
  if (marker && persisted === true && snapshotFreshForWebhook(snapshot, buildStarted, now())) {
    try { await deps.clearWebhookDirty(accountId, marker); }
    catch { webhookWarning(deps, 'clear', accountId); }
  } else if (marker) {
    logEvent('refresh.webhook_retained', { accountId, reason: persisted === true ? 'incomplete_snapshot' : 'snapshot_not_persisted' });
  }
  if (storeConfigured()) {
    await markKeyStatus(accountId, 'ok');
    await noteRefresh(accountId, persisted, persistenceError?.message || persistenceWarning?.message);
  }
  logEvent(persisted ? 'refresh.ok' : 'refresh.not_persisted', { accountId, ms: now() - started,
    warnings: snapshot.warnings?.length || 0, persisted, code: persistenceError?.code || persistenceWarning?.code });
  return { snapshot, ...persistence };
}

/**
 * Cron with no ?account=: dirty accounts first, then stalest first. Clients
 * of an agency whose accessible_account_id mode is unsupported cannot be
 * read at all, so they are listed as skipped instead of failing daily.
 */
export function cronTargets(listed, { dirtyAccounts = new Set(), dirtyOnly = false } = {}) {
  const byId = new Map(listed.map((a) => [a.id, a]));
  const unsupported = (a) => a.parentId && byId.get(a.parentId)?.clientModeStatus === 'unsupported';
  const candidates = listed.filter((a) => a.keyStatus !== 'invalid' && a.status === 'APPROVED'
    && (!dirtyOnly || dirtyAccounts.has(a.id)));
  return {
    skipped: candidates.filter(unsupported).map((a) => ({ id: a.id, skipped: 'unsupported' })),
    accounts: candidates.filter((a) => !unsupported(a))
      .sort((a, b) => Number(dirtyAccounts.has(b.id)) - Number(dirtyAccounts.has(a.id))
        || String(a.lastRefresh || '').localeCompare(String(b.lastRefresh || ''))),
  };
}

export async function webhookCronTargets(listed, overrides = {}) {
  const deps = { ...dependencies, ...overrides };
  const webhookAccounts = deps.webhookAccounts ?? configuredWebhookAccounts(deps);
  const dirtyAccounts = new Set();
  const unreadable = [];
  const candidates = cronTargets(listed).accounts.filter((account) => webhookAccounts.has(account.id));
  // Small batches keep marker reads bounded by the configured account limit.
  for (let offset = 0; offset < candidates.length; offset += 5) {
    await Promise.all(candidates.slice(offset, offset + 5).map(async (account) => {
      const marker = await captureWebhookMarker(account.id, deps);
      if (marker) dirtyAccounts.add(account.id);
      else if (marker === undefined) unreadable.push({ id: account.id, skipped: 'webhook marker unavailable' });
    }));
  }
  const targets = cronTargets(listed, { dirtyAccounts, dirtyOnly: deps.dirtyOnly });
  if (deps.dirtyOnly) targets.skipped.push(...unreadable);
  return targets;
}

export function createRefreshHandler(overrides = {}) {
  const deps = { ...dependencies, ...overrides };
  return (req, res) => handleRefresh(req, res, deps);
}

async function handleRefresh(req, res, deps) {
  const { checkAccess, isCron, deny, storeConfigured, kvRaw, listAccounts,
    syncClients, accountFromReq, now, cronSecret } = deps;
  const cron = isCron(req);
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const dirtyOnly = url.searchParams.get('dirty') === '1';
  if (!cron) {
    const access = await checkAccess(req);
    if (!access.ok) return deny(res, access);
  }
  if (dirtyOnly && (!cron || !cronSecret())) {
    return res.status(403).json({ ok: false, error: 'cron_only', message: 'Dirty-only refresh requires CRON_SECRET authentication.' });
  }
  if (dirtyOnly && url.searchParams.has('account')) {
    return res.status(400).json({ ok: false, error: 'invalid_target', message: 'Dirty-only refresh selects eligible accounts automatically; omit account.' });
  }
  if (cron && !cronSecret()) {
    // Unsigned cron (CRON_SECRET not pasted into Vercel yet): at most one run per hour.
    if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage' });
    const lock = await kvRaw(['SET', 'aihyros:cron:lock', new Date().toISOString(), 'NX', 'EX', '3000']);
    if (lock === null) return res.status(429).json({ ok: false, error: 'cron_locked', message: 'An unsigned cron run already happened this hour. Set CRON_SECRET in Vercel to lift the limit.' });
  }

  const steps = [];
  const started = now();
  const webhookAccounts = configuredWebhookAccounts(deps);
  const refreshDeps = { ...deps, webhookAccounts, dirtyOnly };
  if (dirtyOnly && !webhookAccounts.size) {
    return res.status(503).json({ ok: false, error: 'webhook_not_configured', message: 'Configure HYROS_WEBHOOK_ACCOUNTS before running the dirty-only worker.' });
  }

  // Cron with no ?account=: refresh dirty accounts, then the stalest fallback,
  // until the function's time budget is spent; the rest wait for the next run.
  if (cron && !url.searchParams.get('account')) {
    const listed = await listAccounts({ withStatus: true });
    // Agencies: pick up new / revoked clients (one cheap call each).
    const synced = [];
    for (const a of listed.filter((x) => !dirtyOnly && x.agency && x.keyStatus !== 'invalid')) {
      try { synced.push({ id: a.id, ...(await syncClients(a.id)) }); } catch (err) { synced.push({ id: a.id, error: err.message }); }
    }
    const { accounts, skipped } = await webhookCronTargets(
      dirtyOnly ? listed : await listAccounts({ withStatus: true }), { ...refreshDeps, dirtyOnly });
    const done = [...skipped];
    // Each account gets min(what is left, 120 s) and the loop
    // runs until the budget is spent, so a big agency is spread over runs.
    for (const a of accounts) {
      const left = CRON_BUDGET_MS - (now() - started);
      if (left < CRON_MIN_ACCOUNT_MS) { done.push({ id: a.id, skipped: 'time budget' }); continue; }
      try {
        const result = await refreshAccount(a.id, steps, cronAccountBudgetMs(left), refreshDeps);
        done.push(result.skipped ? { id: a.id, skipped: result.skipped } : {
          id: a.id, ok: result.persisted, persisted: result.persisted,
          ...(result.persistenceError ? { persistenceError: result.persistenceError } : {}),
          ...(result.persistenceWarning ? { persistenceWarning: result.persistenceWarning } : {}),
        });
      } catch (err) { done.push({ id: a.id, ok: false, error: err.message }); }
    }
    return res.status(200).json({ ok: true, cron: true, ...(dirtyOnly ? { dirtyOnly: true } : {}), ms: now() - started, budgetMs: CRON_BUDGET_MS, elapsedMs: now() - started, accounts: done, synced, steps });
  }

  const accountId = await accountFromReq(req);
  if (!accountId) {
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  }

  try {
    const { snapshot, persisted, persistenceError, persistenceWarning, storage } = await refreshAccount(accountId, steps, REFRESH_BUDGET_MS, refreshDeps);

    res.status(200).json({
      ok: true,
      account: accountId,
      persisted,
      ...(persistenceError ? { persistenceError } : {}),
      ...(persistenceWarning ? { persistenceWarning } : {}),
      ...(storage ? { storage } : {}),
      storeConfigured: storeConfigured(),
      warning: storeConfigured()
        ? undefined
        : 'KV is not configured, so this snapshot was not stored. Set KV_REST_API_URL / KV_REST_API_TOKEN.',
      ms: now() - started,
      // Budget vs. spent, so the client can show how much of the 5 minutes
      // a large account really needed (`ms` is kept for older clients).
      budgetMs: REFRESH_BUDGET_MS,
      elapsedMs: now() - started,
      steps,
      generatedAt: snapshot.generatedAt,
      templateVersion: snapshot.templateVersion,
      settings: snapshot.settings,
      counts: {
        adAccounts: snapshot.adAccounts.length,
        sources: snapshot.sourceCount,
        leads: snapshot.crm.leads.length,
        sales: snapshot.crm.sales?.length ?? 0,
        calls: snapshot.crm.calls?.length ?? 0,
        subscriptions: snapshot.crm.subscriptions?.length ?? 0,
        leadsFetched: snapshot.crm.sync?.leadsFetched,
        incremental: snapshot.crm.sync?.incremental,
        warnings: snapshot.warnings?.length || 0,
        curves: snapshot.scale?.curves?.length ?? 0,
      },
    });
  } catch (err) {
    const status = err instanceof McpNotConfigured ? 503 : (err.status || 502);
    res.status(status).json({
      ok: false,
      error: err.code || err.name || 'error',
      message: err.message,
      detail: err.detail ?? undefined,
      storeConfigured: storeConfigured(),
      steps,
      ms: now() - started,
      budgetMs: REFRESH_BUDGET_MS,
      elapsedMs: now() - started,
    });
  }
}

export default createRefreshHandler();
