export const HISTORY_LIMIT = 14;
export const ALERT_LIMIT = 40;
export const BRIEF_RANGE = '7d';
export const THRESHOLDS = { minSales: 10, minSpend: 100, minRevenue: 500, revenueRevisionPercent: 20, revenueRevisionAmount: 100 };
export const RULES = {
  'report-coverage': { severity: 'high', title: 'Report coverage needs attention', message: 'The 7-day report is missing, stale, partial, or has unknown metrics.', view: 'report' },
  'tracking-coverage': { severity: 'warning', title: 'Tracking checks are incomplete', message: 'Current check coverage cannot establish tracking health.', view: 'health' },
  'script-missing': { severity: 'high', title: 'Tracking script not detected', message: 'A completed check did not find the script. Verify the site and check again.', view: 'health' },
  'params-missing': { severity: 'warning', title: 'Ad tracking parameters need review', message: 'A returned diagnostic explicitly reports missing or invalid parameters.', view: 'health' },
  'crm-coverage': { severity: 'warning', title: 'CRM sample is incomplete', message: 'CRM pagination or refresh coverage is incomplete.', view: 'crm' },
  'attribution-coverage': { severity: 'warning', title: 'Attribution sample is incomplete', message: 'Available paths do not cover the complete requested sample.', view: 'attribution' },
  'revenue-below-spend': { severity: 'warning', title: 'Attributed revenue is below ad spend', message: 'The sample meets the review threshold. Check conversion lag and costs before making a budget decision; this is not a profit estimate.', view: 'profit' },
  'revenue-revision': { severity: 'high', title: 'Same-window revenue was revised down', message: 'The revenue revision exceeds the review threshold. Confirm attribution and coverage; this is not a comparison of separate periods.', view: 'report' },
};
export const COMPARISON_REASONS = {
  first_snapshot: 'No prior summary',
  rolling_window: 'Rolling 7-day windows differ; not comparable',
  currency_changed: 'Currency differs; not comparable',
  model_changed: 'Attribution model differs; not comparable',
  context_changed: 'Report settings differ; not comparable',
  context_unknown: 'Reporting context is unknown; not comparable',
  incomplete: 'Report coverage is incomplete; not comparable',
  clock: 'Snapshot order is inconsistent; not comparable',
  same_window: 'Same-window snapshot revision',
};

const array = (value) => Array.isArray(value) ? value : [];
export const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = (value) => finite(value) !== null && value >= 0 ? Math.floor(value) : null;
export function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const day = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && timestamp(value)?.slice(0, 10) === value ? value : null;
const currencyOf = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value) && !['XXX', 'XTS'].includes(value) ? value : null;
const modelOf = (value) => ['LAST_CLICK', 'FIRST_CLICK', 'SCIENTIFIC', 'CUSTOM HYROS', 'LINEAR', 'TIME_DECAY', 'POSITION_BASED'].includes(value) ? value : null;
const stateOf = (value) => ['complete', 'partial', 'missing', 'stale', 'error', 'skipped'].includes(value) ? value : 'missing';
const boundedId = (value) => typeof value === 'string' && /^(snapshot|alert|read)-[0-9a-f]{8}$/.test(value) ? value : null;
const truthyFlags = (value) => value === true || (value && typeof value === 'object' && Object.values(value).some((v) => v === true));

export function hash(value) {
  let code = 2166136261;
  for (const char of String(value)) code = Math.imul(code ^ char.charCodeAt(0), 16777619);
  return (code >>> 0).toString(16).padStart(8, '0');
}

export function paginationCoverage(source) {
  const parts = [source, source?.coverage, source?.pagination, source?.pageInfo, source?.meta?.pagination, source?.sync].filter((part) => part && typeof part === 'object');
  const cursorPresent = parts.some((p) => Boolean(p.nextCursor || p.nextPageId || p.nextPageToken || p.endCursor && p.hasNextPage));
  const truncated = parts.some((p) => truthyFlags(p.truncated) || p.hasMore === true || p.hasNextPage === true || p.complete === false) || cursorPresent;
  const firstCount = (keys) => {
    for (const part of parts) for (const key of keys) if (count(part[key]) !== null) return count(part[key]);
    return null;
  };
  return {
    truncated, cursorPresent,
    pages: firstCount(['pagesFetched', 'pages']),
    sampled: firstCount(['sampled', 'rowsFetched', 'returned']),
    total: firstCount(['total', 'totalCount']),
  };
}

