from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:100]!r}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/services/contextualResponseGate.js',
    "    || (!resolvedReadiness.hasValidCv && candidate.currentStep === 'ASK_CV')\n    || candidate.currentStep === 'SCHEDULING'\n  );",
    "    || (!resolvedReadiness.hasValidCv && candidate.currentStep === 'ASK_CV')\n    || candidate.currentStep === 'CONFIRMING_DATA'\n    || candidate.currentStep === 'SCHEDULING'\n  );"
)

replace_once(
    'src/services/contextualResponseGate.js',
    "    if (/\\b(como\\s+va|estado\\s+de|alguna\\s+novedad|hay\\s+novedad|mi\\s+proceso|mi\\s+postulacion|cuando\\s+me\\s+llaman|me\\s+van\\s+a\\s+llamar|sigue\\s+registrad[oa])\\b/.test(normalized)) {",
    "    if (/\\b(como\\s+va|estado\\s+de|alguna\\s+novedad|hay\\s+novedad|mi\\s+proceso|mi\\s+postulacion|me\\s+habia\\s+postulad[oa]|me\\s+he\\s+postulad[oa]|que\\s+ha\\s+pasado|cuando\\s+me\\s+llaman|me\\s+van\\s+a\\s+llamar|sigue\\s+registrad[oa])\\b/.test(normalized)) {"
)

marker = "    if (APPOINTMENT_MANUAL_REVIEW_INTENTS.has(semanticIntent)) {\n"
insertion = marker + "      if (semanticIntent === 'REPORT_ARRIVAL_PROBLEM') {\n        return decision({\n          shouldReply: false,\n          allowedAction: ContextualAllowedAction.NO_REPLY,\n          reason: 'Candidate has an active appointment and reported an arrival issue that is not answerable from the assigned vacancy or appointment context; this requires human validation before replying.',\n          responsePurpose: ContextualResponsePurpose.NONE,\n          requiresHumanReview: true\n        });\n      }\n\n"
replace_once('src/services/contextualResponseGate.js', marker, insertion)

marker = "  if ((isCvOnlyComplete(candidate, vacancy, resolvedReadiness) || isMainFlowComplete(candidate, vacancy, resolvedReadiness)) && !realPendingAction) {\n"
insertion = "  if (candidate.currentStep === 'SCHEDULED' && LOGISTIC_INTENTS.has(semanticIntent)) {\n    const logisticsReply = buildLogisticsReply({ semanticIntent, vacancy, activeInterviewBooking: activeBooking });\n    if (logisticsReply) {\n      return decision({\n        shouldReply: true,\n        allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,\n        reason: 'Candidate has a scheduled interview and the assigned vacancy contains the requested logistics information.',\n        responsePurpose: ContextualResponsePurpose.LOGISTICS_ANSWER,\n        reply: logisticsReply\n      });\n    }\n    return safeReviewDecision(\n      'Candidate has a scheduled interview but the requested logistics detail is not present in the assigned context.',\n      semanticIntent\n    );\n  }\n\n" + marker
replace_once('src/services/contextualResponseGate.js', marker, insertion)

marker = "  if ((isCvOnlyComplete(candidate, vacancy, resolvedReadiness) || isMainFlowComplete(candidate, vacancy, resolvedReadiness)) && !realPendingAction) {\n    if (CLOSING_INTENTS.has(semanticIntent)) {\n"
replacement = "  if ((isCvOnlyComplete(candidate, vacancy, resolvedReadiness) || isMainFlowComplete(candidate, vacancy, resolvedReadiness)) && !realPendingAction) {\n    if (semanticIntent === 'ASK_APPLICATION_STATUS') {\n      return decision({\n        shouldReply: true,\n        allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,\n        reason: 'Candidate asked for the status of an already completed application; answer from persisted process state.',\n        responsePurpose: ContextualResponsePurpose.LOGISTICS_ANSWER,\n        reply: buildApplicationStatusReply({ candidate, vacancy, activeInterviewBooking: activeBooking })\n      });\n    }\n    if (CLOSING_INTENTS.has(semanticIntent)) {\n"
replace_once('src/services/contextualResponseGate.js', marker, replacement)

