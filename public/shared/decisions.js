import { reportRevenue } from './metrics.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const rank = { critical: 0, high: 1, medium: 2, low: 3 };

export function decisionBrief(snapshot = {}, range = '7d', now = Date.now()) {
  const period = snapshot.ranges?.[range];
  const issues = [];
  const add = (id, priority, title, reason, action, view, evidence) => issues.push({ id, priority, title, reason, action, view, evidence });
  const age = snapshot.generatedAt ? (Number(now) - Date.parse(snapshot.generatedAt)) / 3600000 : NaN;
  const stale = !Number.isFinite(age) || age > 36 || age < -0.08 || snapshot.stale === true;
  const currency = /^[A-Z]{3}$/.test(snapshot.account?.currency) ? snapshot.account.currency : null;
  const incomplete = !period || Boolean(period.skipped || period.error || period.stale || period.partial)
    || stale || !currency || !finite(reportRevenue(period?.totals || {})) || !finite(period?.totals?.cost)
    || (snapshot.warnings || []).some(w => w.level !== 'crm' && (!w.range || w.range === range));
  if (incomplete) add('data-coverage', 'critical', 'Verify report coverage', 'This period has missing or partial data.', 'Complete the refresh before making budget decisions.', 'report', [{ label: 'Range', value: range }]);
  for (const [url, status] of Object.entries(snapshot.health?.scripts || {})) {
    const previous = stale || snapshot.health?.stale || snapshot.health?.checks?.script?.stale;
    if (status === 'SCRIPT_NOT_FOUND') add(`script:${url}`, previous ? 'medium' : 'high', previous ? 'Recheck previous tracking finding' : 'Tracking script not detected', url, previous ? 'Previous check only; run diagnostics before treating this finding as current.' : 'Verify installation and recheck the affected site.', 'health', [{ label: 'Check', value: status }, { label: 'Previous check', value: Boolean(previous) }]);
  }
  const rows = period?.levels?.campaign || [];
  const totalCost = rows.reduce((s, r) => s + (finite(r.cost) ? r.cost : 0), 0);
  if (!incomplete) for (const row of rows) {
    const revenue = reportRevenue(row);
    const evidence = [{ label: 'Campaign', value: row.name || row.id }, { label: 'Ad spend', value: row.cost }, { label: 'Total revenue', value: revenue }, { label: 'Sales', value: row.sales ?? null }];
    if (row.cost > 0 && finite(revenue) && finite(row.sales) && row.sales >= 10 && revenue < row.cost) {
      add(`efficiency:${row.id}`, 'high', `Review ${row.name || row.id}`, 'Attributed revenue is below ad spend; recent conversions may still mature.', 'Inspect conversion lag, margin and attribution before reducing spend.', 'profit', evidence);
    }
    if (totalCost > 0 && row.cost / totalCost > 0.6 && rows.length > 1) {
      add(`concentration:${row.id}`, 'medium', 'Campaign concentration', `${Math.round(row.cost / totalCost * 100)}% of measured spend is in one campaign.`, 'Review diversification with the creative team.', 'creative', evidence);
    }
  }
  const coverage = snapshot.attribution?.coverage;
  if (coverage && (coverage.truncated || (coverage.sampled > 0 && coverage.withPaths < coverage.sampled))) {
    add('journey-coverage', 'medium', 'Attribution sample is incomplete', 'Model comparisons describe the available paths, not every conversion.', 'Review missing paths and sample coverage.', 'attribution', [{ label: 'Sampled', value: coverage.sampled }, { label: 'With paths', value: coverage.withPaths }, { label: 'Truncated', value: Boolean(coverage.truncated) }]);
  }
  const health = snapshot.health;
  if (!health || stale || health.stale || health.error || health.skipped || health.checks?.script?.stale) add('health-coverage', 'medium', 'Tracking checks need attention', health?.stale || health?.checks?.script?.stale || stale ? 'Showing previous checks.' : 'Current checks are unavailable or incomplete.', 'Run tracking diagnostics.', 'health', []);
  const totals = period?.totals;
  return {
    range, window: period ? { start: period.start, end: period.end } : null,
    generatedAt: snapshot.generatedAt || null, currency, stale,
    incomplete, attributionModel: snapshot.attributionModel || null,
    totals: totals && !period.skipped ? { cost: totals.cost ?? null, revenue: reportRevenue(totals), sales: totals.sales ?? null, roas: totals.cost > 0 && finite(reportRevenue(totals)) ? reportRevenue(totals) / totals.cost : null } : null,
    issues: issues.sort((a, b) => rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id)),
    caveats: ['Observational attribution, not causal lift.', 'Revenue includes rebills; ad profit excludes operating costs.', 'No campaign changes are executed.'],
  };
}

