import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProfessionalVacancyPresentation } from '../src/services/vacancyPublicInfo.js';
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

test('la ficha pública de una vacante zonificada prioriza la ubicación real y no la ciudad administrativa', () => {
  const presentation = buildProfessionalVacancyPresentation(vacancy({
    title: 'Auxiliar Cargue y Descargue Siberia',
    city: 'Bogota',
    operation: operation('bogota', 'Bogota'),
    operationAddress: 'Parques Logísticos Siberia, Metropolitano, Tierrapuerto, Celta',
    roleDescription: 'Cargue y descargue de mercancía',
    requirements: 'Experiencia mínima de 3 meses',
    conditions: 'Vinculación inmediata',
    requiredDocuments: 'Documento de identidad y hoja de vida'
  }), { includeInterestPrompt: true });

  assert.match(presentation, /\*Zona de trabajo:\* Parques Logísticos Siberia, Metropolitano, Tierrapuerto, Celta/);
  assert.doesNotMatch(presentation, /\*Ciudad:\*\s*Bogota/i);
  assert.doesNotMatch(presentation, /Documentación para el proceso/i);
  assert.doesNotMatch(presentation, /Documento de identidad y hoja de vida/i);
  assert.match(presentation, /¿Te interesa continuar con esta vacante\?/i);
});

test('la ficha pública conserva ciudad sin zona y permite documentos solo cuando una etapa los solicita explícitamente', () => {
  const withoutZone = buildProfessionalVacancyPresentation(vacancy({
    title: 'Auxiliar de operación Neiva',
    city: 'Neiva',
    operation: operation('neiva', 'Neiva'),
    operationAddress: '',
    requiredDocuments: 'Documento de identidad de prueba'
  }));

  assert.match(withoutZone, /\*Ciudad:\* Neiva/);
  assert.doesNotMatch(withoutZone, /Documentación para el proceso/i);

  const laterStage = buildProfessionalVacancyPresentation(vacancy({
    title: 'Auxiliar de operación Neiva',
    city: 'Neiva',
    operation: operation('neiva', 'Neiva'),
    operationAddress: '',
    requiredDocuments: 'Documento de identidad de prueba'
  }), { includeDocuments: true });

  assert.match(laterStage, /\*Documentación para el proceso\*/);
  assert.match(laterStage, /Documento de identidad de prueba/);
});
