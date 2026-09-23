/** Shared account-local profit model. Percentages use 0..100; missing inputs stay null. */
const memory = new Map();
export const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const numeric = (value) => value === '' || value == null || typeof value === 'boolean' ? null : finite(Number(value));
const pct = (value) => { const n = numeric(value); return n !== null && n >= 0 && n <= 100 ? n : null; };
const keyOf = (account) => `aihyros:profit:v1:${encodeURIComponent(String(account ?? 'default'))}`;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function normalizeProfitSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const mapping = (value) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([key, value]) => key && pct(value) !== null).map(([key, value]) => [key, pct(value)]));
  return {
    version: 1, defaultMarginPct: pct(s.defaultMarginPct),
    productMargins: mapping(s.productMargins), offerMargins: mapping(s.offerMargins),
    dailyOverhead: Math.max(0, numeric(s.dailyOverhead) ?? 0),
    costBasis: s.costBasis === 'native' ? 'native' : 'margin',
    refundTreatment: ['included', 'subtract'].includes(s.refundTreatment) ? s.refundTreatment : 'unknown',
    nativeCostsIncludeRefunds: typeof s.nativeCostsIncludeRefunds === 'boolean' ? s.nativeCostsIncludeRefunds : null,
  };
}

export function loadProfitSettings(account) {
  const key = keyOf(account);
  if (memory.has(key)) return normalizeProfitSettings(memory.get(key));
  try { return normalizeProfitSettings(JSON.parse(globalThis.localStorage?.getItem(key) || 'null')); }
  catch { return normalizeProfitSettings(); }
}

export function saveProfitSettings(account, settings) {
  const normalized = normalizeProfitSettings(settings);
  const key = keyOf(account);
  memory.set(key, normalized);
  let persisted = false;
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(key, JSON.stringify(normalized));
      persisted = true;
      memory.delete(key);
    }
  } catch { /* Keep a session copy when browser storage is unavailable. */ }
  return { settings: normalizeProfitSettings(normalized), persisted };
}

export function revenueOf(row = {}) {
  const total = finite(row?.totalRevenue);
  if (total !== null) return { revenue: total, basis: 'totalRevenue', issues: [] };
  const revenue = finite(row?.revenue), recurring = finite(row?.recurringRevenue);
  if (revenue === null) return { revenue: null, basis: null, issues: ['Revenue unavailable.'] };
  if (recurring !== null) return {
    revenue: revenue + recurring, basis: 'revenue + recurringRevenue',
    issues: ['Total revenue unavailable; using revenue plus recurring revenue.'],
  };
  return { revenue, basis: 'revenue', issues: ['Total revenue and recurring revenue unavailable; rebill coverage unknown.'] };
}

export function resolveMargin(row, settings) {
  const product = row?.productId, offer = row?.offerId ?? row?.offer;
  if (product != null && own(settings.productMargins, String(product))) return settings.productMargins[String(product)];
  if (offer != null && own(settings.offerMargins, String(offer))) return settings.offerMargins[String(offer)];
  return settings.defaultMarginPct;
}

export function computeProfit(row = {}, settings = {}) {
  row = row && typeof row === 'object' ? row : {};
  const config = normalizeProfitSettings(settings);
  const { revenue, basis, issues } = revenueOf(row);
  const spend = finite(row.cost);
  const marginPct = resolveMargin(row, config);
  const nativeCost = finite(row.hardCosts ?? row.hardCost);
  const refund = finite(row.refund) === null ? null : Math.abs(row.refund);
  const overhead = finite(settings?.overhead) ?? (config.dailyOverhead === 0 ? 0 : null);
  let configured = config.costBasis === 'native' ? nativeCost !== null && nativeCost >= 0 : marginPct !== null;
  if (!configured) issues.push(config.costBasis === 'native' ? 'Native hard costs unavailable.' : 'Margin not configured for this row.');
  let refundDeduction = 0;
  if (config.refundTreatment === 'unknown' && refund !== 0) {
    configured = false;
    issues.push('Refund treatment is unconfirmed.');
  }
  if (config.refundTreatment === 'subtract') {
    if (refund === null) { configured = false; issues.push('Refund amount unavailable.'); }
    else if (config.costBasis === 'native' && refund > 0 && config.nativeCostsIncludeRefunds === null) {
      configured = false; issues.push('Confirm whether native hard costs already include refunds.');
    } else refundDeduction = config.costBasis === 'native' && config.nativeCostsIncludeRefunds === true ? 0 : refund;
  }
  if (config.costBasis === 'native' && config.refundTreatment === 'included' && refund !== 0 && config.nativeCostsIncludeRefunds !== false) {
    configured = false;
    issues.push('Net revenue requires native hard costs that exclude refunds.');
  }
  const contribution = configured && revenue !== null
    ? revenue - (config.costBasis === 'native' ? nativeCost : revenue * (1 - marginPct / 100)) - refundDeduction : null;
  if (spend === null || spend < 0) issues.push('Ad spend unavailable or invalid.');
  if (overhead === null || overhead < 0) issues.push('Overhead allocation unavailable or invalid.');
  const netProfit = contribution !== null && spend !== null && spend >= 0 && overhead !== null && overhead >= 0
    ? contribution - spend - overhead : null;
  const breakEvenRoas = contribution > 0 && revenue > 0 && spend > 0 && overhead !== null && overhead >= 0
    ? (1 + overhead / spend) / (contribution / revenue) : null;
  if (spend === 0) issues.push('ROAS is undefined at zero spend.');
  if (contribution !== null && contribution <= 0) issues.push('No positive contribution rate for break-even ROAS.');
  return { revenue, contribution, netProfit, breakEvenRoas, configured, issues,
    revenueBasis: basis, spend, overhead, refundDeduction, marginPct,
    roas: revenue !== null && spend > 0 ? revenue / spend : null };
}

