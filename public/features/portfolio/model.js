export const RANGES = ['today', 'yesterday', '7d', '30d'];
export const STALE_AFTER_HOURS = 36;
export const STATUS_LABELS = { fresh: 'Fresh', stale: 'Stale', error: 'Error', not_connected: 'Not connected' };
export const REASONS = {
  no_snapshot: 'No stored snapshot',
  demo_snapshot: 'Only demo data is stored',
  key_invalid: 'Account key needs attention',
  access_pending: 'Client access is not approved',
  agency_missing: 'Agency connection is unavailable',
  client_unverified: 'Agency client access is not verified',
  refresh_failed: 'Last refresh failed; previous snapshot shown',
  refresh_failed_no_snapshot: 'Last refresh failed; no stored snapshot',
  snapshot_failed: 'Stored snapshot could not be read',
  report_error: 'Report is unavailable',
  range_skipped: 'This range was skipped during refresh',
  range_missing: 'This range has not been stored',
  previous: 'Showing the previous result',
  expired: 'Snapshot is more than 36 hours old',
  time_unknown: 'Snapshot time is unavailable or inconsistent',
  partial: 'Incomplete report; excluded from totals',
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const day = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const round = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
export const currencyCode = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value) && !['XXX', 'XTS'].includes(value) ? value : null;

export function connectionGate(account, byId = new Map()) {
  if (account.kind === 'client') {
    if (account.status !== 'APPROVED') return { status: 'not_connected', reason: 'access_pending' };
    const agency = byId.get(account.parentId);
    if (!agency || agency.kind === 'client') return { status: 'not_connected', reason: 'agency_missing' };
    if (agency.keyStatus === 'invalid') return { status: 'error', reason: 'key_invalid' };
    if (agency.clientModeStatus !== 'verified') return { status: 'not_connected', reason: 'client_unverified' };
  }
  if (account.keyStatus === 'invalid') return { status: 'error', reason: 'key_invalid' };
  return null;
}

function accountLabel(account, demo) {
  const label = demo ? account.label : account.company;
  // Registry labels can fall back to personal names or email addresses.
  if (typeof label === 'string' && label.trim() && !label.includes('@')) return label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
  return `Account ${String(account.id || '').slice(-6) || 'pending'}`;
}

export function summarizeAccount(account, snapshot, { range = '30d', now = new Date(), gate = null, demo = false } = {}) {
  const row = {
    id: String(account.id || ''), label: accountLabel(account, demo),
    kind: account.kind === 'client' ? 'client' : 'key', agency: Boolean(account.agency),
    currency: null, status: 'not_connected', reason: 'no_snapshot',
    generatedAt: null, ageHours: null, window: { start: null, end: null },
    metrics: null, partial: false, canOpen: !gate, demo,
  };
  if (gate) return { ...row, ...gate, canOpen: false };
  if (!snapshot || typeof snapshot !== 'object') return account.lastError ? { ...row, status: 'error', reason: 'refresh_failed_no_snapshot' } : row;
  if (!demo && (snapshot.demo === true || ['demo', 'seed'].includes(snapshot.origin))) return { ...row, reason: 'demo_snapshot' };
  row.currency = currencyCode(snapshot.account?.currency);
  row.generatedAt = iso(snapshot.generatedAt);
  row.ageHours = row.generatedAt ? round((new Date(now).getTime() - Date.parse(row.generatedAt)) / 3600000) : null;
  const report = snapshot.ranges?.[range];
  row.window = { start: day(report?.start), end: day(report?.end) };
  if (snapshot.error || report?.error) return { ...row, status: 'error', reason: 'report_error' };
  if (!report) return { ...row, status: 'stale', reason: 'range_missing' };
  if (report.skipped && !report.stale) return { ...row, status: 'stale', reason: 'range_skipped' };
  const totals = report.totals;
  if (!totals || typeof totals !== 'object') return { ...row, status: 'stale', reason: 'range_missing' };
  const spend = finite(totals.cost);
  const totalRevenue = finite(totals.totalRevenue);
  row.metrics = {
    spend, totalRevenue,
    roas: spend !== null && spend > 0 && totalRevenue !== null ? finite(totalRevenue / spend) : null,
    calls: finite(totals.calls), leads: finite(totals.leads),
  };
  row.partial = Boolean(report.partial || (Array.isArray(snapshot.warnings) && snapshot.warnings.some((w) => w && w.level !== 'crm')));
  if (Object.values(row.metrics).every((value) => value === null)) row.partial = true;
  if (account.lastError) return { ...row, status: 'error', reason: 'refresh_failed' };
  if (report.stale || snapshot.stale) return { ...row, status: 'stale', reason: 'previous' };
  if (row.ageHours === null || row.ageHours < -0.08) return { ...row, status: 'stale', reason: 'time_unknown' };
  if (row.ageHours > STALE_AFTER_HOURS) return { ...row, status: 'stale', reason: 'expired' };
  if (row.partial) return { ...row, status: 'stale', reason: 'partial' };
  return { ...row, status: 'fresh', reason: null };
}

