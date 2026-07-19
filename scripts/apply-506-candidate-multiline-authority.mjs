import fs from 'node:fs';

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function write(filePath, content) {
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
}

function replaceOnce(filePath, before, after) {
  const source = read(filePath);
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`missing_patch_anchor:${filePath}`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`ambiguous_patch_anchor:${filePath}`);
  }
  write(filePath, source.slice(0, first) + after + source.slice(first + before.length));
}

function replaceSection(filePath, startMarker, endMarker, replacement) {
  const source = read(filePath);
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`missing_section_start:${filePath}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`missing_section_end:${filePath}`);
  write(filePath, source.slice(0, start) + replacement + source.slice(end));
}

const candidateServicePath = 'src/services/candidateStateService.js';
replaceOnce(
  candidateServicePath,
  `function requireCandidateClient(client) {
  if (
    typeof client?.candidate?.updateMany !== 'function'
    || typeof client?.candidate?.findUnique !== 'function'
  ) {
    throw new TypeError('candidate_state_client_required');
  }
  return client;
}
`,
  `function requireCandidateClient(client) {
  if (
    typeof client?.candidate?.updateMany !== 'function'
    || typeof client?.candidate?.findUnique !== 'function'
  ) {
    throw new TypeError('candidate_state_client_required');
  }
  return client;
}

function requireCandidateMultilineClient(client) {
  if (
    typeof client?.candidate?.update !== 'function'
    || typeof client?.candidate?.updateMany !== 'function'
  ) {
    throw new TypeError('candidate_multiline_state_client_required');
  }
  return client;
}
`
);

replaceOnce(
  candidateServicePath,
  `function requireValidDate(value, fieldName) {
  if (value === null || typeof value === 'boolean') {
    throw new TypeError(\`${'${fieldName}'}_invalid\`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(\`${'${fieldName}'}_invalid\`);
  return date;
}
`,
  `function requireValidDate(value, fieldName) {
  if (value === null || typeof value === 'boolean') {
    throw new TypeError(\`${'${fieldName}'}_invalid\`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(\`${'${fieldName}'}_invalid\`);
  return date;
}

function requireMultilineBatchVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  return value;
}
`
);

replaceOnce(
  candidateServicePath,
  `export async function resumeCandidateAutomationOnInbound(client, input = {}) {`,
  `export async function scheduleCandidateMultilineWindow(client, input = {}) {
  const candidateClient = requireCandidateMultilineClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const windowUntil = requireValidDate(input.windowUntil, 'candidate_multiline_window_until');

  const updated = await candidateClient.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });

  return {
    windowUntil,
    batchVersion: requireMultilineBatchVersion(updated?.multilineBatchVersion)
  };
}

export async function acquireCandidateMultilineBatch(client, input = {}) {
  const candidateClient = requireCandidateMultilineClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expectedBatchVersion = requireMultilineBatchVersion(input.expectedBatchVersion);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_acquire_now');

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: expectedBatchVersion,
      multilineWindowUntil: { lte: now }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });

  return { count: Number(result?.count || 0) };
}

export async function resumeCandidateAutomationOnInbound(client, input = {}) {`
);

const webhookPath = 'src/routes/webhook.js';
replaceOnce(
  webhookPath,
  `import { resumeCandidateAutomationOnInbound } from '../services/candidateStateService.js';`,
  `import {
  acquireCandidateMultilineBatch,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';`
);

replaceOnce(
  webhookPath,
  `async function scheduleMultilineWindow(prisma, candidateId, context = {}) {
  const windowMs = getMultilineWindowMs(context);
  const windowUntil = new Date(Date.now() + windowMs);
  const updated = await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });

  return { windowMs, batchVersion: updated.multilineBatchVersion };
}`,
  `async function scheduleMultilineWindow(prisma, candidateId, context = {}) {
  const windowMs = getMultilineWindowMs(context);
  const windowUntil = new Date(Date.now() + windowMs);
  const transition = await scheduleCandidateMultilineWindow(prisma, {
    candidateId,
    windowUntil
  });

  return { windowMs, batchVersion: transition.batchVersion };
}`
);

replaceOnce(
  webhookPath,
  `async function tryAcquireMultilineProcessing(prisma, candidateId, batchVersion) {
  const acquired = await prisma.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: batchVersion,
      multilineWindowUntil: { lte: new Date() }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });
  return acquired.count === 1;
}`,
  `async function tryAcquireMultilineProcessing(prisma, candidateId, batchVersion) {
  const acquired = await acquireCandidateMultilineBatch(prisma, {
    candidateId,
    expectedBatchVersion: batchVersion,
    now: new Date()
  });
  return acquired.count === 1;
}`
);

const progressManifestPath = 'config/candidate-progress-authority.json';
const progressManifest = JSON.parse(read(progressManifestPath));
progressManifest.schemaVersion = 2;
progressManifest.phase = 'multiline_boundary';
progressManifest.rules.runtimeChangesAllowedInThisPhase = true;
progressManifest.rules.multilineRuntimeMigrated = true;
const webhookSource = progressManifest.sourceInventory.find((source) => source.path === 'src/routes/webhook.js');
if (!webhookSource) throw new Error('candidate_progress_webhook_source_missing');
webhookSource.trackedFields = ['currentStep'];
webhookSource.notes = 'Orquesta el flujo determinístico legacy; los dos contratos multilinea delegan su persistencia en CandidateStateService.';
if (progressManifest.sourceInventory.some((source) => source.path === candidateServicePath)) {
  throw new Error('candidate_progress_service_source_already_present');
}
const webhookSourceIndex = progressManifest.sourceInventory.indexOf(webhookSource);
progressManifest.sourceInventory.splice(webhookSourceIndex + 1, 0, {
  path: candidateServicePath,
  role: 'direct_writer',
  trackedFields: ['multilineWindowUntil', 'multilineBatchVersion'],
  notes: 'Autoridad estrecha para programar y adquirir lotes multilinea; no modifica currentStep.'
});
for (const contract of progressManifest.multilineContracts) {
  contract.owner = candidateServicePath;
  contract.orchestrator = webhookPath;
}
progressManifest.multilineContracts[0].preconditions = ['candidateId requerido', 'windowUntil válido'];
progressManifest.multilineContracts[0].concurrency = 'Cada programación usa candidate.update, extiende la ventana e invalida propietarios anteriores al incrementar la versión.';
progressManifest.multilineContracts[1].preconditions = ['candidateId requerido', 'versión esperada entera', 'multilineWindowUntil venció'];
progressManifest.nextMigrationSlices = [
  'migrar la reducción final de conversationEngine.act() con snapshot de currentStep',
  'migrar las transiciones de consentimiento manteniendo ConsentStateService como autoridad del evento',
  'migrar las ramas legacy de webhook por familias pequeñas',
  'migrar correcciones administrativas con actor, motivo y origen esperado'
];
write(progressManifestPath, JSON.stringify(progressManifest, null, 2));

const stateManifestPath = 'docs/architecture/state-authority-manifest.json';
const stateManifest = JSON.parse(read(stateManifestPath));
const candidateAuthorityWriter = stateManifest.models.candidate.writers.find((writer) => writer.path === candidateServicePath);
if (!candidateAuthorityWriter) throw new Error('candidate_state_manifest_service_missing');
candidateAuthorityWriter.reason = 'Frontera de la autoridad objetivo para reanudación por inbound, pausas administrativas, apertura de WhatsApp, entrega manual saliente, resolución del supervisor y contratos multilinea; Candidate continúa fragmentado';
write(stateManifestPath, JSON.stringify(stateManifest, null, 2));

const progressTestPath = 'test/candidateProgressAuthority.test.js';
replaceOnce(
  progressTestPath,
  `  assert.equal(manifest.phase, 'characterization');
  assert.equal(manifest.rules.runtimeChangesAllowedInThisPhase, false);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);`,
  `  assert.equal(manifest.phase, 'multiline_boundary');
  assert.equal(manifest.rules.runtimeChangesAllowedInThisPhase, true);
  assert.equal(manifest.rules.multilineRuntimeMigrated, true);
  assert.equal(manifest.rules.allowArbitraryCandidatePatch, false);`
);

replaceSection(
  progressTestPath,
  `test('los contratos multilinea preservan el compare-and-set observado', () => {`,
  `test('la reducción del engine y el consentimiento permanecen caracterizados sin una API genérica', () => {`,
  `test('los contratos multilinea pertenecen a CandidateStateService y preservan el compare-and-set', () => {
  assert.deepEqual(
    manifest.multilineContracts.map((contract) => contract.id),
    ['schedule_multiline_window', 'acquire_multiline_batch']
  );

  for (const contract of manifest.multilineContracts) {
    assert.equal(contract.owner, 'src/services/candidateStateService.js');
    assert.equal(contract.orchestrator, 'src/routes/webhook.js');
    assert.deepEqual(contract.allowedFields, ['multilineWindowUntil', 'multilineBatchVersion']);
    assert.ok(contract.concurrency);
    assert.ok(contract.idempotency);
  }

  const authority = readSource('src/services/candidateStateService.js');
  const webhook = readSource('src/routes/webhook.js');
  assert.match(authority, /export\s+async\s+function\s+scheduleCandidateMultilineWindow/);
  assert.match(authority, /multilineWindowUntil\s*:\s*windowUntil/);
  assert.match(authority, /multilineBatchVersion\s*:\s*\{\s*increment\s*:\s*1\s*,?\s*\}/);
  assert.match(authority, /export\s+async\s+function\s+acquireCandidateMultilineBatch/);
  assert.match(authority, /multilineBatchVersion\s*:\s*expectedBatchVersion/);
  assert.match(authority, /multilineWindowUntil\s*:\s*\{\s*lte\s*:\s*now\s*\}/);
  assert.match(authority, /multilineWindowUntil\s*:\s*null/);
  assert.match(webhook, /scheduleCandidateMultilineWindow\(prisma,\s*\{/);
  assert.match(webhook, /acquireCandidateMultilineBatch\(prisma,\s*\{/);
});

`
);

replaceOnce(
  progressTestPath,
  `  assert.match(documentation, /escritor efectivo/i);
});`,
  `  assert.match(documentation, /escritor efectivo/i);
  assert.match(documentation, /Fase 2: autoridad de ventana multilinea/);
  assert.match(documentation, /scheduleCandidateMultilineWindow/);
  assert.match(documentation, /acquireCandidateMultilineBatch/);
});`
);

const architecturePath = 'docs/architecture/candidate-state-transition-inventory.md';
replaceSection(
  architecturePath,
  '### Multilinea',
  '### Protección en CI',
  `### Multilinea

La primera frontera runtime del grupo ya pertenece a ` + '`CandidateStateService`' + `:

1. ` + '`scheduleMultilineWindow()`' + ` conserva en el webhook el cálculo de ` + '`windowMs`' + ` y la fecha futura.
2. ` + '`scheduleCandidateMultilineWindow()`' + ` persiste únicamente ` + '`multilineWindowUntil`' + ` e incrementa ` + '`multilineBatchVersion`' + `.
3. Cada nuevo inbound invalida al propietario anterior mediante otra versión.
4. ` + '`tryAcquireMultilineProcessing()`' + ` conserva la decisión de orquestación y delega la comparación.
5. ` + '`acquireCandidateMultilineBatch()`' + ` exige ID, versión exacta y ventana vencida.
6. La adquisición limpia la ventana e incrementa otra vez la versión.
7. Solo ` + '`count === 1`' + ` autoriza procesar el lote.

Este contrato no modifica ` + '`currentStep`' + `, no abre transacciones y no cambia tiempos, consolidación ni mensajes.

### Protección en CI`
);

replaceOnce(
  architecturePath,
  `### Siguiente orden de migración

1. Extraer la adquisición multilinea a un contrato estrecho de \`CandidateStateService\`.
2. Migrar la reducción final de \`conversationEngine.act()\` comparando el paso leído.
3. Migrar el reflejo de progreso del consentimiento sin absorber la autoridad del evento.
4. Dividir las ramas legacy de \`webhook.js\` por familias pequeñas.
5. Migrar correcciones administrativas con actor, motivo y origen esperado.
`,
  `### Siguiente orden de migración

1. Migrar la reducción final de \`conversationEngine.act()\` comparando el paso leído.
2. Migrar el reflejo de progreso del consentimiento sin absorber la autoridad del evento.
3. Dividir las ramas legacy de \`webhook.js\` por familias pequeñas.
4. Migrar correcciones administrativas con actor, motivo y origen esperado.

## Fase 2: autoridad de ventana multilinea

La persistencia de la ventana multilinea se extrajo sin mover la orquestación del webhook:

- \`scheduleCandidateMultilineWindow()\` valida candidato y fecha, escribe solo los dos campos permitidos y devuelve la versión persistida;
- \`acquireCandidateMultilineBatch()\` valida candidato, versión y fecha de adquisición, y conserva el compare-and-set mediante \`updateMany\`;
- una versión obsoleta o una ventana todavía abierta devuelve \`count === 0\`;
- los wrappers del webhook ya no ejecutan \`candidate.update\` ni \`candidate.updateMany\` directamente;
- no cambian \`sleep\`, consolidación, mensajes, replays ni la lógica relacionada con género.

\`Candidate\` continúa en estado \`fragmented\` porque \`currentStep\` y los demás grupos todavía tienen escritores distribuidos.
`
);

const ciPath = '.github/workflows/ci.yml';
replaceOnce(
  ciPath,
  `      - name: Run candidate state authority regressions
        run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js test/candidateWhatsAppOpenStateService.test.js test/candidateManualOutboundStateService.test.js test/candidateSupervisorReviewStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminCandidatePauseAuthority.test.js test/adminCandidateWhatsAppOpenAuthority.test.js test/adminSupervisorCandidateStateAuthority.test.js test/adminBotPause.test.js

      - name: Validate candidate progress authority inventory
        run: node --test test/candidateProgressAuthority.test.js
`,
  `      - name: Run candidate state authority regressions
        run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js test/candidateWhatsAppOpenStateService.test.js test/candidateManualOutboundStateService.test.js test/candidateSupervisorReviewStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminCandidatePauseAuthority.test.js test/adminCandidateWhatsAppOpenAuthority.test.js test/adminSupervisorCandidateStateAuthority.test.js test/adminBotPause.test.js

      - name: Run candidate multiline state authority regressions
        run: node --test test/candidateMultilineStateService.test.js test/webhookCandidateMultilineAuthority.test.js

      - name: Validate candidate progress authority inventory
        run: node --test test/candidateProgressAuthority.test.js
`
);

write('test/candidateMultilineStateService.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCandidateMultilineBatch,
  scheduleCandidateMultilineWindow
} from '../src/services/candidateStateService.js';

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { update: [], updateMany: [], transactions: 0 };

  const client = {
    candidate: {
      update: async (args) => {
        calls.update.push(args);
        if (!state || state.id !== args.where.id) throw new Error('candidate_not_found');
        state = {
          ...state,
          multilineWindowUntil: args.data.multilineWindowUntil,
          multilineBatchVersion: state.multilineBatchVersion + args.data.multilineBatchVersion.increment
        };
        return { multilineBatchVersion: state.multilineBatchVersion };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const deadline = state?.multilineWindowUntil ? new Date(state.multilineWindowUntil).getTime() : null;
        const limit = args.where.multilineWindowUntil?.lte
          ? new Date(args.where.multilineWindowUntil.lte).getTime()
          : null;
        const matches = Boolean(
          state
          && state.id === args.where.id
          && state.multilineBatchVersion === args.where.multilineBatchVersion
          && deadline !== null
          && limit !== null
          && deadline <= limit
        );
        if (!matches) return { count: 0 };
        state = {
          ...state,
          multilineWindowUntil: null,
          multilineBatchVersion: state.multilineBatchVersion + args.data.multilineBatchVersion.increment
        };
        return { count: 1 };
      }
    },
    $transaction: async () => {
      calls.transactions += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };

  return {
    client,
    calls,
    getState: () => (state ? { ...state } : null),
    setState: (next) => { state = next ? { ...next } : null; }
  };
}

const candidate = {
  id: 'candidate-multiline-1',
  multilineWindowUntil: null,
  multilineBatchVersion: 4
};

const windowUntil = new Date('2026-07-19T13:00:05.000Z');
const acquireAt = new Date('2026-07-19T13:00:05.001Z');

test('programa la ventana exacta e incrementa una sola versión', async () => {
  const { client, calls, getState } = createHarness(candidate);

  const result = await scheduleCandidateMultilineWindow(client, {
    candidateId: candidate.id,
    windowUntil
  });

  assert.equal(result.batchVersion, 5);
  assert.equal(result.windowUntil.getTime(), windowUntil.getTime());
  assert.equal(getState().multilineWindowUntil.getTime(), windowUntil.getTime());
  assert.equal(getState().multilineBatchVersion, 5);
  assert.deepEqual(calls.update[0], {
    where: { id: candidate.id },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  assert.equal(calls.transactions, 0);
});

test('adquiere únicamente la versión exacta después del vencimiento', async () => {
  const { client, calls, getState } = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 5
  });

  const result = await acquireCandidateMultilineBatch(client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: acquireAt
  });

  assert.equal(result.count, 1);
  assert.equal(getState().multilineWindowUntil, null);
  assert.equal(getState().multilineBatchVersion, 6);
  assert.deepEqual(calls.updateMany[0].where, {
    id: candidate.id,
    multilineBatchVersion: 5,
    multilineWindowUntil: { lte: acquireAt }
  });
  assert.deepEqual(calls.updateMany[0].data, {
    multilineWindowUntil: null,
    multilineBatchVersion: { increment: 1 }
  });
  assert.equal(calls.transactions, 0);
});

test('una versión obsoleta o una ventana abierta devuelven count cero sin mutar', async () => {
  const stale = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 6
  });
  const staleResult = await acquireCandidateMultilineBatch(stale.client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: acquireAt
  });
  assert.equal(staleResult.count, 0);
  assert.equal(stale.getState().multilineBatchVersion, 6);
  assert.equal(stale.getState().multilineWindowUntil.getTime(), windowUntil.getTime());

  const early = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 5
  });
  const earlyResult = await acquireCandidateMultilineBatch(early.client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: new Date('2026-07-19T13:00:04.999Z')
  });
  assert.equal(earlyResult.count, 0);
  assert.equal(early.getState().multilineBatchVersion, 5);
  assert.equal(early.getState().multilineWindowUntil.getTime(), windowUntil.getTime());
});

