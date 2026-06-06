import { normalizeBogotaLocalidad } from './geographyNormalization.js';

export const LocationEntityType = Object.freeze({
  BOGOTA_CITY: 'BOGOTA_CITY',
  BOGOTA_LOCALITY: 'BOGOTA_LOCALITY',
  BOGOTA_AREA_MUNICIPALITY: 'BOGOTA_AREA_MUNICIPALITY',
  OTHER_CITY_OR_PLACE: 'OTHER_CITY_OR_PLACE',
  UNKNOWN: 'UNKNOWN'
});

export const LocationQuestionAction = Object.freeze({
  ASK_CITY: 'ASK_CITY',
  ASK_BOGOTA_LOCALITY: 'ASK_BOGOTA_LOCALITY',
  ASK_NEIGHBORHOOD: 'ASK_NEIGHBORHOOD',
  ACCEPT: 'ACCEPT'
});

const BOGOTA_CITY = new Set(['bogota', 'bogota dc', 'bogota d c']);

// Datos geográficos de referencia para decidir si una respuesta ya es municipio de residencia
// del área Bogotá/Sabana. No son reglas de asignación de vacante.
const BOGOTA_AREA = new Map([
  ['soacha', 'Soacha Cundinamarca'],
  ['funza', 'Funza Cundinamarca'],
  ['mosquera', 'Mosquera Cundinamarca'],
  ['madrid', 'Madrid Cundinamarca'],
  ['cota', 'Cota Cundinamarca'],
  ['chia', 'Chía Cundinamarca'],
  ['facatativa', 'Facatativá Cundinamarca'],
  ['tenjo', 'Tenjo Cundinamarca'],
  ['el rosal', 'El Rosal Cundinamarca'],
  ['bojaca', 'Bojacá Cundinamarca'],
  ['sibate', 'Sibaté Cundinamarca']
]);

const NON_LOCATION = new Set(['hola', 'buenas', 'si', 'sí', 'no', 'ok', 'listo', 'gracias']);

export function normalizeLocationText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripResidencePrefix(value = '') {
  return normalizeLocationText(value)
    .replace(/^(vivo|estoy|resido|soy)\s+(en|por|de)\s+/, '')
    .replace(/^(en|por|de)\s+/, '')
    .trim();
}

function titleCase(value = '') {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function resolveBogotaAreaResidence(value = '') {
  const normalized = stripResidencePrefix(value);
  return BOGOTA_AREA.get(normalized) || BOGOTA_AREA.get(normalized.replace(/\s+/g, '')) || null;
}

export function resolveLocationEntity(value = '') {
  const normalized = stripResidencePrefix(value);
  if (!normalized || NON_LOCATION.has(normalized)) {
    return { type: LocationEntityType.UNKNOWN, name: null, normalized, evidence: value };
  }

  if (BOGOTA_CITY.has(normalized)) {
    return { type: LocationEntityType.BOGOTA_CITY, name: 'Bogotá', normalized, evidence: value };
  }

  const locality = normalizeBogotaLocalidad(normalized);
  if (locality) {
    return { type: LocationEntityType.BOGOTA_LOCALITY, name: locality, city: 'Bogotá', normalized, evidence: value };
  }

  const bogotaAreaResidence = resolveBogotaAreaResidence(normalized);
  if (bogotaAreaResidence) {
    return { type: LocationEntityType.BOGOTA_AREA_MUNICIPALITY, name: bogotaAreaResidence, normalized, evidence: value };
  }

  return { type: LocationEntityType.OTHER_CITY_OR_PLACE, name: titleCase(normalized), normalized, evidence: value };
}

export function buildResidenceFieldsFromLocation(entity = {}) {
  if (entity.type === LocationEntityType.BOGOTA_LOCALITY) {
    return { locality: entity.name, neighborhood: null, zone: entity.name };
  }
  if (entity.type === LocationEntityType.BOGOTA_AREA_MUNICIPALITY) {
    return { neighborhood: entity.name, locality: null, zone: entity.name };
  }
  if (entity.type === LocationEntityType.OTHER_CITY_OR_PLACE) {
    return { neighborhood: entity.name, zone: entity.name };
  }
  return {};
}

export function decideLocationQuestion({ entity = null, hasResidence = false, isBogotaAreaFlow = false } = {}) {
  if (hasResidence) return LocationQuestionAction.ACCEPT;
  if (!entity || entity.type === LocationEntityType.UNKNOWN) return LocationQuestionAction.ASK_CITY;
  if (entity.type === LocationEntityType.BOGOTA_CITY) return LocationQuestionAction.ASK_BOGOTA_LOCALITY;
  if (entity.type === LocationEntityType.BOGOTA_LOCALITY) return LocationQuestionAction.ACCEPT;
  if (entity.type === LocationEntityType.BOGOTA_AREA_MUNICIPALITY) return LocationQuestionAction.ACCEPT;
  if (isBogotaAreaFlow) return LocationQuestionAction.ACCEPT;
  return LocationQuestionAction.ASK_NEIGHBORHOOD;
}

export function buildLocationQuestion(action) {
  if (action === LocationQuestionAction.ASK_BOGOTA_LOCALITY) return 'Gracias. ¿En qué localidad vives?';
  if (action === LocationQuestionAction.ASK_NEIGHBORHOOD) return 'Gracias. ¿En qué barrio vives?';
  return '¿Desde qué ciudad nos escribes?';
}
