import fs from 'node:fs';

function replaceOnce(path, before, after) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  if (!source.includes(before)) throw new Error(`Repair anchor missing in ${path}: ${before.slice(0, 100)}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

const changed = new Set();
function patch(path, before, after) {
  if (replaceOnce(path, before, after)) changed.add(path);
}

patch(
  'src/services/contextualResponseGate.js',
  "    || (!resolvedReadiness.hasValidCv && candidate.currentStep === 'ASK_CV')\n    || candidate.currentStep === 'SCHEDULING'",
  "    || candidate.currentStep === 'CONFIRMING_DATA'\n    || candidate.currentStep === 'ASK_CV'\n    || candidate.currentStep === 'SCHEDULING'"
);

patch(
  'src/services/contextualResponseGate.js',
  "if (/\\b(como\\s+va|estado\\s+de|alguna\\s+novedad|hay\\s+novedad|mi\\s+proceso|mi\\s+postulacion|cuando\\s+me\\s+llaman|me\\s+van\\s+a\\s+llamar|sigue\\s+registrad[oa])\\b/.test(normalized)) {",
  "if (/\\b(como\\s+va|estado\\s+de|alguna\\s+novedad|hay\\s+novedad|mi\\s+proceso|mi\\s+postulacion|me\\s+habia\\s+postulado|me\\s+postule|que\\s+ha\\s+pasado|cuando\\s+me\\s+llaman|me\\s+van\\s+a\\s+llamar|sigue\\s+registrad[oa])\\b/.test(normalized)) {"
);

patch(
  'src/services/contextualResponseGate.js',
  "    if (['ASK_APPLICATION_STATUS', 'ASK_VACANCY_INFORMATION', 'PROVIDE_EXTRA_DATA', 'UNCLEAR', 'UNCLASSIFIED_APPOINTMENT_QUESTION'].includes(semanticIntent)) {\n      return decision({\n        shouldReply: true,\n        allowedAction: ContextualAllowedAction.CONTINUE_FLOW,\n        reason: 'Candidate main flow is complete, but the new message may need a contextual answer or correction; continue to the engine instead of returning a fixed close.',\n        responsePurpose: ContextualResponsePurpose.FLOW,\n        metadata: { postCompletionContext: true }\n      });\n    }",
  "    if (semanticIntent === 'ASK_APPLICATION_STATUS') {\n      return decision({\n        shouldReply: true,\n        allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,\n        reason: 'Candidate main flow is complete and asked for application status; answer from the persisted process state without reopening collection.',\n        responsePurpose: ContextualResponsePurpose.LOGISTICS_ANSWER,\n        reply: buildApplicationStatusReply({ candidate, vacancy, activeInterviewBooking: activeBooking }),\n        metadata: { postCompletionContext: true }\n      });\n    }\n    if (['ASK_VACANCY_INFORMATION', 'PROVIDE_EXTRA_DATA', 'UNCLEAR', 'UNCLASSIFIED_APPOINTMENT_QUESTION'].includes(semanticIntent)) {\n      return decision({\n        shouldReply: true,\n        allowedAction: ContextualAllowedAction.CONTINUE_FLOW,\n        reason: 'Candidate main flow is complete, but the new message may need a contextual answer or correction; continue to the engine instead of returning a fixed close.',\n        responsePurpose: ContextualResponsePurpose.FLOW,\n        metadata: { postCompletionContext: true }\n      });\n    }"
);

patch(
  'src/routes/webhook.js',
  "    const body = 'Quedó registrado tu interés en entrevista. En este momento no tengo un horario válido para ofrecerte, así que el equipo de selección te contactará por este medio.';\n    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });",
  "    await pauseInterviewFlow(prisma, candidate.id, 'missing_valid_slot: no hay un horario válido disponible para ofrecer');\n    const body = 'Quedó registrado tu interés en entrevista. En este momento no tengo un horario válido para ofrecerte, así que el equipo de selección te contactará por este medio.';\n    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });"
);

patch(
  'src/services/vacancyFirstGate.js',
  `    const intent = detectAffirmationIntent(inboundText);
    if (currentStep === GREETING_SENT && currentVacancy && intent.affirmative) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_CONFIRMED_ENTER_DATA',
        replyKind: 'ACTIVE_VACANCY_DATA_PROMPT',
        vacancyId: currentVacancy.id || candidate.vacancyId,
        vacancy: currentVacancy,
        candidateUpdates: buildCollectingDataUpdates(currentVacancy.id || candidate.vacancyId),
        reply: buildActiveDataPrompt(candidate, currentVacancy)
      };
    }
