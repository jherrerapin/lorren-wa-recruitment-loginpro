from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    source = read(path)
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one match, found {count}: {old[:100]!r}')
    write(path, source.replace(old, new, 1))


def replace_tail(path: str, marker: str, new_tail: str) -> None:
    source = read(path)
    index = source.find(marker)
    if index < 0:
        raise RuntimeError(f'{path}: marker not found: {marker!r}')
    write(path, source[:index] + new_tail)


# ---------------------------------------------------------------------------
# Runtime: shared profile persistence independent from consent, while preserving
# the existing consent-specific writer as a guarded wrapper.
# ---------------------------------------------------------------------------
replace_tail(
    'src/services/consentProfileCapture.js',
    'export async function captureConsentedProfileData({',
    r'''async function captureProfileData({
  prisma,
  candidate,
  vacancy = null,
  currentText = '',
  requireAcceptedConsent = true,
  stripConsentPrefix = true
} = {}) {
  if (!candidate?.id) {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  if (requireAcceptedConsent && candidate?.dataConsentStatus !== 'ACCEPTED') {
    return { candidate, capturedFields: [], reason: 'consent_not_accepted' };
  }

  const inboundText = String(currentText || '').trim();
  if (!inboundText) {
    return { candidate, capturedFields: [], reason: 'no_profile_data' };
  }

  const profileText = stripConsentPrefix ? stripConsentDeclaration(inboundText) : inboundText;
  if (!profileText) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  const extracted = extractHighConfidenceFields(profileText, vacancy);
  const update = {};
  for (const [field, value] of Object.entries(extracted)) {
    if (!hasValue(candidate[field])) update[field] = value;
  }

  if (!Object.keys(update).length) {
    return { candidate, capturedFields: [], reason: 'no_new_profile_data' };
  }

  if (typeof prisma?.candidate?.updateMany !== 'function'
    || typeof prisma?.candidate?.findUnique !== 'function') {
    return { candidate, capturedFields: [], reason: 'candidate_not_ready' };
  }

  const where = {
    id: candidate.id,
    ...(requireAcceptedConsent ? { dataConsentStatus: 'ACCEPTED' } : {})
  };
  const writeResult = await prisma.candidate.updateMany({ where, data: update });
  const canonicalCandidate = await prisma.candidate.findUnique({
    where: { id: candidate.id }
  });

  if (writeResult.count !== 1) {
    return {
      candidate: canonicalCandidate || candidate,
      capturedFields: [],
      reason: requireAcceptedConsent ? 'consent_changed_before_write' : 'candidate_changed_before_write'
    };
  }

  return {
    candidate: canonicalCandidate || { ...candidate, ...update },
    capturedFields: Object.keys(update),
    reason: requireAcceptedConsent
      ? 'profile_data_captured_from_consent_message'
      : 'profile_data_captured_from_visible_inbound'
  };
}

export async function captureConsentedProfileData(input = {}) {
  return captureProfileData({
    ...input,
    requireAcceptedConsent: true,
    stripConsentPrefix: true
  });
}

export async function captureVisibleProfileData(input = {}) {
  return captureProfileData({
    ...input,
    requireAcceptedConsent: false,
    stripConsentPrefix: false
  });
}
'''
)

# ---------------------------------------------------------------------------
# Consent gate: normal visible content bypasses the gate only when it is a new
# turn. A previously claimed PENDING turn must recover inside the gate, and a
# human pause must not short-circuit that recovery.
# ---------------------------------------------------------------------------
replace_once(
    'src/services/dataConsentGate.js',
    """        if (!withdrawalRequested) {
          const pauseDecision = await preparePausedCandidateForConsentGate(prisma, candidate, message);""",
    """        if (!withdrawalRequested && !recovering) {
          const pauseDecision = await preparePausedCandidateForConsentGate(prisma, candidate, message);"""
)
replace_once(
    'src/services/dataConsentGate.js',
    """        if (!withdrawalRequested && !consentDecisionTurn
            && (isProtectedAttachment(message) || profileDataDecision.containsProfileData)) {""",
    """        if (!recovering && !withdrawalRequested && !consentDecisionTurn
            && (isProtectedAttachment(message) || profileDataDecision.containsProfileData)) {"""
)

