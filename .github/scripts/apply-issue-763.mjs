import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const fixturePath = 'test/fixtures/conversationParityCases.js';
fs.writeFileSync(fixturePath, `import { buildFutureSlot } from '../helpers/mockScheduler.js';

const OP_BOG = {
  id: 'op-bogota-parity',
  name: 'Operacion Bogota Parity',
  city: { id: 'city-bogota-parity', name: 'Bogota' }
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

function scheduledAtForSlot(slot) {
  const datePart = new Date(slot.specificDate).toISOString().slice(0, 10);
  return new Date(\`\${datePart}T\${slot.startTime}:00-05:00\`);
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
      reminderWindowClosed: false,
      createdAt: new Date(Date.now() - 60 * 60 * 1000)
    }]
  }
];
`);

const runnerPath = 'test/helpers/runConversationParityCases.js';
let runner = fs.readFileSync(runnerPath, 'utf8');
runner = replaceOnce(
  runner,
  `import { conversationCases } from '../fixtures/conversationCases.js';\nimport { buildParitySnapshot, runConversationCase } from './conversationHarness.js';`,
  `import { conversationCases } from '../fixtures/conversationCases.js';\nimport { conversationParityCases } from '../fixtures/conversationParityCases.js';\nimport { buildParitySnapshot, runConversationCase } from './conversationHarness.js';`,
  'import de fixtures focales'
);
runner = replaceOnce(
  runner,
  `  const byId = new Map(conversationCases.map((item) => [item.id, item]));`,
  `  const byId = new Map(\n    [...conversationCases, ...conversationParityCases].map((item) => [item.id, item])\n  );`,
  'catálogo combinado de casos'
);
fs.writeFileSync(runnerPath, runner);

const parityPath = 'test/conversationEngineParity.test.js';
let parity = fs.readFileSync(parityPath, 'utf8');
parity = replaceOnce(
  parity,
  `{ key: 'schedule_confirmation', caseId: 'scheduling-offer-reschedule-confirm', coverage: 'text' }`,
  `{ key: 'schedule_confirmation', caseId: 'parity-schedule-confirmation', coverage: 'text' }`,
  'fixture independiente de confirmación'
);
parity = replaceOnce(
  parity,
  `{ key: 'interview_reschedule', caseId: 'scheduling-offer-reschedule-confirm', coverage: 'text' }`,
  `{ key: 'interview_reschedule', caseId: 'parity-interview-reschedule', coverage: 'text' }`,
  'fixture independiente de reprogramación'
);
parity = replaceOnce(
  parity,
  `test('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {`,
  `test('confirmación y reprogramación usan fixtures focales independientes', () => {\n  const confirmation = SCENARIOS.find((item) => item.key === 'schedule_confirmation');\n  const reschedule = SCENARIOS.find((item) => item.key === 'interview_reschedule');\n  assert.equal(confirmation.caseId, 'parity-schedule-confirmation');\n  assert.equal(reschedule.caseId, 'parity-interview-reschedule');\n  assert.notEqual(confirmation.caseId, reschedule.caseId);\n});\n\ntest('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {`,
  'contrato de independencia de fixtures'
);
fs.writeFileSync(parityPath, parity);

console.log('Issue #763 aplicado correctamente.');
