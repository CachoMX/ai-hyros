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
const PER_CALL_TIMEOUT_MS = 15000;   // FEATURES.md: per-call timeouts <= 15 s
const MIN_CALL_BUDGET_MS = 3000;     // do not start a call with less than this left
const TOP_ADSETS = 6;
const MARKERS = ['skipped', 'error', 'stale'];

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pickNum = (obj, keys) => { for (const k of keys) { const v = num(obj?.[k]); if (v !== null) return v; } return null; };
const addDays = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The REST envelope is `{ request_id, result }`; the MCP tool may hand back either. */
const unwrap = (raw) => (isMap(raw) && isMap(raw.result) && !Array.isArray(raw.curve) ? raw.result : raw);

/** Normalize one hyros_get_marginal_cac_curve response (documented keys first, legacy keys as fallbacks). */
export function normalizeCurve(rawReply, meta) {
  const raw = unwrap(rawReply);
  const points = (Array.isArray(raw?.curve) ? raw.curve : [])
    .map((p) => ({
      spend: pickNum(p, ['spendPerDay', 'dailySpend', 'spend', 'spendLevel', 'x']),
      days: pickNum(p, ['days']),
      customers: pickNum(p, ['newCustomers', 'customers', 'conversions']),
      avgCac: pickNum(p, ['avgCac', 'averageCac', 'cac', 'average']),
      marginalCac: pickNum(p, ['marginalCac', 'marginal', 'mcac']),
    }))
    .filter((p) => p.spend !== null)
    .sort((a, b) => a.spend - b.spend);
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
    points,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : [],
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
  const adsets = snapshot.ranges['30d'].levels.adset;
  return [
    ...snapshot.adAccounts.map((a) => ({ id: String(a.id), name: a.name, level: 'ACCOUNT' })),
    ...[...adsets].sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, TOP_ADSETS)
      .map((a) => ({ id: a.id, name: a.name, level: 'SOURCE_LINK', category: a._category || null })),
  ];
}

export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const end = snapshot.ranges['30d'].end;
  const start = addDays(end, -89); // ACCOUNT level caps history at 90 days
  const ceiling = callerCeiling(ctx.env);
  const curves = [];
  for (const t of targetsFor(snapshot)) {
    if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) { curves.push({ ...t, skipped: 'time budget' }); continue; }
    log(`cac ${t.level.toLowerCase()} ${t.id}`);
    try {
      // Account level has no LTV, so the ceiling is the caller's or none;
      // ad sets get HYROS's LTV break-even ceiling (ceilingBasis says which).
      const request = { id: t.id, level: t.level, startDate: start, endDate: end };
      if (t.level === 'ACCOUNT' && ceiling !== null) request.cacCeiling = ceiling;
      const raw = await callTool('hyros_get_marginal_cac_curve', { request }, { timeoutMs: PER_CALL_TIMEOUT_MS });
      curves.push(normalizeCurve(raw, t));
    } catch (err) {
      curves.push({ ...t, points: [], notes: [], error: err.message });
    }
  }
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  return { checkedAt: now.toISOString(), window: { start, end }, curves };
}