# ---------------------------------------------------------------------------
# Webhook: persist first, then apply rate limiting/consent functional holds.
# Text PII is persisted by the shared profile writer without entering AI traces;
# documents keep using the existing CV storage path but cannot advance the flow
# until current-version consent is accepted.
# ---------------------------------------------------------------------------
replace_once(
    'src/routes/webhook.js',
    "import { requestDataConsent, buildDataConsentPromptReply } from '../services/dataConsentGate.js';",
    """import {
  DATA_CONSENT_VERSION,
  buildDataConsentPromptReply,
  evaluateProfileDataEvidence,
  requestDataConsent,
  shouldRequestConsentForTurn
} from '../services/dataConsentGate.js';"""
)
replace_once(
    'src/routes/webhook.js',
    "import { getOpenAiModelConfig } from '../services/openAiModelConfig.js';",
    """import { getOpenAiModelConfig } from '../services/openAiModelConfig.js';
import { captureVisibleProfileData } from '../services/consentProfileCapture.js';"""
)
replace_once(
    'src/routes/webhook.js',
    "console.warn('[RATE_LIMIT_HIT]', JSON.stringify({ phone, count: timestamps.length, windowMs: RATE_WINDOW_MS }));",
    "console.warn('[RATE_LIMIT_HIT]', JSON.stringify({ phoneTail: String(phone || '').slice(-4), count: timestamps.length, windowMs: RATE_WINDOW_MS }));"
)
replace_once(
    'src/routes/webhook.js',
    """function normalizeText(text = '') { return text.trim(); }""",
    """function hasCurrentDataConsent(candidate = {}) {
  return candidate?.dataConsentStatus === 'ACCEPTED'
    && candidate?.dataConsentVersion === DATA_CONSENT_VERSION;
}

function normalizeText(text = '') { return text.trim(); }"""
)
replace_once(
    'src/routes/webhook.js',
    "        if (!checkRateLimit(from)) continue;",
    "        const rateLimited = !checkRateLimit(from);"
)
replace_once(
    'src/routes/webhook.js',
    """          await cancelReminderOnInbound(prisma, candidate.id);

          let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
          if (shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' })) continue;""",
    """          let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          const preConsentProfileDecision = !hasCurrentDataConsent(freshCandidate)
            ? evaluateProfileDataEvidence(cleanText, { candidate: freshCandidate })
            : { containsProfileData: false };

          if (preConsentProfileDecision.containsProfileData) {
            const storageVacancy = freshCandidate.vacancyId
              ? await loadVacancyContext(prisma, freshCandidate.vacancyId)
              : null;
            const captured = await captureVisibleProfileData({
              prisma,
              candidate: freshCandidate,
              vacancy: storageVacancy,
              currentText: cleanText
            });
            freshCandidate = captured.candidate || freshCandidate;

            const needsCurrentVersionPrompt = freshCandidate.dataConsentStatus === 'ACCEPTED'
              && freshCandidate.dataConsentVersion !== DATA_CONSENT_VERSION;
            const consentTurn = shouldRequestConsentForTurn(freshCandidate, cleanText);
            if (freshCandidate.dataConsentStatus !== 'REVOKED'
                && (needsCurrentVersionPrompt || consentTurn.allowed)) {
              await requestDataConsent(prisma, {
                candidate: freshCandidate,
                to: from,
                inboundMessageId: message.id
              });
            }

            await markConversationMessagesResponded(prisma, {
              messageIds: [inbound.id],
              respondedAt: new Date()
            });
            continue;
          }

          if (rateLimited) {
            await markConversationMessagesResponded(prisma, {
              messageIds: [inbound.id],
              respondedAt: new Date()
            });
            continue;
          }

          await cancelReminderOnInbound(prisma, candidate.id);
          freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
          if (shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' })) continue;"""
)
replace_once(
    'src/routes/webhook.js',
    """        await cancelReminderOnInbound(prisma, candidate.id);

        let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
        const automationBlocked = shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' });""",
    """        let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        const consentAutomationHold = !hasCurrentDataConsent(freshCandidate);
        if (!consentAutomationHold) {
          await cancelReminderOnInbound(prisma, candidate.id);
          freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
        }
        const automationBlocked = consentAutomationHold
          || rateLimited
          || shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' });"""
)
replace_once(
    'src/routes/webhook.js',
    """            if (isFeatureEnabled('FF_ATTACHMENT_ANALYZER', false)) {
              if (await shouldSuppressAttachmentReply('image')) continue;""",
    """            if (!automationBlocked && isFeatureEnabled('FF_ATTACHMENT_ANALYZER', false)) {
              if (await shouldSuppressAttachmentReply('image')) continue;"""
)
replace_once(
    'src/routes/webhook.js',
    """                  if (requiresHumanReview) {
                    await pauseForManualQuestionReview(prisma, freshCandidate, from, filename || '');
                  } else {
                    const attachmentDecision = deriveAttachmentDecision(analysis.classification);
                    if (await shouldSuppressAttachmentReply('document')) continue;
                    await composeContextualAttachmentReply(prisma, {
                      candidate: freshCandidate,
                      from,
                      inboundText: filename,
                      recentOutbound,
                      situation: attachmentDecision.situation,
                      decision: 'attachment_not_saved_request_valid_cv',
                      attachmentAnalysis: analysis,
                      fallbackIntent: attachmentDecision.fallbackIntent,
                      requiresHumanReview: false,
                      rawPayload: { replyIntent: attachmentDecision.fallbackIntent }
                    });
                  }
                  continue;""",
    """                  if (requiresHumanReview) {
                    if (!automationBlocked) {
                      await pauseForManualQuestionReview(prisma, freshCandidate, from, filename || '');
                    }
                  } else if (!automationBlocked) {
                    const attachmentDecision = deriveAttachmentDecision(analysis.classification);
                    if (await shouldSuppressAttachmentReply('document')) continue;
                    await composeContextualAttachmentReply(prisma, {
                      candidate: freshCandidate,
                      from,
                      inboundText: filename,
                      recentOutbound,
                      situation: attachmentDecision.situation,
                      decision: 'attachment_not_saved_request_valid_cv',
                      attachmentAnalysis: analysis,
                      fallbackIntent: attachmentDecision.fallbackIntent,
                      requiresHumanReview: false,
                      rawPayload: { replyIntent: attachmentDecision.fallbackIntent }
                    });
                  }
                  continue;"""
)
replace_once(
    'src/routes/webhook.js',
    "console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename, mimeType }));",
    "console.log('[CV_TRACE]', JSON.stringify({ candidateId: candidate.id, mimeType, consentAutomationHold }));"
)

