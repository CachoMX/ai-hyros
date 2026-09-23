const list = (value) => Array.isArray(value) ? value : [];
export const SCRIPT_OK = new Set(['SCRIPT_FOUND', 'FOUND', 'OK', 'PRESENT', 'INSTALLED']);
const SCRIPT_MISSING = new Set(['SCRIPT_NOT_FOUND', 'NOT_FOUND', 'MISSING', 'ABSENT', 'NOT_INSTALLED']);
export const scriptState = (value) => SCRIPT_OK.has(String(value).toUpperCase()) ? 'ok'
  : SCRIPT_MISSING.has(String(value).toUpperCase()) ? 'missing' : 'unknown';

export function missingParameters(row) {
  const value = row?.missingParameters ?? row?.missing;
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string' && x.trim());
  return typeof value === 'string' && value.trim() ? [value] : [];
}

/** Only diagnostic fields count; an ad named "Missing you" is not a failure. */
export function parameterState(row) {
  if (!row || typeof row !== 'object') return 'unknown';
  const status = String(row.status || '').toUpperCase();
  if (row.valid === false || row.ok === false || row.missing === true || missingParameters(row).length
    || ['MISSING', 'INVALID', 'FAILED', 'MISSING_PARAMETERS', 'INVALID_PARAMETERS'].includes(status)) return 'missing';
  if (row.valid === true || row.ok === true || ['OK', 'VALID', 'PASSED'].includes(status)) return 'ok';
  return 'unknown';
}

export const parameterKey = (row) => String(row?.adId ?? row?.id ?? row?.adName ?? row?.name ?? row?.ad ?? '');

function issue(check, key, title, evidence, steps, extra = {}) {
  return { id: `${check}:${key}`, check, title, severity: 'warning', evidence, steps, ...extra };
}

