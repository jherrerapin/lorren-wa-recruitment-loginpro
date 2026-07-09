import { normalizeComparableText } from './geographyNormalization.js';

export class TransportNormalizationService {
  normalize(value) {
    return normalizeTransportMode(value);
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizeTransportMode(value) {
  const raw = normalizeString(value);
  if (!raw) return null;

  const normalized = normalizeComparableText(raw);
  if (!normalized) return null;

  if (
    normalized === 'sin medio de transporte' ||
    normalized === 'sin transporte' ||
    normalized === 'sin vehiculo' ||
    normalized === 'ninguno' ||
    normalized === 'ninguna' ||
    normalized === 'no tiene' ||
    normalized === 'no tengo' ||
    normalized.startsWith('sin ') ||
    normalized.startsWith('no tengo') ||
    normalized.startsWith('no tiene') ||
    normalized.startsWith('no cuento con')
  ) {
    return 'Publico';
  }

  if (/(^| )(moto|motocicleta)( |$)/.test(normalized)) return 'Moto';
  if (/(^| )(bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)( |$)/.test(normalized)) return 'Bicicleta';
  if (/(^| )(carro|auto|automovil|coche|vehiculo propio|carro propio)( |$)/.test(normalized)) return 'Carro';
  if (/(^| )(patineta electrica|patineta)( |$)/.test(normalized)) return 'Patineta eléctrica';
  if (/(^| )(a pie|caminando|caminar|voy a pie)( |$)/.test(normalized)) return 'Publico';
  if (/(^| )(bus|buseta|colectivo|transmilenio|transmi|sitp|alimentador|metro|transporte publico|publico|servicio publico|didi|uber|indrive|in drive|taxi|transporte urbano)( |$)/.test(normalized)) return 'Publico';

  return null;
}

export function uniqueNormalizedTransportModes(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeTransportMode(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result.sort((a, b) => a.localeCompare(b, 'es'));
}

export const transportNormalizationService = new TransportNormalizationService();
