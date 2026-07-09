export const BOGOTA_LOCALIDAD_ALIASES = Object.freeze({
  usaquen: 'Usaquén',
  'usaquén': 'Usaquén',
  chapinero: 'Chapinero',
  'santa fe': 'Santa Fe',
  sancristobal: 'San Cristóbal',
  'san cristobal': 'San Cristóbal',
  'san cristóbal': 'San Cristóbal',
  usme: 'Usme',
  tunjuelito: 'Tunjuelito',
  bosa: 'Bosa',
  kennedy: 'Kennedy',
  fontibon: 'Fontibón',
  'fontibón': 'Fontibón',
  engativa: 'Engativá',
  'engativá': 'Engativá',
  suba: 'Suba',
  barriosunidos: 'Barrios Unidos',
  'barrios unidos': 'Barrios Unidos',
  teusaquillo: 'Teusaquillo',
  martires: 'Los Mártires',
  'los martires': 'Los Mártires',
  'los mártires': 'Los Mártires',
  antonionarino: 'Antonio Nariño',
  'antonio narino': 'Antonio Nariño',
  'antonio nariño': 'Antonio Nariño',
  puentearanda: 'Puente Aranda',
  'puente aranda': 'Puente Aranda',
  lacandelaria: 'La Candelaria',
  'la candelaria': 'La Candelaria',
  rafaeluribeuribe: 'Rafael Uribe Uribe',
  'rafael uribe': 'Rafael Uribe Uribe',
  'rafael uribe uribe': 'Rafael Uribe Uribe',
  ciudadbolivar: 'Ciudad Bolívar',
  'ciudad bolivar': 'Ciudad Bolívar',
  'ciudad bolívar': 'Ciudad Bolívar',
  sumapaz: 'Sumapaz',

  lisboa: 'Suba',
  bilbao: 'Suba',
  'suba lisboa': 'Suba',
  'suba bilbao': 'Suba',
  'patio bonito': 'Kennedy',
  'kennedy patio bonito': 'Kennedy',
  'bosa san jose': 'Bosa',
  'montevideo': 'Puente Aranda',
  'zona industrial': 'Puente Aranda',
  'zona industrial montevideo': 'Puente Aranda'
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

export function normalizeComparableText(value = '') {
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
