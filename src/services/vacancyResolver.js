const ROLE_STOPWORDS = new Set([
  'a', 'al', 'ante', 'aplicar', 'aplicando', 'aplicarme', 'aplico', 'ayuda',
  'buen', 'buena', 'buenas', 'cargo', 'con', 'continuar', 'cual', 'cuales',
  'cuanto', 'de', 'del', 'desde', 'deseo', 'el', 'en', 'es', 'esa', 'ese',
  'esta', 'estoy', 'favor', 'gracias', 'hola', 'informacion', 'interesa',
  'interesada', 'interesado', 'la', 'las', 'loginpro', 'los', 'me', 'mi',
  'necesito', 'para', 'por', 'postular', 'postularme', 'puesto', 'que',
  'quiero', 'rol', 'seria', 'solicito', 'su', 'trabajar', 'trabajo', 'una',
  'uno', 'vacante', 'y', 'ubico', 'ubicado', 'ubicada', 'escribo', 'municipio',
  'encuentro', 'espera', 'desde', 'si', 'sii', 'sip', 'sipi', 'ok', 'okay',
  'vale', 'listo', 'correcto', 'bueno', 'bn', 'perfecto', 'confirmo', 'te',
  'cundinamarca', 'tolima', 'bogota', 'ibague', 'funza', 'mosquera', 'madrid', 'siberia',
  'facebook', 'faceb', 'face', 'canal', 'watsap', 'whatsapp', 'anuncio', 'publicaron',
  'publicada', 'publicado', 'empleo', 'oferta', 'averiguar', 'informarme', 'quisiera'
]);
const ROLE_SIGNAL_REGEX = /\b(aux|auxiliar|cargue|descargue|bodega|operari|operativo|mensajer|conductor|coordinador|coordinadora|logistic|logistica|logistico|operaciones|ruta|cargo|vacante|puesto|rol)\b/i;
const LOCATION_ALIASES = [
  { value: 'Bogota', patterns: [/\bbogota\b/i, /\bfunza\b/i, /\bmosquera\b/i, /\bmadrid\b/i, /\bsiberia\b/i, /\bsuba\b/i, /\bengativa\b/i, /\bcalle 80\b/i, /\bvillas? de granada\b/i, /\bel rosal\b/i] },
  { value: 'Ibague', patterns: [/\bibague\b/i] }
];
const LOCATION_GROUPS = [
  { key: 'bogota-siberia', aliases: ['bogota', 'siberia', 'funza', 'mosquera', 'madrid', 'suba', 'engativa', 'calle 80', 'villas de granada', 'el rosal'] },
  { key: 'ibague', aliases: ['ibague'] }
];

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

function findLocationGroup(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return null;
  return LOCATION_GROUPS.find((group) => group.aliases.some((alias) => normalized.includes(alias))) || null;
}

function cityMatchesVacancy(vacancy, requestedCity = '') {
  const normalizedRequestedCity = normalizeResolverText(requestedCity);
  const normalizedVacancyCity = normalizeResolverText(canonicalVacancyCity(vacancy));
  if (!normalizedRequestedCity) return true;
  if (normalizedVacancyCity === normalizedRequestedCity) return true;

  const requestedGroup = findLocationGroup(normalizedRequestedCity);
  if (!requestedGroup) return false;

  const vacancyLocationText = buildVacancyLocationText(vacancy);
  return requestedGroup.aliases.some((alias) => vacancyLocationText.includes(alias));
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
    if (padded.includes(` ${cityNormalized} `)) {
      if (!bestMatch || cityNormalized.length > bestMatch.normalized.length) {
        bestMatch = { value: cityName, normalized: cityNormalized };
      }
    }
  }

  if (bestMatch?.value) return bestMatch.value;

  const alias = LOCATION_ALIASES.find((entry) => entry.patterns.some((pattern) => pattern.test(text)));
  return alias?.value || null;
}

function cleanRoleTokens(tokens = [], cityTokens = new Set()) {
  return tokens.filter((token) => (
    token
    && token.length > 1
    && !ROLE_STOPWORDS.has(token)
    && !cityTokens.has(token)
  ));
}

function splitMeaningfulSegments(text = '') {
  return String(text || '')
    .split(/[\n,;]+/)
    .map((segment) => normalizeResolverText(segment))
    .filter(Boolean);
}

function findSegmentWithRoleSignal(segments = []) {
  return segments.find((segment) => ROLE_SIGNAL_REGEX.test(segment)) || null;
}

