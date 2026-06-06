const ROLE_STOPWORDS = new Set([
  'a', 'al', 'ante', 'aplicar', 'aplicando', 'aplicarme', 'aplico', 'ayuda',
  'buen', 'buena', 'buenas', 'cargo', 'con', 'continuar', 'cual', 'cuales',
  'cuanto', 'de', 'del', 'desde', 'deseo', 'el', 'en', 'es', 'esa', 'ese',
  'esta', 'estoy', 'favor', 'gracias', 'hola', 'informacion', 'interesa',
  'interesada', 'interesado', 'la', 'las', 'loginpro', 'los', 'me', 'mi',
  'necesito', 'para', 'por', 'postular', 'postularme', 'puesto', 'que',
  'quiero', 'rol', 'seria', 'solicito', 'su', 'trabajar', 'trabajo', 'una',
  'uno', 'vacante', 'y', 'ubico', 'ubicado', 'ubicada', 'escribo', 'municipio',
  'encuentro', 'espera', 'si', 'sii', 'sip', 'sipi', 'ok', 'okay',
  'vale', 'listo', 'correcto', 'bueno', 'bn', 'perfecto', 'confirmo', 'te',
  'cundinamarca', 'tolima', 'bogota', 'ibague', 'funza', 'mosquera', 'madrid', 'siberia',
  'facebook', 'faceb', 'face', 'canal', 'watsap', 'whatsapp', 'anuncio', 'publicaron',
  'publicada', 'publicado', 'empleo', 'oferta', 'averiguar', 'informarme', 'quisiera',
  'vivo', 'vive', 'vives', 'vivir', 'ciudad', 'numero', 'dieron', 'este'
]);

const CITY_ALIASES = [
  { value: 'Bogota', aliases: ['bogota'] },
  { value: 'Ibague', aliases: ['ibague'] }
];

const OPERATION_ZONE_ALIASES = [
  { key: 'siberia', aliases: ['siberia'] },
  { key: 'funza', aliases: ['funza'] },
  { key: 'mosquera', aliases: ['mosquera'] },
  { key: 'madrid', aliases: ['madrid'] },
  { key: 'calle 80', aliases: ['calle 80'] },
  { key: 'tenjo', aliases: ['tenjo'] },
  { key: 'la punta', aliases: ['la punta'] },
  { key: 'el rosal', aliases: ['el rosal'] },
  { key: 'villas de granada', aliases: ['villas de granada', 'villa de granada'] },
  { key: 'suba', aliases: ['suba'] },
  { key: 'engativa', aliases: ['engativa'] }
];

const DOMAIN_ROLE_TOKENS = [
  'auxiliar', 'cargue', 'descargue', 'bodega', 'operario', 'operativo', 'operaciones',
  'mensajero', 'conductor', 'coordinador', 'lider', 'logistica', 'ruta', 'maquila',
  'empaque', 'produccion', 'planta', 'picking', 'packing', 'alistamiento', 'servicios',
  'general', 'montacarga', 'administrativo'
];

const ROLE_SIGNAL_REGEX = /\b(aux|auxiliar|cargue|carge|cargar|cargando|descargue|descarge|descargar|descargando|bodega|bidega|operari|operativo|operativa|mensajer|conductor|coordinador|coordinadora|lider|lideres|logistic|logistica|logistico|operacion|operaciones|ruta|cargo|vacante|puesto|rol|maquila|empaque|produccion|planta|picking|packing|alistamiento|servicio|servicios|general|generales|montacarg|administrativ|jefe|supervisor|optacion|optaciones)\b/i;
const SPECIFIC_ROLE_TOKEN_REGEX = /^(aux|auxiliar|cargue|cargar|descargue|descargar|bodega|operari|operativo|operativa|operaciones|mensajer|mensajero|conductor|coordinador|coordinadora|logistic|logistica|logistico|ruta|analista|supervisor|lider|jefe|asesor|comercial|mantenimiento|produccion|servicio|servicios|montacarg|administrativ|maquila|empaque|planta|picking|packing|alistamiento|general)/i;
const GENERIC_ROLE_HINT_TOKENS = new Set(['trabajo', 'empleo', 'vacante', 'cargo', 'informacion', 'trabajar', 'puesto', 'rol']);

