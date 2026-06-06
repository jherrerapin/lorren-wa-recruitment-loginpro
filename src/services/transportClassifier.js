import { normalizeTransportMode } from './transportMode.js';

export const TransportKind = Object.freeze({
  OWN: 'OWN',
  PUBLIC: 'PUBLIC',
  UNKNOWN: 'UNKNOWN'
});

export function classifyTransportKind(value = '') {
  const normalized = normalizeTransportMode(value);
  if (!normalized) return { kind: TransportKind.UNKNOWN, normalized: null, evidence: value };

  if (['Moto', 'Carro', 'Bicicleta', 'Patineta eléctrica'].includes(normalized)) {
    return { kind: TransportKind.OWN, normalized, evidence: value };
  }

  if (normalized === 'Publico') {
    return { kind: TransportKind.PUBLIC, normalized, evidence: value };
  }

  return { kind: TransportKind.UNKNOWN, normalized, evidence: value };
}

export function hasOwnTransport(value = '') {
  return classifyTransportKind(value).kind === TransportKind.OWN;
}

export function needsOwnTransportQuestion({ operationKey = '', transportMode = null } = {}) {
  const operation = String(operationKey || '').toLowerCase();
  if (!operation.includes('siberia')) return false;
  return classifyTransportKind(transportMode).kind === TransportKind.UNKNOWN;
}

export function buildOwnTransportQuestion() {
  return 'Para esa zona, ¿cuentas con medio de transporte propio?';
}
