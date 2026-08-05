export const CONSENT_ORDER_REPLAYS = Object.freeze([
  {
    id: 'conv-004-greeting-without-consent-v1',
    sourceConversation: 'CONV-004',
    title: 'Un saludo inicial no equivale a interés ni activa consentimiento',
    candidate: {
      id: 'candidate-conv-004-replay',
      phone: 'TEST-PHONE-CONV-004',
      vacancyId: null,
      dataConsentStatus: 'PENDING',
      currentStep: 'MENU',
      botResumeMode: null,
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-004-GREETING',
      from: 'TEST-PHONE-CONV-004',
      type: 'text',
      text: { body: 'Hola, buenos días.' }
    },
    expected: {
      gateBlock: false,
      reason: 'consent_not_required_for_this_turn',
      outboundCount: 0,
      nextCalls: 1
    }
  },
  {
    id: 'conv-034-salary-question-without-consent-v1',
    sourceConversation: 'CONV-034',
    title: 'Una pregunta de salario no equivale a interés explícito',
    candidate: {
      id: 'candidate-conv-034-replay',
      phone: 'TEST-PHONE-CONV-034',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-034-SALARY',
      from: 'TEST-PHONE-CONV-034',
      type: 'text',
      text: { body: '¿Cuál es el salario?' }
    },
    expected: {
      gateBlock: false,
      reason: 'consent_not_required_for_this_turn',
      outboundCount: 0,
      nextCalls: 1
    }
  },
  {
    id: 'conv-065-schedule-question-without-consent-v1',
    sourceConversation: 'CONV-065',
    title: 'Una pregunta de horario no equivale a interés explícito',
    candidate: {
      id: 'candidate-conv-065-replay',
      phone: 'TEST-PHONE-CONV-065',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-065-SCHEDULE',
      from: 'TEST-PHONE-CONV-065',
      type: 'text',
      text: { body: '¿Qué horarios manejan?' }
    },
    expected: {
      gateBlock: false,
      reason: 'consent_not_required_for_this_turn',
      outboundCount: 0,
      nextCalls: 1
    }
  },
  {
    id: 'conv-062-vacancy-confirmation-before-consent-v1',
    sourceConversation: 'CONV-062',
    title: 'Confirmar la vacante presenta información y pregunta interés antes del consentimiento',
    candidate: {
      id: 'candidate-conv-062-replay',
      phone: 'TEST-PHONE-CONV-062',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'campaign_vacancy_pending_confirmation',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-062-CONFIRM',
      from: 'TEST-PHONE-CONV-062',
      type: 'text',
      text: { body: 'Sí, esa es la vacante.' }
    },
    expected: {
      outboundCount: 1,
      nextCalls: 0,
      includes: ['¿Te interesa continuar con esta postulación?'],
      excludes: ['Autorizo a LoginPro', 'si autorizas'],
      finalStep: 'GREETING_SENT',
      finalResumeMode: 'awaiting_application_interest'
    }
  },
  {
    id: 'conv-039-explicit-interest-prompts-once-v1',
    sourceConversation: 'CONV-039',
    title: 'El interés explícito después de la vacante activa una solicitud de consentimiento',
    candidate: {
      id: 'candidate-conv-039-replay',
      phone: 'TEST-PHONE-CONV-039',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-039-INTEREST',
      from: 'TEST-PHONE-CONV-039',
      type: 'text',
      text: { body: 'Sí, quiero postularme y participar en el proceso.' }
    },
    expected: {
      gateBlock: true,
      reason: 'candidate_wants_to_continue',
      outboundCount: 1,
      nextCalls: 0,
      includes: ['Autorizo a LoginPro'],
      finalResumeMode: 'awaiting_data_consent'
    }
  },
  {
    id: 'accepted-consent-is-not-requested-again-v1',
    sourceConversation: 'CONV-039',
    title: 'Una autorización aceptada no se solicita nuevamente',
    candidate: {
      id: 'candidate-accepted-replay',
      phone: 'TEST-PHONE-ACCEPTED',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'ACCEPTED',
      currentStep: 'COLLECTING_DATA',
      botResumeMode: null,
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-ACCEPTED-NEXT',
      from: 'TEST-PHONE-ACCEPTED',
      type: 'text',
      text: { body: 'Mi edad es 30 años.' }
    },
    expected: {
      gateBlock: false,
      reason: 'consent_already_accepted',
      outboundCount: 0,
      nextCalls: 1
    }
  },
  {
    id: 'rejected-consent-is-not-requested-again-v1',
    sourceConversation: 'CONV-004',
    title: 'Un consentimiento rechazado no vuelve a solicitarse',
    candidate: {
      id: 'candidate-rejected-replay',
      phone: 'TEST-PHONE-REJECTED',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'REVOKED',
      currentStep: 'DONE',
      botResumeMode: null,
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-REJECTED-NEXT',
      from: 'TEST-PHONE-REJECTED',
      type: 'text',
      text: { body: 'Quiero información.' }
    },
    expected: {
      gateBlock: true,
      reason: 'consent_revoked',
      outboundCount: 0,
      nextCalls: 0
    }
  },
  {
    id: 'conv-007-revoked-consent-is-not-requested-again-v1',
    sourceConversation: 'CONV-007',
    title: 'Una revocación persistida no reabre ni repite el consentimiento',
    candidate: {
      id: 'candidate-conv-007-replay',
      phone: 'TEST-PHONE-CONV-007',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'REVOKED',
      currentStep: 'DONE',
      botResumeMode: null,
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-007-AFTER-REVOCATION',
      from: 'TEST-PHONE-CONV-007',
      type: 'text',
      text: { body: 'Listo.' }
    },
    expected: {
      gateBlock: true,
      reason: 'consent_revoked',
      outboundCount: 0,
      nextCalls: 0
    }
  },
  {
    id: 'question-during-consent-is-answered-v1',
    sourceConversation: 'CONV-034',
    title: 'Una pregunta durante el consentimiento se responde antes de retomarlo',
    candidate: {
      id: 'candidate-consent-question-replay',
      phone: 'TEST-PHONE-CONSENT-QUESTION',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_data_consent',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONSENT-QUESTION',
      from: 'TEST-PHONE-CONSENT-QUESTION',
      type: 'text',
      text: { body: '¿Para qué van a usar mis datos?' }
    },
    expected: {
      gateBlock: true,
      reason: 'consent_pending',
      outboundCount: 1,
      nextCalls: 0,
      includesInOrder: ['gestionar tu postulación', 'Para continuar necesito saber si autorizas'],
      finalResumeMode: 'awaiting_data_consent'
    }
  },
  {
    id: 'consent-answer-resumes-pending-context-v1',
    sourceConversation: 'CONV-034',
    title: 'Después de responder una pregunta se conserva el contexto pendiente de consentimiento',
    candidate: {
      id: 'candidate-consent-resume-replay',
      phone: 'TEST-PHONE-CONSENT-RESUME',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_data_consent',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONSENT-RESUME',
      from: 'TEST-PHONE-CONSENT-RESUME',
      type: 'text',
      text: { body: 'Entiendo, sí autorizo.' }
    },
    expected: {
      resumeStep: 'COLLECTING_DATA',
      resumeMode: null
    }
  },
  {
    id: 'conv-008-attachment-before-interest-v1',
    sourceConversation: 'CONV-008',
    title: 'Un archivo sin interés explícito no activa consentimiento',
    candidate: {
      id: 'candidate-conv-008-replay',
      phone: 'TEST-PHONE-CONV-008',
      vacancyId: 'vacancy-consent-order',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    inbound: {
      id: 'TEST-WAMID-CONV-008-ATTACHMENT',
      from: 'TEST-PHONE-CONV-008',
      type: 'document',
      document: { id: 'TEST-MEDIA-CONV-008', filename: 'TEST-CV-CONV-008.pdf', mime_type: 'application/pdf' }
    },
    expected: {
      gateBlock: true,
      reason: 'attachment_before_consent',
      outboundCount: 1,
      nextCalls: 0,
      includes: ['todavía no lo descargué', 'confírmame si deseas postularte'],
      excludes: ['Autorizo a LoginPro', 'si autorizas'],
      finalStep: 'GREETING_SENT',
      finalResumeMode: 'pre_consent_cv_resend'
    }
  }
]);