export function normalizeResolverText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  return normalizeResolverText(text).split(' ').filter(Boolean);
}

function editDistance(a = '', b = '') {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[left.length][right.length];
}

function fuzzyDomainToken(token = '') {
  const normalized = normalizeResolverText(token);
  if (!normalized || normalized.length < 5) return normalized;
  let best = { token: normalized, distance: Infinity };
  for (const domainToken of DOMAIN_ROLE_TOKENS) {
    const distance = editDistance(normalized, domainToken);
    if (distance < best.distance) best = { token: domainToken, distance };
  }
  const maxDistance = normalized.length >= 9 ? 3 : 2;
  if (best.distance <= maxDistance) return best.token;
  return normalized;
}

function normalizeRoleToken(token = '') {
  const normalized = fuzzyDomainToken(token);
  if (!normalized) return '';
  if (/^carg(?:e|ue|ar|ando)$/.test(normalized)) return 'cargue';
  if (/^descarg(?:e|ue|ar|ando)$/.test(normalized)) return 'descargue';
  if (/^aux$/.test(normalized)) return 'auxiliar';
  if (/^bideg[ae]$/.test(normalized)) return 'bodega';
  if (/^bodegas?$/.test(normalized)) return 'bodega';
  if (/^(operativ[ao]s?|operaciones?|operacion|logistic[ao]s?|optaciones?)$/.test(normalized)) return 'operaciones';
  if (/^coordinadoras?$/.test(normalized)) return 'coordinador';
  if (/^lideres?$/.test(normalized)) return 'lider';
  if (/^mensajer[oa]s?$/.test(normalized)) return 'mensajero';
  if (/^maquil/.test(normalized)) return 'maquila';
  if (/^empac/.test(normalized)) return 'empaque';
  if (/^producc/.test(normalized)) return 'produccion';
  return normalized;
}

function canonicalVacancyCity(vacancy) {
  return vacancy?.operation?.city?.name || vacancy?.city || null;
}

function buildVacancyLocationText(vacancy) {
  return normalizeResolverText([
    canonicalVacancyCity(vacancy),
    vacancy?.city,
    vacancy?.title,
    vacancy?.role,
    vacancy?.operation?.name,
    vacancy?.operationAddress
  ].filter(Boolean).join(' '));
}

function buildVacancyRoleText(vacancy) {
  return [vacancy?.title, vacancy?.role, vacancy?.roleDescription, vacancy?.operation?.name, vacancy?.operationAddress]
    .filter(Boolean)
    .join(' ');
}

function buildVacancyFunctionalText(vacancy) {
  return [vacancy?.roleDescription, vacancy?.requirements, vacancy?.conditions, vacancy?.requiredDocuments, vacancy?.operationAddress, vacancy?.operation?.name]
    .filter(Boolean)
    .join(' ');
}

export function detectOperationZoneEvidence(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return [];
  const padded = ` ${normalized} `;
  return OPERATION_ZONE_ALIASES
    .filter((entry) => entry.aliases.some((alias) => padded.includes(` ${normalizeResolverText(alias)} `)))
    .map((entry) => entry.key);
}

function cityMatchesVacancy(vacancy, requestedCity = '') {
  const normalizedRequestedCity = normalizeResolverText(requestedCity);
  const normalizedVacancyCity = normalizeResolverText(canonicalVacancyCity(vacancy));
  if (!normalizedRequestedCity) return true;
  return normalizedVacancyCity === normalizedRequestedCity;
}

function zoneMatchesVacancy(vacancy, zones = []) {
  if (!zones.length) return false;
  const vacancyLocationText = buildVacancyLocationText(vacancy);
  return zones.some((zone) => vacancyLocationText.includes(normalizeResolverText(zone)));
}

