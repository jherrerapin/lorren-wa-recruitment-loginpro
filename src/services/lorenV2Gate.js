const DEFAULT_RELEASE_DATE = '2026-07-09';

function getReleaseDate() {
  return process.env.LOREN_V2_RELEASE_DATE || DEFAULT_RELEASE_DATE;
}

function hasPanelSession(req = {}) {
  return Boolean(req.userRole || req.role || req.session?.userRole);
}

function isHtmlNavigation(req = {}) {
  if (req.method !== 'GET' || typeof req.accepts !== 'function') return false;
  return Boolean(req.accepts('html'));
}

function renderPanelAccessDenied() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso no disponible</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">
  <style>
    *,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f1f5f9;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column}.topbar{height:54px;background:#1e2d3d;display:flex;align-items:center;padding:0 24px;color:#fff;font-size:14px;font-weight:800;letter-spacing:.01em}.page{flex:1;display:grid;place-items:center;padding:32px 18px}.card{width:min(100%,520px);background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:36px 34px;text-align:center;box-shadow:0 18px 45px rgba(30,45,61,.10)}.icon{width:64px;height:64px;margin:0 auto 20px;border-radius:18px;background:#fff7ed;color:#b45309;display:grid;place-items:center}.icon svg{width:31px;height:31px}h1{margin:0;color:#1e2d3d;font-size:25px;line-height:1.2}.lead{margin:12px auto 0;max-width:390px;color:#475569;font-size:15px;line-height:1.55}.hint{margin:10px auto 0;max-width:400px;color:#64748b;font-size:13px;line-height:1.5}.actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:26px}.btn{min-height:42px;padding:10px 16px;border-radius:9px;text-decoration:none;font-size:13px;font-weight:800;display:inline-flex;align-items:center;justify-content:center}.btn.primary{background:#0d7a6b;color:#fff}.btn.secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}.code{margin-top:22px;color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}@media(max-width:560px){.topbar{padding:0 16px}.page{padding:20px 12px}.card{padding:30px 20px;border-radius:14px}.actions{flex-direction:column}.btn{width:100%}}
  </style>
</head>
<body>
  <header class="topbar">Lórren · Panel administrativo</header>
  <main class="page">
    <section class="card" aria-labelledby="access-title">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><path d="M12 14v2"></path></svg>
      </div>
      <h1 id="access-title">Acceso no disponible</h1>
      <p class="lead">Este módulo no está habilitado para tu perfil.</p>
      <p class="hint">Si consideras que necesitas ingresar, solicita al administrador que revise los permisos de tu usuario.</p>
      <div class="actions">
        <a class="btn primary" href="/admin">Volver al panel</a>
        <a class="btn secondary" href="/logout">Cerrar sesión</a>
      </div>
      <div class="code">Acceso restringido</div>
    </section>
  </main>
</body>
</html>`;
}

function rejectPanelAccess(req, res, message) {
  const authenticated = hasPanelSession(req);
  if (isHtmlNavigation(req) && typeof res.redirect === 'function') {
    if (!authenticated) return res.redirect('/login');
    if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
    return res.status(403).send(renderPanelAccessDenied());
  }
  return res.status(authenticated ? 403 : 401).send(
    authenticated ? message : 'Debes iniciar sesión.'
  );
}

export function isLorenV2Released(now = new Date()) {
  if (process.env.LOREN_V2_ENABLED === 'false') return false;
  const releaseDate = new Date(`${getReleaseDate()}T00:00:00-05:00`);
  return now >= releaseDate;
}

export function canSeeLorenV2(source = {}, now = new Date()) {
  const role = source.userRole || source.role || null;
  const username = source.username || null;
  const scope = source.userAccessScope || source.accessScope || null;
  const canAccessMetaAds = Boolean(
    source.canAccessMetaAds ?? source.session?.canAccessMetaAds
  );
  const canAccessCvAnalysis = Boolean(
    source.canAccessCvAnalysis ?? source.session?.canAccessCvAnalysis
  );

  if (role === 'dev') return true;
  if (role !== 'admin') return false;
  if (username === 'reclutador-general' && scope === 'ALL') {
    return isLorenV2Released(now);
  }
  return (canAccessMetaAds || canAccessCvAnalysis) && isLorenV2Released(now);
}

export function canSeeMetaAds(source = {}, now = new Date()) {
  if (!canSeeLorenV2(source, now)) return false;
  if (canManageLorenV2(source, now)) return true;
  return Boolean(source.canAccessMetaAds ?? source.session?.canAccessMetaAds);
}

export function canSeeCvAnalysis(source = {}, now = new Date()) {
  if (!canSeeLorenV2(source, now)) return false;
  if (canManageLorenV2(source, now)) return true;
  return Boolean(source.canAccessCvAnalysis ?? source.session?.canAccessCvAnalysis);
}

export function canManageLorenV2(source = {}, now = new Date()) {
  const role = source.userRole || source.role || null;
  const username = source.username || null;
  const scope = source.userAccessScope || source.accessScope || null;

  if (role === 'dev') return true;
  return role === 'admin'
    && username === 'reclutador-general'
    && scope === 'ALL'
    && isLorenV2Released(now);
}

export function requireLorenV2(req, res, next) {
  if (!canSeeLorenV2(req)) {
    return rejectPanelAccess(req, res, 'Modulo no disponible para este perfil.');
  }
  return next();
}

export function requireMetaAds(req, res, next) {
  if (!canSeeMetaAds(req)) {
    return rejectPanelAccess(req, res, 'No tienes permiso para consultar Meta Ads.');
  }
  return next();
}

export function requireCvAnalysis(req, res, next) {
  if (!canSeeCvAnalysis(req)) {
    return rejectPanelAccess(req, res, 'No tienes permiso para analizar hojas de vida.');
  }
  return next();
}

export function requireLorenV2Write(req, res, next) {
  if (!canManageLorenV2(req)) {
    return rejectPanelAccess(req, res, 'Este perfil solo puede consultar Estadísticas.');
  }
  return next();
}
