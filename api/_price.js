/**
 * Money on a sale or subscription as the API sends it.
 *
 * The documented `price` object is in the account currency — what the HYROS
 * UI shows — so it wins. The undocumented `usdPrice` is a USD conversion;
 * it is kept as `usdAmount` and used only when `price` is missing.
 * Returns { amount, currency, usdAmount? }.
 */
export function priceOf(x) {
  const usd = x?.usdPrice?.price != null ? Number(x.usdPrice.price) || 0 : null;
  if (x?.price && typeof x.price === 'object' && x.price.price != null) {
    return { amount: Number(x.price.price) || 0, currency: x.price.currency || null, ...(usd !== null ? { usdAmount: usd } : {}) };
  }
  if (usd !== null) return { amount: usd, currency: x.usdPrice.currency || 'USD' };
  return { amount: Number(x?.price) || 0, currency: null };
}
