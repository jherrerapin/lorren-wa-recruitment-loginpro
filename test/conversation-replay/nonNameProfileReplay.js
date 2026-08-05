export const NON_NAME_PROFILE_REPLAYS = Object.freeze([
  {
    id: 'conv-032-profession-is-not-name-v1',
    sourceConversation: 'CONV-032',
    title: 'Una profesión expresada con “soy” no se guarda como nombre',
    inbound: 'Sí señora, yo soy administrador logístico retirado de la fuerza pública.',
    proposedFields: {
      fullName: 'Administrador Logístico',
      experienceInfo: 'Sí',
      experienceSummary: 'Administrador logístico retirado de la fuerza pública.'
    },
    sourceByField: {
      fullName: 'engine',
      experienceInfo: 'engine',
      experienceSummary: 'engine'
    },
    expected: {
      rejectedFields: ['fullName'],
      persistedFields: ['experienceInfo', 'experienceSummary'],
      fullName: null
    }
  },
  {
    id: 'conv-064-trait-is-not-name-v1',
    sourceConversation: 'CONV-064',
    title: 'Un rasgo personal después de “soy” no se interpreta como nombre',
    inbound: 'He trabajado en atención al cliente, me interesa aplicar y soy muy enfocado.',
    expected: {
      parsedFullName: null,
      suspiciousCandidate: 'Muy Enfocado'
    }
  },
  {
    id: 'valid-explicit-name-remains-supported-v1',
    sourceConversation: 'CONV-064',
    title: 'Un nombre explícito real sigue siendo aceptado',
    inbound: 'Me llamo José Luis Pérez.',
    expected: {
      parsedFullName: 'José Luis Pérez'
    }
  },
  {
    id: 'valid-name-corrects-suspicious-persisted-value-v1',
    sourceConversation: 'CONV-032',
    title: 'Un nombre válido corrige un valor no nominal persistido previamente',
    candidate: {
      fullName: 'Administrador Logístico'
    },
    proposedFields: {
      fullName: 'José Luis Pérez'
    },
    sourceByField: {
      fullName: 'local'
    },
    expected: {
      persistedFullName: 'José Luis Pérez',
      consolidatedFields: ['fullName']
    }
  }
]);