export function windowDays(window) {
  const parse = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const ms = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
  };
  const start = parse(window?.start), end = parse(window?.end);
  return start === null || end === null || end < start ? null : (end - start) / 86400000 + 1;
}

export function computeProfitRows(rows, settings, window) {
  const config = normalizeProfitSettings(settings), days = windowDays(window);
  const spend = sumKnown(rows.map((row) => finite(row.cost)));
  const totalOverhead = config.dailyOverhead === 0 ? 0 : days === null ? null : config.dailyOverhead * days;
  return rows.map((row) => {
    const share = spend > 0 && finite(row.cost) !== null ? row.cost / spend : spend === 0 ? 1 / rows.length : null;
    const overhead = totalOverhead === 0 ? 0 : totalOverhead !== null && share !== null ? totalOverhead * share : null;
    return { row, ...computeProfit(row, { ...config, overhead }) };
  });
}

export function sumKnown(values) {
  return values.length && values.every((value) => finite(value) !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
}

/** Native rows retain nulls; rolled-up core rows can turn absent metrics into zero. */
export function captureEconomicsSnapshot(snapshot = {}, level = 'adset') {
  const fields = ['id', 'name', 'parentId', 'parentName', '_account', '_traffic', 'productId', 'offerId', 'offer',
    'cost', 'totalRevenue', 'revenue', 'recurringRevenue', 'refund', 'hardCosts', 'hardCost', 'sales'];
  const ranges = {};
  for (const key of ['today', 'yesterday', '7d', '30d']) {
    const source = snapshot.ranges?.[key];
    if (!source) continue;
    const rows = [], errors = [];
    const sourceRows = Array.isArray(source.levels?.[level]) ? source.levels[level].filter((row) => row && typeof row === 'object') : [];
    let bytes = 0;
    const parents = new Map((source.levels?.adset || []).map((row) => [String(row.id), row]));
    for (const row of sourceRows) {
      const parent = parents.get(String(row.parentId));
      const compact = Object.fromEntries(fields.filter((field) => row[field] !== undefined)
        .map((field) => [field, typeof row[field] === 'string' ? row[field] : finite(row[field]) ?? null]));
      if (parent) for (const field of ['_account', '_traffic']) if (compact[field] == null && parent[field] != null) compact[field] = String(parent[field]);
      const size = new TextEncoder().encode(JSON.stringify(compact)).length;
      if (bytes + size > 35000 || rows.length >= 200) break;
      bytes += size;
      rows.push(compact);
    }
    if (rows.length < sourceRows.length) errors.push(`Showing first ${rows.length} of ${sourceRows.length} ${level} rows; totals cover these rows only.`);
    if (!Array.isArray(source.levels?.[level])) errors.push(`Native ${level} rows unavailable.`);
    if (source.skipped) errors.push(`Report range skipped: ${String(source.skipped)}`);
    const warnings = (Array.isArray(snapshot.warnings) ? snapshot.warnings : []).filter((warning) => !warning.level
      || [level, 'sources', 'adaccounts', ...(level === 'adset' ? ['source_link'] : [])].includes(String(warning.level).toLowerCase()));
    if (warnings.length) errors.push(`${warnings.length} source warning(s); report coverage may be incomplete.`);
    ranges[key] = { start: source.start ?? null, end: source.end ?? null, rows: source.skipped ? [] : rows,
      sourceCount: sourceRows.length, complete: !source.skipped && !errors.length, errors };
  }
  const context = snapshot.settings && finite(snapshot.settings.windowDays) !== null ? JSON.stringify({
    windowDays: snapshot.settings.windowDays,
    leadStage: Array.isArray(snapshot.settings.leadStage) ? [...snapshot.settings.leadStage].sort() : [],
  }) : null;
  return { checkedAt: snapshot.generatedAt ?? null, level, context,
    currency: snapshot.account?.currency ?? null, model: snapshot.attributionModel ?? snapshot.settings?.model ?? null,
    ranges, errors: [] };
}

export function skippedEconomics(previous) {
  const data = Object.fromEntries(Object.entries(previous || {}).filter(([key]) => !['stale', 'skipped', 'error'].includes(key)));
  return Object.keys(data).length ? { ...data, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
}
