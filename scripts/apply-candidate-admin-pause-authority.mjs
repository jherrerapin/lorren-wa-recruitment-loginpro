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
  "import { describeResumeBehavior } from '../services/botAutomationPolicy.js';",
  `import {
  pauseCandidateAutomationFromAdmin,
  resumeCandidateAutomationFromAdmin
} from '../services/candidateStateService.js';`,
  'candidate_admin_pause_import'
);

const oldRoutes = `  // ── Pausar / reanudar bot ────────────────────────────────────
  router.post('/candidates/:id/bot-pause', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const reason = normalizeString(req.body.reason) || 'Pausa manual desde admin';
    if (!await ensureCandidateIdAccess(prisma, req, id, res, \`/admin/candidates/\${id}\`)) return;
    await prisma.candidate.update({
      where: { id },
      data: {
        botPaused: true,
        botPausedAt: new Date(),
        botPausedBy: req.userRole || 'admin',
        botPauseReason: reason,
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });
    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_PAUSED',
      eventLabel: 'Pausó el bot',
      note: reason
    });
    res.redirect(\`/admin/candidates/\${id}?botPauseSuccess=\` + encodeURIComponent('Bot pausado correctamente.'));
  });

  router.post('/candidates/:id/bot-resume', ensureDevRole, async (req, res) => {
    const { id } = req.params;
    if (!await ensureCandidateIdAccess(prisma, req, id, res, \`/admin/candidates/\${id}\`)) return;
    await prisma.candidate.update({
      where: { id },
      data: {
        botPaused: false,
        botPausedAt: null,
        botPauseReason: null,
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });
    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_RESUMED',
      eventLabel: 'Reanudó el bot'
    });
    res.redirect(\`/admin/candidates/\${id}?botPauseSuccess=\` + encodeURIComponent('Bot reanudado correctamente.'));
  });
`;

const newRoutes = `  // ── Pausar / reanudar bot ────────────────────────────────────
  router.post('/candidates/:id/bot-pause', ensureDevRole, express.urlencoded({ extended: true }), async (req, res) => {
    const { id } = req.params;
    const reason = normalizeString(req.body.reason) || 'Pausa manual desde admin';
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        vacancyId: true,
        botPaused: true,
        botPausedAt: true,
        botPausedBy: true,
        botPauseReason: true,
        botResumeMode: true,
        vacancy: { select: { id: true, city: true } }
      }
    });
    if (!candidate) {
      return res.redirect(\`/admin/candidates/\${id}?botPauseError=\` + encodeURIComponent('Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, candidate, res, \`/admin/candidates/\${id}\`)) return;

    const transition = await pauseCandidateAutomationFromAdmin(prisma, {
      candidateId: candidate.id,
      expected: {
        botPaused: candidate.botPaused,
        botPausedAt: candidate.botPausedAt ?? null,
        botPausedBy: candidate.botPausedBy ?? null,
        botPauseReason: candidate.botPauseReason ?? null,
        botResumeMode: candidate.botResumeMode ?? null
      },
      actor: req.userRole || 'admin',
      reason,
      now: new Date()
    });

    if (transition.count !== 1) {
      return res.redirect(\`/admin/candidates/\${id}?botPauseError=\` + encodeURIComponent('El estado del bot cambió mientras se procesaba la solicitud. Actualiza la página e intenta de nuevo.'));
    }

    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_PAUSED',
      eventLabel: 'Pausó el bot',
      note: reason
    });
    res.redirect(\`/admin/candidates/\${id}?botPauseSuccess=\` + encodeURIComponent('Bot pausado correctamente.'));
  });

  router.post('/candidates/:id/bot-resume', ensureDevRole, async (req, res) => {
    const { id } = req.params;
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      select: {
        id: true,
        vacancyId: true,
        botPaused: true,
        botPausedAt: true,
        botPausedBy: true,
        botPauseReason: true,
        botResumeMode: true,
        vacancy: { select: { id: true, city: true } }
      }
    });
    if (!candidate) {
      return res.redirect(\`/admin/candidates/\${id}?botPauseError=\` + encodeURIComponent('Candidato no encontrado.'));
    }
    if (!ensureCandidateAccess(req, candidate, res, \`/admin/candidates/\${id}\`)) return;

    const transition = await resumeCandidateAutomationFromAdmin(prisma, {
      candidateId: candidate.id,
      expected: {
        botPaused: candidate.botPaused,
        botPausedAt: candidate.botPausedAt ?? null,
        botPausedBy: candidate.botPausedBy ?? null,
        botPauseReason: candidate.botPauseReason ?? null,
        botResumeMode: candidate.botResumeMode ?? null
      }
    });

    if (transition.count !== 1) {
      return res.redirect(\`/admin/candidates/\${id}?botPauseError=\` + encodeURIComponent('El estado del bot cambió mientras se procesaba la solicitud. Actualiza la página e intenta de nuevo.'));
    }

    await logCandidateAdminEvent(prisma, {
      candidateId: id,
      actorRole: req.userRole,
      eventType: 'BOT_RESUMED',
      eventLabel: 'Reanudó el bot'
    });
    res.redirect(\`/admin/candidates/\${id}?botPauseSuccess=\` + encodeURIComponent('Bot reanudado correctamente.'));
  });
`;