export function detectRoleHintFromText(text = '', options = {}) {
  const normalized = normalizeResolverText(text);
  if (!normalized) return null;

  const cityTokens = new Set(tokenize(options.city || ''));
  const segments = splitMeaningfulSegments(text);
  const preferredSegment = findSegmentWithRoleSignal(segments);
  if (preferredSegment) {
    const preferredTokens = cleanRoleTokens(tokenize(preferredSegment), cityTokens);
    if (preferredTokens.length) return preferredTokens.join(' ');
  }

  const explicitPatterns = [
    /\b(?:vacante|cargo|rol|puesto)\s+(?:de|para)?\s*([a-z0-9 ]{3,80})/i,
    /\b(?:quiero aplicar(?: a)?|quiero postularme(?: a)?|me interesa(?: la)?|estoy interesad[oa] en(?: la)?|informacion(?: de)?(?: la)?|para)\s+(?:vacante|cargo|rol|puesto)?\s*(?:de|para)?\s*([a-z0-9 ]{3,80})/i
  ];

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const roleTokens = cleanRoleTokens(tokenize(match[1]), cityTokens);
    if (roleTokens.length) return roleTokens.join(' ');
  }

  if (ROLE_SIGNAL_REGEX.test(normalized)) {
    const roleTokens = cleanRoleTokens(tokenize(normalized), cityTokens);
    return roleTokens.length ? roleTokens.join(' ') : null;
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
  for (const token of inputSet) {
    if (candidateSet.has(token)) overlap += 1;
  }
  if (!overlap) return 0;

  const inputNormalized = normalizeResolverText(input);
  const candidateNormalized = normalizeResolverText(candidate);
  let score = overlap / Math.max(inputSet.size, candidateSet.size);

  if (candidateNormalized && inputNormalized) {
    if (candidateNormalized === inputNormalized) score += 0.9;
    else if (candidateNormalized.includes(inputNormalized) || inputNormalized.includes(candidateNormalized)) score += 0.45;
  }

  return score;
}

function hasInterestSignal(text = '') {
  return /\b(vacante|cargo|empleo|trabajo|informacion|interesa|interesado|interesada|aplicar|postular|continuar)\b/i
    .test(normalizeResolverText(text));
}

function scoreVacancy(vacancy, { text, city, roleHint }) {
  const vacancyText = [vacancy?.title, vacancy?.role, vacancy?.operation?.name, vacancy?.operationAddress].filter(Boolean).join(' ');
  const vacancyCity = canonicalVacancyCity(vacancy);
  let score = 0;

  if (city) {
    if (!cityMatchesVacancy(vacancy, city)) return -1;
    score += 4;
  }

  if (roleHint) {
    score += similarityScore(roleHint, vacancyText) * 6;
  } else {
    score += similarityScore(text, vacancyText) * 3;
  }

  const normalizedText = normalizeResolverText(text);
  const normalizedTitle = normalizeResolverText(vacancy?.title || '');
  const normalizedRole = normalizeResolverText(vacancy?.role || '');

  if (normalizedTitle && normalizedText.includes(normalizedTitle)) score += 2;
  if (normalizedRole && normalizedText.includes(normalizedRole)) score += 2;

  return score;
}

export async function findActiveVacancies(prisma) {
  return prisma.vacancy.findMany({
    where: {
      isActive: true,
      acceptingApplications: true,
    },
    include: {
      operation: {
        include: {
          city: true,
        },
      },
    },
    orderBy: [
      { updatedAt: 'desc' },
      { title: 'asc' },
    ],
  });
}

export async function findAllVacancies(prisma) {
  return prisma.vacancy.findMany({
    include: {
      operation: {
        include: {
          city: true,
        },
      },
    },
    orderBy: [
      { updatedAt: 'desc' },
      { title: 'asc' },
    ],
  });
}

