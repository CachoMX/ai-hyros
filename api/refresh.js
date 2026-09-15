/**
 * POST|GET /api/refresh -> rebuild the snapshot from the MCP and persist it.
 *
 * Triggered by Vercel Cron daily (Authorization: Bearer $CRON_SECRET) or
 * on demand from the dashboard's Refresh button (password-gated).
 */
import { checkAccess, isCron, deny } from './_auth.js';
import { buildSnapshot } from './_snapshot.js';
import { writeSnapshot, readSnapshot, readPrefs, storeConfigured, kvRaw } from './_store.js';
import { McpNotConfigured } from './_mcp.js';
import { accountFromReq, asAccount, listAccounts, markKeyStatus, noteRefresh, syncClients } from './_accounts.js';

export const maxDuration = 60;

/** Build + persist one account's snapshot under its own key. */
async function refreshAccount(accountId, steps, budgetMs) {
  const [prefs, previous] = storeConfigured()
    ? await Promise.all([readPrefs(accountId), readSnapshot(accountId)])
    : [null, null];
  let snapshot;
  try {
    snapshot = await asAccount(accountId, () =>
      buildSnapshot({ onProgress: (s) => steps.push(`${accountId}: ${s}`), prefs, previous, budgetMs }));
  } catch (err) {
    // A rejected key marks the account (or its agency) invalid so the
    // selector can say so instead of 40 clients failing one by one.
    if (storeConfigured()) {
      if (err.code === 'auth') await markKeyStatus(accountId, 'invalid', err.message);
      await noteRefresh(accountId, false, err.message);
    }
    throw err;
  }
  const persisted = storeConfigured() ? await writeSnapshot(snapshot, accountId) : false;
  if (storeConfigured()) { await markKeyStatus(accountId, 'ok'); await noteRefresh(accountId, true); }
  return { snapshot, persisted };
}

export default async function handler(req, res) {
  const cron = isCron(req);
  if (!cron) {
    const access = await checkAccess(req);
    if (!access.ok) return deny(res, access);
  } else if (!process.env.CRON_SECRET) {
    // Unsigned cron (CRON_SECRET not pasted into Vercel yet): at most one run per hour.
    if (!storeConfigured()) return res.status(503).json({ ok: false, error: 'needs_storage' });
    const lock = await kvRaw(['SET', 'aihyros:cron:lock', new Date().toISOString(), 'NX', 'EX', '3000']);
    if (lock === null) return res.status(429).json({ ok: false, error: 'cron_locked', message: 'An unsigned cron run already happened this hour. Set CRON_SECRET in Vercel to lift the limit.' });
  }

  const steps = [];
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);

  // Cron with no ?account=: refresh the stalest accounts, one after another,
  // until the function's time budget is spent; the rest wait for the next run.
  if (cron && !url.searchParams.get('account')) {
    const listed = await listAccounts({ withStatus: true });
    // Agencies: pick up new / revoked clients (one cheap call each).
    const synced = [];
    for (const a of listed.filter((x) => x.agency && x.keyStatus !== 'invalid')) {
      try { synced.push({ id: a.id, ...(await syncClients(a.id)) }); } catch (err) { synced.push({ id: a.id, error: err.message }); }
    }
    const accounts = (await listAccounts({ withStatus: true }))
      .filter((a) => a.keyStatus !== 'invalid' && a.status === 'APPROVED')
      .sort((a, b) => String(a.lastRefresh || '').localeCompare(String(b.lastRefresh || '')));
    const done = [];
    for (const a of accounts) {
      const left = 55000 - (Date.now() - started);
      if (left < 20000) { done.push({ id: a.id, skipped: 'time budget' }); continue; }
      try {
        const { persisted } = await refreshAccount(a.id, steps, Math.min(50000, left - 5000));
        done.push({ id: a.id, ok: true, persisted });
      } catch (err) { done.push({ id: a.id, ok: false, error: err.message }); }
    }
    return res.status(200).json({ ok: true, cron: true, ms: Date.now() - started, accounts: done, synced, steps });
  }

  const accountId = await accountFromReq(req);
  if (!accountId) {
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  }

  try {
    const { snapshot, persisted } = await refreshAccount(accountId, steps);

    res.status(200).json({
      ok: true,
      account: accountId,
      persisted,
      warning: storeConfigured()
        ? undefined
        : 'KV is not configured, so this snapshot was not stored. Set KV_REST_API_URL / KV_REST_API_TOKEN.',
      ms: Date.now() - started,
      steps,
      generatedAt: snapshot.generatedAt,
      settings: snapshot.settings,
      counts: {
        adAccounts: snapshot.adAccounts.length,
        sources: snapshot.sourceCount,
        leads: snapshot.crm.leads.length,
        leadsFetched: snapshot.crm.sync?.leadsFetched,
        incremental: snapshot.crm.sync?.incremental,
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
      steps,
      ms: Date.now() - started,
    });
  }
}
