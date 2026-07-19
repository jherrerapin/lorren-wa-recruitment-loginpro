import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`${label}_source_not_unique`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

const docsPath = 'docs/architecture/candidate-state-transition-inventory.md';
const ciPath = '.github/workflows/ci.yml';
const workflowPath = '.github/workflows/apply-candidate-multiline-docs.yml';
const scriptPath = 'scripts/apply-candidate-multiline-docs.mjs';

let docs = fs.readFileSync(docsPath, 'utf8');

docs = replaceOnce(
  docs,
  `### Siguiente orden de migración

1. Extraer la adquisición multilinea a un contrato estrecho de \`CandidateStateService\`.
2. Migrar la reducción final de \`conversationEngine.act()\` comparando el paso leído.
3. Migrar el reflejo de progreso del consentimiento sin absorber la autoridad del evento.
4. Dividir las ramas legacy de \`webhook.js\` por familias pequeñas.
5. Migrar correcciones administrativas con actor, motivo y origen esperado.

## Reglas para la autoridad`,
  `### Siguiente orden de migración

1. Migrar la reducción final de \`conversationEngine.act()\` comparando el paso leído.
2. Migrar el reflejo de progreso del consentimiento sin absorber la autoridad del evento.
3. Dividir las ramas legacy de \`webhook.js\` por familias pequeñas.
4. Migrar correcciones administrativas con actor, motivo y origen esperado.

## Fase 2: autoridad multilinea migrada

La primera frontera runtime de progreso ya está centralizada sin cambiar los tiempos, la consolidación ni el orden del webhook.

### Contratos canónicos

- \`scheduleCandidateMultilineWindow()\` recibe \`candidateId\`, \`windowMs\` y una fecha válida. Calcula \`multilineWindowUntil\`, incrementa \`multilineBatchVersion\` de forma atómica y devuelve la versión asignada.
- \`acquireCandidateMultilineBatch()\` recibe \`candidateId\`, la versión esperada y una fecha válida. Ejecuta \`updateMany\` con ID, versión exacta y ventana vencida; limpia la ventana e incrementa otra vez la versión únicamente cuando \`count === 1\`.

Ambos contratos aceptan el cliente Prisma raíz o un \`tx\` existente y no abren transacciones anidadas. Las duraciones negativas o no finitas, las versiones negativas o no enteras y las fechas nulas o inválidas se rechazan antes de escribir.

### Responsabilidades después de la migración

- \`webhook.js\` conserva la decisión sobre la duración mediante \`getMultilineWindowMs()\`, duerme el mismo intervalo y procesa el lote únicamente cuando la autoridad devuelve \`count === 1\`.
- \`CandidateStateService\` es el único escritor del slice \`multilineWindowUntil\` / \`multilineBatchVersion\`.
- La persistencia de mensajes pendientes, su consolidación, el marcado \`respondedAt\` y los replays no cambian.

### Próxima frontera

El siguiente slice aislado es la reducción final de \`conversationEngine.act()\`. Debe comparar el \`currentStep\` leído, conservar sus guardas determinísticas y no absorber las autoridades de perfil o de \`InterviewBooking\`.

## Reglas para la autoridad`,
  'candidate_multiline_docs'
);

fs.writeFileSync(docsPath, docs);

let ci = fs.readFileSync(ciPath, 'utf8');
ci = replaceOnce(
  ci,
  'run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js',
  'run: node --test test/candidateStateService.test.js test/candidateMultilineStateService.test.js test/candidateAdminPauseStateService.test.js',
  'candidate_multiline_ci'
);
fs.writeFileSync(ciPath, ci);

fs.rmSync(workflowPath, { force: true });
fs.rmSync(scriptPath, { force: true });
