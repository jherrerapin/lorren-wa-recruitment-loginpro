import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = 'config/candidate-progress-authority.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walkJavaScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath.replaceAll('\\', '/'));
    }
  }
  return files;
}

function parseConversationSteps(schema) {
  const match = schema.match(/enum\s+ConversationStep\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'No se encontró enum ConversationStep en prisma/schema.prisma');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}

function extractFunctionSource(source, functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró la función ${functionName}`);

  const parametersStart = source.indexOf('(', match.index);
  assert.notEqual(parametersStart, -1, `No se encontraron los parámetros de ${functionName}`);

  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') parameterDepth -= 1;
    if (parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `Parámetros incompletos para ${functionName}`);

  const openingBrace = source.indexOf('{', parametersEnd + 1);
  assert.notEqual(openingBrace, -1, `No se encontró el cuerpo de ${functionName}`);

  let bodyDepth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') bodyDepth += 1;
    if (source[index] === '}') bodyDepth -= 1;
    if (bodyDepth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

const allowedRoles = new Set([
  'canonical_schema',
  'direct_writer',
  'indirect_writer',
  'decision_producer',
  'decision_policy',
  'decision_schema',
  'read_only_context',
  'read_only_projection',
  'read_only_support'
]);

const trackedLiteralPattern = /\b(?:currentStep|multilineWindowUntil|multilineBatchVersion)\s*:/;

test('el manifiesto de progreso coincide con el enum canónico de Prisma', () => {
  const schemaSteps = parseConversationSteps(readSource('prisma/schema.prisma'));
  assert.deepEqual(manifest.canonicalSteps, schemaSteps);
  assert.deepEqual(manifest.trackedFields, [
    'currentStep',
    'multilineWindowUntil',
    'multilineBatchVersion'
  ]);
  assert.equal(manifest.phase, 'interview_reschedule_progress_authority_migrated');
  assert.equal(manifest.rules.runtimeChangesAllowedInThisPhase, true);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);
  assert.equal(manifest.rules.genderLogicInScope, false);
  assert.deepEqual(manifest.completedSlices, [
    'multiline_window_authority',
    'conversation_engine_simple_step_authority',
    'conversation_engine_no_interest_authority',
    'conversation_engine_requirement_rejection_authority',
    'conversation_engine_explicit_pause_authority',
    'consent_step_authority',
    'vacancy_first_gate_authority',
    'silent_profile_capture_authority',
    'admin_interview_progress_authority',
    'manual_review_pause_authority',
    'interview_reschedule_progress_authority'
  ]);
  assert.doesNotMatch(manifest.trackedFields.join('|'), /gender/i);
});

test('cada fuente productiva está clasificada y existe en el repositorio', () => {
  const classifiedPaths = new Set();
  for (const source of manifest.sourceInventory) {
    assert.ok(source.path, 'Toda fuente debe declarar path');
    assert.ok(allowedRoles.has(source.role), `Rol no soportado para ${source.path}: ${source.role}`);
    assert.equal(fs.existsSync(source.path), true, `No existe la fuente clasificada: ${source.path}`);
    assert.equal(classifiedPaths.has(source.path), false, `Fuente duplicada: ${source.path}`);
    classifiedPaths.add(source.path);
    for (const field of source.trackedFields || []) {
      assert.ok(manifest.trackedFields.includes(field), `Campo no rastreado en ${source.path}: ${field}`);
    }
  }

  const observed = walkJavaScriptFiles('src')
    .filter((filePath) => trackedLiteralPattern.test(readSource(filePath)));

  const unclassified = observed.filter((filePath) => !classifiedPaths.has(filePath));
  assert.deepEqual(
    unclassified,
    [],
    `Aparecieron fuentes con literales de progreso sin clasificar: ${unclassified.join(', ')}`
  );
});

test('las familias de transición usan pasos conocidos y contratos estrechos', () => {
  const canonicalSteps = new Set(manifest.canonicalSteps);
  const trackedFields = new Set(manifest.trackedFields);
  const sourcePaths = new Set(manifest.sourceInventory.map((source) => source.path));
  const ids = new Set();

  for (const family of manifest.transitionFamilies) {
    assert.ok(family.id, 'Cada familia debe tener id');
    assert.equal(ids.has(family.id), false, `Familia duplicada: ${family.id}`);
    ids.add(family.id);
    assert.ok(Array.isArray(family.owners) && family.owners.length > 0, `${family.id} no declara owners`);
    assert.ok(Array.isArray(family.writers) && family.writers.length > 0, `${family.id} no declara writers`);
    assert.ok(family.trigger, `${family.id} no declara trigger`);
    assert.ok(family.concurrency, `${family.id} no documenta concurrencia`);
    assert.ok(family.idempotency, `${family.id} no documenta idempotencia`);

    for (const filePath of [...family.owners, ...family.writers]) {
      assert.ok(sourcePaths.has(filePath), `${family.id} referencia una fuente no inventariada: ${filePath}`);
    }
    for (const origin of family.origins) {
      assert.ok(origin === '*' || canonicalSteps.has(origin), `${family.id} usa origen inválido: ${origin}`);
    }
    for (const destination of family.destinations) {
      assert.ok(canonicalSteps.has(destination), `${family.id} usa destino inválido: ${destination}`);
    }
    for (const field of family.allowedFields) {
      assert.ok(trackedFields.has(field), `${family.id} intenta mutar un campo fuera de alcance: ${field}`);
    }
    assert.deepEqual(family.allowedFields, ['currentStep'], `${family.id} debe ser un contrato estrecho de currentStep`);
  }
});

test('CandidateStateService es la autoridad exclusiva de persistencia multilinea', () => {
  assert.deepEqual(
    manifest.multilineContracts.map((contract) => contract.id),
    ['schedule_multiline_window', 'acquire_multiline_batch']
  );

  for (const contract of manifest.multilineContracts) {
    assert.equal(contract.owner, 'src/services/candidateStateService.js');
    assert.equal(contract.consumer, 'src/routes/webhook.js');
    assert.equal(contract.status, 'canonical');
    assert.deepEqual(contract.allowedFields, ['multilineWindowUntil', 'multilineBatchVersion']);
    assert.ok(contract.concurrency);
    assert.ok(contract.idempotency);
  }

  const authority = readSource('src/services/candidateStateService.js');
  const scheduleAuthority = extractFunctionSource(authority, 'scheduleCandidateMultilineWindow');
  const acquireAuthority = extractFunctionSource(authority, 'acquireCandidateMultilineBatch');

  assert.match(scheduleAuthority, /candidate\.update\s*\(/);
  assert.match(scheduleAuthority, /multilineWindowUntil\s*:\s*windowUntil/);
  assert.match(scheduleAuthority, /multilineBatchVersion\s*:\s*\{\s*increment\s*:\s*1\s*,?\s*\}/);
  assert.match(acquireAuthority, /candidate\.updateMany\s*\(/);
  assert.match(acquireAuthority, /multilineBatchVersion\s*:\s*batchVersion/);
  assert.match(acquireAuthority, /multilineWindowUntil\s*:\s*\{\s*lte\s*:\s*now\s*\}/);
  assert.match(acquireAuthority, /multilineWindowUntil\s*:\s*null/);
  assert.match(acquireAuthority, /return\s+\{\s*count\s*:/);

  const webhook = readSource('src/routes/webhook.js');
  const scheduleConsumer = extractFunctionSource(webhook, 'scheduleMultilineWindow');
  const acquireConsumer = extractFunctionSource(webhook, 'tryAcquireMultilineProcessing');

  assert.match(webhook, /scheduleCandidateMultilineWindow/);
  assert.match(webhook, /acquireCandidateMultilineBatch/);
  assert.match(scheduleConsumer, /return\s+scheduleCandidateMultilineWindow\s*\(/);
  assert.doesNotMatch(scheduleConsumer, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.match(acquireConsumer, /await\s+acquireCandidateMultilineBatch\s*\(/);
  assert.match(acquireConsumer, /return\s+acquired\.count\s*===\s*1/);
  assert.doesNotMatch(acquireConsumer, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.match(webhook, /tryAcquireMultilineProcessing\(prisma,\s*candidate\.id,\s*scheduling\)/);
});

test('CandidateStateService controla las transiciones simples del engine y explicita los compuestos diferidos', () => {
  const contract = manifest.stepContracts.find((item) => item.id === 'conversation_engine_simple_step');
  assert.ok(contract);
  assert.equal(contract.id, 'conversation_engine_simple_step');
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical_simple_only');
  assert.deepEqual(contract.allowedFields, ['currentStep']);
  assert.ok(contract.deferredCompositeFields.includes('status'));
  assert.ok(contract.deferredCompositeFields.includes('botPaused'));
  assert.ok(contract.deferredCompositeFields.includes('reminderState'));

  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'transitionCandidateConversationStep');
  assert.match(transition, /candidate\.updateMany\s*\(/);
  assert.match(transition, /currentStep\s*:\s*expectedStep/);
  assert.match(transition, /data\s*:\s*\{\s*currentStep\s*:\s*nextStep/);
  assert.doesNotMatch(transition, /status|botPaused|reminderState|rejectionReason/);

  const engine = readSource('src/services/conversationEngine.js');
  const actSource = extractFunctionSource(engine, 'act');
  assert.match(actSource, /hasSimpleStepTransition/);
  assert.match(actSource, /pendingUpdateKeys\.length\s*===\s*1/);
  assert.match(actSource, /transitionCandidateConversationStep\s*\(\s*prisma/);
  assert.match(actSource, /conflict:\s*!transitionApplied/);
  assert.match(actSource, /if\s*\(\s*!transitionApplied\s*\)\s*finalStep\s*=\s*observedStep/);

  const chatEngine = readSource('src/services/chatEngine.js');
  assert.match(chatEngine, /staleStepConflict/);
  assert.match(chatEngine, /stale_candidate_step/);
  assert.match(chatEngine, /effectiveReply\s*=\s*staleStepConflict\s*\?\s*null/);
});

test('el manifiesto registra el contrato compuesto de falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 7);
  const contract = manifest.compositeContracts.find((item) => item.id === 'conversation_engine_no_interest');
  assert.equal(contract.id, 'conversation_engine_no_interest');
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep', 'reminderScheduledFor', 'reminderState']);
  assert.ok(contract.excludedCombinations.includes('mark_rejected'));
  assert.ok(contract.excludedCombinations.includes('pause_bot'));
});

test('CandidateStateService usa updateMany para el cierre por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\.updateMany\s*\(/);
});

test('CandidateStateService fija DONE en el cierre por falta de interés', () => {
  const authority = readSource('src/services/candidateStateService.js');
  assert.match(
    authority,
    /function\s+completeCandidateNoInterestTransition[\s\S]*?data\s*:\s*\{[\s\S]*?currentStep\s*:\s*ConversationStep\.DONE/
  );
});

test('CandidateStateService limpia la fecha del recordatorio por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /reminderScheduledFor\s*:\s*null/);
});

test('CandidateStateService marca SKIPPED por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /reminderState\s*:\s*ReminderState\.SKIPPED/);
});

test('CandidateStateService no absorbe campos ajenos en falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);
});

test('conversationEngine delega el cierre exacto por falta de interés', () => {
  const engine = readSource('src/services/conversationEngine.js');
  const actSource = extractFunctionSource(engine, 'act');
  assert.match(actSource, /hasNoInterestTransition/);
  assert.match(actSource, /noInterestUpdateFields\.every/);
  assert.match(actSource, /completeCandidateNoInterestTransition\s*\(\s*prisma/);
  assert.match(actSource, /contract:\s*['"]no_interest['"]/);
});

test('el manifiesto registra el contrato compuesto de rechazo por requisitos', () => {
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
  assert.match(actSource, /contract:\s*['"]requirement_rejection['"]/);
});

test('el manifiesto registra el contrato compuesto de pause_bot explícito', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'conversation_engine_explicit_pause');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, [
    'botPaused',
    'botPausedAt',
    'botPauseReason',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.ok(contract.observedFields.includes('botPausedBy'));
  assert.ok(contract.observedFields.includes('botResumeMode'));
  assert.ok(contract.excludedCombinations.includes('mark_female_pipeline'));
  assert.ok(contract.excludedCombinations.includes('offer_interview'));
});

test('CandidateStateService implementa la pausa explícita exacta', () => {
  const transition = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'pauseCandidateAutomationFromConversationEngine'
  );
  assert.match(transition, /applyConditionalCandidatePauseTransition\s*\(/);
  assert.match(transition, /botPaused\s*:\s*true/);
  assert.match(transition, /botPausedAt\s*:\s*pausedAt/);
  assert.match(transition, /botPauseReason\s*:\s*reason/);
  assert.match(transition, /reminderScheduledFor\s*:\s*null/);
  assert.match(transition, /reminderState\s*:\s*ReminderState\.CANCELLED/);
  assert.doesNotMatch(transition, /currentStep|status|gender|vacancyId/);
});

test('conversationEngine delega únicamente pause_bot exacto', () => {
  const actSource = extractFunctionSource(readSource('src/services/conversationEngine.js'), 'act');
  assert.match(actSource, /hasExplicitPauseTransition/);
  assert.match(actSource, /explicitPauseUpdateFields\.every/);
  assert.match(actSource, /pauseCandidateAutomationFromConversationEngine\s*\(\s*prisma/);
  assert.match(actSource, /contract:\s*['"]explicit_pause['"]/);
});

test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {
  const engine = readSource('src/services/conversationEngine.js');
  const consent = readSource('src/services/consentStateService.js');
  const vacancyGate = readSource('src/services/vacancyFirstGate.js');
  const silentCapture = readSource('src/services/silentProfileCapture.js');

  assert.match(engine, /Object\.values\(ConversationStep\)\.includes\(nextStep\)/);
  assert.match(engine, /pendingUpdate\.currentStep = finalStep/);
  assert.match(consent, /ALLOWED_CANDIDATE_PATCH_FIELDS/);
  assert.match(consent, /'currentStep'/);
  assert.match(consent, /candidate_patch_field_not_allowed/);
  assert.doesNotMatch(vacancyGate, /prisma\.candidate\.(?:create|upsert|update|updateMany)\s*\(/);
  assert.doesNotMatch(silentCapture, /prisma\.candidate\.(?:create|upsert|update|updateMany)\s*\(/);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);
  assert.doesNotMatch(manifest.transitionFamilies.map((family) => family.id).join('|'), /generic|arbitrary|patch/i);
});

test('la documentación registra las fases migradas y mantiene el siguiente slice acotado', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /config\/candidate-progress-authority\.json/);
  assert.match(documentation, /Fase 1: caracterización del progreso conversacional/);
  assert.match(documentation, /Fase 2: autoridad multilinea migrada/);
  assert.match(documentation, /Fase 3: transiciones simples del engine/);
  assert.match(documentation, /Fase 4: cierre por falta de interés/);
  assert.match(documentation, /Fase 5: rechazo por requisitos/);
  assert.match(documentation, /Fase 6: pausa conversacional explícita/);
  assert.match(documentation, /Fase 6: pausa conversacional explícita/);
  assert.match(documentation, /scheduleCandidateMultilineWindow/);
  assert.match(documentation, /acquireCandidateMultilineBatch/);
  assert.match(documentation, /transitionCandidateConversationStep/);
  assert.match(documentation, /completeCandidateNoInterestTransition/);
  assert.match(documentation, /completeCandidateRequirementRejection/);
  assert.match(documentation, /pauseCandidateAutomationFromConversationEngine/);
  assert.match(documentation, /pauseCandidateAutomationFromConversationEngine/);
  assert.match(documentation, /stale_candidate_step/);
  assert.match(documentation, /conversationEngine\.act\(\)/);
  assert.match(documentation, /productor de decisión/i);
  assert.match(documentation, /escritor efectivo/i);
});


test('el manifiesto registra el contrato de currentStep del consentimiento', () => {
  const contract = manifest.stepContracts.find((item) => item.id === 'consent_step_transition');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/consentStateService.js');
  assert.equal(contract.responseConsumer, 'src/services/dataConsentGate.js');
  assert.deepEqual(contract.allowedFields, ['currentStep']);
  assert.equal(contract.status, 'canonical');

  const authority = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'transitionCandidateConsentStep');
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /currentStep\s*:\s*expectedStep/);
  assert.match(authority, /data\s*:\s*\{\s*currentStep\s*:\s*nextStep/);
  assert.doesNotMatch(authority, /dataConsent|status|vacancyId|botPaused|reminder/);

  const consent = readSource('src/services/consentStateService.js');
  assert.match(consent, /transitionCandidateConsentStep/);
  assert.match(consent, /CandidateConsentStepConflictError/);
  assert.match(consent, /candidate_consent_expected_current_step_required/);
  assert.match(consent, /conflict:\s*true/);

  const gate = readSource('src/services/dataConsentGate.js');
  assert.match(gate, /expected:\s*\{\s*currentStep:\s*candidate\.currentStep\s*\}/);
  assert.match(gate, /CONSENT_STEP_CONFLICT/);
});

test('la documentación registra la fase de consentimiento', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 7: currentStep del consentimiento/);
  assert.match(documentation, /transitionCandidateConsentStep/);
  assert.match(documentation, /CandidateDataConsentEvent/);
  assert.match(documentation, /no captura perfil ni envía respuesta obsoleta/i);
});


test('el manifiesto registra la autoridad de vacancyFirstGate', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'vacancy_first_gate_decision');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.decisionProducer, 'src/services/vacancyFirstGate.js');
  assert.equal(contract.consumer, 'src/routes/webhook.js');
  assert.deepEqual(contract.allowedFields, [
    'currentStep',
    'vacancyId',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.ok(contract.excludedCombinations.includes('silent_profile_capture'));
  assert.ok(contract.excludedCombinations.includes('gender_logic'));

  const authoritySource = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'applyCandidateVacancyFirstGateDecision'
  );
  assert.match(authoritySource, /candidate\.updateMany\s*\(/);
  assert.match(authoritySource, /vacancyFirstGateExpectedWhere\(expected\)/);
  assert.match(authoritySource, /data:\s*update/);

  const webhook = readSource('src/routes/webhook.js');
  const processText = extractFunctionSource(webhook, 'processText');
  assert.match(processText, /applyCandidateVacancyFirstGateDecision/);
  assert.match(processText, /STALE_CANDIDATE_VACANCY_FIRST_GATE/);
  assert.match(processText, /if\s*\(!applied\.applied\)\s*return;/);
});

test('la documentación registra la fase de vacancyFirstGate', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 8: autoridad de vacancyFirstGate/);
  assert.match(documentation, /applyCandidateVacancyFirstGateDecision/);
  assert.match(documentation, /STALE_CANDIDATE_VACANCY_FIRST_GATE/);
  assert.match(documentation, /captura silenciosa permanece fuera/i);
});



test('el manifiesto registra la autoridad de captura silenciosa', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'silent_profile_capture_decision');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.decisionProducer, 'src/services/silentProfileCapture.js');
  assert.equal(contract.consumer, 'src/routes/webhook.js');
  assert.equal(contract.status, 'canonical');
  assert.ok(contract.allowedFields.includes('fullName'));
  assert.ok(contract.allowedFields.includes('experienceSummary'));
  assert.ok(contract.allowedFields.includes('gender'));
  assert.ok(contract.observedFields.includes('vacancyId'));
  assert.ok(contract.excludedCombinations.includes('gender_policy_change'));

  const family = manifest.transitionFamilies.find((item) => item.id === 'silent_profile_capture_decision');
  assert.deepEqual(family.writers, ['src/services/candidateStateService.js']);

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'applyCandidateSilentProfileCapture'
  );
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /silentProfileCaptureExpectedWhere\(expected,\s*normalized\.profileFields\)/);
  assert.match(authority, /data:\s*normalized\.update/);

  const webhook = extractFunctionSource(readSource('src/routes/webhook.js'), 'processText');
  assert.match(webhook, /applyCandidateSilentProfileCapture/);
  assert.match(webhook, /STALE_CANDIDATE_SILENT_PROFILE_CAPTURE/);
});

test('la documentación registra la fase de captura silenciosa', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 9: autoridad de captura silenciosa/);
  assert.match(documentation, /applyCandidateSilentProfileCapture/);
  assert.match(documentation, /STALE_CANDIDATE_SILENT_PROFILE_CAPTURE/);
  assert.match(documentation, /no modifica detección, inferencia, filtros, rutas ni decisiones relacionadas con género/i);
});


test('el manifiesto registra la autoridad administrativa de progreso de entrevistas', () => {
  const contract = manifest.stepContracts.find((item) => item.id === 'admin_interview_progress_reflection');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/routes/admin.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep']);
  assert.deepEqual(contract.actions, {
    MANUAL_BOOKING_CREATED: 'SCHEDULED',
    LAST_BOOKING_DELETED: 'SCHEDULING'
  });

  const family = manifest.transitionFamilies.find((item) => item.id === 'admin_interview_progress_reflection');
  assert.ok(family);
  assert.deepEqual(family.writers, ['src/services/candidateStateService.js']);
  assert.deepEqual(family.destinations, ['SCHEDULING', 'SCHEDULED']);

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'reflectCandidateAdminInterviewProgress'
  );
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /currentStep\s*:\s*expectedStep/);
  assert.match(authority, /currentStep\s*:\s*nextStep/);
  assert.match(authority, /candidate_admin_interview_next_step_not_allowed/);
  assert.doesNotMatch(authority, /InterviewBooking|interviewBooking|status|gender|vacancyId|reminder/);

  const adminSource = manifest.sourceInventory.find((item) => item.path === 'src/routes/admin.js');
  assert.equal(adminSource.role, 'indirect_writer');
});

test('la documentación registra la fase administrativa de entrevistas', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 10: progreso administrativo de entrevistas/);
  assert.match(documentation, /reflectCandidateAdminInterviewProgress/);
  assert.match(documentation, /MANUAL_BOOKING_CREATED/);
  assert.match(documentation, /LAST_BOOKING_DELETED/);
  assert.match(documentation, /actor, motivo y origen esperado/i);
});


test('el manifiesto registra la autoridad de pausa por revisión manual', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'manual_review_pause_authority');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/routes/webhook.js');
  assert.equal(contract.responseConsumer, 'src/routes/webhook.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, [
    'botPaused',
    'botPausedAt',
    'botPauseReason',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.ok(contract.observedFields.includes('botPausedBy'));
  assert.ok(contract.observedFields.includes('botResumeMode'));
  assert.ok(contract.excludedCombinations.includes('gender_logic'));

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'pauseCandidateAutomationForManualReview'
  );
  assert.match(authority, /applyConditionalCandidatePauseTransition\s*\(/);
  assert.match(authority, /botPaused\s*:\s*true/);
  assert.match(authority, /botPausedAt\s*:\s*pausedAt/);
  assert.match(authority, /botPauseReason\s*:\s*reason/);
  assert.match(authority, /reminderScheduledFor\s*:\s*null/);
  assert.match(authority, /reminderState\s*:\s*ReminderState\.CANCELLED/);
  assert.doesNotMatch(authority, /currentStep|status|gender|vacancyId|interviewBooking/);
});

test('el webhook suprime la notificación si la pausa manual queda obsoleta', () => {
  const webhook = readSource('src/routes/webhook.js');
  const consumer = extractFunctionSource(webhook, 'pauseSilentlyForManualReview');
  assert.match(consumer, /pauseCandidateAutomationForManualReview/);
  assert.match(consumer, /STALE_CANDIDATE_MANUAL_REVIEW_PAUSE/);
  assert.match(consumer, /recordIntentionalSilence/);
  assert.doesNotMatch(consumer, /pauseInterviewFlow\s*\(/);
});

test('la documentación registra la fase de pausa por revisión manual', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 11: pausa por revisión manual/);
  assert.match(documentation, /pauseCandidateAutomationForManualReview/);
  assert.match(documentation, /STALE_CANDIDATE_MANUAL_REVIEW_PAUSE/);
  assert.match(documentation, /no notifica al\s+supervisor ni reintenta/i);
});



test('el manifiesto registra la autoridad del reflejo de reprogramación', () => {
  const contract = manifest.compositeContracts.find((item) => item.id === 'interview_reschedule_progress_reflection');
  assert.ok(contract);
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/chatEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, [
    'currentStep',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.deepEqual(contract.origins, ['SCHEDULING', 'SCHEDULED']);
  assert.ok(contract.excludedCombinations.includes('cancel_interview'));
  assert.ok(contract.excludedCombinations.includes('gender_logic'));

  const family = manifest.transitionFamilies.find((item) => item.id === 'appointment_reschedule_progress_reflection');
  assert.ok(family);
  assert.deepEqual(family.writers, ['src/services/candidateStateService.js']);
  assert.deepEqual(family.destinations, ['SCHEDULING']);

  const authority = extractFunctionSource(
    readSource('src/services/candidateStateService.js'),
    'reflectCandidateInterviewRescheduleProgress'
  );
  assert.match(authority, /candidate\.updateMany\s*\(/);
  assert.match(authority, /candidateInterviewRescheduleProgressExpectedWhere\(expected\)/);
  assert.match(authority, /currentStep:\s*ConversationStep\.SCHEDULING/);
  assert.match(authority, /reminderScheduledFor:\s*null/);
  assert.match(authority, /reminderState:\s*ReminderState\.SKIPPED/);
  assert.match(authority, /candidate_interview_reschedule_next_step_not_allowed/);
  assert.match(authority, /candidate_interview_reschedule_patch_not_allowed/);
  assert.doesNotMatch(authority, /InterviewBooking|interviewBooking|gender|vacancyId|botPaused/);
});

test('chatEngine delega la reprogramación y suprime respuestas sobre snapshots obsoletos', () => {
  const handler = extractFunctionSource(readSource('src/services/chatEngine.js'), 'handleAppointmentIntentDirectly');
  const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
  assert.ok(rescheduleStart >= 0);
  const rescheduleBranch = handler.slice(rescheduleStart);

  assert.match(rescheduleBranch, /reflectCandidateInterviewRescheduleProgress/);
  assert.match(rescheduleBranch, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(rescheduleBranch, /suppressedReason:\s*['"]stale_candidate_reschedule_progress['"]/);
  assert.doesNotMatch(rescheduleBranch, /prisma\.candidate\.update\s*\(/);

  const transitionIndex = handler.indexOf('applyInterviewReminderResponse');
  const reflectionIndex = handler.indexOf('reflectCandidateInterviewRescheduleProgress');
  const replyIndex = rescheduleBranch.indexOf('const reply =');
  assert.ok(transitionIndex >= 0 && reflectionIndex > transitionIndex);
  assert.ok(replyIndex > rescheduleBranch.indexOf('reflectCandidateInterviewRescheduleProgress'));
});

test('la documentación registra la fase del reflejo de reprogramación', () => {
  const documentation = readSource('docs/architecture/candidate-state-transition-inventory.md');
  assert.match(documentation, /Fase 12: reflejo de reprogramación/);
  assert.match(documentation, /reflectCandidateInterviewRescheduleProgress/);
  assert.match(documentation, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(documentation, /no construye ni envía la respuesta obsoleta/i);
});