replace_once(
    'src/routes/webhook.js',
    "  const missing = getMissingFieldLabels(candidate, vacancy);\n  const hasMainBlock = getRequiredCandidateFieldKeys(vacancy).every((field) => {",
    "  const missing = getMissingFieldLabels(candidate, vacancy);\n  if (missing.length > 0) return false;\n  const hasMainBlock = getRequiredCandidateFieldKeys(vacancy).every((field) => {"
)

replace_once(
    'test/helpers/conversationHarness.js',
    "  const candidate = prisma.state.candidates[0];\n  const lastReply = whatsappMock.sentMessages.at(-1)?.body || '';",
    "  const candidate = prisma.state.candidates[0];\n  const candidateOutboundMessages = whatsappMock.sentMessages.filter((message) => message.to === candidate.phone);\n  const lastReply = candidateOutboundMessages.at(-1)?.body || '';"
)
replace_once(
    'test/helpers/conversationHarness.js',
    "    assert.equal(whatsappMock.sentMessages.length, conversationCase.expect.exactOutboundCount, `${conversationCase.id}: cantidad de salidas inesperada`);",
    "    assert.equal(candidateOutboundMessages.length, conversationCase.expect.exactOutboundCount, `${conversationCase.id}: cantidad de salidas inesperada`);"
)

replace_once(
    'test/conversation-replay/consentOrderReplay.js',
    "includesInOrder: ['gestionar tu postulación', 'Para continuar necesito saber si autorizas']",
    "includesInOrder: ['gestionar la postulación', 'Para continuar necesito saber si autorizas']"
)

Path('test/candidateConversationReleaseGaps.test.js').write_text("""import assert from 'node:assert/strict';
import test from 'node:test';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { conversationCases } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';
process.env.LORREN_SEND_DELAY_MS = '0';

function findCase(id) {
  const conversationCase = conversationCases.find((item) => item.id === id);
  if (!conversationCase) throw new Error(`Missing conversation case: ${id}`);
  return conversationCase;
}

for (const id of [
  'document-exception-pauses-for-manual-review',
  'done-step-followup-about-previous-application-gets-status-ack',
  'ask-cv-out-of-scope-question-pauses-for-dev-review',
  'scheduled-arrival-problem-pauses-for-manual-review-without-reply'
]) {
  test(`candidate release gap: ${id}`, async () => {
    await runConversationCase(findCase(id), { processText, createDebugTrace });
  });
}

test('candidate release gap: incomplete data is not sent to confirmation', async () => {
  const result = await runConversationCase(findCase('bodega-data-block-keeps-name-doc-and-transport'), {
    processText,
    createDebugTrace,
    assertExpectations: false
  });
  assert.equal(result.candidate.currentStep, 'COLLECTING_DATA');
  const candidateReplies = result.outbound.filter((message) => message.to === result.candidate.phone);
  const lastReply = String(candidateReplies.at(-1)?.body || '').toLowerCase();
  assert.match(lastReply, /edad/);
  assert.match(lastReply, /localidad/);
  assert.doesNotMatch(lastReply, /esta correcto|está correcto/);
});

test('candidate release gap: explicit confirmation is not swallowed as contextual closure', async () => {
  const result = await runConversationCase(findCase('female-pipeline-after-cv'), {
    processText,
    createDebugTrace,
    assertExpectations: false
  });
  assert.notEqual(result.candidate.currentStep, 'CONFIRMING_DATA');
});

test('candidate release gap: scheduled address question never invents an interview address', async () => {
  const result = await runConversationCase(findCase('scheduled-question-uses-context-instead-of-repeating-flow'), {
    processText,
    createDebugTrace,
    assertExpectations: false
  });
  const candidateReplies = result.outbound.filter((message) => message.to === result.candidate.phone);
  const lastReply = String(candidateReplies.at(-1)?.body || '').toLowerCase();
  assert.ok(lastReply.length > 0);
  assert.match(lastReply, /no tengo|no tengo una condicion|informacion registrada|zona de operacion/);
});
""", encoding='utf-8')
