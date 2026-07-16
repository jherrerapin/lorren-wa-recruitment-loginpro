const DEFAULT_RELEASE_DATE = '2026-07-09';

function getReleaseDate() {
  return process.env.LOREN_V2_RELEASE_DATE || DEFAULT_RELEASE_DATE;
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
    return res.status(403).send('Modulo no disponible para este perfil.');
  }
  return next();
}

export function requireMetaAds(req, res, next) {
  if (!canSeeMetaAds(req)) {
    return res.status(403).send('No tienes permiso para consultar Meta Ads.');
  }
  return next();
}

export function requireCvAnalysis(req, res, next) {
  if (!canSeeCvAnalysis(req)) {
    return res.status(403).send('No tienes permiso para analizar hojas de vida.');
  }
  return next();
}

export function requireLorenV2Write(req, res, next) {
  if (!canManageLorenV2(req)) {
    return res.status(403).send('Este perfil solo puede consultar Estadísticas.');
  }
  return next();
}
