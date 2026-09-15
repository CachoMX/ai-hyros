/**
 * POST /api/prefs — save dashboard defaults in KV next to the snapshot.
 *
 *   { cols: [metric keys] }          column loadout + order (the saved view)
 *   { settings: { model, windowDays, leadStage } }
 *                                    report settings the NEXT refresh builds with:
 *                                    attribution model, per-query attribution
 *                                    window (days, LAST_CLICK only) and the
 *                                    lead-stage filter that ranks ads by a
 *                                    funnel outcome (MCP upgrade, Sept 2026)
 *
 * Either key may be sent alone; the other is preserved. /api/data returns the
 * whole prefs object so every browser boots with them. Falls soft when KV is
 * absent (client keeps its localStorage copy and says so).
 */
import { checkAccess, deny } from './_auth.js';
import { readPrefs, writePrefs, storeConfigured } from './_store.js';
import { CATALOG_BY_KEY } from '../public/shared/metrics.js';
import { normalizeSettings, REPORT_MODELS } from './_snapshot.js';
import { accountFromReq } from './_accounts.js';

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const cols = Array.isArray(req.body?.cols)
    ? req.body.cols.filter((k) => typeof k === 'string' && CATALOG_BY_KEY.has(k)).slice(0, 120)
    : null;
  const settings = req.body?.settings && typeof req.body.settings === 'object'
    ? normalizeSettings(req.body.settings) : null;

  if ((!cols || !cols.length) && !settings) {
    return res.status(400).json({
      ok: false, error: 'bad_request',
      message: `Body must be {cols: [metric keys]} and/or {settings: {model: ${REPORT_MODELS.join('|')}, windowDays: 0-365, leadStage: [stage names]}}.`,
    });
  }

  if (!storeConfigured()) {
    return res.status(200).json({
      ok: true, persisted: false, settings,
      message: 'KV is not configured — saved in this browser only.',
    });
  }

  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(200).json({ ok: true, persisted: false, settings, message: 'No account connected — saved in this browser only.' });
  const current = (await readPrefs(accountId)) || {};
  const next = {
    ...current,
    ...(cols && cols.length ? { cols } : {}),
    ...(settings ? { settings } : {}),
    savedAt: new Date().toISOString(),
  };
  const persisted = await writePrefs(next, accountId);
  res.status(200).json({ ok: persisted, persisted, prefs: persisted ? next : null });
}