export function currencyTotals(accounts) {
  const groups = new Map();
  const seen = new Set();
  for (const row of Array.isArray(accounts) ? accounts : []) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const currency = currencyCode(row.currency);
    if (!currency || row.partial || !row.metrics || !['fresh', 'stale'].includes(row.status)) continue;
    if (!groups.has(currency)) groups.set(currency, { currency, accounts: 0, stale: 0, windows: new Set(), rows: [] });
    const group = groups.get(currency);
    group.accounts += 1;
    group.stale += Number(row.status === 'stale');
    group.windows.add(`${row.window?.start || '?'} / ${row.window?.end || '?'}`);
    group.rows.push(row.metrics);
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((group) => {
    // A missing metric remains unknown, including in the aggregate.
    const sum = (key) => group.rows.every((r) => finite(r[key]) !== null) ? finite(group.rows.reduce((n, r) => n + r[key], 0)) : null;
    const spend = round(sum('spend'));
    const totalRevenue = round(sum('totalRevenue'));
    return {
      currency: group.currency, accounts: group.accounts, stale: group.stale, windows: [...group.windows],
      spend, totalRevenue, roas: spend !== null && spend > 0 && totalRevenue !== null ? finite(totalRevenue / spend) : null,
      calls: sum('calls'), leads: sum('leads'),
    };
  });
}

export function selectAccounts(accounts, { search = '', status = 'all', currency = 'all', sort = 'attention' } = {}) {
  const query = String(search).trim().toLowerCase();
  const order = { error: 0, not_connected: 1, stale: 2, fresh: 3 };
  const rows = (Array.isArray(accounts) ? accounts : []).filter((r) => r &&
    (!query || `${r.label} ${r.id}`.toLowerCase().includes(query)) &&
    (status === 'all' || r.status === status) && (currency === 'all' || (r.currency || 'unknown') === currency));
  return rows.slice().sort((a, b) => {
    const nameOrder = String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id));
    if (sort === 'name') return nameOrder;
    if (sort === 'attention') return (order[a.status] ?? 4) - (order[b.status] ?? 4) || nameOrder;
    if (sort === 'spend' || sort === 'totalRevenue') {
      const currencyOrder = String(a.currency || '~').localeCompare(String(b.currency || '~'));
      if (currencyOrder) return currencyOrder;
    }
    const av = sort === 'oldest' ? finite(a.ageHours) : finite(a.metrics?.[sort]);
    const bv = sort === 'oldest' ? finite(b.ageHours) : finite(b.metrics?.[sort]);
    if (av === null || bv === null) return (av === null ? 1 : 0) - (bv === null ? 1 : 0) || nameOrder;
    return bv - av || nameOrder;
  });
}

export function portfolioCsv(accounts, { range = '30d', demo = false } = {}) {
  const cell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [['Mode', 'Account', 'Account ID', 'Status', 'Caveat', 'Currency', 'Range', 'Start', 'End', 'Snapshot', 'Spend', 'Total revenue incl rebills', 'ROAS incl rebills', 'Calls', 'Leads', 'Partial']];
  for (const row of Array.isArray(accounts) ? accounts : []) rows.push([
    demo ? 'DEMO' : 'Stored snapshot', row.label, row.id, STATUS_LABELS[row.status] || 'Unknown', REASONS[row.reason] || '',
    row.currency, range, row.window?.start, row.window?.end, row.generatedAt,
    row.metrics?.spend, row.metrics?.totalRevenue, row.metrics?.roas, row.metrics?.calls, row.metrics?.leads, row.partial ? 'Yes' : 'No',
  ]);
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
