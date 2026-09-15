/**
 * Scale Advisor — server step. Runs inside /api/refresh after the core
 * snapshot is built; returns the block stored as snapshot.scale.
 *
 * ctx: { callTool, snapshot, previous, deadline, timeLeft, log, env }
 * Every call is independent and failure-tolerant: a curve that errors is
 * stored with its message so the tab can say why it is empty.
 */
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pickNum = (obj, keys) => { for (const k of keys) { const v = num(obj?.[k]); if (v !== null) return v; } return null; };
const addDays = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

/** Normalize one hyros_get_marginal_cac_curve response (keys read tolerantly). */
export function normalizeCurve(raw, meta) {
  const points = (Array.isArray(raw?.curve) ? raw.curve : [])
    .map((p) => ({
      spend: pickNum(p, ['dailySpend', 'spend', 'spendLevel', 'x']),
      avgCac: pickNum(p, ['averageCac', 'avgCac', 'cac', 'average']),
      marginalCac: pickNum(p, ['marginalCac', 'marginal', 'mcac']),
      customers: pickNum(p, ['customers', 'newCustomers', 'conversions']),
    }))
    .filter((p) => p.spend !== null)
    .sort((a, b) => a.spend - b.spend);
  const sat = raw?.saturationPoint ?? raw?.saturation ?? null;
  const saturationSpend = typeof sat === 'object' && sat
    ? pickNum(sat, ['dailySpend', 'spend', 'spendLevel'])
    : num(sat);
  return {
    ...meta,
    attributionModel: raw?.attributionModel || null,
    daysSampled: num(raw?.daysSampled) ?? 0,
    ceiling: num(raw?.cacCeiling),
    ceilingBasis: raw?.ceilingBasis || null,
    saturationSpend,
    points,
    notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : [],
  };
}

export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  const end = snapshot.ranges['30d'].end;
  const start = addDays(end, -89); // ACCOUNT level caps history at 90 days
  const adsets = snapshot.ranges['30d'].levels.adset;
  const targets = [
    ...snapshot.adAccounts.map((a) => ({ id: String(a.id), name: a.name, level: 'ACCOUNT' })),
    ...[...adsets].sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 6)
      .map((a) => ({ id: a.id, name: a.name, level: 'SOURCE_LINK', category: a._category || null })),
  ];
  const curves = [];
  for (const t of targets) {
    if (ctx.timeLeft() < 3000) { curves.push({ ...t, skipped: 'time budget' }); continue; }
    log(`cac ${t.level.toLowerCase()} ${t.id}`);
    try {
      const request = { id: t.id, level: t.level, startDate: start, endDate: end };
      if (t.level === 'ACCOUNT') request.cacCeiling = Number(ctx.env.HYROS_CAC_CEILING) || 100;
      const raw = await callTool('hyros_get_marginal_cac_curve', { request }, { timeoutMs: 15000 });
      curves.push(normalizeCurve(raw, t));
    } catch (err) {
      curves.push({ ...t, points: [], notes: [], error: err.message });
    }
  }
  return { window: { start, end }, curves };
}