function cleanPagination(value) {
  return { truncated: value?.truncated === true, cursorPresent: value?.cursorPresent === true, pages: count(value?.pages), sampled: count(value?.sampled), total: count(value?.total) };
}

function trackingState(health) {
  if (!health || !timestamp(health.checkedAt)) return 'missing';
  if (health.error) return 'error';
  if (health.stale) return 'stale';
  if (health.skipped) return 'skipped';
  const checks = ['domains', 'script', 'params'].map((key) => health.checks?.[key]);
  if (checks.some((check) => check?.stale)) return 'stale';
  if (checks.some((check) => !check || !['ok', 'empty'].includes(check.status)) || array(health.errors).length) return 'partial';
  if (checks.some((check) => check.reason || Object.values(check.channels || {}).some((status) => !['ok', 'empty'].includes(status)))) return 'partial';
  return 'complete';
}

function cleanCoverage(value) {
  const pagination = {};
  for (const key of ['report', 'crm', 'attribution', 'tracking']) pagination[key] = cleanPagination(value?.pagination?.[key]);
  return {
    report: stateOf(value?.report), tracking: stateOf(value?.tracking), crm: stateOf(value?.crm), attribution: stateOf(value?.attribution),
    warningCount: count(value?.warningCount) ?? 0,
    unknownMetrics: ['totalRevenue', 'cost', 'calls', 'sales'].filter((key) => array(value?.unknownMetrics).includes(key)),
    pagination,
  };
}

export function summarize(snapshot = {}, now = null) {
  snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const period = snapshot.ranges?.[BRIEF_RANGE];
  const window = { start: day(period?.start), end: day(period?.end) };
  const generatedAt = timestamp(snapshot.generatedAt) || timestamp(now);
  const currency = currencyOf(snapshot.account?.currency);
  const model = modelOf(snapshot.attributionModel || snapshot.settings?.model);
  const contextKey = hash(JSON.stringify({
    windowDays: count(snapshot.settings?.windowDays),
    stages: array(snapshot.settings?.leadStage).filter((s) => typeof s === 'string').map(hash).sort(),
    timezone: typeof snapshot.account?.timezone === 'string' ? hash(snapshot.account.timezone) : null,
  }));
  const metrics = {};
  for (const key of ['totalRevenue', 'cost', 'calls', 'sales']) metrics[key] = period?.skipped || period?.error ? null : finite(period?.totals?.[key]);
  const warnings = array(snapshot.warnings).filter((w) => w && w.level !== 'crm' && (!w.range || w.range === BRIEF_RANGE));
  const pagination = { report: paginationCoverage(period), crm: paginationCoverage(snapshot.crm), attribution: paginationCoverage(snapshot.attribution), tracking: paginationCoverage(snapshot.health) };
  if (snapshot.sourcesTruncated || warnings.some((w) => w.kind === 'truncated')) pagination.report.truncated = true;
  const unknownMetrics = Object.keys(metrics).filter((key) => metrics[key] === null);
  const report = !period ? 'missing' : period.error || snapshot.error ? 'error' : period.skipped ? 'skipped'
    : period.stale || snapshot.stale ? 'stale'
      : warnings.length || period.partial || pagination.report.truncated || unknownMetrics.length || !window.start || !window.end ? 'partial' : 'complete';
  const crm = !snapshot.crm ? 'missing' : snapshot.crm.error ? 'error' : snapshot.crm.sync?.stale ? 'stale'
    : snapshot.crm.sync?.skipped ? 'skipped' : pagination.crm.truncated ? 'partial' : 'complete';
  const attribution = !snapshot.attribution ? 'missing' : snapshot.attribution.error ? 'error' : snapshot.attribution.stale ? 'stale'
    : snapshot.attribution.skipped ? 'skipped' : pagination.attribution.truncated ||
      (finite(snapshot.attribution.coverage?.sampled) !== null && finite(snapshot.attribution.coverage?.withPaths) !== null && snapshot.attribution.coverage.withPaths < snapshot.attribution.coverage.sampled) ? 'partial' : 'complete';
  return {
    id: 'snapshot-' + hash(JSON.stringify([generatedAt, window, currency, model, contextKey])),
    generatedAt, range: BRIEF_RANGE, window, currency, model, contextKey, ...metrics,
    coverage: { report, crm, attribution, tracking: pagination.tracking.truncated && trackingState(snapshot.health) === 'complete' ? 'partial' : trackingState(snapshot.health), warningCount: warnings.length, unknownMetrics, pagination },
  };
}

