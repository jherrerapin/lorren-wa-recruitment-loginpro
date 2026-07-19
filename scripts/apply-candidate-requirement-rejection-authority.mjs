import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) {
    if (source.includes(after)) return source;
    throw new Error(`${label}_source_not_found`);
  }
  if (source.indexOf(before, index + before.length) !== -1) {
    throw new Error(`${label}_source_not_unique`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function updateFile(path, updater) {
  const source = fs.readFileSync(path, 'utf8');
  const updated = updater(source);
  if (updated !== source) fs.writeFileSync(path, updated);
}

updateFile('src/services/candidateStateService.js', (source) => {
  let next = replaceOnce(
    source,
    "import { ConversationStep, ReminderState } from '@prisma/client';",
    "import { CandidateStatus, ConversationStep, ReminderState } from '@prisma/client';",
    'candidate_status_import'
  );

  const marker = `export async function completeCandidateNoInterestTransition(client, input = {}) {
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

  const addition = `${marker}

function requireCandidateStatus(value, fieldName) {
  if (typeof value !== 'string' || !Object.values(CandidateStatus).includes(value)) {
    throw new TypeError(\`${'${fieldName}'}_invalid\`);
  }
  return value;
}

function requireNullableSnapshotString(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(\`${'${fieldName}'}_invalid\`);
  return value;
}

function requireStrictDecisionString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(\`${'${fieldName}'}_required\`);
  }
  return value;
}

function normalizeRequirementRejectionSnapshot(expected) {
  const requiredFields = [
    'currentStep',
    'status',
    'rejectionReason',
    'rejectionDetails',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_requirement_rejection_snapshot_required');
  }

  return {
    currentStep: requireConversationStep(
      expected.currentStep,
      'candidate_requirement_rejection_current_step'
    ),
    status: requireCandidateStatus(
      expected.status,
      'candidate_requirement_rejection_status'
    ),
    rejectionReason: requireNullableSnapshotString(
      expected.rejectionReason,
      'candidate_requirement_rejection_expected_reason'
    ),
    rejectionDetails: requireNullableSnapshotString(
      expected.rejectionDetails,
      'candidate_requirement_rejection_expected_details'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_requirement_rejection_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_requirement_rejection_reminder_state'
    )
  };
}

function requirementRejectionExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    status: snapshot.status,
    rejectionReason: snapshot.rejectionReason,
    rejectionDetails: snapshot.rejectionDetails,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function completeCandidateRequirementRejection(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeRequirementRejectionSnapshot(input.expected);
  const reason = requireStrictDecisionString(
    input.reason,
    'candidate_requirement_rejection_reason'
  );
  const details = requireStrictDecisionString(
    input.details,
    'candidate_requirement_rejection_details'
  );

  if (expected.status === CandidateStatus.RECHAZADO) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: 'already_rejected'
    });
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...requirementRejectionExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.DONE,
      status: CandidateStatus.RECHAZADO,
      rejectionReason: reason,
      rejectionDetails: details,
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
    reason,
    details,
    nextStep: ConversationStep.DONE,
    nextStatus: CandidateStatus.RECHAZADO,
    nextReminderState: ReminderState.SKIPPED
  };
}`;

  next = replaceOnce(next, marker, addition, 'candidate_rejection_authority');
  return next;
});

updateFile('src/services/conversationEngine.js', (source) => {
  let next = replaceOnce(
    source,
    `import {
  completeCandidateNoInterestTransition,
  transitionCandidateConversationStep
} from './candidateStateService.js';`,
    `import {
  completeCandidateNoInterestTransition,
  completeCandidateRequirementRejection,
  transitionCandidateConversationStep
} from './candidateStateService.js';`,
    'conversation_engine_authority_import'
  );

  next = replaceOnce(
    next,
    `  const hasMarkNoInterestAction = normalizedActions.some((action) => action?.type === 'mark_no_interest');`,
    `  const hasMarkNoInterestAction = normalizedActions.some((action) => action?.type === 'mark_no_interest');
  const hasMarkRejectedAction = normalizedActions.some((action) => action?.type === 'mark_rejected');`,
    'conversation_engine_rejection_flag'
  );

  next = replaceOnce(
    next,
    `  const pendingUpdateKeys = Object.keys(pendingUpdate);
  const noInterestUpdateFields = ['currentStep', 'reminderScheduledFor', 'reminderState'];`,
    `  const pendingUpdateKeys = Object.keys(pendingUpdate);
  const requirementRejectionUpdateFields = [
    'status',
    'rejectionReason',
    'rejectionDetails',
    'reminderScheduledFor',
    'reminderState'
  ];
  const requirementRejectionPendingFields = hasStepTransition
    ? [...requirementRejectionUpdateFields, 'currentStep']
    : requirementRejectionUpdateFields;
  const hasRequirementRejectionTransition = finalStep === ConversationStep.DONE
    && hasMarkRejectedAction
    && !hasMarkNoInterestAction
    && pendingUpdateKeys.length === requirementRejectionPendingFields.length
    && requirementRejectionPendingFields.every((field) => pendingUpdateKeys.includes(field))
    && pendingUpdate.status === CandidateStatus.RECHAZADO
    && typeof pendingUpdate.rejectionReason === 'string'
    && Boolean(pendingUpdate.rejectionReason.trim())
    && typeof pendingUpdate.rejectionDetails === 'string'
    && Boolean(pendingUpdate.rejectionDetails.trim())
    && pendingUpdate.reminderScheduledFor === null
    && pendingUpdate.reminderState === ReminderState.SKIPPED;
  const noInterestUpdateFields = ['currentStep', 'reminderScheduledFor', 'reminderState'];`,
    'conversation_engine_rejection_contract_detection'
  );

  next = replaceOnce(
    next,
    `  if (hasNoInterestTransition) {`,
    `  if (hasRequirementRejectionTransition) {
    const rejectionReason = pendingUpdate.rejectionReason;
    const rejectionDetails = pendingUpdate.rejectionDetails;
    for (const field of requirementRejectionUpdateFields) delete pendingUpdate[field];
    if (hasStepTransition) delete pendingUpdate.currentStep;

    stepTransition = await completeCandidateRequirementRejection(prisma, {
      candidateId: candidate.id,
      expected: {
        currentStep: candidate.currentStep,
        status: candidate.status,
        rejectionReason: candidate.rejectionReason ?? null,
        rejectionDetails: candidate.rejectionDetails ?? null,
        reminderScheduledFor: candidate.reminderScheduledFor,
        reminderState: candidate.reminderState
      },
      reason: rejectionReason,
      details: rejectionDetails
    }).catch((error) => {
      console.error('[ACT_REQUIREMENT_REJECTION_ERROR]', error?.message);
      return {
        count: 0,
        candidate: null,
        error: error?.message || 'candidate_requirement_rejection_error'
      };
    });

    const transitionApplied = stepTransition.count === 1;
    const observedStep = stepTransition.candidate?.currentStep || candidate.currentStep;
    stepTransition = {
      ...stepTransition,
      contract: 'requirement_rejection',
      conflict: !transitionApplied,
      observedStep
    };
    if (!transitionApplied) finalStep = observedStep;
  } else if (hasNoInterestTransition) {`,
    'conversation_engine_rejection_delegation'
  );

  return next;
});

updateFile('test/conversationEngineGuardRails.test.js', (source) => {
  let next = replaceOnce(
    source,
    `    currentStep: ConversationStep.ASK_CV,
    fullName: 'Fredy Granados',`,
    `    currentStep: ConversationStep.ASK_CV,
    status: 'REGISTRADO',
    rejectionReason: null,
    rejectionDetails: null,
    fullName: 'Fredy Granados',`,
    'guardrail_candidate_rejection_snapshot'
  );

  next = replaceOnce(
    next,
    `  const update = prisma.updates.at(-1).data;
  assert.equal(update.status, 'RECHAZADO');`,
    `  const update = prisma.stepUpdates.at(-1).data;
  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(update.status, 'RECHAZADO');`,
    'guardrail_rejection_assertion'
  );

  return next;
});

const manifestPath = 'config/candidate-progress-authority.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.schemaVersion = 5;
manifest.phase = 'requirement_rejection_authority_migrated';
if (!manifest.completedSlices.includes('conversation_engine_requirement_rejection_authority')) {
  manifest.completedSlices.push('conversation_engine_requirement_rejection_authority');
}
const authoritySource = manifest.sourceInventory.find((item) => item.path === 'src/services/candidateStateService.js');
authoritySource.notes = 'Autoridad canónica del slice multilinea, transiciones simples, cierre por falta de interés y rechazo por requisitos mediante contratos estrechos y compare-and-set.';
const engineSource = manifest.sourceInventory.find((item) => item.path === 'src/services/conversationEngine.js');
engineSource.notes = 'act() conserva la reducción determinística. Delega transiciones simples, falta de interés y rechazo exacto; pausa y agenda siguen temporalmente unidas.';
const engineFamily = manifest.transitionFamilies.find((item) => item.id === 'engine_action_reducer');
engineFamily.concurrency = 'Las transiciones simples comparan id y currentStep. Falta de interés compara recordatorio. Rechazo por requisitos compara además status, razón y detalle observados. Pausa y agenda permanecen temporalmente en candidate.update.';
engineFamily.idempotency = 'No escribe cuando el paso simple no cambia. Carreras simples, de falta de interés o de rechazo devuelven count cero y preservan el estado observado.';
manifest.nextMigrationSlices = manifest.nextMigrationSlices.filter((item) => !/mark_rejected/.test(item));
if (!manifest.nextMigrationSlices.some((item) => /pause_bot/.test(item))) {
  manifest.nextMigrationSlices.unshift('migrar pause_bot como contrato compuesto separado sin absorber agenda ni lógica relacionada con género');
}
if (!manifest.compositeContracts.some((contract) => contract.id === 'conversation_engine_requirement_rejection')) {
  manifest.compositeContracts.push({
    id: 'conversation_engine_requirement_rejection',
    owner: 'src/services/candidateStateService.js',
    consumer: 'src/services/conversationEngine.js',
    responseConsumer: 'src/services/chatEngine.js',
    status: 'canonical',
    allowedFields: [
      'currentStep',
      'status',
      'rejectionReason',
      'rejectionDetails',
      'reminderScheduledFor',
      'reminderState'
    ],
    preconditions: [
      'candidateId requerido',
      'decisión de rechazo ya autorizada por rejectionPolicy',
      'snapshot completo de paso, estado, trazabilidad y recordatorio',
      'razón y detalle no vacíos',
      'pendingUpdate contiene exactamente los campos permitidos'
    ],
    mutation: {
      currentStep: 'DONE',
      status: 'RECHAZADO',
      rejectionReason: 'razón canónica de la política',
      rejectionDetails: 'evidencia canónica de la política',
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    },
    concurrency: 'updateMany compara id, currentStep, status, razón, detalle y recordatorio; count cero preserva el estado vigente.',
    idempotency: 'Un candidato ya rechazado produce no-op y un snapshot obsoleto no sobrescribe trazabilidad o recordatorios más recientes.',
    conflictPolicy: 'chatEngine reutiliza stale_candidate_step y suprime la respuesta calculada sobre el snapshot obsoleto.',
    excludedCombinations: [
      'mark_no_interest',
      'pause_bot',
      'mark_female_pipeline',
      'offer_interview',
      'reschedule'
    ]
  });
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

updateFile('test/candidateProgressAuthority.test.js', (source) => {
  let next = replaceOnce(
    source,
    `  assert.equal(manifest.phase, 'no_interest_authority_migrated');`,
    `  assert.equal(manifest.phase, 'requirement_rejection_authority_migrated');`,
    'scanner_phase'
  );

  next = replaceOnce(
    next,
    `    'conversation_engine_simple_step_authority',
    'conversation_engine_no_interest_authority'
  ]);`,
    `    'conversation_engine_simple_step_authority',
    'conversation_engine_no_interest_authority',
    'conversation_engine_requirement_rejection_authority'
  ]);`,
    'scanner_completed_slices'
  );

  next = replaceOnce(
    next,
    `test('el manifiesto registra el contrato compuesto de falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 1);
  const contract = manifest.compositeContracts[0];`,
    `test('el manifiesto registra el contrato compuesto de falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 2);
  const contract = manifest.compositeContracts.find((item) => item.id === 'conversation_engine_no_interest');`,
    'scanner_no_interest_contract_lookup'
  );

  const insertionMarker = `test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`;
  const rejectionTests = `test('el manifiesto registra el contrato compuesto de rechazo por requisitos', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'conversation_engine_requirement_rejection');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, [
    'currentStep',
    'status',
    'rejectionReason',
    'rejectionDetails',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.ok(contract.excludedCombinations.includes('pause_bot'));
  assert.ok(contract.excludedCombinations.includes('mark_female_pipeline'));
});

test('CandidateStateService implementa el rechazo exacto por requisitos', () => {
  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'completeCandidateRequirementRejection');
  assert.match(transition, /candidate\.updateMany\s*\(/);
  assert.match(transition, /currentStep\s*:\s*ConversationStep\.DONE/);
  assert.match(transition, /status\s*:\s*CandidateStatus\.RECHAZADO/);
  assert.match(transition, /rejectionReason\s*:\s*reason/);
  assert.match(transition, /rejectionDetails\s*:\s*details/);
  assert.match(transition, /reminderScheduledFor\s*:\s*null/);
  assert.match(transition, /reminderState\s*:\s*ReminderState\.SKIPPED/);
  assert.doesNotMatch(transition, /botPaused|botPausedAt|botPauseReason|gender|vacancyId/);
});

test('conversationEngine delega únicamente el rechazo exacto', () => {
  const actSource = extractFunctionSource(readSource('src/services/conversationEngine.js'), 'act');
  assert.match(actSource, /hasRequirementRejectionTransition/);
  assert.match(actSource, /requirementRejectionPendingFields\.every/);
  assert.match(actSource, /completeCandidateRequirementRejection\s*\(\s*prisma/);
  assert.match(actSource, /contract:\s*['\"]requirement_rejection['\"]/);
});

${insertionMarker}`;
  next = replaceOnce(next, insertionMarker, rejectionTests, 'scanner_rejection_contracts');

  next = replaceOnce(
    next,
    `  assert.match(documentation, /Fase 4: cierre por falta de interés/);`,
    `  assert.match(documentation, /Fase 4: cierre por falta de interés/);
  assert.match(documentation, /Fase 5: rechazo por requisitos/);`,
    'scanner_documentation_phase'
  );

  next = replaceOnce(
    next,
    `  assert.match(documentation, /completeCandidateNoInterestTransition/);`,
    `  assert.match(documentation, /completeCandidateNoInterestTransition/);
  assert.match(documentation, /completeCandidateRequirementRejection/);`,
    'scanner_documentation_function'
  );

  return next;
});

const docsPath = 'docs/architecture/candidate-state-transition-inventory.md';
let docs = fs.readFileSync(docsPath, 'utf8');
const phaseFive = `

## Fase 5: rechazo por requisitos

La transición producida por \`mark_rejected\` delega en \`completeCandidateRequirementRejection()\` únicamente cuando \`conversationEngine.act()\` ha obtenido una decisión permitida de \`buildRequirementRejectionDecision()\` y el objeto pendiente contiene exactamente:

- \`currentStep\`;
- \`status\`;
- \`rejectionReason\`;
- \`rejectionDetails\`;
- \`reminderScheduledFor\`;
- \`reminderState\`.

La política de rechazo sigue siendo el **productor de decisión**. \`CandidateStateService\` es el **escritor efectivo** y no infiere motivos: compara el snapshot completo mediante \`updateMany\`, escribe \`DONE / RECHAZADO / SKIPPED\` y recupera el candidato vigente. Un conflicto devuelve \`count=0\` y \`chatEngine\` reutiliza \`stale_candidate_step\` para no enviar una respuesta construida sobre estado obsoleto.

Combinaciones con \`pause_bot\`, agenda, \`mark_female_pipeline\` u otros campos permanecen fuera del contrato. La próxima frontera recomendada es la pausa conversacional explícita, separada de cualquier lógica relacionada con género.
`;
if (!docs.includes('## Fase 5: rechazo por requisitos')) {
  docs = `${docs.trimEnd()}${phaseFive}\n`;
  fs.writeFileSync(docsPath, docs);
}
