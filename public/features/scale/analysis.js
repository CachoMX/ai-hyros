export const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const positive = (value) => finite(value) && value > 0;

export function observedPoints(curve) {
  return (Array.isArray(curve?.points) ? curve.points : []).filter((point) => finite(point?.spend) && point.spend >= 0)
    .slice().sort((a, b) => a.spend - b.spend);
}

export function attributionRole(model) {
  const value = String(model || '').toUpperCase();
  if (['FIRST_CLICK', 'FIRST_CLICK_UNIQUE'].includes(value)) return 'Acquisition credit';
  if (['LAST_CLICK', 'LAST_CLICK_UNIQUE'].includes(value)) return 'Closing credit';
  return value ? 'Other attribution credit' : 'Attribution model unavailable';
}

/** Compare one observed bucket without interpolating outcomes or projecting spend. */
export function historicalScenario(curve, index = 0, userCeiling = null) {
  const points = observedPoints(curve);
  const bucket = points[Number.isInteger(index) && index >= 0 ? index : 0] || null;
  const ceiling = positive(userCeiling) ? userCeiling : positive(curve?.ceiling) ? curve.ceiling : null;
  const metric = finite(bucket?.marginalCac) ? bucket.marginalCac : null;
  return { bucket, ceiling, source: positive(userCeiling) ? 'local comparison' : 'HYROS ceiling',
    status: !bucket ? 'unavailable' : ceiling === null || metric === null ? 'unknown' : metric > ceiling ? 'above' : 'within' };
}

export function curveAssessment(curve, userCeiling = null) {
  if (curve?.stale) return { cls: '', text: 'Previous curve; current check incomplete' };
  if (curve?.error) return { cls: 'bad', text: 'Curve unavailable' };
  if (curve?.skipped) return { cls: '', text: `Skipped: ${curve.skipped}` };
  const points = observedPoints(curve);
  if (!points.length) return { cls: '', text: 'No observed curve points' };
  const ceiling = positive(userCeiling) ? userCeiling : positive(curve.ceiling) ? curve.ceiling : null;
  if (ceiling === null) return { cls: '', text: 'No CAC ceiling; efficiency unassessed' };
  const comparable = points.filter((p) => finite(p.marginalCac));
  if (!comparable.length) return { cls: '', text: 'Marginal CAC unavailable' };
  if (comparable.some((p) => p.marginalCac > ceiling)) return { cls: 'bad', text: 'Observed marginal CAC exceeds the ceiling' };
  if (points.length < 2 || comparable.length < points.length - 1 || (curve.notes || []).length) return { cls: '', text: 'Partial evidence; no scale conclusion' };
  return { cls: '', text: 'Observed marginal CAC within ceiling; future response unknown' };
}