export function loadDecisions(account) {
  try { const value = JSON.parse(globalThis.localStorage?.getItem(`hyros:decisions:${account || 'default'}`) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
export function saveDecision(account, id, status, details = {}) {
  if (!['open', 'monitoring', 'resolved', 'dismissed'].includes(status)) return false;
  try {
    const all = loadDecisions(account);
    all[id] = { ...all[id], status, changedAt: new Date().toISOString() };
    for (const field of ['owner', 'hypothesis', 'reviewDate']) {
      if (typeof details[field] === 'string') all[id][field] = details[field].slice(0, field === 'hypothesis' ? 1200 : 80);
    }
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(`hyros:decisions:${account || 'default'}`, JSON.stringify(all));
    return true;
  } catch { return false; }
}

export function evidencePack(brief, { redact = true } = {}) {
  const issues = brief.issues.map((issue, i) => ({ ...issue, id: redact ? `finding-${i + 1}` : issue.id,
    title: redact && issue.id.startsWith('efficiency:') ? 'Review campaign efficiency' : issue.title,
    reason: redact && issue.id.startsWith('script:') ? 'Tracking finding on a site; see check freshness.' : issue.reason,
    evidence: issue.evidence.map(e => ({ ...e, value: redact && e.label === 'Campaign' ? '[redacted]' : e.value })) }));
  return { ...brief, issues, redacted: redact, schema: 1 };
}

export function answerQuestion(question, brief) {
  const q = String(question).toLowerCase();
  const citations = brief.issues.map((x, i) => ({ id: i + 1, title: x.title, view: x.view, evidence: x.evidence }));
  if (/profit|margin|beneficio|rentab/.test(q)) return { text: 'Net profit needs your cost and margin assumptions. Open Profit to configure them. Revenue minus advertising cost alone is not net profit.', citations: citations.filter(x => x.view === 'profit') };
  if (/track|script|utm|salud/.test(q)) return { text: brief.issues.filter(x => x.view === 'health').map(x => `${x.title}: ${x.reason} ${x.action}`).join('\n\n') || 'No tracking issue is listed in this snapshot. That is not proof that all tracking is healthy; inspect Tracking Health for check coverage.', citations: citations.filter(x => x.view === 'health') };
  if (/attribution|atribuci|winner|ganador/.test(q)) return { text: 'Compare first, last, linear, position-based and time-decay credit in Attribution Lab. The comparison uses sampled observed conversion paths and cannot establish incremental lift or a causal winner.', citations: citations.filter(x => x.view === 'attribution') };
  if (/budget|scale|presupuesto|escalar/.test(q)) return { text: 'Scale Advisor shows observed marginal CAC curves. Check maturity and your CAC ceiling, then design a measured budget test. This snapshot does not justify an automatic budget change.', citations: [] };
  if (/revenue|roas|ingreso|sales|venta|resum|summary/.test(q)) return { text: brief.totals ? `Period ${brief.range}: ${brief.currency || 'Unknown currency'} ${finite(brief.totals.revenue) ? brief.totals.revenue.toFixed(2) : 'unknown'} total revenue; ${finite(brief.totals.cost) ? brief.totals.cost.toFixed(2) : 'unknown'} ad spend; ${brief.totals.sales ?? 'unknown'} sales. ROAS: ${brief.totals.roas?.toFixed(2) ?? 'unavailable'}.${brief.incomplete ? ' Coverage is partial.' : ''}${brief.stale ? ' Snapshot is stale or its time is unknown.' : ''}` : 'This period has no complete report. Refresh the data or choose an available period.', citations: [{ id: 0, title: `Performance report: ${brief.range}`, view: 'report', evidence: [] }] };
  if (/priorit|action|acci[oó]n|hacer|review|revis|riesgo|risk/.test(q)) return { text: brief.issues.slice(0, 5).map((x, i) => `[${i + 1}] ${x.title}. ${x.reason} ${x.action}`).join('\n\n') || 'No rule-based finding is present for this period. Inspect coverage and margins before interpreting this as a clean bill of health.', citations: citations.slice(0, 5) };
  return { text: 'No verified answer is available for that question. Available topics: priorities, revenue, tracking, attribution, profit and scaling. This assistant uses snapshot rules, not a generative model.', citations: [] };
}

export function downloadFile(name, value, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
