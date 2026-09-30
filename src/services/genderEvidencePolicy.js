const STRONG_GENDER_EVIDENCE = Object.freeze({
  FEMALE: Object.freeze([
    'soy mujer',
    'soy candidata',
    'estoy interesada en la vacante',
    'interesada en la vacante',
    'quedo atenta',
    'me postulo como candidata',
    'sexo femenino',
    'genero femenino',
    'me considero mujer',
    'me identifico como mujer',
    'soy una chica',
    'soy trabajadora',
    'soy operaria',
    'fui registrada como mujer',
    'nací mujer',
    'estoy postulada',
    'postulada',
    'inscrita',
    'registrada',
    'estoy casada',
    'soy soltera',
    'soy colombiana',
    'soy venezolana',
    'soy tecnica',
    'soy profesional titulada',
    'estoy certificada',
    'estoy capacitada',
    'estoy dispuesta',
    'estoy desempleada',
    'femenina'
  ]),
  MALE: Object.freeze([
    'soy hombre',
    'soy candidato',
    'estoy interesado en la vacante',
    'interesado en la vacante',
    'quedo atento',
    'me postulo como candidato',
    'sexo masculino',
    'genero masculino',
    'me considero hombre',
    'me identifico como hombre',
    'soy un chico',
    'soy trabajador',
    'soy operario',
    'fui registrado como hombre',
    'nací hombre',
    'estoy postulado',
    'postulado',
    'inscrito',
    'registrado',
    'estoy casado',
    'soy soltero',
    'soy colombiano',
    'soy venezolano',
    'soy tecnico',
    'soy profesional titulado',
    'estoy certificado',
    'estoy capacitado',
    'estoy dispuesto',
    'estoy desempleado',
    'masculino'
  ])
});

const AMBIGUOUS_GENDER_EVIDENCE = Object.freeze([
  'si senora',
  'gracias senorita',
  'la senorita me dijo',
  'mi esposa esta interesada',
  'es para mi hermana',
  'quedo atento a la respuesta de la senora',
  'candidata es la vacante que vi'
]);

const STRONG_PATTERNS = Object.freeze({
  FEMALE: Object.freeze([
    /\bsoy\s+(?:una\s+)?mujer\b/,
    /\bsoy\s+(?:una\s+)?candidata\b/,
    /\bestoy\s+interesada(?:\s+en\s+la\s+vacante)?\b/,
    /\binteresada\s+en\s+la\s+vacante\b/,
    /\bquedo\s+atenta\b/,
    /\bme\s+postulo\s+como\s+(?:mujer|candidata)\b/,
    /\bme\s+(?:considero|identifico\s+como)\s+mujer\b/,
    /\bsoy\s+(?:una\s+)?(?:chica|trabajadora|operaria)\b/,
    /\b(?:naci|fui\s+registrada)\s+(?:como\s+)?(?:mujer|sexo\s+femenino)\b/,
    /\bsexo\s+femenino\b/,
    /\bgenero\s+femenino\b/,
    /\bestoy\s+postulada\b/,
    /\b(?:soy|estoy)\s+(?:casada|soltera|colombiana|venezolana|tecnica|titulada|certificada|capacitada|dispuesta|desempleada)\b/,
    /\b(?:profesional|tecnica|tecnologa|bachiller)\s+(?:graduada|titulada|certificada)\b/,
    /\b(?:postulada|inscrita|registrada|femenin[ao])\b/
  ]),
  MALE: Object.freeze([
    /\bsoy\s+(?:un\s+)?hombre\b/,
    /\bsoy\s+(?:un\s+)?candidato\b/,
    /\bestoy\s+interesado(?:\s+en\s+la\s+vacante)?\b/,
    /\binteresado\s+en\s+la\s+vacante\b/,
    /\bquedo\s+atento\b/,
    /\bme\s+postulo\s+como\s+(?:hombre|candidato)\b/,
    /\bme\s+(?:considero|identifico\s+como)\s+hombre\b/,
    /\bsoy\s+(?:un\s+)?(?:chico|trabajador|operario)\b/,
    /\b(?:naci|fui\s+registrado)\s+(?:como\s+)?(?:hombre|sexo\s+masculino)\b/,
    /\bsexo\s+masculino\b/,
    /\bgenero\s+masculino\b/,
    /\bestoy\s+postulado\b/,
    /\b(?:soy|estoy)\s+(?:casado|soltero|colombiano|venezolano|tecnico|titulado|certificado|capacitado|dispuesto|desempleado)\b/,
    /\b(?:profesional|tecnico|tecnologo|bachiller)\s+(?:graduado|titulado|certificado)\b/,
    /\b(?:postulado|inscrito|registrado|masculino)\b/
  ])
});

