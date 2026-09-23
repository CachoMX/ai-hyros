/**
 * Scale Advisor — server step. Runs inside /api/refresh after the core
 * snapshot is built; returns the block stored as snapshot.scale.
 *
 * ctx: { callTool, snapshot, previous, deadline, timeLeft, log, env, now }
 * Every call is independent and failure-tolerant: a curve that errors is
 * stored with its message so the tab can say why it is empty.
 *
 * Documented reply (GET /attribution/marginal-cac-curve, mirrored by
 * hyros_get_marginal_cac_curve):
 *   { id, level, name, startDate, endDate, attributionModel, daysSampled,
 *     cacCeiling, ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN, ltvWindow,
 *     curve: [{ spendPerDay, days, newCustomers, avgCac, marginalCac }],
 *     saturationPoint: { efficientSpendPerDay, saturatedSpendPerDay, reason } | null,
 *     notes: [NO_SPEND_DATA | NO_CUSTOMERS | INSUFFICIENT_DATA | LTV_CEILING_UNAVAILABLE] }
 * Older key spellings are still read as fallbacks.
 */
const PER_CALL_TIMEOUT_MS = 15000;   // default lane (FEATURES.md)
/** The curve is computed live from 90 days of spend history and often needs more than 15 s: use the runner's slow lane when it offers one, never past the step's remaining time. */
/** The runner's slow lane (ctx.slowTimeout); a runner without one keeps the default lane. */
const curveTimeout = (ctx, slow) => Math.max(1000, Math.min(ctx.timeLeft() - 2000,
  slow && typeof ctx.slowTimeout === 'function' ? ctx.slowTimeout(2000) : PER_CALL_TIMEOUT_MS));
const MIN_CALL_BUDGET_MS = 3000;     // do not start a call with less than this left
const TOP_ADSETS = 6;
const MAX_POINTS = 120;
const MARKERS = ['skipped', 'error', 'stale'];

