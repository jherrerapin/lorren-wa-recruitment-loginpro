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
  const canAccessStatistics = Boolean(
    source.canAccessStatistics ?? source.session?.canAccessStatistics
  );

  if (role === 'dev') return true;
  if (canAccessStatistics) return isLorenV2Released(now);
  if (username === 'reclutador-general' && scope === 'ALL') {
    return isLorenV2Released(now);
  }
  return false;
}

export function requireLorenV2(req, res, next) {
  if (!canSeeLorenV2(req)) {
    return res.status(403).send('Modulo no disponible para este perfil.');
  }
  return next();
}