function cleanSummary(value) {
  if (!value || !timestamp(value.generatedAt)) return null;
  return {
    id: boundedId(value.id)?.startsWith('snapshot-') ? value.id : 'snapshot-' + hash(value.generatedAt),
    generatedAt: timestamp(value.generatedAt), range: BRIEF_RANGE,
    window: { start: day(value.window?.start), end: day(value.window?.end) },
    currency: currencyOf(value.currency), model: modelOf(value.model),
    contextKey: typeof value.contextKey === 'string' && /^[0-9a-f]{8}$/.test(value.contextKey) ? value.contextKey : null,
    totalRevenue: finite(value.totalRevenue), cost: finite(value.cost), calls: finite(value.calls), sales: finite(value.sales),
    coverage: cleanCoverage(value.coverage),
  };
}

export function compareSummaries(current, previous) {
  const base = { comparable: false, reason: 'first_snapshot', previousId: previous?.id || null, previousGeneratedAt: previous?.generatedAt || null, changes: null };
  if (!previous) return base;
  if (!current?.generatedAt || !previous.generatedAt || Date.parse(current.generatedAt) <= Date.parse(previous.generatedAt)) return { ...base, reason: 'clock' };
  if (!current.window?.start || !current.window?.end || !previous.window?.start || !previous.window?.end ||
    !current.currency || !previous.currency || !current.model || !previous.model || !current.contextKey || !previous.contextKey) return { ...base, reason: 'context_unknown' };
  if (current.window.start !== previous.window.start || current.window.end !== previous.window.end) return { ...base, reason: 'rolling_window' };
  if (current.currency !== previous.currency) return { ...base, reason: 'currency_changed' };
  if (current.model !== previous.model) return { ...base, reason: 'model_changed' };
  if (current.contextKey !== previous.contextKey) return { ...base, reason: 'context_changed' };
  if (current.coverage?.report !== 'complete' || previous.coverage?.report !== 'complete') return { ...base, reason: 'incomplete' };
  const changes = {};
  for (const key of ['totalRevenue', 'cost', 'calls', 'sales']) {
    const currentValue = finite(current[key]), previousValue = finite(previous[key]);
    const delta = currentValue === null || previousValue === null ? null : finite(currentValue - previousValue);
    changes[key] = delta === null ? null : { delta, percent: previousValue === 0 ? null : finite(delta / Math.abs(previousValue) * 100) };
  }
  return { ...base, comparable: true, reason: 'same_window', changes };
}

const PRIORITY = { high: 0, warning: 1, info: 2 };
const EVIDENCE_KEYS = ['count', 'cost', 'totalRevenue', 'sales', 'delta', 'percent', 'minSales', 'minSpend', 'minRevenue', 'thresholdPercent', 'thresholdAmount'];
function evidenceOf(value) {
  return Object.fromEntries(EVIDENCE_KEYS.filter((key) => finite(value?.[key]) !== null).map((key) => [key, value[key]]));
}

function cleanAlert(value) {
  if (!Object.hasOwn(RULES, value?.rule) || !boundedId(value.id)?.startsWith('alert-')) return null;
  return {
    id: value.id, rule: value.rule, severity: RULES[value.rule].severity,
    firstSeenAt: timestamp(value.firstSeenAt), lastSeenAt: timestamp(value.lastSeenAt),
    change: ['new', 'observed', 'updated', 'ongoing'].includes(value.change) ? value.change : 'observed',
    readToken: boundedId(value.readToken)?.startsWith('read-') ? value.readToken : null,
    evidenceKey: typeof value.evidenceKey === 'string' && /^[0-9a-f]{8}$/.test(value.evidenceKey) ? value.evidenceKey : null,
    evidence: evidenceOf(value.evidence),
  };
}

