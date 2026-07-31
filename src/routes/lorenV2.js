import express from 'express';
import {
  canSeeCvAnalysis,
  canSeeMetaAds,
  requireLorenV2,
  requireMetaAds
} from '../services/lorenV2Gate.js';
import { metaAdsStatsRouter } from './metaAdsStats.js';

function renderStatisticsHub(req = {}) {
  const metaAdsLink = canSeeMetaAds(req)
    ? '<a href="/admin/estadisticas/campaigns">Meta Ads</a>'
    : '';
  const cvAnalysisLink = canSeeCvAnalysis(req)
    ? '<a href="/admin/estadisticas/cv-analysis">Análisis HV</a>'
    : '';
  const metaAdsCard = canSeeMetaAds(req)
    ? `<a href="/admin/estadisticas/campaigns" class="hub-card">
        <div class="hub-card-icon">📣</div>
        <div class="hub-card-title">Meta Ads</div>
        <div class="hub-card-desc">Inversión, resultados del proceso y costo promedio por resultado.</div>
      </a>`
    : '';
  const cvAnalysisCard = canSeeCvAnalysis(req)
    ? `<a href="/admin/estadisticas/cv-analysis" class="hub-card">
        <div class="hub-card-icon">🧠</div>
        <div class="hub-card-title">Análisis de hojas de vida</div>
        <div class="hub-card-desc">Organiza candidatos según la vacante y el perfil que estás buscando.</div>
      </a>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Estadísticas</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #1a1d23; font-size: 14px; }
    .navbar { background: #1e2d3d; padding: 0 24px; display: flex; align-items: center; gap: 8px; height: 52px; border-bottom: 1px solid #0f1a26; }
    .navbar a { color: #94a3b8; text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 10px; border-radius: 6px; transition: all .15s; }
    .navbar a:hover, .navbar a.active { color: #fff; background: rgba(255,255,255,.08); }
    .navbar .sep { color: #334155; font-size: 16px; }
    .navbar .spacer { flex: 1; }
    .page { max-width: 960px; margin: 0 auto; padding: 40px 20px 60px; }
    h1 { font-size: 22px; font-weight: 800; color: #1e2d3d; margin-bottom: 6px; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 36px; }
    .hub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .hub-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px 20px; text-decoration: none; color: #1a1d23; transition: box-shadow .15s, border-color .15s; display: flex; flex-direction: column; gap: 8px; }
    .hub-card:hover { border-color: #0d7a6b; box-shadow: 0 4px 16px rgba(13,122,107,.12); }
    .hub-card-icon { font-size: 28px; }
    .hub-card-title { font-size: 15px; font-weight: 700; color: #1e2d3d; }
    .hub-card-desc { font-size: 12px; color: #64748b; line-height: 1.5; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/admin">Panel</a>
    <span class="sep">›</span>
    <a href="/admin/estadisticas" class="active">Estadísticas</a>
    ${metaAdsLink}
    ${cvAnalysisLink}
    <span class="spacer"></span>
    <a href="/logout">Cerrar sesión</a>
  </nav>
  <main class="page">
    <h1>Estadísticas — Centro de inteligencia de Lórren</h1>
    <p class="subtitle">Elige la herramienta que necesitas para revisar resultados o candidatos.</p>
    <div class="hub-grid">
      ${metaAdsCard}
      ${cvAnalysisCard}
    </div>
  </main>
</body>
</html>`;
}

export function lorenV2Router(prisma, dependencies = {}) {
  const router = express.Router();

  router.use((req, _res, next) => {
    req.prisma = req.prisma || prisma;
    next();
  });

  router.get('/', requireLorenV2, (req, res) => {
    res.send(renderStatisticsHub(req));
  });

  router.use(requireMetaAds, metaAdsStatsRouter(prisma, dependencies));
  return router;
}

export default lorenV2Router;
