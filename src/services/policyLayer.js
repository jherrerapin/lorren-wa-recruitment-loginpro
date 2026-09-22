/**
 * Adaptador transitorio de compatibilidad.
 *
 * Los campos que llegan aquí ya fueron curados por conversationUnderstanding /
 * fieldSanitizer. Esta capa no vuelve a interpretar lenguaje ni confianza; solo
 * conserva el contrato histórico mientras se retira FF_POLICY_LAYER del
 * orquestador.
 */
export function applyFieldPolicy(extraction = {}, currentCandidate = {}) {
  const fields = extraction?.fields && typeof extraction.fields === 'object'
    ? extraction.fields
    : {};

  return {
    persistedFields: { ...fields },
    reviewQueue: [],
    blocked: [],
    protectedDiscardFields: [],
    shouldPreventAutoDiscard: false,
    metadata: {
      blockedCount: 0,
      reviewCount: 0,
      criticalProtectionActive: false
    },
    currentCandidate
  };
}