function isVacancyOpen(vacancy) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function buildCityNames(vacancies = []) {
  return Array.from(new Set(vacancies.map(canonicalVacancyCity).filter(Boolean)));
}

export function detectCityFromText(text = '', cityNames = []) {
  const normalized = normalizeResolverText(text);
  if (!normalized) return null;
  const padded = ` ${normalized} `;
  let bestMatch = null;
  for (const cityName of cityNames) {
    const cityNormalized = normalizeResolverText(cityName);
    if (!cityNormalized) continue;
    if (padded.includes(` ${cityNormalized} `) && (!bestMatch || cityNormalized.length > bestMatch.normalized.length)) {
      bestMatch = { value: cityName, normalized: cityNormalized };
    }
  }
  if (bestMatch?.value) return bestMatch.value;
  for (const entry of CITY_ALIASES) {
    if (entry.aliases.some((alias) => padded.includes(` ${normalizeResolverText(alias)} `))) return entry.value;
  }
  return null;
}

function cleanRoleTokens(tokens = [], cityTokens = new Set()) {
  return tokens
    .map((token) => normalizeRoleToken(token))
    .filter((token) => token && token.length > 1 && !ROLE_STOPWORDS.has(token) && !cityTokens.has(token));
}

function normalizeRoleHint(value = '', city = '') {
  const cityTokens = new Set(tokenize(city));
  const tokens = cleanRoleTokens(tokenize(value), cityTokens);
  if (!tokens.length) return null;
  if (tokens.every((token) => GENERIC_ROLE_HINT_TOKENS.has(token))) return null;
  const specificTokens = tokens.filter((token) => SPECIFIC_ROLE_TOKEN_REGEX.test(token));
  if (!specificTokens.length) return null;
  return [...new Set(specificTokens)].join(' ');
}

function splitMeaningfulSegments(text = '') {
  return String(text || '').split(/[\n,;]+/).map((segment) => normalizeResolverText(segment)).filter(Boolean);
}

export function detectRoleHintFromText(text = '', options = {}) {
  const normalized = normalizeResolverText(text);
  if (!normalized) return null;
  const cityTokens = new Set(tokenize(options.city || ''));
  const segments = splitMeaningfulSegments(text);
  const preferredSegments = segments.filter((segment) => ROLE_SIGNAL_REGEX.test(segment));
  if (preferredSegments.length) {
    const preferredTokens = preferredSegments.flatMap((segment) => cleanRoleTokens(tokenize(segment), cityTokens));
    const preferredRoleHint = preferredTokens.length ? normalizeRoleHint(preferredTokens.join(' '), options.city || '') : null;
    if (preferredRoleHint) return preferredRoleHint;
  }
  const explicitPatterns = [
    /\b(?:vacante|cargo|rol|puesto)\s+(?:de|para)?\s*([a-z0-9 ]{3,80})/i,
    /\b(?:quiero aplicar(?: a)?|quiero postularme(?: a)?|me interesa(?: la)?|estoy interesad[oa] en(?: la)?|informacion(?: de)?(?: la)?|para)\s+(?:vacante|cargo|rol|puesto)?\s*(?:de|para)?\s*([a-z0-9 ]{3,80})/i
  ];
  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const roleTokens = cleanRoleTokens(tokenize(match[1]), cityTokens);
    if (roleTokens.length) return normalizeRoleHint(roleTokens.join(' '), options.city || '');
  }
  if (ROLE_SIGNAL_REGEX.test(normalized)) {
    const roleTokens = cleanRoleTokens(tokenize(normalized), cityTokens);
    return roleTokens.length ? normalizeRoleHint(roleTokens.join(' '), options.city || '') : null;
  }
  return null;
}