`,
  `    const intent = detectAffirmationIntent(inboundText);
    if (currentStep === GREETING_SENT && currentVacancy && intent.affirmative) {
      const informationAnswer = buildVacancyInformationAnswer(currentVacancy, inboundText);
      const dataPrompt = buildActiveDataPrompt(candidate, currentVacancy);
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_CONFIRMED_ENTER_DATA',
        replyKind: 'ACTIVE_VACANCY_DATA_PROMPT',
        vacancyId: currentVacancy.id || candidate.vacancyId,
        vacancy: currentVacancy,
        candidateUpdates: buildCollectingDataUpdates(currentVacancy.id || candidate.vacancyId),
        reply: [informationAnswer, dataPrompt].filter(Boolean).join('\\n\\n')
      };
    }
`
);

patch(
  'test/conversation-replay/consentOrderReplay.js',
  "includesInOrder: ['gestionar tu postulación', 'Para continuar necesito saber si autorizas']",
  "includesInOrder: ['gestionar la postulación', 'Para continuar necesito saber si autorizas']"
);

let fixture = fs.readFileSync('test/fixtures/conversationCases.js', 'utf8');
const manualBefore = "{ direction: 'OUTBOUND', body: 'Hola, te escribe un humano del equipo.', rawPayload: {}, createdAt: new Date('2026-04-07T09:59:00.000Z') }";
const manualAfter = "{ direction: 'OUTBOUND', body: 'Hola, te escribe un humano del equipo.', rawPayload: { source: 'admin_outbound', actor: 'RECRUITER', sourceCategory: 'MANUAL_AUTHORIZED' }, createdAt: new Date('2026-04-07T09:59:00.000Z') }";
if (fixture.includes(manualBefore)) fixture = fixture.replace(manualBefore, manualAfter);
else if (!fixture.includes(manualAfter)) throw new Error('Manual outbound fixture anchor missing');

const humanCandidateBefore = "candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),\n    expect: {\n      candidate: { botPaused: true },\n      exactOutboundCount: 0\n    }\n  },\n  {\n    id: 'cv-first-then-city-vacancy'";
const humanCandidateAfter = "candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post', botPaused: true, botPausedAt: new Date('2026-04-07T09:59:00.000Z'), botPausedBy: 'recruiter', botPauseReason: 'Conversacion tomada manualmente desde dashboard', botResumeMode: 'manual_resume_dashboard', reminderState: ReminderState.CANCELLED }),\n    expect: {\n      candidate: { botPaused: true },\n      exactOutboundCount: 0\n    }\n  },\n  {\n    id: 'cv-first-then-city-vacancy'";
if (fixture.includes(humanCandidateBefore)) fixture = fixture.replace(humanCandidateBefore, humanCandidateAfter);
else if (!fixture.includes(humanCandidateAfter)) throw new Error('Manual candidate fixture anchor missing');

const scheduledMarker = "id: 'scheduled-question-uses-context-instead-of-repeating-flow'";
const scheduledStart = fixture.indexOf(scheduledMarker);
if (scheduledStart < 0) throw new Error('Scheduled question fixture missing');
const scheduledEnd = fixture.indexOf('\n  }\n];', scheduledStart);
let scheduledBlock = fixture.slice(scheduledStart, scheduledEnd);
if (!scheduledBlock.includes('interviewBookings:')) {
  const anchor = '    interviewSlots: schedulingSlots,\n';
  if (!scheduledBlock.includes(anchor)) throw new Error('Scheduled slot anchor missing');
  scheduledBlock = scheduledBlock.replace(anchor, `${anchor}    interviewBookings: [{\n      id: 'booking-scheduled-question',\n      candidateId: 'candidate-1',\n      vacancyId: 'vac-sched',\n      slotId: 'slot-1',\n      scheduledAt: new Date(Date.now() + 8 * 60 * 60 * 1000),\n      status: 'SCHEDULED',\n      reminderWindowClosed: false\n    }],\n`);
  fixture = fixture.slice(0, scheduledStart) + scheduledBlock + fixture.slice(scheduledEnd);
}
fs.writeFileSync('test/fixtures/conversationCases.js', fixture);
changed.add('test/fixtures/conversationCases.js');

let contextualTests = fs.readFileSync('test/contextualResponseGate.test.js', 'utf8');
const contextualAddition = `