const num = (v) => (typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const pickNum = (obj, keys) => { for (const k of keys) { const v = num(obj?.[k]); if (v !== null) return v; } return null; };
const addDays = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The REST envelope is `{ request_id, result }`; the MCP tool may hand back either. */
const unwrap = (raw) => (isMap(raw) && isMap(raw.result) && !Array.isArray(raw.curve) ? raw.result : raw);

/** Normalize one hyros_get_marginal_cac_curve response (documented keys first, legacy keys as fallbacks). */
export function normalizeCurve(rawReply, meta) {
  const raw = unwrap(rawReply);
  const notes = Array.isArray(raw?.notes) ? raw.notes.slice(0, 30).map(String) : [];
  if (!Array.isArray(raw?.curve)) notes.push('UNEXPECTED_REPLY');
  const points = (Array.isArray(raw?.curve) ? raw.curve : [])
    .map((p) => ({
      spend: pickNum(p, ['spendPerDay', 'dailySpend', 'spend', 'spendLevel', 'x']),
      days: pickNum(p, ['days']),
      customers: pickNum(p, ['newCustomers', 'customers', 'conversions']),
      avgCac: pickNum(p, ['avgCac', 'averageCac', 'cac', 'average']),
      marginalCac: pickNum(p, ['marginalCac', 'marginal', 'mcac']),
    }))
    .filter((p) => p.spend !== null && p.spend >= 0)
    .sort((a, b) => a.spend - b.spend);
  if (points.length > MAX_POINTS) notes.push('CURVE_TRUNCATED');
  if (Array.isArray(raw?.curve) && raw.curve.length !== points.length) notes.push('INVALID_POINTS_OMITTED');
  const sat = raw?.saturationPoint ?? raw?.saturation ?? null;
  const saturationSpend = isMap(sat) ? pickNum(sat, ['saturatedSpendPerDay', 'dailySpend', 'spend', 'spendLevel']) : num(sat);
  const efficientSpend = isMap(sat) ? pickNum(sat, ['efficientSpendPerDay']) : null;
  return {
    ...meta,
    name: (typeof raw?.name === 'string' && raw.name) || meta?.name || null,
    attributionModel: raw?.attributionModel || null,
    daysSampled: num(raw?.daysSampled) ?? 0,
    ceiling: num(raw?.cacCeiling),
    ceilingBasis: raw?.ceilingBasis || null,
    ltvWindow: raw?.ltvWindow || null,
    saturationSpend,
    efficientSpend,
    saturationReason: isMap(sat) && sat.reason ? String(sat.reason) : null,
    points: points.slice(0, MAX_POINTS),
    notes,
  };
}

/** The caller's CAC ceiling: only a positive number counts; anything else means "let HYROS decide". */
export function callerCeiling(env) {
  const v = Number(env?.HYROS_CAC_CEILING);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Out of time before the first call: keep the previous data (marked stale) or return a bare marker. */
function skippedBlock(previous, reason) {
  const hasData = isMap(previous) && Object.keys(previous).some((k) => !MARKERS.includes(k));
  if (!hasData) return { skipped: reason };
  const data = Object.fromEntries(Object.entries(previous).filter(([k]) => !MARKERS.includes(k)));
  return { ...data, stale: true, skipped: reason };
}

function targetsFor(snapshot) {
  const adsets = snapshot?.ranges?.['30d']?.levels?.adset || [];
  return [
    ...(snapshot?.adAccounts || []).filter((a) => a?.id != null).map((a) => ({ id: String(a.id), name: a.name, level: 'ACCOUNT' })),
    ...[...adsets].sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, TOP_ADSETS)
      .filter((a) => a?.id != null).map((a) => ({ id: a.id, name: a.name, level: 'SOURCE_LINK', category: a._category || null })),
  ];
}

function previousCurve(previous, target, state) {
  const old = previous?.curves?.find((c) => c.id === target.id && c.level === target.level && c.points?.length);
  if (!old) return { ...target, points: [], notes: [], ...state };
  const clean = Object.fromEntries(Object.entries(old).filter(([key]) => ![...MARKERS, 'errorCode', 'retry'].includes(key)));
  return { ...clean, ...target, ...state, stale: true, checkedAt: old.checkedAt || previous.checkedAt,
    window: old.window || previous.window };
}

export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const end = snapshot?.ranges?.['30d']?.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end || '') || !Number.isFinite(Date.parse(end))) return { error: 'The snapshot has no valid reporting end date.' };
  const start = addDays(end, -89); // ACCOUNT level caps history at 90 days
  const ceiling = callerCeiling(ctx.env);
  const curves = [];
  const targets = targetsFor(snapshot);
  const notes = [];
  let stop = null;
  let calls = 0;
  const checkedAt = (ctx.now instanceof Date ? ctx.now : new Date()).toISOString();
  for (const t of targets) {
    if (stop || ctx.timeLeft() < MIN_CALL_BUDGET_MS) {
      curves.push(previousCurve(ctx.previous, t, { skipped: stop || 'time budget' }));
      continue;
    }
    log?.(`cac ${t.level.toLowerCase()} ${t.id}`);
    const timeoutMs = curveTimeout(ctx, calls === 0);
    calls += 1;
    try {
      // Account level has no LTV, so the ceiling is the caller's or none;
      // ad sets get HYROS's LTV break-even ceiling (ceilingBasis says which).
      const request = { id: t.id, level: t.level, startDate: start, endDate: end };
      if (t.level === 'ACCOUNT' && ceiling !== null) request.cacCeiling = ceiling;
      const raw = await callTool('hyros_get_marginal_cac_curve', { request }, { timeoutMs });
      const curve = normalizeCurve(raw, t);
      if (curve.notes.includes('UNEXPECTED_REPLY')) throw new Error('Unexpected CAC curve reply shape.');
      curves.push({ ...curve, checkedAt, window: { start, end } });
    } catch (err) {
      const code = err?.code || (/timed? out|timeout/i.test(err?.message || '') ? 'timeout' : 'error');
      const message = code === 'timeout' ? `HYROS did not return a curve within ${Math.round(timeoutMs / 1000)}s. ${err?.message || ''}`.trim()
        : err?.message || 'CAC curve request failed.';
      curves.push(previousCurve(ctx.previous, t, { error: message, errorCode: code,
        retry: ['timeout', 'rate_limited'].includes(code) ? 'next refresh' : null }));
      if (['rate_limited', 'auth', 'forbidden', 'NOT_CONFIGURED'].includes(code)) stop = code === 'rate_limited' ? 'rate limited; try next refresh' : 'account access unavailable';
    }
  }
  return { checkedAt, window: { start, end }, configuredCeiling: ceiling, curves, notes,
    coverage: { requested: calls, eligible: targets.length, shown: curves.length,
      fresh: curves.filter((c) => !c.error && !c.skipped && !c.stale).length,
      failed: curves.filter((c) => c.error).length, skipped: curves.filter((c) => c.skipped).length } };
}
