import { buildFutureSlot } from '../helpers/mockScheduler.js';

const OP_BOG = {
  id: 'op-bogota-parity',
  name: 'Operacion Bogota Parity',
  city: { id: 'city-bogota-parity', name: 'Bogota' }
};

const OP_IBAGUE = {
  id: 'op-ibague-parity',
  name: 'Operacion Ibague Parity',
  city: { id: 'city-ibague-parity', name: 'Ibague' }
};

const VACANCY = {
  id: 'vac-sched-parity',
  title: 'Mensajero Bogota Parity',
  role: 'Mensajero',
  city: 'Bogota',
  operationId: OP_BOG.id,
  operation: OP_BOG,
  operationAddress: 'Calle 80 # 10-20',
  interviewAddress: 'Calle 80 # 10-20',
  requirements: 'Conocimiento de direcciones y disponibilidad',
  conditions: 'Contrato por obra y proceso con entrevista',
  roleDescription: 'Mensajeria y entregas urbanas',
  requiredDocuments: 'Documento y hoja de vida',
  acceptingApplications: true,
  isActive: true,
  schedulingEnabled: true,
  updatedAt: new Date('2026-07-27T12:00:00.000Z')
};

const IBAGUE_VACANCY = {
  ...VACANCY,
  id: 'vac-ibague-only-parity',
  title: 'Auxiliar de Cargue Ibague Parity',
  role: 'Auxiliar de cargue y descargue',
  city: 'Ibague',
  operationId: OP_IBAGUE.id,
  operation: OP_IBAGUE,
  schedulingEnabled: false
};

function completeCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate-parity-scheduling',
    phone: overrides.phone || '573001119999',
    status: 'REGISTRADO',
    currentStep: 'SCHEDULING',
    vacancyId: VACANCY.id,
    fullName: 'Candidato Agenda Parity',
    documentType: 'CC',
    documentNumber: '1000000009',
    age: 28,
    gender: 'MALE',
    neighborhood: null,
    locality: 'Suba',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: null,
    experienceTime: null,
    cvData: Buffer.from('pdf'),
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf',
    reminderState: 'SKIPPED',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: null,
    lastInboundAt: new Date(),
    lastOutboundAt: null,
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides
  };
}

function initialCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate-parity-city',
    phone: overrides.phone || '573001118888',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    fullName: null,
    documentType: null,
    documentNumber: null,
    age: null,
    gender: 'UNKNOWN',
    neighborhood: null,
    locality: null,
    medicalRestrictions: null,
    transportMode: null,
    experienceInfo: null,
    experienceTime: null,
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderState: 'NONE',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: null,
    lastInboundAt: new Date(),
    lastOutboundAt: null,
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides
  };
}

function scheduledAtForSlot(slot) {
  const datePart = new Date(slot.specificDate).toISOString().slice(0, 10);
  return new Date(`${datePart}T${slot.startTime}:00-05:00`);
}

const offeredSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-offered',
  hoursFromNow: 8
});
const offeredAt = scheduledAtForSlot(offeredSlot);

const activeSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-active',
  hoursFromNow: 8
});
const alternativeSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-alternative',
  hoursFromNow: 14
});
const activeAt = scheduledAtForSlot(activeSlot);

const cancellationSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-cancellation',
  hoursFromNow: 10
});
const cancellationAt = scheduledAtForSlot(cancellationSlot);

const attendanceSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-attendance',
  hoursFromNow: 6
});
const attendanceAt = scheduledAtForSlot(attendanceSlot);

export const conversationParityCases = [
  {
    id: 'parity-schedule-confirmation',
    steps: ['ese horario me sirve'],
    candidate: completeCandidate({ currentStep: 'SCHEDULING' }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [offeredSlot],
    preMessages: [{
      direction: 'OUTBOUND',
      body: 'Te puedo ofrecer un horario disponible. Me confirmas si te sirve.',
      rawPayload: {
        source: 'interview_offer',
        slotId: offeredSlot.id,
        scheduledAt: offeredAt.toISOString(),
        formattedDate: 'horario ofrecido'
      },
      createdAt: new Date(Date.now() - 5 * 60 * 1000)
    }]
  },
  {
    id: 'parity-interview-reschedule',
    steps: ['no puedo asistir, necesito otro horario'],
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [activeSlot, alternativeSlot],
    interviewBookings: [{
      id: 'booking-parity-active',
      candidateId: 'candidate-parity-scheduling',
      vacancyId: VACANCY.id,
      slotId: activeSlot.id,
      scheduledAt: activeAt,
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderResponse: null,
      reminderWindowClosed: false,
      createdAt: new Date(Date.now() - 60 * 60 * 1000)
    }]
  },
  {
    id: 'parity-interview-cancellation',
    steps: ['quiero cancelar la entrevista'],
    candidate: completeCandidate({
      currentStep: 'SCHEDULED',
      reminderState: 'SCHEDULED',
      reminderScheduledFor: new Date(Date.now() + 60 * 60 * 1000)
    }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [cancellationSlot],
    interviewBookings: [{
      id: 'booking-parity-cancellation',
      candidateId: 'candidate-parity-scheduling',
      vacancyId: VACANCY.id,
      slotId: cancellationSlot.id,
      scheduledAt: cancellationAt,
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderResponse: null,
      reminderWindowClosed: false,
      createdAt: new Date(Date.now() - 60 * 60 * 1000)
    }]
  },
  {
    id: 'parity-attendance-confirmation',
    steps: ['sí'],
    candidate: completeCandidate({
      currentStep: 'SCHEDULED',
      reminderState: 'SENT',
      reminderScheduledFor: null
    }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [attendanceSlot],
    interviewBookings: [{
      id: 'booking-parity-attendance',
      candidateId: 'candidate-parity-scheduling',
      vacancyId: VACANCY.id,
      slotId: attendanceSlot.id,
      scheduledAt: attendanceAt,
      status: 'SCHEDULED',
      reminderSentAt: new Date(Date.now() - 5 * 60 * 1000),
      reminderResponse: null,
      reminderWindowClosed: true,
      createdAt: new Date(Date.now() - 60 * 60 * 1000)
    }]
  },
  {
    id: 'parity-no-available-slots',
    steps: ['quiero agendar la entrevista'],
    candidate: completeCandidate({
      currentStep: 'SCHEDULING',
      reminderState: 'SKIPPED',
      reminderScheduledFor: null
    }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [],
    interviewBookings: []
  },
  {
    id: 'parity-city-without-active-vacancies',
    steps: ['Desde Bogotá para trabajo de bodega'],
    candidate: initialCandidate(),
    vacancies: [IBAGUE_VACANCY],
    operations: [OP_IBAGUE],
    interviewSlots: [],
    interviewBookings: []
  }
];
