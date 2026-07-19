import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`${label}_source_not_unique`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

// CandidateStateService: contrato compuesto y estrecho para mark_no_interest.
{
  const path = 'src/services/candidateStateService.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "import { ConversationStep } from '@prisma/client';",
    "import { ConversationStep, ReminderState } from '@prisma/client';",
    'candidate_state_prisma_import'
  );

  const anchor = `export async function transitionCandidateConversationStep(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expectedStep = requireConversationStep(
    input.expected?.currentStep,
    'candidate_expected_current_step'
  );
  const nextStep = requireConversationStep(input.nextStep, 'candidate_next_step');

  if (expectedStep === nextStep) {
    throw new TypeError('candidate_conversation_step_noop');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      currentStep: expectedStep
    },
    data: {
      currentStep: nextStep
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expectedStep,
    nextStep
  };
}`;

  const replacement = `${anchor}

function requireReminderState(value, fieldName) {
  if (typeof value !== 'string' || !Object.values(ReminderState).includes(value)) {
    throw new TypeError(\`${'${fieldName}'}_invalid\`);
  }
  return value;
}

function normalizeNoInterestSnapshot(expected = {}) {
  if (!Object.hasOwn(expected, 'reminderScheduledFor')) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }

  return {
    currentStep: requireConversationStep(
      expected.currentStep,
      'candidate_no_interest_current_step'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_no_interest_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_no_interest_reminder_state'
    )
  };
}

function noInterestExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function completeCandidateNoInterestTransition(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeNoInterestSnapshot(input.expected);

  if (expected.currentStep === ConversationStep.DONE) {
    throw new TypeError('candidate_no_interest_already_done');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...noInterestExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.DONE,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    nextStep: ConversationStep.DONE,
    nextReminderState: ReminderState.SKIPPED
  };
}`;

  source = replaceOnce(source, anchor, replacement, 'candidate_no_interest_contract');
  write(path, source);
}

