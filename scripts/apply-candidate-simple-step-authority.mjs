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

const temporaryWorkflow = '.github/workflows/apply-candidate-simple-step-authority.yml';
const temporaryScript = 'scripts/apply-candidate-simple-step-authority.mjs';

// CandidateStateService: autoridad estrecha por id + currentStep.
{
  const path = 'src/services/candidateStateService.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "import { buildManualWhatsAppOpenCandidateUpdate } from './adminOutboundPolicy.js';\n",
    "import { ConversationStep } from '@prisma/client';\nimport { buildManualWhatsAppOpenCandidateUpdate } from './adminOutboundPolicy.js';\n",
    'candidate_state_prisma_import'
  );

  if (source.includes('export async function transitionCandidateConversationStep')) {
    throw new Error('candidate_step_authority_already_exists');
  }

  source += `\n\nfunction requireConversationStep(value, fieldName) {\n  if (typeof value !== 'string' || !Object.values(ConversationStep).includes(value)) {\n    throw new TypeError(\`${'${fieldName}'}_invalid\`);\n  }\n  return value;\n}\n\nexport async function transitionCandidateConversationStep(client, input = {}) {\n  const candidateClient = requireCandidateClient(client);\n  const candidateId = requireCandidateId(input.candidateId);\n  const expectedStep = requireConversationStep(\n    input.expected?.currentStep,\n    'candidate_expected_current_step'\n  );\n  const nextStep = requireConversationStep(input.nextStep, 'candidate_next_step');\n\n  if (expectedStep === nextStep) {\n    throw new TypeError('candidate_conversation_step_noop');\n  }\n\n  const result = await candidateClient.candidate.updateMany({\n    where: {\n      id: candidateId,\n      currentStep: expectedStep\n    },\n    data: {\n      currentStep: nextStep\n    }\n  });\n\n  const candidate = await candidateClient.candidate.findUnique({\n    where: { id: candidateId }\n  });\n\n  return {\n    count: Number(result?.count || 0),\n    candidate,\n    expectedStep,\n    nextStep\n  };\n}\n`;
  write(path, source);
}

// conversationEngine: solo delega cuando currentStep es el único campo pendiente.
{
  const path = 'src/services/conversationEngine.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    "import { OPENAI_CONVERSATION_MODEL } from './openAiModelConfig.js';\n",
    "import { OPENAI_CONVERSATION_MODEL } from './openAiModelConfig.js';\nimport { transitionCandidateConversationStep } from './candidateStateService.js';\n",
    'conversation_engine_authority_import'
  );

  source = replaceOnce(
    source,
    `  if (finalStep && finalStep !== candidate.currentStep) {\n    pendingUpdate.currentStep = finalStep;\n  }\n\n  if (Object.keys(pendingUpdate).length) {\n    await prisma.candidate.update({\n      where: { id: candidate.id },\n      data: pendingUpdate\n    }).catch((error) => console.error('[ACT_STEP_UPDATE_ERROR]', error?.message));\n  }\n\n  return { readiness: readinessAfterMerge, blockedActions, finalStep };`,
    `  const requestedFinalStep = finalStep;\n  const hasStepTransition = Boolean(finalStep && finalStep !== candidate.currentStep);\n  if (hasStepTransition) {\n    pendingUpdate.currentStep = finalStep;\n  }\n\n  const pendingUpdateKeys = Object.keys(pendingUpdate);\n  const hasSimpleStepTransition = hasStepTransition\n    && pendingUpdateKeys.length === 1\n    && pendingUpdateKeys[0] === 'currentStep';\n  let stepTransition = null;\n\n  if (hasSimpleStepTransition) {\n    delete pendingUpdate.currentStep;\n    stepTransition = await transitionCandidateConversationStep(prisma, {\n      candidateId: candidate.id,\n      expected: { currentStep: candidate.currentStep },\n      nextStep: finalStep\n    }).catch((error) => {\n      console.error('[ACT_STEP_TRANSITION_ERROR]', error?.message);\n      return {\n        count: 0,\n        candidate: null,\n        expectedStep: candidate.currentStep,\n        nextStep: finalStep,\n        error: error?.message || 'candidate_step_transition_error'\n      };\n    });\n\n    const transitionApplied = stepTransition.count === 1;\n    const observedStep = stepTransition.candidate?.currentStep || candidate.currentStep;\n    stepTransition = {\n      ...stepTransition,\n      conflict: !transitionApplied,\n      observedStep\n    };\n    if (!transitionApplied) finalStep = observedStep;\n  }\n\n  if (Object.keys(pendingUpdate).length) {\n    await prisma.candidate.update({\n      where: { id: candidate.id },\n      data: pendingUpdate\n    }).catch((error) => console.error('[ACT_STEP_UPDATE_ERROR]', error?.message));\n  }\n\n  return {\n    readiness: readinessAfterMerge,\n    blockedActions,\n    finalStep,\n    requestedFinalStep,\n    stepTransition\n  };`,
    'conversation_engine_simple_step_transition'
  );
  write(path, source);
}