# ---------------------------------------------------------------------------
# Deterministic replay: an attachment is persisted but the application remains
# held. It is no longer rejected, redacted, or converted into a resend request.
# ---------------------------------------------------------------------------
replace_once(
    'test/conversation-replay/planningReplay.js',
    """const PRE_CONSENT_CV_RESEND_MODE = 'pre_consent_cv_resend';
const PROTECTED_ATTACHMENT_BOUNDARY_REASONS = new Set([
  'attachment_before_consent',
  'capture_mode_without_consent',
  'consent_pending',
  'consent_revoked'
]);
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const PRE_CONSENT_ATTACHMENT_REPLY = 'Recibí que intentaste enviar un archivo, pero todavía no lo descargué ni lo guardé. Antes de recibir datos, hojas de vida o documentos necesito tu autorización para el tratamiento de datos.';
const CONSENT_PROMPT = `Antes de recibir o guardar datos personales, hojas de vida o documentos, necesito tu autorización para tratarlos con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si autorizas o si no autorizas.`;""",
    """const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const CONSENT_PROMPT = `Para continuar con tu postulación necesito que me indiques si autorizas a LoginPro a tratar tus datos con fines de reclutamiento.\n\n${DATA_CONSENT_TEXT}\n\nElige Sí autorizo o No autorizo. También puedes responder por escrito.`;"""
)
replace_once(
    'test/conversation-replay/planningReplay.js',
    """  const consentReply = status === 'ACCEPTED'
    ? buildConsentAcceptedReply(state.candidate, state.vacancy, {
      cvResendRequired: parseConsentPendingMode(fixture.initialState.candidate.botResumeMode).cvResendRequired
    })
    : CONSENT_REVOKED_REPLY;""",
    """  const consentReply = status === 'ACCEPTED'
    ? buildConsentAcceptedReply(state.candidate, state.vacancy)
    : CONSENT_REVOKED_REPLY;"""
)
planning = read('test/conversation-replay/planningReplay.js')
start = planning.find('function resolveAttachmentResumeMode')
end = planning.find('\nfunction planVacancyQuestion', start)
if start < 0 or end < 0:
    raise RuntimeError('planningReplay.js: attachment planner block not found')
new_attachment_planner = r'''function planPreConsentAttachment(fixture, state) {
  const boundary = evaluateConsentBoundary(state.candidate, buildInboundMessage(fixture));
  if (boundary.block || boundary.reason !== 'content_persists_independently_of_consent') {
    throw new Error(`${fixture.id}: el adjunto no quedó habilitado para persistencia independiente del consentimiento`);
  }

  const attachment = fixture.inbound.attachment || {};
  state.candidate.cvStorageKey = `fixture:${fixture.inbound.messageId}`;
  state.candidate.cvOriginalName = attachment.fileName || null;
  state.candidate.cvMimeType = attachment.mimeType || null;
  const actions = [
    {
      type: 'PERSIST_PRECONSENT_ATTACHMENT',
      data: {
        attachmentKind: fixture.inbound.type,
        fileName: attachment.fileName || null,
        mimeType: attachment.mimeType || null
      }
    },
    { type: 'HOLD_APPLICATION_UNTIL_CONSENT' }
  ];
  const allowedWrites = [
    'candidate.cvStorageKey',
    'candidate.cvOriginalName',
    'candidate.cvMimeType',
    'attachment.download',
    'attachment.persist'
  ];

  return {
    plan: {
      actions,
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: {
      consentBoundary: boundary,
      attachment: structuredClone(attachment),
      attachmentPersisted: true,
      functionalHold: true
    }
  };
}
'''
write('test/conversation-replay/planningReplay.js', planning[:start] + new_attachment_planner + planning[end:])