function pickBestVacancyMatch(vacancies = [], context = {}) {
  if (!vacancies.length) return null;

  const scored = vacancies
    .map((vacancy) => ({ vacancy, score: scoreVacancy(vacancy, context) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  const runnerUp = scored[1] || null;
  return {
    best,
    runnerUp,
    margin: best ? (runnerUp ? best.score - runnerUp.score : best.score) : 0
  };
}

function isStrongUniqueRoleMatch(match, threshold = 4.5) {
  if (!match?.best) return false;
  if (match.best.score < threshold) return false;
  return !match.runnerUp || match.margin >= 0.75;
}

export async function resolveVacancyFromText(prisma, text, options = {}) {
  const normalizedText = normalizeResolverText(text);
  if (!normalizedText) {
    return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'empty_input' };
  }

  const allVacancies = options.allVacancies || options.vacancies || await findAllVacancies(prisma);
  const activeVacancies = options.activeVacancies || options.vacancies || allVacancies.filter(isVacancyOpen);

  if (!allVacancies.length) {
    return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'no_vacancies_configured' };
  }

  const city = options.cityHint || detectCityFromText(text, buildCityNames(allVacancies));
  const roleHint = options.roleHint || detectRoleHintFromText(text, { city });
  if (!city && !roleHint) {
    return { resolved: false, vacancy: null, city: null, roleHint: null, reason: 'missing_city_and_role' };
  }

  const matchingCityVacancies = city
    ? activeVacancies.filter((vacancy) => cityMatchesVacancy(vacancy, city))
    : activeVacancies;

  const inactiveVacancies = allVacancies.filter((vacancy) => !isVacancyOpen(vacancy));
  const inactiveCityVacancies = city
    ? inactiveVacancies.filter((vacancy) => cityMatchesVacancy(vacancy, city))
    : inactiveVacancies;

  const roleTokenCount = roleHint ? cleanRoleTokens(tokenize(roleHint)).length : 0;
  const threshold = roleHint ? (roleTokenCount >= 2 ? 4 : 4.5) : 6;

  if (city && !matchingCityVacancies.length) {
    const crossCityActiveMatch = roleHint
      ? pickBestVacancyMatch(activeVacancies, { text, city: null, roleHint })
      : null;
    if (isStrongUniqueRoleMatch(crossCityActiveMatch, threshold)) {
      return {
        resolved: true,
        vacancy: crossCityActiveMatch.best.vacancy,
        city: canonicalVacancyCity(crossCityActiveMatch.best.vacancy),
        roleHint,
        reason: 'matched_active_vacancy_by_role_outside_city'
      };
    }

    const inactiveMatch = pickBestVacancyMatch(inactiveCityVacancies, { text, city, roleHint });
    if (inactiveMatch?.best && inactiveMatch.best.score >= threshold) {
      return {
        resolved: true,
        vacancy: inactiveMatch.best.vacancy,
        city,
        roleHint,
        reason: 'matched_inactive_vacancy'
      };
    }
    return { resolved: false, vacancy: null, city, roleHint, reason: 'city_without_active_vacancies' };
  }

  if (!activeVacancies.length) {
    const inactiveMatch = pickBestVacancyMatch(inactiveCityVacancies, { text, city, roleHint });
    if (inactiveMatch?.best && inactiveMatch.best.score >= threshold) {
      return {
        resolved: true,
        vacancy: inactiveMatch.best.vacancy,
        city: city || canonicalVacancyCity(inactiveMatch.best.vacancy),
        roleHint,
        reason: 'matched_inactive_vacancy'
      };
    }
    return { resolved: false, vacancy: null, city, roleHint, reason: 'no_active_vacancies' };
  }

  const { best, runnerUp, margin } = pickBestVacancyMatch(matchingCityVacancies, { text, city, roleHint });
  const inactiveMatch = pickBestVacancyMatch(inactiveCityVacancies, { text, city, roleHint });
  const hasUniqueCityMatch = Boolean(city && matchingCityVacancies.length === 1);
  const effectiveThreshold = roleHint ? threshold : hasUniqueCityMatch ? 4 : 6;

  if (!best || best.score < effectiveThreshold) {
    if (inactiveMatch?.best && inactiveMatch.best.score >= threshold) {
      return {
        resolved: true,
        vacancy: inactiveMatch.best.vacancy,
        city: city || canonicalVacancyCity(inactiveMatch.best.vacancy),
        roleHint,
        reason: 'matched_inactive_vacancy'
      };
    }
    if (city && !roleHint && matchingCityVacancies.length) {
      return { resolved: false, vacancy: null, city, roleHint, reason: 'city_with_active_vacancies' };
    }
    return { resolved: false, vacancy: null, city, roleHint, reason: 'low_confidence_match' };
  }

  if (
    inactiveMatch?.best
    && inactiveMatch.best.score >= threshold
    && inactiveMatch.best.score >= (best.score + 0.5)
  ) {
    return {
      resolved: true,
      vacancy: inactiveMatch.best.vacancy,
      city: city || canonicalVacancyCity(inactiveMatch.best.vacancy),
      roleHint,
      reason: 'matched_inactive_vacancy'
    };
  }

  if (runnerUp && margin < 0.75) {
    return { resolved: false, vacancy: null, city, roleHint, reason: 'ambiguous_match' };
  }

  return {
    resolved: true,
    vacancy: best.vacancy,
    city: city || canonicalVacancyCity(best.vacancy),
    roleHint,
    reason: 'matched_active_vacancy'
  };
}
