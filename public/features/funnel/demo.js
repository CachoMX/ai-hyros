/**
 * Demo block for the Funnel & Journey feature. Pure function of the demo
 * snapshot: ranges → stages / entering / converting. Deterministic.
 */
export function demo(snapshot) {
  const block = snapshot.ranges['30d'];
  const t = block.totals;

  const stages = [
    { label: 'Ad Clicks',     sub: 'tracked visitors from ads',   value: t.clicks },
    { label: 'Added to Cart', sub: 'product intent shown',        value: t.carts },
    { label: 'Leads',         sub: 'email captured at checkout',  value: t.leads },
    { label: 'Customers',     sub: 'purchased',                   value: t.uniqueCustomers },
  ];

  const camps = [...block.levels.campaign].sort((a, b) => (b.leads || 0) - (a.leads || 0));
  const totLeads = camps.reduce((s, c) => s + (c.leads || 0), 0);
  const totCust = camps.reduce((s, c) => s + (c.uniqueCustomers || 0), 0);

  const entering = camps.map((c) => ({
    name: c.name, value: c.leads || 0,
    share: totLeads ? (c.leads || 0) / totLeads : 0,
  }));
  const converting = [...camps]
    .sort((a, b) => (b.uniqueCustomers || 0) - (a.uniqueCustomers || 0))
    .map((c) => ({
      name: c.name, value: c.uniqueCustomers || 0,
      share: totCust ? (c.uniqueCustomers || 0) / totCust : 0,
      // Reassigned credit can exceed a campaign's own lead count — hide the
      // ratio rather than show a >100% "conversion rate".
      cvr: c.leads && (c.uniqueCustomers || 0) <= c.leads
        ? ((c.uniqueCustomers || 0) / c.leads) * 100 : null,
    }));

  /* Most common paths across converting customers (illustrative). */
  const paths = [
    { pct: 44, steps: ['Meta prospecting ad', 'Landing page', 'Email opt-in', 'Retargeting ad', 'Booked call', 'Purchase'] },
    { pct: 27, steps: ['Meta ad', 'Landing page', 'Same-day checkout'] },
    { pct: 18, steps: ['Google brand search', 'Reviews page', 'Email opt-in', 'Email click', 'Purchase'] },
    { pct: 11, steps: ['3+ touches, multi-channel', 'Purchase'] },
  ];

  return { stages, entering, converting, paths, avgTouches: 3.4, avgDaysToConvert: 5.2 };
}