// conversationEngine: delegar solo el conjunto exacto del cierre por falta de interés.
{
  const path = 'src/services/conversationEngine.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "import { transitionCandidateConversationStep } from './candidateStateService.js';",
    `import {
  completeCandidateNoInterestTransition,
  transitionCandidateConversationStep
} from './candidateStateService.js';`,
    'conversation_engine_candidate_state_import'
  );
  source = replaceOnce(
    source,
    "  const { CandidateStatus, ConversationStep, Gender } = await import('@prisma/client');",
    "  const { CandidateStatus, ConversationStep, Gender, ReminderState } = await import('@prisma/client');",
    'conversation_engine_prisma_import'
  );
  source = replaceOnce(
    source,
    `  const normalizedActions = Array.isArray(actions) ? actions : [];
  const mergedRawFields = Object.keys(candidateFields || {}).length`,
    `  const normalizedActions = Array.isArray(actions) ? actions : [];
  const hasMarkNoInterestAction = normalizedActions.some((action) => action?.type === 'mark_no_interest');
  const mergedRawFields = Object.keys(candidateFields || {}).length`,
    'conversation_engine_no_interest_marker'
  );

  const oldTransitionBlock = `  const pendingUpdateKeys = Object.keys(pendingUpdate);
  const hasSimpleStepTransition = hasStepTransition
    && pendingUpdateKeys.length === 1
    && pendingUpdateKeys[0] === 'currentStep';
  let stepTransition = null;

  if (hasSimpleStepTransition) {
    delete pendingUpdate.currentStep;
    stepTransition = await transitionCandidateConversationStep(prisma, {
      candidateId: candidate.id,
      expected: { currentStep: candidate.currentStep },
      nextStep: finalStep
    }).catch((error) => {
      console.error('[ACT_STEP_TRANSITION_ERROR]', error?.message);
      return {
        count: 0,
        candidate: null,
        expectedStep: candidate.currentStep,
        nextStep: finalStep,
        error: error?.message || 'candidate_step_transition_error'
      };
    });

    const transitionApplied = stepTransition.count === 1;
    const observedStep = stepTransition.candidate?.currentStep || candidate.currentStep;
    stepTransition = {
      ...stepTransition,
      conflict: !transitionApplied,
      observedStep
    };
    if (!transitionApplied) finalStep = observedStep;
  }`;

  const newTransitionBlock = `  const pendingUpdateKeys = Object.keys(pendingUpdate);
  const noInterestUpdateFields = ['currentStep', 'reminderScheduledFor', 'reminderState'];
  const hasNoInterestTransition = hasStepTransition
    && finalStep === ConversationStep.DONE
    && hasMarkNoInterestAction
    && pendingUpdateKeys.length === noInterestUpdateFields.length
    && noInterestUpdateFields.every((field) => pendingUpdateKeys.includes(field))
    && pendingUpdate.reminderScheduledFor === null
    && pendingUpdate.reminderState === ReminderState.SKIPPED;
  const hasSimpleStepTransition = hasStepTransition
    && pendingUpdateKeys.length === 1
    && pendingUpdateKeys[0] === 'currentStep';
  let stepTransition = null;

  if (hasNoInterestTransition) {
    delete pendingUpdate.currentStep;
    delete pendingUpdate.reminderScheduledFor;
    delete pendingUpdate.reminderState;
    stepTransition = await completeCandidateNoInterestTransition(prisma, {
      candidateId: candidate.id,
      expected: {
        currentStep: candidate.currentStep,
        reminderScheduledFor: candidate.reminderScheduledFor,
        reminderState: candidate.reminderState
      }
    }).catch((error) => {
      console.error('[ACT_NO_INTEREST_TRANSITION_ERROR]', error?.message);
      return {
        count: 0,
        candidate: null,
        error: error?.message || 'candidate_no_interest_transition_error'
      };
    });

    const transitionApplied = stepTransition.count === 1;
    const observedStep = stepTransition.candidate?.currentStep || candidate.currentStep;
    stepTransition = {
      ...stepTransition,
      contract: 'no_interest',
      conflict: !transitionApplied,
      observedStep
    };
    if (!transitionApplied) finalStep = observedStep;
  } else if (hasSimpleStepTransition) {
    delete pendingUpdate.currentStep;
    stepTransition = await transitionCandidateConversationStep(prisma, {
      candidateId: candidate.id,
      expected: { currentStep: candidate.currentStep },
      nextStep: finalStep
    }).catch((error) => {
      console.error('[ACT_STEP_TRANSITION_ERROR]', error?.message);
      return {
        count: 0,
        candidate: null,
        expectedStep: candidate.currentStep,
        nextStep: finalStep,
        error: error?.message || 'candidate_step_transition_error'
      };
    });

    const transitionApplied = stepTransition.count === 1;
    const observedStep = stepTransition.candidate?.currentStep || candidate.currentStep;
    stepTransition = {
      ...stepTransition,
      contract: 'simple_step',
      conflict: !transitionApplied,
      observedStep
    };
    if (!transitionApplied) finalStep = observedStep;
  }`;

  source = replaceOnce(source, oldTransitionBlock, newTransitionBlock, 'conversation_engine_transition_dispatch');
  write(path, source);
}

// Regresión histórica de #511: el primer compuesto deja de ser deuda directa.
{
  const path = 'test/conversationEngineStepAuthority.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "import { ConversationStep, Gender } from '@prisma/client';",
    "import { ConversationStep, Gender, ReminderState } from '@prisma/client';",
    'step_authority_prisma_import'
  );
  source = replaceOnce(
    source,
    `    cvMimeType: null,
    ...overrides`,
    `    cvMimeType: null,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE,
    ...overrides`,
    'step_authority_candidate_reminder_snapshot'
  );

  const oldTest = `test('una transición compuesta conserva temporalmente su escritura unida', async () => {
  const candidate = baseCandidate({
    currentStep: ConversationStep.ASK_CV,
    cvStorageKey: 'cv/candidate-engine-step-1.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf'
  });
  const prisma = createPrismaHarness(candidate);

  const result = await act({
    prisma,
    candidate,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.deepEqual(prisma.calls.update[0].data, {
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    currentStep: ConversationStep.DONE
  });
});`;

  const newTest = `test('mark_no_interest usa el primer contrato compuesto del engine', async () => {
  const candidate = baseCandidate({
    currentStep: ConversationStep.ASK_CV,
    cvStorageKey: 'cv/candidate-engine-step-1.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf'
  });
  const prisma = createPrismaHarness(candidate);

  const result = await act({
    prisma,
    candidate,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'no_interest');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
  assert.deepEqual(prisma.calls.updateMany[0].data, {
    currentStep: ConversationStep.DONE,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
});`;

  source = replaceOnce(source, oldTest, newTest, 'step_authority_no_interest_expectation');
  write(path, source);
}