// chatEngine: una carrera no puede emitir la respuesta calculada sobre el snapshot viejo.
{
  const path = 'src/services/chatEngine.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `  const progressReply = buildDeterministicProgressReply(actResult);\n  const guardedReply = actResult?.blockedActions?.length\n    ? buildMissingFieldReply(actResult.readiness)\n    : (progressReply || result.reply);`,
    `  const staleStepConflict = Boolean(actResult?.stepTransition?.conflict);\n  const progressReply = staleStepConflict ? null : buildDeterministicProgressReply(actResult);\n  const guardedReply = staleStepConflict\n    ? null\n    : (actResult?.blockedActions?.length\n      ? buildMissingFieldReply(actResult.readiness)\n      : (progressReply || result.reply));`,
    'chat_engine_stale_step_guard'
  );
  source = replaceOnce(
    source,
    `  const hasSilentManualPause = !String(safeReply.reply || '').trim()\n    && actions.some((action) => action?.type === 'pause_bot');\n  const noUsefulReply = !String(safeReply.reply || '').trim()\n    && actions.length\n    && (hasSilentManualPause || actions.every((action) => action?.type === 'nothing'));`,
    `  const effectiveReply = staleStepConflict ? null : safeReply.reply;\n  const hasSilentManualPause = !String(effectiveReply || '').trim()\n    && actions.some((action) => action?.type === 'pause_bot');\n  const noUsefulReply = staleStepConflict || (\n    !String(effectiveReply || '').trim()\n    && actions.length\n    && (hasSilentManualPause || actions.every((action) => action?.type === 'nothing'))\n  );`,
    'chat_engine_effective_reply'
  );
  source = replaceOnce(
    source,
    `    reply: safeReply.reply,`,
    `    reply: effectiveReply,`,
    'chat_engine_return_effective_reply'
  );
  source = replaceOnce(
    source,
    `    suppressedReason: noUsefulReply\n      ? (hasSilentManualPause ? 'engine_pause_bot_no_reply' : 'engine_nothing_no_reply')\n      : null,`,
    `    suppressedReason: staleStepConflict\n      ? 'stale_candidate_step'\n      : (noUsefulReply\n        ? (hasSilentManualPause ? 'engine_pause_bot_no_reply' : 'engine_nothing_no_reply')\n        : null),`,
    'chat_engine_stale_suppressed_reason'
  );
  write(path, source);
}

// Mock histórico: soporta la nueva autoridad sin alterar las expectativas de updates compuestos.
{
  const path = 'test/conversationEngineGuardRails.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `function prismaMock() {\n  const updates = [];\n  const bookings = [];\n  return {\n    updates,\n    bookings,\n    candidate: {\n      update: async (args) => { updates.push(args); return { id: args.where.id, ...args.data }; }\n    },\n    interviewBooking: {\n      findFirst: async () => null,\n      updateMany: async () => ({ count: 0 }),\n      create: async (args) => { bookings.push(args); return { id: bookings.length, ...args.data }; }\n    }\n  };\n}`,
    `function prismaMock() {\n  const updates = [];\n  const stepUpdates = [];\n  const bookings = [];\n  let persistedStep = null;\n  return {\n    updates,\n    stepUpdates,\n    bookings,\n    candidate: {\n      update: async (args) => { updates.push(args); return { id: args.where.id, ...args.data }; },\n      updateMany: async (args) => {\n        stepUpdates.push(args);\n        persistedStep = args.data.currentStep;\n        return { count: 1 };\n      },\n      findUnique: async (args) => ({ id: args.where.id, currentStep: persistedStep })\n    },\n    interviewBooking: {\n      findFirst: async () => null,\n      updateMany: async () => ({ count: 0 }),\n      create: async (args) => { bookings.push(args); return { id: bookings.length, ...args.data }; }\n    }\n  };\n}`,
    'conversation_engine_guardrails_mock'
  );
  write(path, source);
}

