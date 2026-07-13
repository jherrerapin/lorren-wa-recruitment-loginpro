import { metaAdsStatsRouter } from '../routes/metaAdsStats.js';

const routersByPrisma = new WeakMap();
const STATS_CAMPAIGNS_PREFIX = '/admin/estadisticas/campaigns';
const META_AD_DETAIL_PATH = /^\/admin\/estadisticas\/campaigns\/[^/]+$/;

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function routerFor(prisma) {
  if (!routersByPrisma.has(prisma)) {
    routersByPrisma.set(prisma, metaAdsStatsRouter(prisma));
  }
  return routersByPrisma.get(prisma);
}

export function stripListFiltersFromMetaAdDetail(req = {}) {
  if (String(req.method || '').toUpperCase() !== 'GET') return false;
  if (!META_AD_DETAIL_PATH.test(requestPath(req))) return false;

  let removed = false;
  const rawUrl = String(req.url || '');
  const separatorIndex = rawUrl.indexOf('?');
  const pathname = separatorIndex >= 0 ? rawUrl.slice(0, separatorIndex) : rawUrl;
  const rawQuery = separatorIndex >= 0 ? rawUrl.slice(separatorIndex + 1) : '';
  const params = new URLSearchParams(rawQuery);

  for (const key of ['city', 'vacancyId']) {
    if (params.has(key)) removed = true;
    params.delete(key);
    if (req.query && typeof req.query === 'object' && Object.hasOwn(req.query, key)) {
      delete req.query[key];
      removed = true;
    }
  }

  const cleanQuery = params.toString();
  req.url = cleanQuery ? `${pathname}?${cleanQuery}` : pathname;
  return removed;
}

export function dispatchMetaAdsStatsIfApplicable(req, res, next) {
  if (!requestPath(req).startsWith(STATS_CAMPAIGNS_PREFIX)) return next();
  if (!req.prisma) return next();
  stripListFiltersFromMetaAdDetail(req);
  return routerFor(req.prisma)(req, res, next);
}

export default dispatchMetaAdsStatsIfApplicable;
