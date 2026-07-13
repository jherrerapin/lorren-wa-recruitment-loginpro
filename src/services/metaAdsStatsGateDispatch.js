import { metaAdsStatsRouter } from '../routes/metaAdsStats.js';

const routersByPrisma = new WeakMap();
const STATS_CAMPAIGNS_PREFIX = '/admin/estadisticas/campaigns';

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function routerFor(prisma) {
  if (!routersByPrisma.has(prisma)) {
    routersByPrisma.set(prisma, metaAdsStatsRouter(prisma));
  }
  return routersByPrisma.get(prisma);
}

export function dispatchMetaAdsStatsIfApplicable(req, res, next) {
  if (!requestPath(req).startsWith(STATS_CAMPAIGNS_PREFIX)) return next();
  if (!req.prisma) return next();
  return routerFor(req.prisma)(req, res, next);
}

export default dispatchMetaAdsStatsIfApplicable;
