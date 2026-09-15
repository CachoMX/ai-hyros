/** Demo block for Tracking Health. */
export function demo() {
  return {
    checkedAt: new Date().toISOString(),
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
  };
}