# Update the single canonical pre-consent attachment fixture.
fixture_path = 'test/conversation-replay/fixtures/attachments/document-before-consent.json'
fixture = json.loads(read(fixture_path))
fixture['title'] = 'Un documento enviado antes de autorizar se guarda sin avanzar la postulación'
fixture['expected']['plan'] = {
    'actions': [
        {
            'type': 'PERSIST_PRECONSENT_ATTACHMENT',
            'data': {
                'attachmentKind': 'document',
                'fileName': 'TEST-HV.docx',
                'mimeType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            }
        },
        {'type': 'HOLD_APPLICATION_UNTIL_CONSENT'}
    ],
    'allowedWrites': [
        'candidate.cvStorageKey',
        'candidate.cvOriginalName',
        'candidate.cvMimeType',
        'attachment.download',
        'attachment.persist'
    ],
    'forbiddenWrites': [
        'candidate.currentStep',
        'candidate.status',
        'candidate.dataConsentStatus',
        'candidate.botResumeMode',
        'message.outbound'
    ],
    'nextStep': 'GREETING_SENT'
}
fixture['expected']['response'] = {
    'requiredFacts': [
        'El archivo puede persistirse aunque el consentimiento siga pendiente',
        'La postulación no avanza hasta resolver el consentimiento'
    ],
    'forbiddenClaims': [
        'El archivo fue descartado por falta de consentimiento',
        'Debe reenviar la hoja de vida por haberla enviado antes de autorizar'
    ],
    'requiredText': [],
    'forbiddenText': ['no lo guardé', 'vuelve a adjuntar']
}
fixture['expected']['finalState'] = {
    'dataConsentStatus': 'PENDING',
    'currentStep': 'GREETING_SENT',
    'botResumeMode': None,
    'cvData': None,
    'cvStorageKey': 'fixture:test-message-attachment-001',
    'cvOriginalName': 'TEST-HV.docx',
    'cvMimeType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}
write(fixture_path, json.dumps(fixture, ensure_ascii=False, indent=2) + '\n')

replace_once(
    'test/conversationReplayPlanning.test.js',
    "import { parseConsentPendingMode } from '../src/services/dataConsentGate.js';\n",
    ''
)
replace_once(
    'test/conversationReplayPlanning.test.js',
    """  if (intent === 'SEND_ATTACHMENT') {
    assert.equal(replay.evidence.consentBoundary.block, true, `${label}: el adjunto debe quedar bloqueado antes del consentimiento`);
    assert.equal(replay.evidence.consentBoundary.reason, 'attachment_before_consent', `${label}: razón de bloqueo incorrecta`);
    const pending = parseConsentPendingMode(replay.finalState.botResumeMode);
    assert.equal(pending.pending, true, `${label}: debe quedar consentimiento pendiente`);
    assert.equal(pending.cvResendRequired, true, `${label}: debe solicitarse reenvío del archivo después de autorizar`);
  }""",
    """  if (intent === 'SEND_ATTACHMENT') {
    assert.equal(replay.evidence.consentBoundary.block, false, `${label}: el adjunto debe llegar a persistencia aunque falte consentimiento`);
    assert.equal(replay.evidence.consentBoundary.reason, 'content_persists_independently_of_consent', `${label}: razón de persistencia incorrecta`);
    assert.equal(replay.evidence.attachmentPersisted, true, `${label}: el adjunto debe quedar persistido`);
    assert.equal(replay.evidence.functionalHold, true, `${label}: la postulación debe permanecer detenida`);
  }"""
)

# Replace attachment edge regressions with the new persistence + hold contract.
write('test/conversationReplayConsentAttachmentEdges.test.js', r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { replayFixtureInterpretation } from './conversation-replay/interpretationReplay.js';
import { replayFixturePlanning } from './conversation-replay/planningReplay.js';

function fixtureById(id) {
  const entry = loadConversationFixtures().find(({ fixture }) => fixture.id === id);
  assert.ok(entry, `fixture no encontrado: ${id}`);
  return structuredClone(entry.fixture);
}

function assertStoredWithConsentHold(planning) {
  assert.equal(planning.evidence.consentBoundary.block, false);
  assert.equal(planning.evidence.consentBoundary.reason, 'content_persists_independently_of_consent');
  assert.equal(planning.evidence.attachmentPersisted, true);
  assert.equal(planning.evidence.functionalHold, true);
  assert.deepEqual(planning.plan.actions.map((action) => action.type), [
    'PERSIST_PRECONSENT_ATTACHMENT',
    'HOLD_APPLICATION_UNTIL_CONSENT'
  ]);
  assert.equal(planning.finalState.dataConsentStatus, 'PENDING');
  assert.equal(planning.finalState.currentStep, 'GREETING_SENT');
}

test('un botón interactivo usa la forma real y solicita consentimiento', async () => {
  const fixture = fixtureById('consent-interest-is-not-consent-v1');
  fixture.id = 'synthetic-interactive-interest';
  fixture.inbound = {
    messageId: 'test-message-interactive-interest',
    type: 'interactive',
    body: 'Sí, me interesa continuar'
  };

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(interpretation.interpretation.intent, 'CONTINUE_APPLICATION');
  assert.deepEqual(planning.plan.actions, [{ type: 'ASK_DATA_CONSENT' }]);
  assert.equal(planning.evidence.consentBoundary.reason, 'candidate_wants_to_continue');
});

test('un pie de adjunto que parece autorizar no convierte el archivo en decisión de consentimiento', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-captioned-document';
  fixture.inbound.caption = 'Sí, autorizo el tratamiento de mis datos';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(interpretation.interpretation.consentDecision, 'ACCEPTED');
  assertStoredWithConsentHold(planning);
});

test('un adjunto de perfil futuro se guarda y conserva el modo sin pedir reenvío', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-future-profile-attachment';
  fixture.initialState.candidate.botResumeMode = 'future_profile_offer';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assertStoredWithConsentHold(planning);
  assert.equal(planning.finalState.botResumeMode, 'future_profile_offer');
});

test('un adjunto en modo de captura se guarda sin avanzar el proceso', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-capture-mode-attachment';
  fixture.initialState.candidate.botResumeMode = 'future_profile_capture';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assertStoredWithConsentHold(planning);
  assert.equal(planning.finalState.botResumeMode, 'future_profile_capture');
});

