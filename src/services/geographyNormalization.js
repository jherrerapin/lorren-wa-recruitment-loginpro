export const BOGOTA_LOCALIDAD_ALIASES = Object.freeze({
  suba: 'Suba',
  lisboa: 'Suba',
  bilbao: 'Suba',
  'suba lisboa': 'Suba',
  'suba bilbao': 'Suba',

  kennedy: 'Kennedy',
  'patio bonito': 'Kennedy',
  'kennedy patio bonito': 'Kennedy',

  bosa: 'Bosa',
  'bosa san jose': 'Bosa',

  'ciudad bolivar': 'Ciudad Bolívar',
  'ciudad bolívar': 'Ciudad Bolívar'
});

const NON_DATA_LOCATION_TEXT = new Set([
  'hola',
  'buenas',
  'buenos dias',
  'buenos días',
  'si',
  'sí',
  'no',
  'estoy interesado',
  'estoy interesada',
  'quiero aplicar'
]);

function normalizeComparableText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_BOGOTA_LOCALIDAD_ALIASES = Object.freeze(
  Object.fromEntries(
    Object.entries(BOGOTA_LOCALIDAD_ALIASES).map(([alias, localidad]) => [normalizeComparableText(alias), localidad])
  )
);

export class GeographyNormalizationService {
  normalizeBogotaLocalidad(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized || NON_DATA_LOCATION_TEXT.has(normalized)) return null;
    return NORMALIZED_BOGOTA_LOCALIDAD_ALIASES[normalized] || null;
  }
}

export const geographyNormalizationService = new GeographyNormalizationService();

export function normalizeBogotaLocalidad(value) {
  return geographyNormalizationService.normalizeBogotaLocalidad(value);
}

export const __geographyNormalizationInternals = {
  normalizeComparableText
};
