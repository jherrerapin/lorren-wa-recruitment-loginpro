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
  },
  {
    id: 'conv-007-punctuated-withdrawal-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Quiero retirar mi autorización y detener el proceso?',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-punctuated-revoke-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Deseo revocar mi consentimiento?',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-polite-delete-command-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Eliminen mis datos, por favor?',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-polite-rights-question-delete-v1',
    sourceConversation: 'CONV-007',
    kind: 'RIGHTS_QUESTION',
    body: 'Por favor, ¿cómo puedo eliminar mis datos si más adelante lo necesito?',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-polite-rights-question-revoke-v1',
    sourceConversation: 'CONV-007',
    kind: 'RIGHTS_QUESTION',
    body: 'Por favor, ¿qué debo hacer para revocar la autorización después?',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-rights-question-location-v1',
    sourceConversation: 'CONV-007',
    kind: 'RIGHTS_QUESTION',
    body: '¿Dónde puedo solicitar la eliminación de mis datos?',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-non-consent-refusal-sunday-v1',
    sourceConversation: 'CONV-007',
    kind: 'CONDITION_REFUSAL',
    body: 'No doy permiso para trabajar el domingo.',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-non-consent-refusal-shift-v1',
    sourceConversation: 'CONV-007',
    kind: 'CONDITION_REFUSAL',
    body: 'No autorizo ese turno.',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-non-consent-refusal-schedule-v1',
    sourceConversation: 'CONV-007',
    kind: 'CONDITION_REFUSAL',
    body: 'No acepto ese horario.',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-non-consent-refusal-salary-v1',
    sourceConversation: 'CONV-007',
    kind: 'CONDITION_REFUSAL',
    body: 'No estoy de acuerdo con el salario.',
    expectedBoundary: { block: false, reason: 'consent_already_accepted' }
  },
  {
    id: 'conv-007-reject-data-treatment-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'No autorizo el tratamiento de mis datos.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-reject-cv-retention-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'No acepto que conserven mi hoja de vida.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  },
  {
    id: 'conv-007-withdraw-consent-v1',
    sourceConversation: 'CONV-007',
    kind: 'REVOCATION',
    body: 'Retiro mi consentimiento.',
    expectedBoundary: { block: true, reason: 'explicit_consent_revocation' }
  }
]);