function collectAlerts(snapshot, current, comparison, previous) {
  const candidates = new Map();
  const add = (rule, source = '', evidence = {}, evidenceKey = null) => {
    const id = 'alert-' + hash(rule + ':' + source);
    if (!candidates.has(id)) candidates.set(id, { id, rule, severity: RULES[rule].severity, evidence: evidenceOf(evidence), evidenceKey });
  };
  if (current.coverage.report !== 'complete' || !current.currency || !current.model) add('report-coverage', '', { count: current.coverage.warningCount });
  if (current.coverage.tracking !== 'complete') add('tracking-coverage');
  if (['partial', 'stale', 'error', 'skipped'].includes(current.coverage.crm)) add('crm-coverage');
  if (['partial', 'stale', 'error', 'skipped'].includes(current.coverage.attribution)) add('attribution-coverage');
  const health = snapshot.health;
  if (health && !health.stale && !health.error && !health.skipped && timestamp(health.checkedAt)) {
    const script = health.checks?.script;
    if (!script?.stale && ['ok', 'empty'].includes(script?.status)) {
      for (const [source, status] of Object.entries(health.scripts || {})) {
        if (['SCRIPT_NOT_FOUND', 'NOT_FOUND', 'MISSING', 'ABSENT', 'NOT_INSTALLED'].includes(String(status).toUpperCase())) add('script-missing', source, { count: 1 });
      }
    }
    const params = health.checks?.params;
    if (!params?.stale && ['ok', 'empty'].includes(params?.status)) for (const group of array(health.trackingParams)) {
      if (['failed', 'skipped'].includes(params.channels?.[group?.type])) continue;
      for (const row of array(group?.rows)) {
        if (!row || typeof row !== 'object') continue;
        const missing = row.missingParameters ?? row.missing;
        if (row.valid === false || row.ok === false || missing === true || array(missing).length ||
          (typeof missing === 'string' && missing.trim()) || ['MISSING', 'INVALID', 'FAILED', 'MISSING_PARAMETERS', 'INVALID_PARAMETERS'].includes(String(row.status).toUpperCase())) {
          const evidenceKey = hash(JSON.stringify([Array.isArray(missing) ? missing.map(String).sort() : missing, row.valid, row.ok, row.status]));
          add('params-missing', JSON.stringify([group.type || '', row.adId ?? row.id ?? row.adName ?? row.name ?? 'unidentified']), { count: 1 }, evidenceKey);
        }
      }
    }
  }
  if (current.coverage.report === 'complete' && current.currency && current.model && current.sales >= THRESHOLDS.minSales && current.cost >= THRESHOLDS.minSpend && current.totalRevenue !== null && current.totalRevenue < current.cost) {
    add('revenue-below-spend', current.contextKey, { totalRevenue: current.totalRevenue, cost: current.cost, sales: current.sales, minSales: THRESHOLDS.minSales, minSpend: THRESHOLDS.minSpend });
  }
  const baseline = array(previous?.history).find((entry) => entry.id === comparison.previousId) || previous?.current;
  const change = comparison.changes?.totalRevenue;
  if (comparison.comparable && change && baseline?.sales >= THRESHOLDS.minSales && current.sales >= THRESHOLDS.minSales &&
    baseline.cost >= THRESHOLDS.minSpend && current.cost >= THRESHOLDS.minSpend && baseline.totalRevenue >= THRESHOLDS.minRevenue &&
    change.delta <= -THRESHOLDS.revenueRevisionAmount && change.percent <= -THRESHOLDS.revenueRevisionPercent) {
    add('revenue-revision', current.contextKey, { delta: change.delta, percent: change.percent, sales: current.sales,
      minSales: THRESHOLDS.minSales, minSpend: THRESHOLDS.minSpend, minRevenue: THRESHOLDS.minRevenue,
      thresholdPercent: THRESHOLDS.revenueRevisionPercent, thresholdAmount: THRESHOLDS.revenueRevisionAmount });
  }
  const old = new Map(array(previous?.alerts).map(cleanAlert).filter(Boolean).map((alert) => [alert.id, alert]));
  const alerts = [...candidates.values()].sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity] || a.id.localeCompare(b.id)).map((alert) => {
    const prior = old.get(alert.id);
    const firstSeenAt = prior?.firstSeenAt || current.generatedAt;
    const scope = ['script-missing', 'params-missing', 'tracking-coverage'].includes(alert.rule) ? 'tracking'
      : alert.rule === 'crm-coverage' ? 'crm' : alert.rule === 'attribution-coverage' ? 'attribution' : 'report';
    const readToken = 'read-' + hash(JSON.stringify([alert.id, firstSeenAt, alert.evidence, alert.evidenceKey,
      scope === 'report' ? [current.window, current.currency, current.model, current.contextKey, current.coverage.unknownMetrics] : null, current.coverage[scope], current.coverage.pagination[scope]]));
    const change = prior ? prior.readToken === readToken ? 'ongoing' : 'updated'
      : !previous?.alertsTruncated && previous?.current?.coverage?.[scope] === 'complete' ? 'new' : 'observed';
    return { ...alert, firstSeenAt, lastSeenAt: current.generatedAt, readToken, change };
  });
  return { alerts: alerts.slice(0, ALERT_LIMIT), total: alerts.length, truncated: alerts.length > ALERT_LIMIT };
}