admin = replaceOnce(admin, oldRoutes, newRoutes, 'candidate_admin_pause_routes');
write(adminPath, admin);

const ciPath = '.github/workflows/ci.yml';
let ci = read(ciPath);
ci = replaceOnce(
  ci,
  '        run: node --test test/candidateStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminBotPause.test.js',
  '        run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminCandidatePauseAuthority.test.js test/adminBotPause.test.js',
  'candidate_ci_gate'
);
write(ciPath, ci);

const manifestPath = 'docs/architecture/state-authority-manifest.json';
let manifest = read(manifestPath);
manifest = replaceOnce(
  manifest,
  '"reason": "Primera frontera de la autoridad objetivo para reanudación condicional por mensaje entrante; Candidate continúa fragmentado"',
  '"reason": "Frontera de la autoridad objetivo para reanudación condicional por inbound y pausa o reanudación explícita desde admin; Candidate continúa fragmentado"',
  'candidate_manifest_reason'
);
write(manifestPath, manifest);

const mapPath = 'docs/architecture/state-authority-map.md';
let map = read(mapPath);
const oldProgress = `### Candidate: primera frontera migrada

\`CandidateStateService\` inicia como autoridad estrecha sin convertir todavía el agregado en canónico. En el manifiesto se declara como \`boundary\` transitorio porque \`ConsentStateService\` continúa siendo el escritor canónico del subgrupo de consentimiento mientras los demás consumidores todavía escriben otros campos de \`Candidate\`.

La primera operación centralizada es la reanudación por mensaje entrante después de una pausa manual. El webhook conserva la decisión mediante \`shouldBlockAutomation()\` y \`shouldResumeAutomationOnInbound()\`, pero la persistencia compara el snapshot completo de pausa —ID, marca temporal, actor, motivo y modo de reanudación— mediante \`updateMany\`. Si otra operación cambió la pausa, \`count=0\` evita sobrescribirla y el webhook devuelve el estado actual sin registrar una reanudación falsa.

La incorporación temporal de la nueva frontera aumenta el inventario a dieciséis escritores porque los quince consumidores heredados todavía modifican otros grupos de campos de \`Candidate\`. El agregado permanece \`fragmented\` hasta migrar cada frontera y resolver la autoridad final por composición de casos de uso.
`;
const newProgress = `### Candidate: dos fronteras migradas

\`CandidateStateService\` continúa como autoridad estrecha sin convertir todavía el agregado en canónico. En el manifiesto se declara como \`boundary\` transitorio porque \`ConsentStateService\` conserva la autoridad especializada del consentimiento y otros consumidores todavía escriben grupos distintos de \`Candidate\`.

La primera frontera centralizada fue la reanudación por mensaje entrante después de una pausa manual. La segunda incorpora los botones explícitos de pausar y reanudar del panel administrativo. Los tres casos de uso comparan el snapshot completo de pausa —ID, marca temporal, actor, motivo y modo de reanudación— mediante \`updateMany\`. Si otra operación cambió ese estado, \`count=0\` evita sobrescribir o levantar una intervención concurrente y tampoco permite registrar un evento administrativo falso.

El inventario permanece en dieciséis escritores porque \`admin.js\` todavía modifica otros grupos de campos de \`Candidate\`. El agregado continúa \`fragmented\` hasta migrar cada frontera y resolver la autoridad final por composición de casos de uso.
`;
map = replaceOnce(map, oldProgress, newProgress, 'candidate_progress_section');
write(mapPath, map);

fs.rmSync('scripts/apply-candidate-admin-pause-authority.mjs', { force: true });
