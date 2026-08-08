export const VACANCY_CONSENT_ORDER_REPLAYS = Object.freeze([
  {
    id: 'conv-034-salary-before-interest-v1',
    sourceConversation: 'CONV-034',
    title: 'Resolver la vacante responde salario y pregunta interés antes de pedir datos',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-034-VACANCY',
      phone: 'TEST-PHONE-CONV-034-VACANCY',
      vacancyId: null,
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: null
    },
    inboundText: 'Estoy en Neiva para auxiliar de bodega. ¿Cuál es el salario?',
    expected: {
      reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
      replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
      includes: ['condiciones registradas', '(te interesa continuar|deseas postularte)'],
      excludes: ['nombre completo', 'documento', 'edad', 'transporte', 'hoja de vida'],
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest'
    }
  },
  {
    id: 'conv-037-requirements-before-interest-v1',
    sourceConversation: 'CONV-037',
    title: 'Resolver la vacante responde requisitos antes de preguntar interés',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-037-VACANCY',
      phone: 'TEST-PHONE-CONV-037-VACANCY',
      vacancyId: null,
      dataConsentStatus: 'PENDING',
      currentStep: 'MENU',
      botResumeMode: null
    },
    inboundText: 'Quiero información de auxiliar de bodega en Neiva. ¿Qué requisitos tiene?',
    expected: {
      reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
      replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
      includes: ['requisitos registrados', '(te interesa continuar|deseas postularte)'],
      excludes: ['nombre completo', 'documento', 'edad', 'transporte', 'hoja de vida'],
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest'
    }
  },
  {
    id: 'conv-039-explicit-interest-with-vacancy-resolution-v1',
    sourceConversation: 'CONV-039',
    title: 'El interés incluido en el primer mensaje no permite saltar la presentación de la vacante',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-039-VACANCY',
      phone: 'TEST-PHONE-CONV-039-VACANCY',
      vacancyId: null,
      dataConsentStatus: 'PENDING',
      currentStep: 'MENU',
      botResumeMode: null
    },
    inboundText: 'Quiero postularme a auxiliar de bodega en Neiva.',
    expected: {
      reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
      replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
      includes: ['(te comparto la información|encontré la vacante)', '(te interesa continuar|deseas postularte)'],
      excludes: ['nombre completo', 'documento', 'edad', 'transporte', 'hoja de vida', 'Autorizo a LoginPro'],
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest'
    }
  }
]);