test('un adjunto posterior a revocatoria se conserva sin reabrir automáticamente la postulación', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-revoked-consent-attachment';
  fixture.initialState.candidate.dataConsentStatus = 'REVOKED';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assertStoredWithConsentHold(planning);
  assert.equal(planning.finalState.dataConsentStatus, 'REVOKED');
});
''')

# ---------------------------------------------------------------------------
# Boundary suites: persistence is permitted; consent still governs progression.
# ---------------------------------------------------------------------------
for path in ['test/flexibleApplicationFlow.test.js', 'test/consentBoundaryHardening.test.js']:
    source = read(path)
    source = source.replace("{ block: true, reason: 'attachment_before_consent' }", "{ block: false, reason: 'content_persists_independently_of_consent' }")
    source = source.replace("{ block: true, reason: 'profile_data_before_consent' }", "{ block: false, reason: 'content_persists_independently_of_consent' }")
    source = source.replace("{ block: true, reason: 'capture_mode_without_consent' }", "{ block: false, reason: 'content_persists_independently_of_consent' }")
    write(path, source)

replace_once(
    'test/consentBoundaryHardening.test.js',
    """test('si una HV fue descartada antes de autorizar se solicita reenviarla solo en PDF o DOCX', () => {
  const reply = buildConsentAcceptedReply(
    {
      fullName: 'Laura Pérez',
      documentType: 'CC',
      documentNumber: '1020304050',
      age: 30,
      neighborhood: 'Canaima',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto'
    },
    { city: 'Neiva', experienceRequired: 'NO' },
    { cvResendRequired: true }
  );

  assert.match(reply, /archivo anterior.*no fue guardado/i);
  assert.match(reply, /vuelve a adjuntar tu hoja de vida/i);
  assert.match(reply, /PDF o DOCX/i);
  assert.doesNotMatch(reply, /PDF, DOC o DOCX/i);
});""",
    """test('un contexto legado de reenvío no vuelve a pedir una HV que ahora puede persistirse antes de autorizar', () => {
  const reply = buildConsentAcceptedReply(
    {
      fullName: 'Laura Pérez',
      documentType: 'CC',
      documentNumber: '1020304050',
      age: 30,
      neighborhood: 'Canaima',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto'
    },
    { city: 'Neiva', experienceRequired: 'NO' },
    { cvResendRequired: true }
  );

  assert.doesNotMatch(reply, /archivo anterior.*no fue guardado/i);
  assert.doesNotMatch(reply, /vuelve a adjuntar tu hoja de vida/i);
});"""
)

# ---------------------------------------------------------------------------
# Consent-order replay: an attachment bypasses the gate and is handled by the
# canonical webhook persistence path.
# ---------------------------------------------------------------------------
replace_once(
    'test/conversation-replay/consentOrderReplay.js',
    """    expected: {
      gateBlock: true,
      reason: 'attachment_before_consent',
      outboundCount: 1,
      nextCalls: 0,
      includes: ['todavía no lo descargué', 'confírmame si deseas postularte'],
      excludes: ['Autorizo a LoginPro', 'si autorizas'],
      finalStep: 'GREETING_SENT',
      finalResumeMode: 'pre_consent_cv_resend'
    }""",
    """    expected: {
      gateBlock: false,
      reason: 'content_persists_independently_of_consent',
      outboundCount: 0,
      nextCalls: 1,
      finalStep: 'GREETING_SENT',
      finalResumeMode: 'awaiting_application_interest'
    }"""
)

# ---------------------------------------------------------------------------
# Human-pause regression: the gate no longer acquires visible content. Router
# owns persistence even while automation remains paused.
# ---------------------------------------------------------------------------
replace_once(
    'test/dataConsentHumanPauseReplay.test.js',
    """test('A3: un documento previo al consentimiento se adquiere sin descargar, responder ni levantar la pausa', async () => {
  const base = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const replay = structuredClone(base);
  replay.candidate.dataConsentStatus = 'PENDING';
  replay.candidate.currentStep = 'GREETING_SENT';
  replay.inbound = {
    id: 'TEST-WAMID-PAUSED-PRECONSENT-DOCUMENT',
    from: replay.candidate.phone,
    type: 'document',
    document: {
      id: 'TEST-MEDIA-PAUSED-PRECONSENT',
      filename: 'TEST-HOJA-DE-VIDA.pdf',
      mime_type: 'application/pdf'
    }
  };

  const result = await executeReplay(replay);
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, 0);
  assert.deepEqual(result.statuses, [200]);
  assert.equal(result.metrics.resumeUpdates, 0);
  assert.equal(result.metrics.inboundMessages, 1);
  assert.equal(result.metrics.outboundMessages, 0);
  assert.equal(result.payloadMessageCount, 0);
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(finalCandidate.botResumeMode, replay.candidate.botResumeMode);
});

test('A3: un error al adquirir un adjunto pausado exige reintento sin levantar la pausa ni llegar al router', async () => {
  const base = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const replay = structuredClone(base);
  replay.candidate.dataConsentStatus = 'PENDING';
  replay.inbound = {
    id: 'TEST-WAMID-PAUSED-PERSISTENCE-ERROR',
    from: replay.candidate.phone,
    type: 'document',
    document: {
      id: 'TEST-MEDIA-PERSISTENCE-ERROR',
      filename: 'TEST-HOJA-DE-VIDA-ERROR.pdf',
      mime_type: 'application/pdf'
    }
  };

  const result = await executeReplay(replay, { inboundPersistenceError: true });
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, 0);
  assert.deepEqual(result.statuses, [503]);
  assert.equal(result.metrics.resumeUpdates, 0);
  assert.equal(result.metrics.inboundMessages, 0);
  assert.equal(result.metrics.outboundMessages, 0);
  assert.equal(result.payloadMessageCount, 1);
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(finalCandidate.botResumeMode, replay.candidate.botResumeMode);
});""",
    """test('A3: un documento previo al consentimiento llega intacto al router sin levantar la pausa', async () => {
  const base = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const replay = structuredClone(base);
  replay.candidate.dataConsentStatus = 'PENDING';
  replay.candidate.currentStep = 'GREETING_SENT';
  replay.inbound = {
    id: 'TEST-WAMID-PAUSED-PRECONSENT-DOCUMENT',
    from: replay.candidate.phone,
    type: 'document',
    document: {
      id: 'TEST-MEDIA-PAUSED-PRECONSENT',
      filename: 'TEST-HOJA-DE-VIDA.pdf',
      mime_type: 'application/pdf'
    }
  };

  const result = await executeReplay(replay);
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.statuses, []);
  assert.equal(result.metrics.resumeUpdates, 0);
  assert.equal(result.metrics.inboundMessages, 0);
  assert.equal(result.metrics.outboundMessages, 0);
  assert.equal(result.payloadMessageCount, 1);
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(finalCandidate.botResumeMode, replay.candidate.botResumeMode);
});

test('A3: la persistencia del adjunto pausado pertenece al router y no al gate', async () => {
  const base = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const replay = structuredClone(base);
  replay.candidate.dataConsentStatus = 'PENDING';
  replay.inbound = {
    id: 'TEST-WAMID-PAUSED-PERSISTENCE-ERROR',
    from: replay.candidate.phone,
    type: 'document',
    document: {
      id: 'TEST-MEDIA-PERSISTENCE-ERROR',
      filename: 'TEST-HOJA-DE-VIDA-ERROR.pdf',
      mime_type: 'application/pdf'
    }
  };

  const result = await executeReplay(replay, { inboundPersistenceError: true });

  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.statuses, []);
  assert.equal(result.metrics.inboundMessages, 0);
  assert.equal(result.payloadMessageCount, 1);
});"""
)
replace_once(
    'test/dataConsentHumanPauseReplay.test.js',
    """test('A3: el router conserva rate limit y persistencia antes de la única reanudación canónica', () => {
  const source = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("router.post('/', async");
  const rateLimit = source.indexOf('if (!checkRateLimit(from)) continue;', routeStart);
  const persistText = source.indexOf('const inbound = await saveInboundMessage', rateLimit);
  const resumeText = source.indexOf('freshCandidate = await prepareCandidateForInboundAutomation', persistText);

  assert.ok(routeStart >= 0);
  assert.ok(rateLimit > routeStart);
  assert.ok(persistText > rateLimit);
  assert.ok(resumeText > persistText);
});""",
    """test('A3: el router persiste antes de aplicar el rate limit a la automatización', () => {
  const source = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("router.post('/', async");
  const rateLimit = source.indexOf('const rateLimited = !checkRateLimit(from);', routeStart);
  const persistText = source.indexOf('const inbound = await saveInboundMessage', rateLimit);
  const rateLimitStop = source.indexOf('if (rateLimited)', persistText);
  const resumeText = source.indexOf('freshCandidate = await prepareCandidateForInboundAutomation', persistText);

  assert.ok(routeStart >= 0);
  assert.ok(rateLimit > routeStart);
  assert.ok(persistText > rateLimit);
  assert.ok(rateLimitStop > persistText);
  assert.ok(resumeText > rateLimitStop);
  assert.doesNotMatch(source.slice(routeStart), /if \(!checkRateLimit\(from\)\) continue/);
});"""
)

# ---------------------------------------------------------------------------
# Gate-specific suites: visible PII now passes through; persistence is tested by
# the shared writer and webhook contract, not by a shadow gate inbox.
# ---------------------------------------------------------------------------
replace_once(
    'test/conversationalReleaseCandidatePreConsent.test.js',
    "import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';",
    "import { captureConsentedProfileData, captureVisibleProfileData } from '../src/services/consentProfileCapture.js';"
)
conv = read('test/conversationalReleaseCandidatePreConsent.test.js')
marker = "test('TEST-RC-PAUSED-DATA:"
idx = conv.find(marker)
if idx < 0:
    raise RuntimeError('conversationalReleaseCandidatePreConsent: tail marker not found')
conv_tail = r'''test('TEST-RC-VISIBLE-WRITER: persiste datos visibles aunque el consentimiento siga pendiente', async () => {
  let candidate = {
    id: 'TEST-RC-CANDIDATE',
    dataConsentStatus: 'PENDING',
    fullName: null,
    documentNumber: null,
    age: null
  };
  const result = await captureVisibleProfileData({
    prisma: {
      candidate: {
        updateMany: async ({ where, data }) => {
          assert.deepEqual(where, { id: candidate.id });
          candidate = { ...candidate, ...structuredClone(data) };
          return { count: 1 };
        },
        findUnique: async () => structuredClone(candidate)
      }
    },
    candidate,
    currentText: 'Me llamo Nombre de Prueba, mi cédula es TEST-100000001 y tengo 30 años'
  });

  assert.equal(result.reason, 'profile_data_captured_from_visible_inbound');
  assert.ok(result.capturedFields.includes('fullName'));
  assert.ok(result.capturedFields.includes('documentNumber'));
  assert.ok(result.capturedFields.includes('age'));
  assert.equal(result.candidate.documentNumber, 'TEST-100000001');
});

