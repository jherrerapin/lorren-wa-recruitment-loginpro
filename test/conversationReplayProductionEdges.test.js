import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildVacancyResolutionText,
  hasRecentSameBotDecision,
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';
import { appendUniqueReplySegment } from '../src/services/replyComposition.js';
import { markConversationMessagesResponded } from '../src/services/conversationMessageRepository.js';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { createInMemoryReplayAdapters } from './conversation-replay/inMemoryAdapters.js';

const manifestPath = fileURLToPath(new URL('./conversation-replay/production-edge-coverage.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const REQUIRED_OBSERVABILITY_KEYS = [
  'source_by_field',
  'rejected_fields',
  'vacancy_resolution',
  'replyKind',
  'reason',
  'engine_loop_guard',
  'respondedAt'
];
const EXPECTED_CASE_IDS = [
  'explicit-labeled-accented-name',
  'name-after-explicit-request',
  'city-role-correction',
  'assigned-candidate-requests-another-vacancy',
  'trusted-metadata-contradicts-ambiguous-text',
  'generated-reply-already-has-follow-up',
  'delivery-before-responded-state-recovery',
  'paused-vacancy-ambiguous-repeat-window'
];

function operation(id, city) {
  return { id, name: `Operación ${city}`, city: { id: `city-${id}`, name: city } };
}

function vacancy(overrides = {}) {
  return {
    id: 'vac-neiva-aux',
    title: 'Auxiliar de cargue y descargue Neiva',
    role: 'Auxiliar de cargue y descargue',
    city: 'Neiva',
    operation: operation('neiva', 'Neiva'),
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function prismaFor(vacancies) {
  return {
    vacancy: {
      async findMany() {
        return vacancies;
      },
      async findUnique({ where }) {
        return vacancies.find((item) => item.id === where.id) || null;
      }
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-production-edge-test',
    status: 'EN_PROCESO',
    currentStep: 'COLLECTING_DATA',
    vacancyId: null,
    botResumeMode: null,
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    ...overrides
  };
}

async function resolveGate({ text, candidateState, currentVacancy = null, vacancies, vacancyHints = {} }) {
  return resolveVacancyFirstGate({
    prisma: prismaFor(vacancies),
    candidate: candidateState,
    currentVacancy,
    inboundText: text,
    currentStep: candidateState.currentStep,
    recentMessages: [],
    vacancyHints: {
      allVacancies: vacancies,
      activeVacancies: vacancies.filter((item) => item.isActive && item.acceptingApplications),
      ...vacancyHints
    }
  });
}

test('el manifiesto representa los ocho bordes de producción identificados en #423', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.cases.map((item) => item.id), EXPECTED_CASE_IDS);
  assert.equal(new Set(manifest.cases.map((item) => item.id)).size, EXPECTED_CASE_IDS.length);

  const fixtureIds = new Set(loadConversationFixtures().map(({ fixture }) => fixture.id));
  for (const item of manifest.cases) {
    assert.ok(['fixture_replay', 'authority_contract', 'recovery_contract'].includes(item.coverage));
    assert.ok(Array.isArray(item.authorities) && item.authorities.length > 0, `${item.id}: faltan autoridades`);
    assert.deepEqual(Object.keys(item.observability), REQUIRED_OBSERVABILITY_KEYS, `${item.id}: observabilidad incompleta`);
    assert.ok(Array.isArray(item.observability.rejected_fields), `${item.id}: rejected_fields debe ser arreglo`);

    if (item.coverage === 'fixture_replay') {
      assert.ok(fixtureIds.has(item.fixtureId), `${item.id}: fixture no encontrado: ${item.fixtureId}`);
    } else {
      assert.ok(Array.isArray(item.contractTests) && item.contractTests.length > 0, `${item.id}: faltan contratos`);
      for (const relativePath of item.contractTests) {
        const source = readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
        assert.ok(source.trim(), `${item.id}: contrato vacío: ${relativePath}`);
      }
    }
  }
});

test('una corrección actual de ciudad y cargo reemplaza el contexto histórico y ofrece la nueva vacante sin cambiarla todavía', async () => {
  const currentVacancy = vacancy();
  const targetVacancy = vacancy({
    id: 'vac-medellin-lider',
    title: 'Líder de operación Medellín',
    role: 'Líder de operación',
    city: 'Medellin',
    operation: operation('medellin', 'Medellin')
  });
  const text = 'No, en realidad es Medellín para líder de operación';
  const resolutionText = buildVacancyResolutionText(text, [
    { direction: 'INBOUND', body: 'Escribo desde Neiva para auxiliar de cargue y descargue' }
  ]);

  assert.equal(resolutionText, text);
  const decision = await resolveGate({
    text,
    candidateState: candidate({ vacancyId: currentVacancy.id }),
    currentVacancy,
    vacancies: [currentVacancy, targetVacancy]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_OFFERED');
  assert.equal(decision.vacancyId, targetVacancy.id);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.match(decision.reply, /no cambiará todavía/i);
});

test('una solicitud parcial de otra vacante no reutiliza metadata ni reemplaza la vacante actual', async () => {
  const currentVacancy = vacancy();
  const targetVacancy = vacancy({
    id: 'vac-medellin-lider',
    title: 'Líder de operación Medellín',
    role: 'Líder de operación',
    city: 'Medellin',
    operation: operation('medellin', 'Medellin')
  });

  const decision = await resolveGate({
    text: 'Quiero otra vacante en Medellín',
    candidateState: candidate({ vacancyId: currentVacancy.id }),
    currentVacancy,
    vacancies: [currentVacancy, targetVacancy],
    vacancyHints: { trustedVacancyId: currentVacancy.id, trustedVacancy: currentVacancy }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_NEEDS_TARGET');
  assert.equal(decision.candidateUpdates, undefined);
  assert.equal(decision.resolution.city, 'Medellin');
  assert.equal(decision.resolution.roleHint, null);
  assert.match(decision.reply, /cargo exacto/i);
});

test('metadata confiable conserva autoridad frente a texto ambiguo contradictorio', async () => {
  const trusted = vacancy({ id: 'vac-meta-neiva' });
  const textMatch = vacancy({
    id: 'vac-text-bogota',
    title: 'Auxiliar de bodega Bogotá',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: operation('bogota', 'Bogota')
  });

  const decision = await resolveGate({
    text: 'Vi algo de bodega en Bogotá pero no sé bien cuál era',
    candidateState: candidate({ currentStep: 'MENU' }),
    vacancies: [trusted, textMatch],
    vacancyHints: { trustedVacancyId: trusted.id, trustedVacancy: trusted }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, trusted.id);
  assert.equal(decision.resolution.reason, 'matched_trusted_active_vacancy');
  assert.equal(decision.resolution.source, 'metadata_config');
  assert.equal(decision.resolution.fallback, false);
});

test('el compositor no duplica un seguimiento que la respuesta generada ya contiene', () => {
  const generated = 'Estoy validando tus datos. Envíame tu HV como archivo PDF para cerrar el registro.';
  const deterministicFollowUp = 'Para continuar necesito que adjuntes tu hoja de vida como archivo PDF, DOC o DOCX.';

  assert.equal(appendUniqueReplySegment(generated, deterministicFollowUp), generated);
});

test('la entrega exige outbox persistido y respondedAt se actualiza mediante su repositorio explícito', async () => {
  const [{ fixture }] = loadConversationFixtures();
  const adapters = createInMemoryReplayAdapters(fixture);
  const candidateId = fixture.initialState.candidate.candidateId;
  const idempotencyKey = 'test-production-edge-outbox:reply:v1';
  const body = 'Respuesta comprometida de prueba';

  assert.throws(
    () => adapters.deliverOutbound({
      tenantContext: fixture.tenantContext,
      requestedCandidateId: candidateId,
      idempotencyKey,
      body
    }),
    /outbound_not_persisted:/
  );

  assert.equal(adapters.persistOutbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  }), true);
  assert.equal(adapters.deliverOutbound({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  }), true);

  let updateManyArgs = null;
  const respondedAt = new Date('2026-07-28T02:00:00.000Z');
  const result = await markConversationMessagesResponded({
    message: {
      async updateMany(args) {
        updateManyArgs = args;
        return { count: 2 };
      }
    }
  }, {
    messageIds: ['test-inbound-1', 'test-inbound-2'],
    respondedAt
  });

  assert.equal(result.updated, 2);
  assert.deepEqual(updateManyArgs.where.id.in, ['test-inbound-1', 'test-inbound-2']);
  assert.equal(updateManyArgs.data.respondedAt.toISOString(), respondedAt.toISOString());
});

test('la misma decisión de vacante se suprime dentro de diez minutos y vuelve a ser elegible fuera de la ventana', () => {
  const now = Date.now();
  const common = {
    direction: 'OUTBOUND',
    rawPayload: {
      actor: 'BOT',
      source: 'vacancy_first_gate',
      replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
      reason: 'INACTIVE_VACANCY'
    }
  };

  assert.equal(hasRecentSameBotDecision({
    recentMessages: [{ ...common, createdAt: new Date(now - 5 * 60 * 1000) }],
    replyKind: common.rawPayload.replyKind,
    reason: common.rawPayload.reason,
    windowMinutes: 10
  }), true);

  assert.equal(hasRecentSameBotDecision({
    recentMessages: [{ ...common, createdAt: new Date(now - 11 * 60 * 1000) }],
    replyKind: common.rawPayload.replyKind,
    reason: common.rawPayload.reason,
    windowMinutes: 10
  }), false);
});