test('estados de confirmación y CV conservan acción pendiente aunque el perfil ya esté completo', () => {
  for (const currentStep of ['CONFIRMING_DATA', 'ASK_CV']) {
    const result = evaluateContextualResponseGate({
      candidate: completeCandidate({ currentStep }),
      vacancy: vacancy({ schedulingEnabled: true }),
      activeInterviewBooking: null,
      recentMessages: [],
      semanticIntent: 'ACKNOWLEDGEMENT'
    });

    assert.equal(result.shouldReply, true, currentStep);
    assert.equal(result.allowedAction, ContextualAllowedAction.CONTINUE_FLOW, currentStep);
  }
});

test('seguimiento natural después de postularse se clasifica y responde desde estado persistido', () => {
  const semanticIntent = inferContextualSemanticIntent({
    text: 'Yo me había postulado para un empleo con ustedes y quisiera saber qué ha pasado',
    isQuestion: true
  });
  assert.equal(semanticIntent, 'ASK_APPLICATION_STATUS');

  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent
  });
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.match(result.reply, /postulación continúa registrada|proceso sigue/i);
});
`;
if (!contextualTests.includes('estados de confirmación y CV conservan acción pendiente')) {
  contextualTests = contextualTests.trimEnd() + contextualAddition + '\n';
  fs.writeFileSync('test/contextualResponseGate.test.js', contextualTests);
  changed.add('test/contextualResponseGate.test.js');
}

let vacancyTests = fs.readFileSync('test/vacancyFirstGate.test.js', 'utf8');
const vacancyAddition = `

test('vacante activa asignada responde requisitos antes de entrar a recolección cuando hay interés explícito', async () => {
  const active = vacancy({ id: 'vac-question-interest' });
  const decision = await decide({
    text: '¿Qué requisitos tiene la vacante? Sí me interesa',
    candidatePatch: { currentStep: ConversationStep.GREETING_SENT, vacancyId: active.id },
    vacancies: [active],
    currentVacancy: active
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_CONFIRMED_ENTER_DATA');
  assert.match(decision.reply, /requisitos registrados/i);
  assert.match(decision.reply, /para avanzar, compárteme/i);
  assert.ok(decision.reply.indexOf('requisitos registrados') < decision.reply.indexOf('Para avanzar'));
});
`;
if (!vacancyTests.includes('vacante activa asignada responde requisitos antes de entrar a recolección')) {
  vacancyTests = vacancyTests.trimEnd() + vacancyAddition + '\n';
  fs.writeFileSync('test/vacancyFirstGate.test.js', vacancyTests);
  changed.add('test/vacancyFirstGate.test.js');
}

console.log(`Patched ${[...changed].join(', ')}`);