test('rechaza clientes, IDs, versiones y fechas inválidas', async () => {
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(null, {}),
    /candidate_multiline_state_client_required/
  );

  const { client } = createHarness(candidate);
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: ' ', windowUntil }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: null }),
    /candidate_multiline_window_until_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: false }),
    /candidate_multiline_window_until_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: 'not-a-date' }),
    /candidate_multiline_window_until_invalid/
  );

  for (const expectedBatchVersion of [null, -1, 1.5, '5']) {
    await assert.rejects(
      () => acquireCandidateMultilineBatch(client, {
        candidateId: candidate.id,
        expectedBatchVersion,
        now: acquireAt
      }),
      /candidate_multiline_batch_version_invalid/
    );
  }

  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: null
    }),
    /candidate_multiline_acquire_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: false
    }),
    /candidate_multiline_acquire_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: 'not-a-date'
    }),
    /candidate_multiline_acquire_now_invalid/
  );
});
`);

write('test/webhookCandidateMultilineAuthority.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, 'No se encontró el marcador inicial: ' + start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, 'No se encontró el marcador final: ' + end);
  return content.slice(startIndex, endIndex);
}

const scheduleFunction = between(
  source,
  'async function scheduleMultilineWindow',
  'async function fetchPendingTextBatch'
);
const acquireFunction = between(
  source,
  'async function tryAcquireMultilineProcessing',
  'async function markPotentialDuplicateByDocument'
);

test('webhook importa y delega ambos contratos multilinea', () => {
  assert.match(source, /acquireCandidateMultilineBatch/);
  assert.match(source, /scheduleCandidateMultilineWindow/);
  assert.match(scheduleFunction, /getMultilineWindowMs\(context\)/);
  assert.match(scheduleFunction, /scheduleCandidateMultilineWindow\(prisma,\s*\{/);
  assert.match(scheduleFunction, /candidateId/);
  assert.match(scheduleFunction, /windowUntil/);
  assert.match(acquireFunction, /acquireCandidateMultilineBatch\(prisma,\s*\{/);
  assert.match(acquireFunction, /expectedBatchVersion:\s*batchVersion/);
  assert.match(acquireFunction, /now:\s*new Date\(\)/);
  assert.match(acquireFunction, /acquired\.count === 1/);
});

test('los wrappers multilinea no escriben Candidate directamente', () => {
  const directWrite = /prisma\.candidate\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/;
  assert.doesNotMatch(scheduleFunction, directWrite);
  assert.doesNotMatch(acquireFunction, directWrite);
});

test('el webhook conserva tiempos, espera y consolidación fuera de la autoridad', () => {
  const schedulingCall = source.indexOf('const scheduling = await scheduleMultilineWindow');
  const sleepCall = source.indexOf('await sleep(scheduling.windowMs)', schedulingCall);
  const acquireCall = source.indexOf('const stillOwner = await tryAcquireMultilineProcessing', sleepCall);
  const pendingBatchCall = source.indexOf('const pendingBatch = await fetchPendingTextBatch', acquireCall);
  const consolidateCall = source.indexOf('const consolidatedText = consolidateTextMessages', pendingBatchCall);

  assert.ok(schedulingCall >= 0);
  assert.ok(sleepCall > schedulingCall);
  assert.ok(acquireCall > sleepCall);
  assert.ok(pendingBatchCall > acquireCall);
  assert.ok(consolidateCall > pendingBatchCall);
});
`);

console.log('issue_506_patch_applied');