function cleanHistory(previous) {
  const byId = new Map();
  for (const raw of [...array(previous?.history), previous?.current]) {
    const summary = cleanSummary(raw);
    if (summary) byId.set(summary.id, summary);
  }
  return [...byId.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.id.localeCompare(b.id)).slice(0, HISTORY_LIMIT);
}

export function buildBrief(snapshot = {}, previous = null, now = null) {
  const current = summarize(snapshot || {}, now);
  if (!current.generatedAt) return { error: 'Snapshot timestamp unavailable.' };
  const earlier = cleanHistory(previous);
  if (earlier[0]?.generatedAt > current.generatedAt) return { ...sanitizeBrief(previous), stale: true, skipped: 'snapshot predates previous brief' };
  const prior = earlier.filter((entry) => entry.generatedAt < current.generatedAt);
  const comparison = compareSummaries(current, prior[0]);
  const findings = collectAlerts(snapshot || {}, current, comparison, previous);
  const history = [current, ...prior].slice(0, HISTORY_LIMIT);
  return {
    version: 1, checkedAt: current.generatedAt, current, history, comparison,
    alerts: findings.alerts, alertCount: findings.total, alertsTruncated: findings.truncated,
    newIssues: findings.alerts.filter((alert) => alert.change === 'new').length,
    delivery: { inApp: true, email: false, slack: false, configured: false },
  };
}

export function sanitizeBrief(block) {
  const current = cleanSummary(block?.current);
  const history = cleanHistory(block);
  const alerts = array(block?.alerts).map(cleanAlert).filter(Boolean).slice(0, ALERT_LIMIT);
  const previous = history.find((entry) => current && entry.generatedAt < current.generatedAt);
  return {
    version: 1, checkedAt: timestamp(block?.checkedAt), current, history,
    comparison: current ? compareSummaries(current, previous) : compareSummaries(null, null),
    alerts, alertCount: Math.max(alerts.length, count(block?.alertCount) ?? 0), alertsTruncated: block?.alertsTruncated === true,
    newIssues: alerts.filter((alert) => alert.change === 'new').length,
    delivery: { inApp: true, email: false, slack: false, configured: false },
    ...(block?.stale ? { stale: true } : {}),
    ...(block?.skipped ? { skipped: 'Refresh skipped' } : {}),
    ...(block?.error ? { error: 'Brief unavailable' } : {}),
  };
}

export function exportBrief(block, demo = false) {
  const safe = sanitizeBrief(block);
  return {
    ...safe, demo: demo === true, redacted: true,
    history: safe.history.map((entry, index) => ({ ...entry, comparison: compareSummaries(entry, safe.history[index + 1]) })),
  };
}