function similarityScore(input = '', candidate = '') {
  const inputTokens = cleanRoleTokens(tokenize(input));
  const candidateTokens = cleanRoleTokens(tokenize(candidate));
  if (!inputTokens.length || !candidateTokens.length) return 0;
  const inputSet = new Set(inputTokens);
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of inputSet) if (candidateSet.has(token)) overlap += 1;
  if (!overlap) return 0;
  const inputNormalized = normalizeResolverText(inputTokens.join(' '));
  const candidateNormalized = normalizeResolverText(candidateTokens.join(' '));
  let score = overlap / Math.max(inputSet.size, candidateSet.size);
  if (candidateNormalized === inputNormalized) score += 0.9;
  else if (candidateNormalized.includes(inputNormalized) || inputNormalized.includes(candidateNormalized)) score += 0.45;
  return score;
}

function scoreVacancyRole(vacancy, { text, roleHint }) {
  const vacancyText = buildVacancyRoleText(vacancy);
  const functionalText = buildVacancyFunctionalText(vacancy);
  const normalizedText = normalizeResolverText(text);
  const normalizedTitle = normalizeResolverText(vacancy?.title || '');
  const normalizedRole = normalizeResolverText(vacancy?.role || '');
  let score = 0;
  if (roleHint) {
    score += similarityScore(roleHint, vacancyText) * 6;
    score += similarityScore(roleHint, functionalText) * 4;
  } else {
    score += similarityScore(text, vacancyText) * 3;
    score += similarityScore(text, functionalText) * 2;
  }
  if (normalizedTitle && normalizedText.includes(normalizedTitle)) score += 2;
  if (normalizedRole && normalizedText.includes(normalizedRole)) score += 2;
  return score;
}

function scoreVacancy(vacancy, { text, city, roleHint, operationZones = [] }) {
  let score = 0;
  if (city) {
    if (!cityMatchesVacancy(vacancy, city)) return -1;
    score += 4;
  }
  if (operationZones.length && zoneMatchesVacancy(vacancy, operationZones)) score += 3;
  score += scoreVacancyRole(vacancy, { text, roleHint });
  return score;
}

export async function findActiveVacancies(prisma) {
  return prisma.vacancy.findMany({
    where: { isActive: true, acceptingApplications: true },
    include: { operation: { include: { city: true } } },
    orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }]
  });
}

export async function findAllVacancies(prisma) {
  return prisma.vacancy.findMany({
    include: { operation: { include: { city: true } } },
    orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }]
  });
}