// Manifiesto de progreso: registrar el primer contrato compuesto.
{
  const path = 'config/candidate-progress-authority.json';
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
  manifest.schemaVersion = 4;
  manifest.phase = 'no_interest_authority_migrated';
  if (!manifest.completedSlices.includes('conversation_engine_no_interest_authority')) {
    manifest.completedSlices.push('conversation_engine_no_interest_authority');
  }

  const authoritySource = manifest.sourceInventory.find((entry) => entry.path === 'src/services/candidateStateService.js');
  authoritySource.notes = 'Autoridad canónica del slice multilinea, transiciones simples de currentStep y cierre compuesto por falta de interés mediante contratos estrechos y compare-and-set.';
  const engineSource = manifest.sourceInventory.find((entry) => entry.path === 'src/services/conversationEngine.js');
  engineSource.notes = 'act() conserva la reducción determinística. Delega transiciones simples y el cierre exacto por falta de interés; rechazo, pausa y agenda siguen temporalmente unidos.';

  const engineFamily = manifest.transitionFamilies.find((entry) => entry.id === 'engine_action_reducer');
  engineFamily.concurrency = 'Las transiciones simples comparan id y currentStep. mark_no_interest compara además reminderScheduledFor y reminderState. Rechazo, pausa y agenda permanecen temporalmente en candidate.update.';
  engineFamily.idempotency = 'No escribe cuando finalStep coincide con currentStep. Carreras simples o de falta de interés devuelven count cero y preservan el estado observado.';

  manifest.compositeContracts = [{
    id: 'conversation_engine_no_interest',
    owner: 'src/services/candidateStateService.js',
    consumer: 'src/services/conversationEngine.js',
    responseConsumer: 'src/services/chatEngine.js',
    status: 'canonical',
    allowedFields: ['currentStep', 'reminderScheduledFor', 'reminderState'],
    preconditions: [
      'candidateId requerido',
      'currentStep esperado válido y distinto de DONE',
      'reminderScheduledFor esperado explícito y válido',
      'reminderState esperado válido',
      'pendingUpdate contiene exactamente los tres campos permitidos'
    ],
    mutation: {
      currentStep: 'DONE',
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    },
    concurrency: 'updateMany compara id, currentStep, reminderScheduledFor y reminderState; count cero preserva el estado vigente.',
    idempotency: 'Una segunda ejecución con el snapshot anterior devuelve count cero y no altera el cierre o recordatorio actual.',
    conflictPolicy: 'chatEngine reutiliza stale_candidate_step y suprime la respuesta calculada sobre el snapshot obsoleto.',
    excludedCombinations: ['mark_rejected', 'pause_bot', 'mark_female_pipeline', 'offer_interview', 'reschedule']
  }];

  manifest.nextMigrationSlices[0] = 'migrar mark_rejected como contrato compuesto separado sin absorber pausa ni agenda';
  write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Scanner estructural: contrato compuesto exacto y documentación de fase.
{
  const path = 'test/candidateProgressAuthority.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `  assert.equal(manifest.phase, 'simple_step_authority_migrated');`,
    `  assert.equal(manifest.phase, 'no_interest_authority_migrated');`,
    'progress_manifest_phase'
  );
  source = replaceOnce(
    source,
    `  assert.deepEqual(manifest.completedSlices, [
    'multiline_window_authority',
    'conversation_engine_simple_step_authority'
  ]);`,
    `  assert.deepEqual(manifest.completedSlices, [
    'multiline_window_authority',
    'conversation_engine_simple_step_authority',
    'conversation_engine_no_interest_authority'
  ]);`,
    'progress_completed_slices'
  );

  const insertionAnchor = `});

test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`;
  const insertion = `});

test('CandidateStateService controla el cierre exacto por falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 1);
  const contract = manifest.compositeContracts[0];
  assert.equal(contract.id, 'conversation_engine_no_interest');
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep', 'reminderScheduledFor', 'reminderState']);
  assert.ok(contract.excludedCombinations.includes('mark_rejected'));
  assert.ok(contract.excludedCombinations.includes('pause_bot'));

  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\\.updateMany\\s*\\(/);
  assert.match(transition, /currentStep\\s*:\s*ConversationStep\\.DONE/);
  assert.match(transition, /reminderScheduledFor\\s*:\s*null/);
  assert.match(transition, /reminderState\\s*:\s*ReminderState\\.SKIPPED/);
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);

  const engine = readSource('src/services/conversationEngine.js');
  const actSource = extractFunctionSource(engine, 'act');
  assert.match(actSource, /hasNoInterestTransition/);
  assert.match(actSource, /noInterestUpdateFields\\.every/);
  assert.match(actSource, /completeCandidateNoInterestTransition\\s*\\(\\s*prisma/);
  assert.match(actSource, /contract:\s*['"]no_interest['"]/);
});

test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`;
  source = replaceOnce(source, insertionAnchor, insertion, 'progress_no_interest_contract_test');

  source = replaceOnce(
    source,
    `test('la documentación registra la fase multilinea y mantiene el siguiente slice acotado', () => {`,
    `test('la documentación registra las fases migradas y mantiene el siguiente slice acotado', () => {`,
    'progress_documentation_test_title'
  );
  source = replaceOnce(
    source,
    `  assert.match(documentation, /Fase 3: transiciones simples del engine/);
  assert.match(documentation, /scheduleCandidateMultilineWindow/);`,
    `  assert.match(documentation, /Fase 3: transiciones simples del engine/);
  assert.match(documentation, /Fase 4: cierre por falta de interés/);
  assert.match(documentation, /scheduleCandidateMultilineWindow/);`,
    'progress_documentation_phase4'
  );
  source = replaceOnce(
    source,
    `  assert.match(documentation, /transitionCandidateConversationStep/);
  assert.match(documentation, /stale_candidate_step/);`,
    `  assert.match(documentation, /transitionCandidateConversationStep/);
  assert.match(documentation, /completeCandidateNoInterestTransition/);
  assert.match(documentation, /stale_candidate_step/);`,
    'progress_documentation_contract'
  );
  write(path, source);
}

