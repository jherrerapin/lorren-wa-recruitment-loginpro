export const CONSENT_REVOCATION_STABILIZATION_REPLAYS = Object.freeze([
  {
    id: 'conv-007-rights-question-v1',
    sourceConversation: 'CONV-007',
    kind: 'RIGHTS_QUESTION',
    body: '¿Cómo puedo eliminar mis datos si más adelante lo necesito?',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-delete-command-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Eliminen mis datos y detengan mi postulación.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-explicit-rejection-authorize-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'No autorizo el tratamiento de mis datos.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-explicit-rejection-permission-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'No doy permiso para usar mis datos.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-revocatoria-noun-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Solicito la revocatoria de esta autorización.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-ordinary-accepted-v1',
    sourceConversation: 'CONV-007',
    kind: 'ORDINARY',
    body: 'Tengo experiencia en inventarios y despacho.',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-rights-information-v1',
    sourceConversation: 'CONV-007',
    kind: 'RIGHTS_QUESTION',
    body: '¿Puedo revocar la autorización después?',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  }
]);
