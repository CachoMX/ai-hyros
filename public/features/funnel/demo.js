/**
 * Demo block for the Funnel & Journey feature. Pure function of the demo
 * snapshot: ranges → stages / entering / converting. Deterministic.
 */
export function demo(snapshot) {
  const block = snapshot.ranges['30d'];
  const t = block.totals;

  const stages = [
    { label: 'Ad Clicks',     sub: 'tracked visitors from ads',   value: t.clicks,          unit: 'ad click' },
    { label: 'Added to Cart', sub: 'product intent shown',        value: t.carts,           unit: 'add to cart' },
    { label: 'Leads',         sub: 'email captured at checkout',  value: t.leads,           unit: 'lead' },
    { label: 'Customers',     sub: 'purchased',                   value: t.uniqueCustomers, unit: 'customer' },
  ];

  // Order value at the end of the funnel, NET of refunds, then weighed
  // against every stage above it (the add-to-cart figure is the one that
  // prices a cart for an ecom buyer). Orders = sales; refunds come off the
  // gross before any per-unit figure is derived.
  const orders = t.sales || 0;
  const gross = t.revenue || 0;
  const refunds = t.refund || 0;
  const net = Math.max(0, gross - refunds);
  const per = (n) => (n ? net / n : null);
  const value = {
    orders, gross, refunds, refundCount: t.refundCount || 0, net,
    aovGross: orders ? gross / orders : null,
    aov: per(orders),
    perClick: per(t.clicks), perCart: per(t.carts), perLead: per(t.leads), perCustomer: per(t.uniqueCustomers),
  };
  for (const s of stages) s.netPer = per(s.value);

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

  return { stages, value, entering, converting, paths, avgTouches: 3.4, avgDaysToConvert: 5.2 };
}
