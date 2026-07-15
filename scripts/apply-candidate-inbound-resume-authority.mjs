import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`${label}_not_found`);
  if (content.indexOf(search, first + search.length) >= 0) throw new Error(`${label}_not_unique`);
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

const webhookPath = 'src/routes/webhook.js';
let webhook = read(webhookPath);

webhook = replaceOnce(
  webhook,
  "import { buildInboundResumeUpdate, shouldBlockAutomation, shouldResumeAutomationOnInbound } from '../services/botAutomationPolicy.js';",
  "import { shouldBlockAutomation, shouldResumeAutomationOnInbound } from '../services/botAutomationPolicy.js';\nimport { resumeCandidateAutomationOnInbound } from '../services/candidateStateService.js';",
  'candidate_authority_import'
);

const oldFunction = `async function prepareCandidateForInboundAutomation(prisma, candidate = {}) {
  if (!candidate?.botPaused) return candidate;
  if (shouldBlockAutomation(candidate, { direction: 'INBOUND' })) return candidate;
  if (!shouldResumeAutomationOnInbound(candidate)) return candidate;

  const resumed = await prisma.candidate.update({
    where: { id: candidate.id },
    data: buildInboundResumeUpdate(new Date())
  });

  console.info('[BOT_RESUMED_BY_INBOUND]', JSON.stringify({
    candidateId: candidate.id,
    previousReason: candidate.botPauseReason || null,
    previousResumeMode: candidate.botResumeMode || null
  }));

  return resumed;
}
`;

const newFunction = `async function prepareCandidateForInboundAutomation(prisma, candidate = {}) {
  if (!candidate?.botPaused) return candidate;
  if (shouldBlockAutomation(candidate, { direction: 'INBOUND' })) return candidate;
  if (!shouldResumeAutomationOnInbound(candidate)) return candidate;

  const transition = await resumeCandidateAutomationOnInbound(prisma, {
    candidateId: candidate.id,
    expected: {
      botPaused: candidate.botPaused,
      botPausedAt: candidate.botPausedAt ?? null,
      botPausedBy: candidate.botPausedBy ?? null,
      botPauseReason: candidate.botPauseReason ?? null,
      botResumeMode: candidate.botResumeMode ?? null
    },
    now: new Date()
  });

  if (transition.count === 1) {
    console.info('[BOT_RESUMED_BY_INBOUND]', JSON.stringify({
      candidateId: candidate.id,
      previousReason: candidate.botPauseReason || null,
      previousResumeMode: candidate.botResumeMode || null
    }));
  }

  return transition.candidate || candidate;
}
`;

webhook = replaceOnce(webhook, oldFunction, newFunction, 'candidate_inbound_resume_function');
write(webhookPath, webhook);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
const manifest = JSON.parse(read(manifestPath));
const candidate = manifest?.models?.candidate;
if (!candidate || candidate.migrationStage !== 'fragmented') {
  throw new Error('candidate_manifest_stage_invalid');
}
if (!candidate.writers.some((writer) => writer.path === 'src/services/candidateStateService.js')) {
  candidate.writers.push({
    path: 'src/services/candidateStateService.js',
    role: 'canonical',
    reason: 'Primera autoridad estrecha para reanudación condicional por mensaje entrante y futura consolidación de Candidate'
  });
}
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  '| `Candidate` | 15 | Crítico | Fragmentado | `CandidateStateService` |',
  '| `Candidate` | 16 | Crítico | Fragmentado | `CandidateStateService` |',
  'candidate_writer_count'
);
const marker = '## Progreso de consolidación\n\n';
const progress = `### Candidate: primera frontera migrada

\`CandidateStateService\` inicia como autoridad estrecha sin convertir todavía el agregado en canónico. La primera operación centralizada es la reanudación por mensaje entrante después de una pausa manual.

El webhook conserva la decisión mediante \`shouldBlockAutomation()\` y \`shouldResumeAutomationOnInbound()\`, pero la persistencia compara el snapshot completo de pausa —ID, marca temporal, actor, motivo y modo de reanudación— mediante \`updateMany\`. Si otra operación cambió la pausa, \`count=0\` evita sobrescribirla y el webhook devuelve el estado actual sin registrar una reanudación falsa.

La incorporación temporal de la autoridad aumenta el inventario a dieciséis escritores porque los quince consumidores heredados todavía modifican otros grupos de campos de \`Candidate\`. El agregado permanece \`fragmented\` hasta migrar cada frontera.

`;
map = replaceOnce(map, marker, marker + progress, 'candidate_progress_section');
map = map.replace('## Hallazgos\n\n## Hallazgos', '## Hallazgos');
map = map.replace('### 3. La persistencia de mensajes ya tiene una autoridad única### 3. La persistencia de mensajes ya tiene una autoridad única', '### 3. La persistencia de mensajes ya tiene una autoridad única');
write(mapPath, map);

fs.rmSync('scripts/apply-candidate-inbound-resume-authority.mjs', { force: true });
