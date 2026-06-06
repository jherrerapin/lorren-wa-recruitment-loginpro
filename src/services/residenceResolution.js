import {
  buildResidenceFieldsFromLocation,
  LocationEntityType,
  resolveLocationEntity
} from './locationResolver.js';

export const ResidenceResolutionKind = Object.freeze({
  BOGOTA_CITY: 'BOGOTA_CITY',
  BOGOTA_LOCALITY: 'BOGOTA_LOCALITY',
  BOGOTA_AREA_MUNICIPALITY: 'BOGOTA_AREA_MUNICIPALITY',
  OTHER_CITY: 'OTHER_CITY',
  UNKNOWN: 'UNKNOWN'
});

export const ResidenceResolutionSource = Object.freeze({
  CANDIDATE_TEXT: 'candidate_text',
  AI_EXTRACTION: 'ai_extraction',
  GEOCODER: 'geocoder',
  FALLBACK_RESOLVER: 'fallback_resolver'
});

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

function mapLocationType(type) {
  if (type === LocationEntityType.BOGOTA_CITY) return ResidenceResolutionKind.BOGOTA_CITY;
  if (type === LocationEntityType.BOGOTA_LOCALITY) return ResidenceResolutionKind.BOGOTA_LOCALITY;
  if (type === LocationEntityType.BOGOTA_AREA_MUNICIPALITY) return ResidenceResolutionKind.BOGOTA_AREA_MUNICIPALITY;
  if (type === LocationEntityType.OTHER_CITY_OR_PLACE) return ResidenceResolutionKind.OTHER_CITY;
  return ResidenceResolutionKind.UNKNOWN;
}

function buildFromLocationEntity(entity = {}, source = ResidenceResolutionSource.FALLBACK_RESOLVER) {
  const fields = buildResidenceFieldsFromLocation(entity);
  return {
    kind: mapLocationType(entity.type),
    source,
    rawText: cleanText(entity.evidence || entity.raw || entity.name || ''),
    displayName: cleanText(entity.name || ''),
    city: entity.city || (entity.type === LocationEntityType.BOGOTA_CITY ? 'Bogotá' : null),
    locality: fields.locality || null,
    neighborhood: fields.neighborhood || null,
    zone: fields.zone || null,
    confidence: entity.type === LocationEntityType.UNKNOWN ? 0 : 0.78,
    evidence: cleanText(entity.evidence || entity.raw || entity.name || ''),
    fields,
    needsGeocoding: entity.type === LocationEntityType.OTHER_CITY_OR_PLACE
  };
}

function buildFromGeocodedPlace(place = {}, rawText = '') {
  if (!place || typeof place !== 'object' || !place.displayName) return null;
  const city = place.city || place.municipality || null;
  const locality = place.locality || null;
  const neighborhood = place.neighborhood || null;
  const kind = city === 'Bogotá' && locality
    ? ResidenceResolutionKind.BOGOTA_LOCALITY
    : ResidenceResolutionKind.OTHER_CITY;

  return {
    kind,
    source: ResidenceResolutionSource.GEOCODER,
    rawText: cleanText(rawText),
    displayName: cleanText(place.displayName),
    city,
    locality,
    neighborhood,
    zone: locality || neighborhood || city || null,
    confidence: Number.isFinite(place.confidence) ? place.confidence : 0.86,
    evidence: cleanText(rawText),
    fields: {
      ...(locality ? { locality } : {}),
      ...(neighborhood ? { neighborhood } : {}),
      ...(locality || neighborhood ? { zone: locality || neighborhood } : {})
    },
    needsGeocoding: false
  };
}

export function resolveResidence({ text = '', parsedFields = {}, geocodedPlace = null } = {}) {
  const rawText = firstNonEmpty(
    parsedFields.residenceText,
    parsedFields.locality,
    parsedFields.neighborhood,
    text
  );

  const geocoded = buildFromGeocodedPlace(geocodedPlace, rawText);
  if (geocoded) return geocoded;

  const entity = resolveLocationEntity(rawText);
  const source = parsedFields.locality || parsedFields.neighborhood
    ? ResidenceResolutionSource.AI_EXTRACTION
    : ResidenceResolutionSource.CANDIDATE_TEXT;
  return buildFromLocationEntity(entity, source);
}

export function shouldAskBogotaLocality(resolution = {}) {
  return resolution.kind === ResidenceResolutionKind.BOGOTA_CITY;
}

export function hasResolvedResidence(resolution = {}) {
  return Boolean(
    resolution.kind === ResidenceResolutionKind.BOGOTA_LOCALITY
    || resolution.kind === ResidenceResolutionKind.BOGOTA_AREA_MUNICIPALITY
    || (resolution.kind === ResidenceResolutionKind.OTHER_CITY && resolution.displayName)
  );
}
