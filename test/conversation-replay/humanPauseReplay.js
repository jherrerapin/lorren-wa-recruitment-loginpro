export const HUMAN_PAUSE_REPLAYS = Object.freeze([
  {
    id: 'conv-011-human-pause-retried-inbound-v1',
    sourceConversation: 'CONV-011',
    title: 'Un inbound ya persistido no vuelve a disparar consentimiento después de una intervención humana',
    candidate: {
      id: 'candidate-conv-011-replay',
      phone: '573000000011',
      vacancyId: 'vacancy-conv-011-replay',
      dataConsentStatus: 'PENDING',
      currentStep: 'GREETING_SENT',
      fullName: null,
      botPaused: true,
      botPausedAt: '2026-07-30T11:05:29.264Z',
      botPausedBy: 'recruiter-replay',
      botPauseReason: 'Mensaje manual de información de vacante enviado desde dashboard',
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    },
    history: [
      {
        direction: 'OUTBOUND',
        actor: 'HUMAN',
        body: 'Te comparto la información registrada de la vacante. Si te interesa continuar, me confirmas.'
      }
    ],
    inbound: {
      id: 'wamid-replay-conv-011-existing',
      from: '573000000011',
      type: 'text',
      text: { body: 'Quiero más información.' }
    },
    persistedInboundIds: ['wamid-replay-conv-011-existing'],
    expected: {
      nextCalls: 0,
      statuses: [200],
      resumeUpdates: 0,
      outboundMessages: 0,
      payloadMessageCount: 0,
      botPaused: true,
      botResumeMode: 'manual_resume_dashboard'
    }
  },
  {
    id: 'conv-019-human-pause-new-inbound-v1',
    sourceConversation: 'CONV-019',
    title: 'Un inbound nuevo reanuda la automatización desde el contexto vigente antes de continuar',
    candidate: {
      id: 'candidate-conv-019-replay',
      phone: '573000000019',
      vacancyId: 'vacancy-conv-019-replay',
      dataConsentStatus: 'ACCEPTED',
      currentStep: 'COLLECTING_DATA',
      fullName: 'Candidato de prueba',
      documentType: 'CC',
      documentNumber: '1000000019',
      age: 34,
      neighborhood: 'Barrio de prueba',
      medicalRestrictions: 'Sin restricciones medicas',
      transportMode: null,
      botPaused: true,
      botPausedAt: '2026-07-30T02:13:40.755Z',
      botPausedBy: 'recruiter-replay',
      botPauseReason: 'Solicitud manual de hoja de vida enviada desde dashboard',
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    },
    history: [
      {
        direction: 'OUTBOUND',
        actor: 'HUMAN',
        body: 'Para continuar necesito tu hoja de vida como archivo PDF o Word/DOCX.'
      }
    ],
    inbound: {
      id: 'wamid-replay-conv-019-new',
      from: '573000000019',
      type: 'text',
      text: { body: 'De acuerdo, la enviaré.' }
    },
    persistedInboundIds: [],
    expected: {
      nextCalls: 1,
      statuses: [],
      resumeUpdates: 1,
      outboundMessages: 0,
      payloadMessageCount: 1,
      botPaused: false,
      botResumeMode: 'resumed_by_candidate_inbound',
      preserved: {
        vacancyId: 'vacancy-conv-019-replay',
        dataConsentStatus: 'ACCEPTED',
        currentStep: 'COLLECTING_DATA',
        transportMode: null
      }
    }
  }
]);
