/** Tracking Health — server step. Returns the block stored as snapshot.health. */
export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  const out = { checkedAt: new Date().toISOString(), domains: [], scripts: {}, trackingParams: [], errors: [] };
  log('health domains');
  try {
    const d = await callTool('hyros_get_domains', {}, { timeoutMs: 10000 });
    const list = Array.isArray(d) ? d : d?.result || d?.domains || [];
    out.domains = list.map((x) => (typeof x === 'string' ? x : x?.domain || x?.name || x?.url)).filter(Boolean).slice(0, 20);
  } catch (err) { out.errors.push(`domains: ${err.message}`); }

  if (out.domains.length && ctx.timeLeft() > 5000) {
    log('health script');
    try {
      const urls = out.domains.slice(0, 5).map((dom) => (/^https?:\/\//.test(dom) ? dom : `https://${dom}/`));
      const r = await callTool('hyros_assert_script_presence_on_domain', { domains: urls }, { timeoutMs: 20000 });
      out.scripts = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    } catch (err) { out.errors.push(`script: ${err.message}`); }
  }

  // Google ad links need their tracking parameters; check the common channels.
  if (snapshot.adAccounts.some((a) => /GOOGLE/.test(a.type || ''))) {
    for (const type of ['SEARCH', 'PERFORMANCE_MAX']) {
      if (ctx.timeLeft() < 5000) { out.errors.push(`params ${type}: skipped (time budget)`); continue; }
      log(`health params ${type}`);
      try {
        const r = await callTool('hyros_check_tracking_parameters_for_integrations', { request: { type } }, { timeoutMs: 15000 });
        const rows = Array.isArray(r) ? r : r?.result || r?.ads || (r ? [r] : []);
        out.trackingParams.push({ type, rows: rows.slice(0, 50) });
      } catch (err) { out.errors.push(`params ${type}: ${err.message}`); }
    }
  }
  return out;
}
