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

const adminPath = 'src/routes/admin.js';
let admin = read(adminPath);

admin = replaceOnce(
  admin,
  "import { buildManualInterventionCandidateUpdate, buildManualWhatsAppOpenCandidateUpdate } from '../services/adminOutboundPolicy.js';",
  "import { buildManualInterventionCandidateUpdate } from '../services/adminOutboundPolicy.js';",
  'admin_outbound_policy_import'
);

admin = replaceOnce(
  admin,
  `import {
  pauseCandidateAutomationFromAdmin,
  resumeCandidateAutomationFromAdmin
} from '../services/candidateStateService.js';`,
  `import {
  pauseCandidateAutomationFromAdmin,
  recordManualWhatsAppOpen,
  resumeCandidateAutomationFromAdmin
} from '../services/candidateStateService.js';`,
  'candidate_state_import'
);

admin = replaceOnce(
  admin,
  `        phone: true,
        status: true,
        vacancyId: true,
        vacancy: { select: { id: true, city: true } }`,
  `        phone: true,
        status: true,
        vacancyId: true,
        botPaused: true,
        botPausedAt: true,
        botPausedBy: true,
        botPauseReason: true,
        botResumeMode: true,
        devLastSeenAt: true,
        vacancy: { select: { id: true, city: true } }`,
  'whatsapp_open_candidate_snapshot'
);

admin = replaceOnce(
  admin,
  `    await prisma.candidate.update({
      where: { id },
      data: buildManualWhatsAppOpenCandidateUpdate({
        role: req.userRole,
        pausedBy: req.username || req.userRole || 'dashboard'
      })
    });
    if (req.userRole !== 'dev' && candidate.status !== 'CONTACTADO') {`,
  `    const transition = await recordManualWhatsAppOpen(prisma, {
      candidateId: candidate.id,
      role: req.userRole,
      actor: req.username || req.userRole || 'dashboard',
      expected: {
        botPaused: candidate.botPaused,
        botPausedAt: candidate.botPausedAt ?? null,
        botPausedBy: candidate.botPausedBy ?? null,
        botPauseReason: candidate.botPauseReason ?? null,
        botResumeMode: candidate.botResumeMode ?? null,
        devLastSeenAt: candidate.devLastSeenAt ?? null,
        status: candidate.status
      },
      now: new Date()
    });

    if (transition.count !== 1) {
      return res.redirect(withFlashMessage(
        returnTo,
        'error',
        'El estado del candidato cambió mientras se abría WhatsApp. Actualiza la página e intenta de nuevo.'
      ));
    }

    if (req.userRole !== 'dev' && candidate.status !== 'CONTACTADO') {`,
  'whatsapp_open_direct_update'
);

write(adminPath, admin);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
const manifest = JSON.parse(read(manifestPath));
const candidateStateWriter = manifest.models.candidate.writers.find(
  (writer) => writer.path === 'src/services/candidateStateService.js'
);
if (!candidateStateWriter) throw new Error('candidate_state_writer_missing');
candidateStateWriter.reason = 'Frontera de la autoridad objetivo para reanudación por inbound, pausa o reanudación explícita y apertura manual de WhatsApp con comparación optimista; Candidate continúa fragmentado';
write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
map = replaceOnce(
  map,
  '### Candidate: dos fronteras migradas',
  '### Candidate: tres fronteras migradas',
  'candidate_map_heading'
);
map = replaceOnce(
  map,
  'La primera frontera centralizada fue la reanudación por mensaje entrante después de una pausa manual. La segunda incorpora los botones explícitos de pausar y reanudar del panel administrativo. Los tres casos de uso comparan el snapshot completo de pausa —ID, marca temporal, actor, motivo y modo de reanudación— mediante `updateMany`. Si otra operación cambió ese estado, `count=0` evita sobrescribir o levantar una intervención concurrente y tampoco permite registrar un evento administrativo falso.',
  'La primera frontera centralizada fue la reanudación por mensaje entrante después de una pausa manual. La segunda incorpora los botones explícitos de pausar y reanudar del panel administrativo. La tercera migra la intervención implícita al abrir WhatsApp: además del snapshot completo de pausa, compara `status` para reclutadores o `devLastSeenAt` para DEV antes de actualizar. Todos los casos usan `updateMany`; si otra operación cambió el estado, `count=0` evita sobrescribir una intervención concurrente, retroceder el estado de selección, reemplazar una marca DEV más reciente o registrar un evento administrativo falso.',
  'candidate_map_progress'
);
write(mapPath, map);

fs.rmSync('scripts/apply-candidate-whatsapp-open-authority.mjs', { force: true });