/** Adapts Mosaide's evidence -> finding -> fix steps structure to direct checks. */
export function diagnose(block, snapshot = {}) {
  const h = block || {};
  const issues = [];
  const checks = h.checks || {};
  const stamp = (check) => ({ checkedAt: checks[check]?.checkedAt || h.checkedAt || null, stale: h.stale === true || checks[check]?.stale === true });
  const add = (item) => issues.push({ ...item, ...stamp(item.check) });
  if (!h.checkedAt || h.error || h.stale) add(issue('snapshot', 'coverage', 'Current diagnosis unavailable',
    [h.error || h.skipped || 'No completed health check in this snapshot.'],
    ['Run a recheck for this account.', 'Load the resulting snapshot and review each check status.'], { severity: 'coverage' }));
  if (checks.domains?.status === 'empty' && !list(h.domains).length) add(issue('domains', 'none', 'No verified tracking domains',
    ['The domain check returned an empty list.'],
    ['Confirm the selected HYROS account and its intended tracking domain.', 'Copy the account-specific DNS record from HYROS and have the domain owner verify it.', 'Recheck after HYROS reports the domain as verified.'],
    { impact: 'Custom tracking-domain coverage is unverified. This does not establish lost sales.' }));

  const groups = new Map();
  for (const site of list(h.sites)) {
    if (!site?.url) continue;
    const key = String(site.trackingDomain || site.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(site.url);
  }
  const covered = new Set([...groups.values()].flat());
  for (const url of Object.keys(h.scripts || {})) if (!covered.has(url)) groups.set(url, [url]);
  for (const [domain, urls] of groups) {
    const states = urls.map((url) => scriptState(h.scripts?.[url]));
    if (states.includes('ok')) continue;
    const missing = states.every((s) => s === 'missing');
    add(issue('script', domain, missing ? `Script not found: ${domain}` : `Script check incomplete: ${domain}`,
      urls.map((url) => `${url}: ${h.scripts?.[url] ?? 'not checked'}`),
      [`Review the actual landing and checkout pages for ${domain}, including redirects and consent conditions.`,
        'Compare the installed script with the exact account-specific script from HYROS. Confirm the correct account before changing page code.',
        'If it is missing, have the site owner install that script in the relevant page template and publish.',
        'Check the final destination in the browser, then recheck script presence.'],
      { urls, severity: missing ? 'warning' : 'coverage', impact: missing ? 'HYROS did not find a script on these checked URLs. Redirects and consent gating still need review.' : 'The available results cannot establish script presence for this site.' }));
  }
  for (const group of list(h.trackingParams)) {
    for (const [index, row] of list(group?.rows).entries()) {
      const status = parameterState(row);
      if (status === 'ok') continue;
      const key = parameterKey(row);
      const channel = String(group.type || 'unknown');
      const missing = missingParameters(row);
      const evidence = [`Channel: ${channel}`, `Ad: ${key || 'identifier unavailable'}`, `Result: ${status === 'missing' ? 'missing / invalid parameters' : 'unrecognized diagnostic result'}`];
      if (missing.length) evidence.push(`Reported missing: ${missing.join(', ')}`);
      if (typeof row?.message === 'string') evidence.push(row.message);
      add(issue('params', `${channel}:${key || index}`, status === 'missing' ? `Repair ad parameters: ${key || channel}` : `Review parameter result: ${key || channel}`,
        evidence,
        [`Review this ${channel} ad's final URL, suffix and any inherited tracking template.`,
          missing.length ? `Compare the reported missing fields (${missing.join(', ')}) with the account's HYROS integration settings.` : 'Compare the parameter requirements with the account-specific HYROS integration settings.',
          'Prepare the matching platform template; preserve existing parameters and redirect behavior. Do not invent click IDs or paste placeholder values into live ads.',
          'Have the ad-account owner apply the reviewed correction, then verify a new click and run another parameter check.'],
        { channel, rowKey: key, severity: status === 'missing' ? 'warning' : 'coverage', impact: 'This check covers returned ads in the last-hour sample. It does not measure missing revenue.' }));
    }
  }

  for (const [check, value] of Object.entries(checks)) {
    if (!value || ['no Google ad accounts connected', 'no verified domains'].includes(value.reason)) continue;
    if (['skipped', 'failed'].includes(value.status) || value.reason) add(issue(check, 'coverage', `${check} coverage needs review`,
      [`${value.status}: ${value.reason || 'No detail returned.'}`],
      ['Review this check and its full error in the results below.', 'For timeouts or rate limits, retry on the next refresh. For access failures, ask the account owner to review the connection.', 'Confirm fresh results before closing a tracking issue.'], { severity: 'coverage' }));
    for (const [channel, status] of Object.entries(value.channels || {})) {
      if (!['failed', 'skipped'].includes(status)) continue;
      add(issue('params', `coverage:${channel}`, `${channel} coverage unavailable`, [`Channel status: ${status}`],
        ['Review the connection and the channel-specific check error.', 'Run a new refresh and verify that this channel completed.'], { channel, severity: 'coverage' }));
    }
  }
  // Retain access warnings as evidence, without diagnosing an installation defect.
  for (const warning of list(snapshot.warnings).filter((w) => ['error', 'rate_limited', 'unsupported'].includes(w?.kind)).slice(0, 20)) {
    const key = `${warning.adAccountId}:${warning.kind}`;
    if (issues.some((x) => x.id === `access:${key}`)) continue;
    add(issue('access', key, `Account data: ${warning.name || warning.adAccountId || 'unknown'}`,
      [warning.kind, warning.error || 'Account report coverage is incomplete.'],
      ['Review the affected account and report level.', 'Confirm access with the account owner; retry rate-limited requests on a later refresh.'], { severity: 'coverage' }));
  }
  return issues;
}

/** Resolution requires a new, positive result for the same entity, not disappearance. */
export function assessRecheck(selected, block, snapshot = {}) {
  const oldTime = Date.parse(selected.checkedAt || '');
  const newTime = Date.parse(block?.checkedAt || '');
  const check = block?.checks?.[selected.check];
  if (!Number.isFinite(newTime) || (Number.isFinite(oldTime) && newTime <= oldTime)
    || block?.stale || block?.skipped || block?.error || check?.stale || ['failed', 'skipped'].includes(check?.status)) {
    return { status: 'inconclusive', message: 'No fresh, completed result for this issue. Previous evidence remains open.' };
  }
  if (diagnose(block, snapshot).some((x) => x.id === selected.id)) return { status: 'still-open', message: 'The new check still reports this issue.' };
  let verified = false;
  if (selected.check === 'script' && selected.urls) verified = selected.urls.some((url) => scriptState(block.scripts?.[url]) === 'ok');
  if (selected.check === 'params' && selected.rowKey) {
    const rows = list(block.trackingParams).filter((g) => g?.type === selected.channel).flatMap((g) => list(g.rows));
    const matching = rows.filter((r) => parameterKey(r) === selected.rowKey);
    verified = matching.length > 0 && matching.every((r) => parameterState(r) === 'ok')
      && !['skipped', 'failed'].includes(block.checks?.params?.channels?.[selected.channel]);
  }
  if (selected.check === 'domains') verified = check?.status === 'ok' && list(block.domains).length > 0;
  return verified ? { status: 'verified', message: 'A fresh positive result was returned for the affected entity.' }
    : { status: 'inconclusive', message: 'The issue was not returned, but matching positive evidence is missing. Keep it open.' };
}

export function remediationNote(selected, { account, demo, checked = [], result } = {}) {
  return ['# Tracking remediation note', '', `Account: ${account || 'unspecified'}`, `Data: ${demo ? 'Demo sample' : 'HYROS snapshot'}`,
    `Issue: ${selected.title}`, `Checked: ${selected.checkedAt || 'not checked'}${selected.stale ? ' (previous result)' : ''}`,
    '', '## Evidence', ...selected.evidence.map((line) => `- ${line}`), '', selected.impact || '',
    '## Proposed correction', ...selected.steps.map((line, index) => `- [${checked.includes(index) ? 'x' : ' '}] ${line}`),
    '', 'Checklist completion is self-reported; it is not a verification result.', '', '## Recheck',
    result?.message || 'Not run. No correction has been verified.', '', 'No HYROS tracking settings or rules were changed by this tool.', ''].join('\n');
}