// Manifiesto: slice simple canónico; compuestos explícitamente diferidos.
{
  const path = 'config/candidate-progress-authority.json';
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
  manifest.schemaVersion = 3;
  manifest.phase = 'simple_step_authority_migrated';
  manifest.completedSlices = [
    'multiline_window_authority',
    'conversation_engine_simple_step_authority'
  ];

  const authoritySource = manifest.sourceInventory.find((item) => item.path === 'src/services/candidateStateService.js');
  authoritySource.trackedFields = ['currentStep', 'multilineWindowUntil', 'multilineBatchVersion'];
  authoritySource.notes = 'Autoridad canónica del slice multilinea y de las transiciones simples de currentStep mediante contratos estrechos y compare-and-set.';

  const engineSource = manifest.sourceInventory.find((item) => item.path === 'src/services/conversationEngine.js');
  engineSource.notes = 'act() conserva la reducción determinística. Las transiciones simples delegan en CandidateStateService; las compuestas con otros campos siguen temporalmente unidas.';

  const engineFamily = manifest.transitionFamilies.find((item) => item.id === 'engine_action_reducer');
  engineFamily.writers = ['src/services/candidateStateService.js', 'src/services/conversationEngine.js'];
  engineFamily.concurrency = 'Las transiciones simples comparan id y currentStep mediante updateMany. Las transiciones compuestas con rechazo, pausa, recordatorios o agenda permanecen temporalmente en candidate.update y están explícitamente diferidas.';
  engineFamily.idempotency = 'No escribe cuando finalStep coincide con candidate.currentStep. Una carrera simple devuelve count cero y el paso observado; los compuestos conservan la semántica previa.';

  manifest.stepContracts = [{
    id: 'conversation_engine_simple_step',
    owner: 'src/services/candidateStateService.js',
    consumer: 'src/services/conversationEngine.js',
    responseConsumer: 'src/services/chatEngine.js',
    status: 'canonical_simple_only',
    allowedFields: ['currentStep'],
    preconditions: ['candidateId requerido', 'currentStep esperado válido', 'nextStep válido', 'origen y destino distintos'],
    mutation: { currentStep: 'nextStep' },
    concurrency: 'updateMany compara id y currentStep. count cero preserva el estado vigente y marca conflicto.',
    idempotency: 'La misma transición no se reintenta como éxito; un snapshot obsoleto no sobrescribe un paso más nuevo.',
    conflictPolicy: 'chatEngine suprime la respuesta calculada sobre el snapshot obsoleto.',
    deferredCompositeFields: ['status', 'rejectionReason', 'rejectionDetails', 'botPaused', 'botPausedAt', 'botPauseReason', 'reminderScheduledFor', 'reminderState']
  }];

  manifest.nextMigrationSlices = [
    'caracterizar y migrar transiciones compuestas de conversationEngine.act() sin romper atomicidad funcional',
    'migrar las transiciones de consentimiento manteniendo ConsentStateService como autoridad del evento',
    'migrar las ramas legacy de webhook por familias pequeñas',
    'migrar correcciones administrativas con actor, motivo y origen esperado'
  ];
  write(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Scanner y documentación de fase.
{
  const path = 'test/candidateProgressAuthority.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = source
    .replace("assert.equal(manifest.phase, 'multiline_authority_migrated');", "assert.equal(manifest.phase, 'simple_step_authority_migrated');")
    .replace("assert.deepEqual(manifest.completedSlices, ['multiline_window_authority']);", "assert.deepEqual(manifest.completedSlices, [\n    'multiline_window_authority',\n    'conversation_engine_simple_step_authority'\n  ]);");

  source = replaceOnce(
    source,
    `test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`,
    `test('CandidateStateService controla las transiciones simples del engine y explicita los compuestos diferidos', () => {\n  assert.equal(manifest.stepContracts.length, 1);\n  const contract = manifest.stepContracts[0];\n  assert.equal(contract.id, 'conversation_engine_simple_step');\n  assert.equal(contract.owner, 'src/services/candidateStateService.js');\n  assert.equal(contract.consumer, 'src/services/conversationEngine.js');\n  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');\n  assert.equal(contract.status, 'canonical_simple_only');\n  assert.deepEqual(contract.allowedFields, ['currentStep']);\n  assert.ok(contract.deferredCompositeFields.includes('status'));\n  assert.ok(contract.deferredCompositeFields.includes('botPaused'));\n  assert.ok(contract.deferredCompositeFields.includes('reminderState'));\n\n  const authority = readSource('src/services/candidateStateService.js');\n  const transition = extractFunctionSource(authority, 'transitionCandidateConversationStep');\n  assert.match(transition, /candidate\\.updateMany\\s*\\(/);\n  assert.match(transition, /currentStep\\s*:\\s*expectedStep/);\n  assert.match(transition, /data\\s*:\\s*\\{\\s*currentStep\\s*:\\s*nextStep/);\n  assert.doesNotMatch(transition, /status|botPaused|reminderState|rejectionReason/);\n\n  const engine = readSource('src/services/conversationEngine.js');\n  const actSource = extractFunctionSource(engine, 'act');\n  assert.match(actSource, /hasSimpleStepTransition/);\n  assert.match(actSource, /pendingUpdateKeys\\.length\\s*===\\s*1/);\n  assert.match(actSource, /transitionCandidateConversationStep\\(prisma/);\n  assert.match(actSource, /conflict:\\s*!transitionApplied/);\n  assert.match(actSource, /if\\s*\\(!transitionApplied\\)\\s*finalStep\\s*=\\s*observedStep/);\n\n  const chatEngine = readSource('src/services/chatEngine.js');\n  assert.match(chatEngine, /staleStepConflict/);\n  assert.match(chatEngine, /stale_candidate_step/);\n  assert.match(chatEngine, /effectiveReply\\s*=\\s*staleStepConflict\\s*\\?\\s*null/);\n});\n\ntest('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`,
    'candidate_progress_simple_step_contract'
  );

  source = source
    .replace("assert.match(documentation, /Fase 2: autoridad multilinea migrada/);", "assert.match(documentation, /Fase 2: autoridad multilinea migrada/);\n  assert.match(documentation, /Fase 3: transiciones simples del engine/);")
    .replace("assert.match(documentation, /acquireCandidateMultilineBatch/);", "assert.match(documentation, /acquireCandidateMultilineBatch/);\n  assert.match(documentation, /transitionCandidateConversationStep/);\n  assert.match(documentation, /stale_candidate_step/);");
  write(path, source);
}

{
  const path = 'docs/architecture/candidate-state-transition-inventory.md';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `## Próxima frontera\n\nEl siguiente slice es la reducción final de \`conversationEngine.act()\`. Debe comparar el \`currentStep\` leído, conservar sus guardas determinísticas y no absorber las autoridades de perfil ni de \`InterviewBooking\`.\n\nLuego seguirán, una familia por PR:\n\n1. progreso alrededor del consentimiento;\n2. ramas legacy del webhook;\n3. correcciones administrativas con actor, motivo y origen esperado.`,
    `## Fase 3: transiciones simples del engine\n\n\`transitionCandidateConversationStep()\` controla las transiciones donde \`currentStep\` es el único campo pendiente. Compara \`candidateId + currentStep\` mediante \`updateMany\`, escribe exclusivamente el siguiente paso y recupera el candidato vigente.\n\n\`conversationEngine.act()\` conserva la reducción de acciones, readiness y guardas. Solo delega cuando \`pendingUpdate\` contiene exclusivamente \`currentStep\`. Si otra operación cambió el paso, la autoridad devuelve \`count=0\`, \`act()\` conserva el paso observado y \`chatEngine\` suprime la respuesta con razón \`stale_candidate_step\`. No se reintenta ni se sobrescribe el estado más nuevo.\n\nLas transiciones compuestas que también incluyen rechazo, pausa, recordatorios o agenda permanecen temporalmente unidas en \`act()\`. Esta deuda es explícita: no se oculta dentro de un método genérico ni se separa antes de definir su atomicidad funcional.\n\n## Próxima frontera\n\n1. caracterizar y migrar las transiciones compuestas de \`conversationEngine.act()\`;\n2. progreso alrededor del consentimiento;\n3. ramas legacy del webhook;\n4. correcciones administrativas con actor, motivo y origen esperado.`,
    'candidate_progress_phase_three_docs'
  );
  write(path, source);
}

// Gate específico de progreso.
{
  const path = '.github/workflows/candidate-progress-authority.yml';
  let source = fs.readFileSync(path, 'utf8');
  source = source
    .replaceAll('      - src/services/candidateStateService.js\n', '      - src/services/candidateStateService.js\n      - src/services/conversationEngine.js\n      - src/services/chatEngine.js\n')
    .replaceAll('      - test/candidateMultilineStateService.test.js\n', '      - test/candidateMultilineStateService.test.js\n      - test/candidateConversationStepStateService.test.js\n      - test/conversationEngineStepAuthority.test.js\n      - test/conversationEngineGuardRails.test.js\n')
    .replace('      - name: Validate Candidate multiline authority\n        run: node --test test/candidateMultilineStateService.test.js test/candidateProgressAuthority.test.js', '      - name: Validate Candidate progress authority\n        run: node --test test/candidateMultilineStateService.test.js test/candidateConversationStepStateService.test.js test/conversationEngineStepAuthority.test.js test/conversationEngineGuardRails.test.js test/candidateProgressAuthority.test.js');
  write(path, source);
}

fs.rmSync(temporaryWorkflow, { force: true });
fs.rmSync(temporaryScript, { force: true });