// Documentación de arquitectura: fase compuesta y siguiente frontera.
{
  const path = 'docs/architecture/candidate-state-transition-inventory.md';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `Las transiciones compuestas que también incluyen rechazo, pausa, recordatorios o agenda permanecen temporalmente unidas en \`act()\`. Esta deuda es explícita: no se oculta dentro de un método genérico ni se separa antes de definir su atomicidad funcional.

## Próxima frontera

1. caracterizar y migrar las transiciones compuestas de \`conversationEngine.act()\`;
2. progreso alrededor del consentimiento;
3. ramas legacy del webhook;
4. correcciones administrativas con actor, motivo y origen esperado.`,
    `El cierre exacto por falta de interés deja de formar parte de esa deuda. Rechazo, pausa y agenda permanecen temporalmente unidos en \`act()\`; no se ocultan dentro de un método genérico ni se separan antes de definir su atomicidad funcional.

## Fase 4: cierre por falta de interés

\`completeCandidateNoInterestTransition()\` controla únicamente la combinación producida por \`mark_no_interest\` cuando \`pendingUpdate\` contiene exactamente:

- \`currentStep: DONE\`;
- \`reminderScheduledFor: null\`;
- \`reminderState: SKIPPED\`.

La autoridad compara el ID, el paso leído y el snapshot completo del recordatorio. Una carrera por cambio de paso, estado o fecha devuelve \`count=0\`, recupera el candidato vigente y activa la supresión \`stale_candidate_step\`. No reintenta, no crea reservas y no absorbe combinaciones con rechazo o pausa.

## Próxima frontera

1. migrar \`mark_rejected\` como contrato compuesto separado;
2. progreso alrededor del consentimiento;
3. ramas legacy del webhook;
4. correcciones administrativas con actor, motivo y origen esperado.`,
    'candidate_state_documentation_phase4'
  );
  write(path, source);
}
