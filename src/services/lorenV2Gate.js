const DEFAULT_RELEASE_DATE = '2026-07-09';

function getReleaseDate() {
  return process.env.LOREN_V2_RELEASE_DATE || DEFAULT_RELEASE_DATE;
}

function hasPanelSession(req = {}) {
  return Boolean(req.userRole || req.role || req.session?.userRole);
}

function rejectPanelAccess(req, res, message) {
  const authenticated = hasPanelSession(req);
  return res.status(authenticated ? 403 : 401).send(
    authenticated ? message : 'Debes iniciar sesión.'
  );
}

function panelRole(source = {}) {
  return String(source.userRole || source.role || source.session?.userRole || '').trim().toLowerCase();
}

function operationalRole(source = {}) {
  return String(source.operationalRole || source.session?.operationalRole || '').trim().toUpperCase();
}

function metaAdsAllowed(source = {}) {
  return Boolean(source.canAccessMetaAds ?? source.session?.canAccessMetaAds);
}

function cvAnalysisAllowed(source = {}) {
  return Boolean(source.canAccessCvAnalysis ?? source.session?.canAccessCvAnalysis);
}

export function isLorenV2Released(now = new Date()) {
  if (process.env.LOREN_V2_ENABLED === 'false') return false;
  const releaseDate = new Date(`${getReleaseDate()}T00:00:00-05:00`);
  return now >= releaseDate;
}

export function canSeeLorenV2(source = {}, now = new Date()) {
  const role = panelRole(source);
  if (role === 'dev') return true;
  if (role !== 'admin' || !isLorenV2Released(now)) return false;
  return metaAdsAllowed(source) || cvAnalysisAllowed(source);
}

export function canSeeMetaAds(source = {}, now = new Date()) {
  if (panelRole(source) === 'dev') return true;
  return canSeeLorenV2(source, now) && metaAdsAllowed(source);
}

export function canSeeCvAnalysis(source = {}, now = new Date()) {
  if (panelRole(source) === 'dev') return true;
  return canSeeLorenV2(source, now) && cvAnalysisAllowed(source);
}

export function canManageLorenV2(source = {}, now = new Date()) {
  const role = panelRole(source);
  if (role === 'dev') return true;
  return role === 'admin'
    && operationalRole(source) === 'SUPERVISOR'
    && (metaAdsAllowed(source) || cvAnalysisAllowed(source))
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