const AMBIGUOUS_PATTERNS = Object.freeze([
  /\b(?:si|sii|sí|claro|ok|listo|gracias|buen[oa]s?)\b.{0,24}\b(?:senora|senorita|senor)\b/,
  /\b(?:la|una|esa)\s+senorita\b/,
  /\b(?:la|una|esa)\s+senora\b/,
  /\b(?:la|una|esa)\s+senor\b/,
  /\b(?:mi|para\s+mi|es\s+para\s+mi)\s+(?:esposa|hermana|mama|madre|hija|novia|sobrina|prima)\b/,
  /\b(?:mi|para\s+mi|es\s+para\s+mi)\s+(?:esposo|hermano|papa|padre|hijo|novio|sobrino|primo)\b/,
  /\bquedo\s+atent[oa]\b.{0,40}\b(?:senora|senorita|senor)\b/,
  /\bcandidata\s+es\s+la\s+vacante\b/
]);

export function normalizeGenderEvidenceText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasAmbiguousGenderEvidence(text = '') {
  const normalized = normalizeGenderEvidenceText(text);
  if (!normalized) return false;
  return AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasStrongGenderEvidence(value, text = '') {
  const normalizedValue = String(value || '').toUpperCase();
  const normalized = normalizeGenderEvidenceText(text);
  const patterns = STRONG_PATTERNS[normalizedValue];
  if (!patterns || !normalized || hasAmbiguousGenderEvidence(normalized)) return false;
  return patterns.some((pattern) => pattern.test(normalized));
}

export function detectGenderFromEvidence(text = '', _context = {}) {
  const normalized = normalizeGenderEvidenceText(text);
  if (!normalized || hasAmbiguousGenderEvidence(normalized)) return null;

  const female = hasStrongGenderEvidence('FEMALE', normalized);
  const male = hasStrongGenderEvidence('MALE', normalized);
  if (female === male) return null;
  if (female) return 'FEMALE';
  if (male) return 'MALE';
  return null;
}

export function buildGenderEvidencePromptText() {
  const female = STRONG_GENDER_EVIDENCE.FEMALE.map((item) => `"${item}"`).join(', ');
  const male = STRONG_GENDER_EVIDENCE.MALE.map((item) => `"${item}"`).join(', ');
  const ambiguous = AMBIGUOUS_GENDER_EVIDENCE.map((item) => `"${item}"`).join(', ');
  return `Detecta el genero de forma silenciosa: nunca lo preguntes ni sugieras que falta. FEMALE cuando haya marcas claras auto-referidas como ${female} o una correccion explícita equivalente. MALE cuando haya marcas equivalentes como ${male}. El nombre completo puede servir únicamente como contexto corroborante cuando el mismo mensaje contiene evidencia lingüística compatible; jamás clasifiques por el nombre solo. No extraigas genero con evidencia ambigua o de terceros como ${ambiguous}. Si no hay evidencia suficiente, devuelve null y continúa sin preguntarlo.`;
}

export const __genderEvidencePolicyInternals = {
  STRONG_GENDER_EVIDENCE,
  AMBIGUOUS_GENDER_EVIDENCE
};