function pickBestVacancyMatch(vacancies = [], context = {}) {
  if (!vacancies.length) return null;
  const scored = vacancies
    .map((vacancy) => ({ vacancy, score: scoreVacancy(vacancy, context), roleScore: scoreVacancyRole(vacancy, context) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  const runnerUp = scored[1] || null;
  return { best, runnerUp, margin: best ? (runnerUp ? best.score - runnerUp.score : best.score) : 0 };
}

function roleEvidenceThreshold(roleHint = '') {
  const tokenCount = roleHint ? cleanRoleTokens(tokenize(roleHint)).length : 0;
  if (!tokenCount) return 0;
  return tokenCount >= 2 ? 2.8 : 2.2;
}

function hasEnoughRoleEvidence(match, roleHint = '') {
  if (!roleHint) return true;
  return Boolean(match?.best && match.best.roleScore >= roleEvidenceThreshold(roleHint));
}

function roleHintTokens(roleHint = '') {
  return cleanRoleTokens(tokenize(roleHint));
}

function isGenericInactiveRoleHint(roleHint = '') {
  const tokens = roleHintTokens(roleHint);
  if (!tokens.length) return true;
  const tokenSet = new Set(tokens);
  const genericGroups = [
    ['auxiliar'], ['bodega'], ['auxiliar', 'bodega'], ['cargue'], ['descargue'],
    ['cargue', 'descargue'], ['auxiliar', 'cargue'], ['auxiliar', 'descargue'],
    ['auxiliar', 'cargue', 'descargue'], ['operaciones'], ['operativo'], ['operario']
  ];
  return genericGroups.some((group) => group.length === tokens.length && group.every((token) => tokenSet.has(token)));
}

function hasExactNormalizedPhrase(text = '', phrase = '') {
  const normalizedText = ` ${normalizeResolverText(text)} `;
  const normalizedPhrase = normalizeResolverText(phrase);
  return Boolean(normalizedPhrase && normalizedText.includes(` ${normalizedPhrase} `));
}

function hasSpecificInactiveVacancyEvidence({ text = '', vacancy = null, city = null, roleHint = '', operationZones = [], roleScore = 0 } = {}) {
  if (!vacancy) return false;
  if (zoneMatchesVacancy(vacancy, operationZones)) return true;
  const operationName = vacancy?.operation?.name;
  if (operationName && hasExactNormalizedPhrase(text, operationName)) return true;
  const title = vacancy?.title || '';
  if (title && hasExactNormalizedPhrase(text, title)) return true;
  const vacancyCityText = normalizeResolverText(canonicalVacancyCity(vacancy));
  const requestedCityText = normalizeResolverText(city);
  if (requestedCityText && vacancyCityText && requestedCityText !== vacancyCityText) return false;
  return Boolean(roleHint && !isGenericInactiveRoleHint(roleHint) && roleScore >= roleEvidenceThreshold(roleHint));
}

function canUseInactiveMatch(inactiveMatch, context = {}) {
  return Boolean(
    inactiveMatch?.best?.vacancy
    && inactiveMatch.best.score >= context.threshold
    && context.inactiveHasRoleEvidence
    && hasSpecificInactiveVacancyEvidence({
      text: context.text,
      vacancy: inactiveMatch.best.vacancy,
      city: context.city,
      roleHint: context.roleHint,
      operationZones: context.operationZones,
      roleScore: inactiveMatch.best.roleScore
    })
  );
}

function baseVacancyResolution(overrides = {}) {
  return { vacancy: null, requiresRelocation: false, ambiguous: false, options: [], ...overrides };
}

function vacancyImpliesSiberiaRelocation(vacancy, requestedCity = '') {
  const locationText = buildVacancyLocationText(vacancy);
  if (!locationText.includes('siberia')) return false;
  const normalizedRequestedCity = normalizeResolverText(requestedCity);
  const normalizedVacancyCity = normalizeResolverText(canonicalVacancyCity(vacancy));
  return Boolean(!normalizedRequestedCity || normalizedRequestedCity !== 'siberia' || normalizedVacancyCity !== 'siberia');
}

function rankVacanciesByIntent(vacancies = [], context = {}) {
  return vacancies
    .map((vacancy) => ({ vacancy, score: scoreVacancyRole(vacancy, context) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

function selectVacancyFromRanked(ranked = [], requestedCity = '') {
  if (!ranked.length) return baseVacancyResolution();
  const best = ranked[0];
  const matchingBestOptions = ranked.filter((entry) => Math.abs(entry.score - best.score) < 0.75).map((entry) => entry.vacancy);
  if (matchingBestOptions.length > 1) return baseVacancyResolution({ ambiguous: true, options: matchingBestOptions });
  return baseVacancyResolution({ vacancy: best.vacancy, requiresRelocation: vacancyImpliesSiberiaRelocation(best.vacancy, requestedCity) });
}

export function resolveVacancy(city, intentText, availableVacancies = []) {
  const requestedCity = normalizeResolverText(city);
  if (!requestedCity || !Array.isArray(availableVacancies) || !availableVacancies.length) return baseVacancyResolution();
  const cityVacancies = availableVacancies.filter((vacancy) => cityMatchesVacancy(vacancy, city));
  if (!cityVacancies.length) return baseVacancyResolution();
  const roleHint = normalizeRoleHint(detectRoleHintFromText(intentText, { city }) || intentText, city);
  const context = { text: intentText, city, roleHint, operationZones: detectOperationZoneEvidence(intentText) };
  const activeMatches = rankVacanciesByIntent(cityVacancies.filter(isVacancyOpen), context);
  const activeResolution = selectVacancyFromRanked(activeMatches, city);
  if (activeResolution.vacancy || activeResolution.ambiguous) return activeResolution;
  const inactiveMatches = rankVacanciesByIntent(cityVacancies.filter((vacancy) => !isVacancyOpen(vacancy)), context);
  return selectVacancyFromRanked(inactiveMatches, city);
}

export async function resolveVacancyFromText(prisma, text, options = {}) {
  const normalizedText = normalizeResolverText(text);
  if (!normalizedText) return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'empty_input' };
  const allVacancies = options.allVacancies || options.vacancies || await findAllVacancies(prisma);
  const activeVacancies = options.activeVacancies || options.vacancies || allVacancies.filter(isVacancyOpen);
  if (!allVacancies.length) return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'no_vacancies_configured' };

  const city = options.cityHint || detectCityFromText(text, buildCityNames(allVacancies));
  const operationZones = detectOperationZoneEvidence(text);
  const roleHint = normalizeRoleHint(options.roleHint || detectRoleHintFromText(text, { city }), city);
  if (!city && !roleHint) return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'missing_city_and_role' };

  const matchingCityVacancies = city ? activeVacancies.filter((vacancy) => cityMatchesVacancy(vacancy, city)) : activeVacancies;
  const inactiveVacancies = allVacancies.filter((vacancy) => !isVacancyOpen(vacancy));
  const inactiveCityVacancies = city ? inactiveVacancies.filter((vacancy) => cityMatchesVacancy(vacancy, city)) : inactiveVacancies;
  const roleTokenCount = roleHint ? cleanRoleTokens(tokenize(roleHint)).length : 0;
  const hasExplicitOperationZone = operationZones.length > 0;
  const threshold = hasExplicitOperationZone ? 3 : (roleHint ? (roleTokenCount >= 2 ? 4 : 4.2) : 6);
  const inactiveMatch = pickBestVacancyMatch(inactiveCityVacancies, { text, city, roleHint, operationZones });
  const inactiveHasRoleEvidence = operationZones.length ? true : hasEnoughRoleEvidence(inactiveMatch, roleHint);
  const inactiveContext = { text, city, roleHint, operationZones, threshold, inactiveHasRoleEvidence };

  if (city && !matchingCityVacancies.length) {
    if (canUseInactiveMatch(inactiveMatch, inactiveContext)) return { resolved: true, vacancy: inactiveMatch.best.vacancy, city, roleHint, reason: 'matched_inactive_vacancy' };
    return { resolved: false, vacancy: null, city, roleHint, reason: 'city_without_active_vacancies' };
  }

  if (!activeVacancies.length) {
    if (canUseInactiveMatch(inactiveMatch, inactiveContext)) return { resolved: true, vacancy: inactiveMatch.best.vacancy, city: city || canonicalVacancyCity(inactiveMatch.best.vacancy), roleHint, reason: 'matched_inactive_vacancy' };
    return { resolved: false, vacancy: null, city, roleHint, reason: 'no_active_vacancies' };
  }

  if (city && !roleHint && matchingCityVacancies.length) return { resolved: false, vacancy: null, city, roleHint, reason: 'city_with_active_vacancies' };

  const { best, runnerUp, margin } = pickBestVacancyMatch(matchingCityVacancies, { text, city, roleHint, operationZones });
  const effectiveThreshold = roleHint ? threshold : 6;
  const activeHasRoleEvidence = hasEnoughRoleEvidence({ best }, roleHint);
  if (!best || best.score < effectiveThreshold || !activeHasRoleEvidence) {
    if (canUseInactiveMatch(inactiveMatch, inactiveContext) && (!best || !activeHasRoleEvidence)) {
      return { resolved: true, vacancy: inactiveMatch.best.vacancy, city: city || canonicalVacancyCity(inactiveMatch.best.vacancy), roleHint, reason: 'matched_inactive_vacancy' };
    }
    return { resolved: false, vacancy: null, city, roleHint, reason: 'low_confidence_match' };
  }
  if (runnerUp && margin < 0.75) return { resolved: false, vacancy: null, city, roleHint, reason: 'ambiguous_match' };
  return { resolved: true, vacancy: best.vacancy, city: city || canonicalVacancyCity(best.vacancy), roleHint, reason: 'matched_active_vacancy' };
}
