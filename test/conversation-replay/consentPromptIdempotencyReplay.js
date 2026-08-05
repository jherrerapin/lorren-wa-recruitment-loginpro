export const CONSENT_PROMPT_IDEMPOTENCY_REPLAYS = Object.freeze([
  {
    id: 'conv-065-consent-prompt-webhook-retry-v1',
    sourceConversation: 'CONV-065',
    title: 'El reintento del mismo webhook no vuelve a solicitar consentimiento',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-065-IDEMPOTENCY',
      phone: 'TEST-PHONE-CONV-065-IDEMPOTENCY',
      vacancyId: 'TEST-VACANCY-CONSENT-IDEMPOTENCY',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    deliveries: [
      [{
        id: 'TEST-WAMID-CONV-065-INTEREST',
        from: 'TEST-PHONE-CONV-065-IDEMPOTENCY',
        type: 'text',
        text: { body: 'Quiero postularme y continuar con el proceso.' }
      }],
      [{
        id: 'TEST-WAMID-CONV-065-INTEREST',
        from: 'TEST-PHONE-CONV-065-IDEMPOTENCY',
        type: 'text',
        text: { body: 'Quiero postularme y continuar con el proceso.' }
      }]
    ],
    expected: {
      outboundMessages: 1,
      inboundClaims: 1,
      consentPromptCount: 1,
      finalPending: true
    }
  },
  {
    id: 'conv-062-fragmented-interest-single-prompt-v1',
    sourceConversation: 'CONV-062',
    title: 'Dos fragmentos del mismo turno lógico producen una sola solicitud',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-062-FRAGMENTS',
      phone: 'TEST-PHONE-CONV-062-FRAGMENTS',
      vacancyId: 'TEST-VACANCY-CONSENT-IDEMPOTENCY',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_application_interest',
      botPaused: false
    },
    deliveries: [[
      {
        id: 'TEST-WAMID-CONV-062-FRAGMENT-1',
        from: 'TEST-PHONE-CONV-062-FRAGMENTS',
        type: 'text',
        text: { body: 'Quiero postularme.' }
      },
      {
        id: 'TEST-WAMID-CONV-062-FRAGMENT-2',
        from: 'TEST-PHONE-CONV-062-FRAGMENTS',
        type: 'text',
        text: { body: 'También tengo experiencia relacionada.' }
      }
    ]],
    expected: {
      outboundMessages: 1,
      inboundClaims: 2,
      consentPromptCount: 1,
      finalPending: true
    }
  },
  {
    id: 'conv-034-pending-question-retry-v1',
    sourceConversation: 'CONV-034',
    title: 'Una pregunta durante consentimiento se responde una vez ante reintento',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-034-PENDING-QUESTION',
      phone: 'TEST-PHONE-CONV-034-PENDING-QUESTION',
      vacancyId: 'TEST-VACANCY-CONSENT-IDEMPOTENCY',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_data_consent',
      botPaused: false
    },
    deliveries: [
      [{
        id: 'TEST-WAMID-CONV-034-CONSENT-QUESTION',
        from: 'TEST-PHONE-CONV-034-PENDING-QUESTION',
        type: 'text',
        text: { body: '¿Para qué van a usar mis datos?' }
      }],
      [{
        id: 'TEST-WAMID-CONV-034-CONSENT-QUESTION',
        from: 'TEST-PHONE-CONV-034-PENDING-QUESTION',
        type: 'text',
        text: { body: '¿Para qué van a usar mis datos?' }
      }]
    ],
    expected: {
      outboundMessages: 1,
      inboundClaims: 1,
      clarifierCount: 1,
      finalPending: true
    }
  },
  {
    id: 'conv-008-pending-attachment-no-second-prompt-v1',
    sourceConversation: 'CONV-008',
    title: 'Un adjunto fragmentado mientras el consentimiento está pendiente no repite el aviso',
    candidate: {
      id: 'TEST-CANDIDATE-CONV-008-PENDING-ATTACHMENT',
      phone: 'TEST-PHONE-CONV-008-PENDING-ATTACHMENT',
      vacancyId: 'TEST-VACANCY-CONSENT-IDEMPOTENCY',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      botResumeMode: 'awaiting_data_consent',
      botPaused: false
    },
    deliveries: [[{
      id: 'TEST-WAMID-CONV-008-PENDING-ATTACHMENT',
      from: 'TEST-PHONE-CONV-008-PENDING-ATTACHMENT',
      type: 'document',
      document: {
        id: 'TEST-MEDIA-CONV-008-PENDING',
        filename: 'TEST-CV-CONV-008-PENDING.pdf',
        mime_type: 'application/pdf'
      }
    }]],
    expected: {
      outboundMessages: 0,
      inboundClaims: 1,
      consentPromptCount: 0,
      finalPending: true,
      cvResendRequired: true
    }
  }
]);