test('TEST-RC-PAUSED-DATA: un dato personal durante pausa llega intacto al router', async () => {
  const harness = buildHarness({
    candidateOverrides: {
      botPaused: true,
      botPauseReason: 'Intervención humana de prueba',
      dataConsentStatus: 'PENDING'
    }
  });
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-PAUSED-DATA');

  assert.equal(observed.nextCalls, 1);
  assert.deepEqual(observed.statuses, []);
  assert.equal(harness.inboundRows.length, 0);
  assert.equal(harness.providerOutbound.length, 0);
  assert.equal(harness.getCandidate().botPaused, true);
  assert.equal(harness.candidateUpdates.length, 0);
});

test('TEST-RC-PRECONSENT-RAW: el gate no encubre ni crea una copia paralela del texto', async () => {
  const harness = buildHarness();
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-RAW-BODY');

  assert.equal(observed.nextCalls, 1);
  assert.deepEqual(observed.statuses, []);
  assert.equal(harness.inboundRows.length, 0);
  assert.equal(harness.providerOutbound.length, 0);
  assert.equal(harness.candidateUpdates.some((update) => Object.hasOwn(update, 'documentNumber')), false);
});

test('TEST-RC-PRECONSENT-RECOVERY: una adquisición PENDING previa se recupera en el gate y no cae como duplicado al router', async () => {
  const harness = buildHarness({
    candidateOverrides: { botResumeMode: 'awaiting_data_consent' }
  });
  harness.inboundRows.push({
    id: 'TEST-TEST-RC-RECOVERING',
    candidateId: 'TEST-RC-CANDIDATE',
    waMessageId: 'TEST-RC-RECOVERING',
    direction: 'INBOUND',
    messageType: 'TEXT',
    body: 'Mi cédula es TEST-100000001',
    respondedAt: new Date(),
    rawPayload: {
      source: 'data_consent_gate',
      consentGateProcessing: { state: 'PENDING', decision: 'CONSENT_TURN' }
    }
  });

  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-RECOVERING');

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.inboundRows[0].rawPayload?.consentGateProcessing?.state, 'COMPLETED');
});
'''
write('test/conversationalReleaseCandidatePreConsent.test.js', conv[:idx] + conv_tail)

# Replace the final obsolete protected-history test with visible-history behavior.
pre = read('test/preConsentDataEvidence.test.js')
marker = "test('el texto preconsentimiento queda visible en auditoría pero fuera del perfil y del contexto IA'"
idx = pre.find(marker)
if idx < 0:
    raise RuntimeError('preConsentDataEvidence: final legacy test not found')
new_pre_tail = r'''test('el texto preconsentimiento pasa intacto al router y permanece elegible para historial visible', async () => {
  let candidate = {
    id: 'TEST-CANDIDATE-AUDIT-PRECONSENT',
    phone: 'TEST-PHONE-AUDIT-PRECONSENT',
    status: 'NUEVO',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-VACANCY-DATA-EVIDENCE',
    botResumeMode: 'awaiting_data_consent',
    botPaused: false,
    fullName: null,
    locality: null,
    neighborhood: null
  };
  const inboundRows = [];
  const body = 'Mi nombre es Persona de Prueba y vivo en Usme';
  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      findUnique: async () => structuredClone(candidate),
      update: async ({ data }) => {
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async () => ({ count: 1 })
    },
    message: {
      findFirst: async ({ where }) => inboundRows.find((row) => row.waMessageId === where.waMessageId) || null,
      createMany: async ({ data }) => {
        const row = {
          id: `TEST-INBOUND-AUDIT-${inboundRows.length + 1}`,
          createdAt: new Date(),
          ...structuredClone(data[0])
        };
        inboundRows.push(row);
        return { count: 1 };
      },
      create: async ({ data }) => ({ id: 'TEST-OUTBOUND-AUDIT', createdAt: new Date(), ...structuredClone(data) }),
      findMany: async () => inboundRows.map((row) => structuredClone(row))
    },
    vacancy: {
      findUnique: async () => ({
        id: 'TEST-VACANCY-DATA-EVIDENCE',
        title: 'Cargo de Prueba',
        city: 'Neiva',
        isActive: true,
        acceptingApplications: true,
        operation: { city: { name: 'Neiva' } }
      })
    },
    candidateDataConsentEvent: { create: async () => ({ id: 'TEST-CONSENT-EVENT-AUDIT' }) },
    interviewBooking: { updateMany: async () => ({ count: 0 }) }
  };
  axios.post = async () => ({ data: { messages: [{ id: 'TEST-OUTBOUND-AUDIT-PROVIDER' }] } });

  const req = {
    body: { entry: [{ changes: [{ value: { messages: [textMessage(body, 'TEST-WAMID-AUDIT-PRECONSENT')] } }] }] },
    headers: {},
    ip: '127.0.0.1'
  };
  const observed = { nextCalls: 0, statuses: [] };
  const res = { sendStatus: (status) => observed.statuses.push(status) };
  await dataConsentGateMiddleware(withConsentGatePersistence(prisma))(req, res, () => { observed.nextCalls += 1; });

  assert.equal(observed.nextCalls, 1);
  assert.deepEqual(observed.statuses, []);
  assert.equal(inboundRows.length, 0, 'el gate no crea una copia paralela');

  await prisma.message.createMany({
    data: [{
      candidateId: candidate.id,
      direction: 'INBOUND',
      messageType: 'TEXT',
      waMessageId: 'TEST-WAMID-AUDIT-PRECONSENT',
      body,
      rawPayload: { source: 'webhook' },
      respondedAt: new Date()
    }]
  });
  const interpretationContext = await loadConversationInterpretationContext(prisma, {
    candidateId: candidate.id,
    limit: 12
  });
  assert.equal(interpretationContext.recentConversation.some((row) => row.body.includes('Persona de Prueba')), true);
  assert.equal(interpretationContext.recentConversation.some((row) => row.body.includes('Usme')), true);
});
'''
write('test/preConsentDataEvidence.test.js', pre[:idx] + new_pre_tail)

# Traceability: decisions remain gate-owned; ordinary PII is no longer a gate row.
trace = read('test/consentTraceability.test.js')
marker = "test('texto preconsentimiento conserva trazabilidad literal protegida sin alimentar el perfil'"
idx = trace.find(marker)
if idx < 0:
    raise RuntimeError('consentTraceability: legacy preconsent test not found')
new_trace_tail = r'''test('texto preconsentimiento no crea evidencia protegida paralela en el gate', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-PRECONSENT-PII',
    phone: 'TEST-PHONE-PRECONSENT-PII',
    vacancyId: vacancy.id,
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false,
    status: 'NUEVO'
  };
  const harness = createHarness(candidate, vacancy);
  const protectedText = 'Mi documento es 99999123';
  let nextCalls = 0;
  const middleware = dataConsentGateMiddleware(withConsentGatePersistence(harness.prisma));
  const req = {
    body: webhookPayload({
      id: 'TEST-WAMID-PRECONSENT-PII',
      from: candidate.phone,
      type: 'text',
      text: { body: protectedText }
    }),
    headers: {},
    ip: '127.0.0.1'
  };

  await middleware(req, { sendStatus: () => {} }, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(harness.inboundRows.length, 0);
  assert.equal(harness.getCandidate().documentNumber, undefined);
});
'''
write('test/consentTraceability.test.js', trace[:idx] + new_trace_tail)

# Codex regressions: retain recovery coverage, but seed literal visible content and
# ensure persistence failure recovery starts from an actual prior claim.
replace_once(
    'test/preConsentCodexReviewRegressions.test.js',
    "body: '[REDACTED_PRECONSENT]',",
    "body: 'Mi cédula es 1012345678',"
)
replace_once(
    'test/preConsentCodexReviewRegressions.test.js',
    "decision: 'PREREQUISITE_profile_data_before_consent'",
    "decision: 'CONSENT_TURN'"
)
replace_once(
    'test/preConsentCodexReviewRegressions.test.js',
    """  const harness = buildIdempotencyHarness({
    failOutboundCreateTimes: 1
  });""",
    """  const harness = buildIdempotencyHarness({
    seedPending: true,
    failOutboundCreateTimes: 1
  });"""
)

# Focused contract for #1685: overwrite stale shallow assertions with the final
# runtime invariants, including rate limiting and the no-AI-trace text hold.
write('test/preConsentPersistencePolicy1685.test.js', r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsentGateHarness } from './helpers/consentGateHarness.js';
import { evaluateConsentBoundary } from '../src/services/dataConsentGate.js';
import { captureVisibleProfileData } from '../src/services/consentProfileCapture.js';

function text(id, body) {
  return { id, from: 'TEST-PHONE', type: 'text', text: { body } };
}

function document(id) {
  return {
    id,
    from: 'TEST-PHONE',
    type: 'document',
    document: { id: `${id}-media`, filename: 'hoja-de-vida.pdf', mime_type: 'application/pdf' }
  };
}

test('datos personales reales antes del consentimiento no son consumidos ni encubiertos por el gate', async () => {
  const h = createConsentGateHarness({
    candidate: {
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_data_consent',
      currentStep: 'GREETING_SENT'
    }
  });
  const inbound = text('PRECONSENT-DATA-1', 'Mi nombre es Ana Pérez, tengo 27 años y vivo en Suba');

  const boundary = evaluateConsentBoundary(h.getCandidate(), inbound);
  assert.deepEqual(boundary, { block: false, reason: 'content_persists_independently_of_consent' });

  const result = await h.run(inbound);
  assert.equal(result.next, 1);
  assert.equal(result.status, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.messages.length, 0);
});

test('HV enviada antes del consentimiento continúa al almacenamiento canónico', async () => {
  const h = createConsentGateHarness({
    candidate: {
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_data_consent',
      currentStep: 'GREETING_SENT'
    }
  });
  const inbound = document('PRECONSENT-CV-1');
  const boundary = evaluateConsentBoundary(h.getCandidate(), inbound);
  assert.deepEqual(boundary, { block: false, reason: 'content_persists_independently_of_consent' });
  const result = await h.run(inbound);
  assert.equal(result.next, 1);
  assert.equal(h.messages.length, 0);
});

test('el writer visible persiste perfil con PENDING sin alterar estado funcional', async () => {
  let candidate = {
    id: 'candidate-visible',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    status: 'NUEVO',
    fullName: null,
    documentNumber: null,
    age: null
  };
  const result = await captureVisibleProfileData({
    prisma: {
      candidate: {
        updateMany: async ({ where, data }) => {
          assert.deepEqual(where, { id: candidate.id });
          assert.equal(Object.hasOwn(data, 'currentStep'), false);
          assert.equal(Object.hasOwn(data, 'status'), false);
          candidate = { ...candidate, ...data };
          return { count: 1 };
        },
        findUnique: async () => structuredClone(candidate)
      }
    },
    candidate,
    currentText: 'Mi nombre es Ana Pérez, mi cédula es 1012345678 y tengo 27 años'
  });

  assert.equal(result.reason, 'profile_data_captured_from_visible_inbound');
  assert.equal(result.candidate.fullName, 'Ana Pérez');
  assert.equal(result.candidate.documentNumber, '1012345678');
  assert.equal(result.candidate.currentStep, 'GREETING_SENT');
  assert.equal(result.candidate.status, 'NUEVO');
});

test('runtime elimina encubrimiento y mantiene hold funcional antes de IA', () => {
  const consentGate = readFileSync(new URL('../src/services/dataConsentGate.js', import.meta.url), 'utf8');
  const repository = readFileSync(new URL('../src/services/conversationMessageRepository.js', import.meta.url), 'utf8');
  const webhook = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');

  assert.doesNotMatch(consentGate, /PRE_CONSENT_ATTACHMENT_REPLY|PRE_CONSENT_DATA_REPLY|preConsentProtected/);
  assert.doesNotMatch(repository, /preConsentProtected/);
  assert.match(webhook, /captureVisibleProfileData/);
  assert.match(webhook, /preConsentProfileDecision\.containsProfileData/);
  assert.match(webhook, /consentAutomationHold/);
  assert.match(webhook, /const rateLimited = !checkRateLimit\(from\)/);
  assert.doesNotMatch(webhook, /if \(!checkRateLimit\(from\)\) continue/);

  const textBranch = webhook.slice(webhook.indexOf("if (message.type === 'text')"), webhook.indexOf('const inboundType = resolveInboundMessageType'));
  assert.ok(textBranch.indexOf('saveInboundMessage') < textBranch.indexOf('if (rateLimited)'));
  assert.ok(textBranch.indexOf('captureVisibleProfileData') < textBranch.indexOf('createDebugTrace'));
});

test('DEV conserva la etiqueta de eliminación por no consentimiento', async () => {
  const { injectDevConsentResendAction } = await import('../src/routes/devConsentResend.js');
  const html = '<button type="submit" class="btn-danger">Eliminar registro completo</button><h2>Historial de conversación</h2>';

  const pending = injectDevConsentResendAction(html, {
    candidate: { id: 'candidate-1', dataConsentStatus: 'PENDING' },
    outboundWindow: { isOpen: false }
  });
  assert.match(pending, /Eliminar registro por no consentimiento/);

  const revoked = injectDevConsentResendAction(html, {
    candidate: { id: 'candidate-1', dataConsentStatus: 'REVOKED' },
    outboundWindow: { isOpen: false }
  });
  assert.match(revoked, /Eliminar registro por no consentimiento/);
});
''')

print('apply-1685-consent-persistence-hold: patch complete')
