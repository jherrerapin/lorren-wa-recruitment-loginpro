import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Deterministic, non-reversible identity for a directive and its parameters. */
export function directiveKey(reply) {
  if (typeof reply?.directive !== 'string' || !reply.directive.trim()) return null;
  const serialized = JSON.stringify([reply.directive.trim(), canonical(reply.parameters ?? {})]);
  return createHash('sha256').update(serialized).digest('hex');
}
