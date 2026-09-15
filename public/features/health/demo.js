/**
 * Demo block for Tracking Health — the shape server.js produces, with every
 * check completed (`checks.*.status === 'ok'`) so the view's happy path is
 * exercised on the Demo account. Fixed values, no clock beyond today's date
 * (like the Scale demo), so two runs are byte-identical.
 */
import { ymd } from '../../demo.js';

export function demo() {
  return {
    checkedAt: `${ymd(new Date())}T08:00:00.000Z`,
    domains: ['scale-ecom.com', 'shop.scale-ecom.com', 'go.scale-ecom.com'],
    scripts: {
      'https://scale-ecom.com/': 'SCRIPT_FOUND',
      'https://shop.scale-ecom.com/': 'SCRIPT_FOUND',
      'https://go.scale-ecom.com/': 'SCRIPT_NOT_FOUND',
    },
    trackingParams: [{
      type: 'SEARCH',
      rows: [
        { adName: 'Brand Exact — RSA 1', valid: true },
        { adName: 'Brand + Reviews — RSA 2', valid: true },
        { adName: 'Category Exact — RSA 4', valid: false, missing: ['gclid'] },
      ],
    }, { type: 'PERFORMANCE_MAX', rows: [{ adName: 'PMax — Best Sellers', valid: true }] }],
    errors: [],
    checks: {
      domains: { status: 'ok', ms: 412 },
      params: { status: 'ok', ms: 1730, channels: { SEARCH: 'ok', PERFORMANCE_MAX: 'ok' } },
      script: { status: 'ok', ms: 21880 },
    },
  };
}
