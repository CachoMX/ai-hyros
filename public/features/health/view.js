/** Tracking Health — script presence + tracking parameters. Renders ctx.block into ctx.root. */
const SCRIPT_OK = new Set(['SCRIPT_FOUND', 'FOUND', 'OK', 'PRESENT', 'INSTALLED']);
// snapshot.warnings[].kind -> pill text. Skips are quiet, failures are bad.
const WARN_LABEL = { unsupported: 'skipped: unsupported', 'time budget': 'skipped: time budget', rate_limited: 'rate limited', truncated: 'truncated', error: 'error' };
const WARN_BAD = new Set(['rate_limited', 'error']);

/** One pill per distinct warning kind for this ad account (core snapshot.warnings), escaped. */
function warningPills(adAccount, warnings, esc) {
  const mine = warnings.filter((w) => String(w?.adAccountId) === String(adAccount.id));
  const kinds = [...new Set(mine.map((w) => w?.kind || 'error'))];
  return kinds.map((kind) => {
    const detail = mine.filter((w) => (w?.kind || 'error') === kind).map((w) => [w.level, w.error].filter(Boolean).join(': ')).join(' · ');
    return `<span class="pill ${WARN_BAD.has(kind) ? 'bad' : 'warn'}" title="${esc(detail)}">${esc(WARN_LABEL[kind] || `skipped: ${kind}`)}</span>`;
  }).join('');
}

export function render(ctx) {
  const { fmt, esc, kpis, snapshot } = ctx;
  const h = ctx.block;
  if (!h) { ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No health check in this snapshot — hit Refresh.</div></div>'; return; }
  const scripts = Object.entries(h.scripts || {});
  const okCount = scripts.filter(([, st]) => SCRIPT_OK.has(String(st).toUpperCase())).length;
  const paramRows = (h.trackingParams || []).flatMap((p) => (p.rows || []).map((r) => ({ ...r, _type: p.type })));
  const flagged = paramRows.filter((r) => r && (r.valid === false || r.missing || r.ok === false || /missing|invalid/i.test(JSON.stringify(r))));
  const acct = snapshot.account || {};
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  // The step did not run this refresh (no data at all) vs. ran earlier and is
  // being shown again (stale). Only a block with a checkedAt actually ran.
  const notRun = !h.checkedAt;
  const hasGoogle = (snapshot.adAccounts || []).some((a) => /GOOGLE/.test(a.type || ''));
  const status = h.skipped
    ? (h.stale
      ? `<br>Skipped this refresh (${esc(h.skipped)}) — showing the previous check${h.checkedAt ? ` from ${esc(fmt.datetime(h.checkedAt))}` : ''}.`
      : `<br>Skipped this refresh (${esc(h.skipped)}) — nothing was checked yet. Hit Refresh again.`)
    : '';

  ctx.root.innerHTML = `
    <div class="note"><b>Tracking Health.</b> Is the HYROS script actually on your
      domains, and do your ad links carry the parameters attribution needs? Checked by HYROS itself
      (<code>hyros_assert_script_presence_on_domain</code>, <code>hyros_check_tracking_parameters_for_integrations</code>)
      ${h.checkedAt ? `at ${esc(fmt.datetime(h.checkedAt))}` : ''}.
      ${h.error ? `<br><b>Error:</b> ${esc(h.error)}` : ''}${status}
      ${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    <div class="kpis">${kpis([
      { label: 'Verified domains', value: notRun ? '—' : fmt.int((h.domains || []).length), sub: notRun ? 'not checked' : '' },
      { label: 'Script present', value: scripts.length ? `${okCount} / ${scripts.length}` : '—',
        cls: scripts.length && okCount < scripts.length ? 'bad' : (scripts.length ? 'good' : ''), sub: 'of domains checked' },
      { label: 'Ads missing tracking params', value: paramRows.length ? fmt.int(flagged.length) : '—',
        cls: flagged.length ? 'bad' : (paramRows.length ? 'good' : ''), sub: (h.trackingParams || []).map((p) => p.type).join(', ') || 'no Google channels checked' },
      { label: 'Check errors', value: notRun ? '—' : fmt.int((h.errors || []).length), cls: (h.errors || []).length ? 'bad' : '' },
    ])}</div>
    <div class="fcols">
      <div class="fpanel"><h3>Script presence</h3>
        <div class="fhint">the universal script, fetched and inspected per URL (up to 5 verified domains)</div>
        ${scripts.length ? scripts.map(([url, st]) => {
          const ok = SCRIPT_OK.has(String(st).toUpperCase());
          return `<div class="health-row"><code title="${esc(url)}">${esc(url)}</code>
            <span class="pill ${ok ? 'ok' : 'bad'}">${esc(String(st).toLowerCase().replace(/_/g, ' '))}</span></div>`;
        }).join('') : `<div class="empty">${notRun ? 'Not checked this refresh.' : ((h.domains || []).length ? 'No script check result.' : 'No verified domains on this account — add one in HYROS to enable the check.')}</div>`}
        ${(h.errors || []).length ? `<div class="sub" style="margin-top:8px">${esc(h.errors.join(' · '))}</div>` : ''}
      </div>
      <div class="fpanel"><h3>Account &amp; access</h3>
        <div class="fhint">connected ad accounts and agency relationships (MCP: allowedAccounts / accessibleAccounts)</div>
        ${(snapshot.adAccounts || []).map((a) => `<div class="health-row"><code>${esc(a.name)}</code><span class="pill">${esc(a.type)}</span><span class="sub">${esc(a.id)}</span>${warningPills(a, warnings, esc)}</div>`).join('')}
        ${(acct.managedBy || []).map((a) => `<div class="health-row"><code>managed by ${esc(a.email || a.company || a.accountId || '—')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
        ${(acct.clients || []).map((a) => `<div class="health-row"><code>client ${esc(a.email || a.company || a.accountId || '—')}</code><span class="pill ${a.status === 'APPROVED' ? 'ok' : ''}">${esc(a.status || '')}</span></div>`).join('')}
        ${acct.attributionWindowDefault ? `<div class="health-row"><code>account attribution window</code><span class="pill">${acct.attributionWindowDefault} days</span></div>` : ''}
      </div>
    </div>
    <div class="fpanel"><h3>Ad link tracking parameters</h3>
      <div class="fhint">per ad, whether the parameters HYROS needs are present and well-formed (Google channels seen in the last hour)</div>
      ${paramRows.length ? paramRows.slice(0, 50).map((r) => {
        const bad = flagged.includes(r);
        const label = r.adName || r.name || r.ad || r.adId || r.id || JSON.stringify(r).slice(0, 80);
        return `<div class="health-row"><span class="pill">${esc(r._type)}</span><code title="${esc(JSON.stringify(r))}">${esc(String(label))}</code>
          <span class="pill ${bad ? 'bad' : 'ok'}">${bad ? 'missing / invalid' : 'ok'}</span></div>`;
      }).join('') : `<div class="empty">${notRun ? 'Not checked this refresh.' : (hasGoogle ? 'No ads reported by the check in the last hour.' : 'No Google ad accounts connected — nothing to check.')}</div>`}
    </div>`;
}
