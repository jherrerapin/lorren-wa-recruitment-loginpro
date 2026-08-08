from pathlib import Path


def read(path): return Path(path).read_text(encoding='utf-8')
def write(path, text): Path(path).write_text(text, encoding='utf-8')
def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

# vacancyFirstGate: always present professional vacancy card, and explicit interest goes directly to consent.
p = 'src/services/vacancyFirstGate.js'
t = read(p)
t = once(
    t,
    """function buildActiveVacancyInterestReply(vacancy = {}, inboundText = '') {\n  const answer = buildVacancyInformationAnswer(vacancy, inboundText) || buildVacancyOverview(vacancy);\n  return `${answer}\\n\\n¿Te interesa continuar con esta vacante? Si es así, confírmame y seguimos con la postulación.`;\n}""",
    """function buildActiveVacancyInterestReply(vacancy = {}, inboundText = '') {\n  const answer = buildVacancyInformationAnswer(vacancy, inboundText);\n  return [\n    answer,\n    buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt: true })\n  ].filter(Boolean).join('\\n\\n');\n}""",
    'professional vacancy interest reply'
)
old = """  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {\n    if (requiresConsentBeforeCollection(candidate)) {\n      return {\n        action: VacancyFirstGateAction.REPLY,\n        reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',\n        replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',\n        vacancyId: resolution.vacancy.id,\n        vacancy: resolution.vacancy,\n        candidateUpdates: buildAwaitingApplicationInterestUpdates(resolution.vacancy.id),\n        reply: buildActiveVacancyInterestReply(resolution.vacancy, inboundText),\n        resolution\n      };\n    }\n    return { action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE, reason: 'ACTIVE_VACANCY_RESOLVED', vacancyId: resolution.vacancy.id, vacancy: resolution.vacancy, resolution };\n  }\n"""
new = """  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {\n    if (requiresConsentBeforeCollection(candidate)) {\n      const initialTurn = analyzeConversationTurn(inboundText);\n      if (initialTurn.interest) {\n        const informationAnswer = buildVacancyInformationAnswer(resolution.vacancy, inboundText);\n        return {\n          action: VacancyFirstGateAction.REPLY,\n          reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT',\n          replyKind: 'DATA_CONSENT_PROMPT',\n          vacancyId: resolution.vacancy.id,\n          vacancy: resolution.vacancy,\n          candidateUpdates: {\n            vacancyId: resolution.vacancy.id,\n            currentStep: GREETING_SENT,\n            botResumeMode: buildConsentPendingMode(),\n            reminderScheduledFor: null,\n            reminderState: 'SKIPPED'\n          },\n          reply: [\n            informationAnswer,\n            buildProfessionalVacancyPresentation(resolution.vacancy),\n            buildDataConsentPromptReply()\n          ].filter(Boolean).join('\\n\\n'),\n          resolution\n        };\n      }\n      return {\n        action: VacancyFirstGateAction.REPLY,\n        reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',\n        replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',\n        vacancyId: resolution.vacancy.id,\n        vacancy: resolution.vacancy,\n        candidateUpdates: buildAwaitingApplicationInterestUpdates(resolution.vacancy.id),\n        reply: buildActiveVacancyInterestReply(resolution.vacancy, inboundText),\n        resolution\n      };\n    }\n    return { action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE, reason: 'ACTIVE_VACANCY_RESOLVED', vacancyId: resolution.vacancy.id, vacancy: resolution.vacancy, resolution };\n  }\n"""
t = once(t, old, new, 'explicit interest to consent')
write(p, t)

# dataConsentGate: same presentation for Meta, without asking interest twice if it is already explicit.
p = 'src/services/dataConsentGate.js'
t = read(p)
t = once(
    t,
    """function buildVacancyInfoReply(vacancy = {}) {\n  return buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt: true });\n}""",
    """function buildVacancyInfoReply(vacancy = {}, { includeInterestPrompt = true } = {}) {\n  return buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt });\n}""",
    'meta formatter options'
)
old = """  if (isAffirmativeVacancyConfirmation(body)) {\n    const cvResendRequired = candidate.botResumeMode === CAMPAIGN_CONFIRMATION_CV_MODE;\n    await prisma.candidate.update({\n      where: { id: candidate.id },\n      data: {\n        currentStep: ConversationStep.GREETING_SENT,\n        botResumeMode: cvResendRequired ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE\n      }\n    });\n    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\\n\\n');\n    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id, cvResendRequired });\n    return true;\n  }\n"""
new = """  if (isAffirmativeVacancyConfirmation(body)) {\n    const cvResendRequired = candidate.botResumeMode === CAMPAIGN_CONFIRMATION_CV_MODE;\n    const explicitApplicationInterest = Boolean(analyzeConversationTurn(body).interest);\n    if (explicitApplicationInterest) {\n      await prisma.candidate.update({\n        where: { id: candidate.id },\n        data: {\n          currentStep: ConversationStep.GREETING_SENT,\n          botResumeMode: buildConsentPendingMode({ cvResendRequired })\n        }\n      });\n      const reply = [\n        questionReply,\n        buildVacancyInfoReply(vacancy, { includeInterestPrompt: false }),\n        buildDataConsentPromptReply()\n      ].filter(Boolean).join('\\n\\n');\n      await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed_interest', { vacancyId: vacancy.id, cvResendRequired });\n      return true;\n    }\n    await prisma.candidate.update({\n      where: { id: candidate.id },\n      data: {\n        currentStep: ConversationStep.GREETING_SENT,\n        botResumeMode: cvResendRequired ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE\n      }\n    });\n    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\\n\\n');\n    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id, cvResendRequired });\n    return true;\n  }\n"""
t = once(t, old, new, 'meta explicit interest')
write(p, t)

# webhook: legitimate configured facts must reach replySafety with their vacancy context.
p = 'src/routes/webhook.js'
t = read(p)
old = """      source: 'vacancy_first_gate',\n      reason: vacancyFirstGateDecision.reason,\n      replyKind: vacancyFirstGateDecision.replyKind\n    });\n  }\n\n  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT) {"""
new = """      source: 'vacancy_first_gate',\n      reason: vacancyFirstGateDecision.reason,\n      replyKind: vacancyFirstGateDecision.replyKind,\n      safetyVacancy: currentVacancy || vacancyFirstGateDecision.vacancy || null\n    });\n  }\n\n  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT) {"""
t = once(t, old, new, 'reply safety vacancy context')
write(p, t)

# Add focused regressions if absent.
p = 'test/productionPaidAdFlowRegressions.test.js'
t = read(p)
if "import { readFileSync } from 'node:fs';" not in t:
    t = t.replace("import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';")
if "interés explícito al resolver vacante pasa directamente a consentimiento" not in t:
    t += r'''

test('producción: interés explícito al resolver vacante pasa directamente a consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Quiero postularme a Líder de Operación en Neiva',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT');
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.match(decision.reply, /Vacante: Líder de Operación/i);
  assert.match(decision.reply, /Antes de recibir o guardar datos personales/i);
  assert.doesNotMatch(decision.reply, /¿Te interesa continuar con esta vacante\?/i);
});

test('defensa: vacancy-first entrega contexto de vacante al filtro de seguridad', () => {
  const source = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.match(source, /replyKind: vacancyFirstGateDecision\.replyKind,[\s\S]{0,180}safetyVacancy: currentVacancy \|\| vacancyFirstGateDecision\.vacancy \|\| null/);
});

test('Meta: confirmación con interés explícito prepara consentimiento y no repite interés', () => {
  const source = readFileSync(new URL('../src/services/dataConsentGate.js', import.meta.url), 'utf8');
  assert.match(source, /explicitApplicationInterest = Boolean\(analyzeConversationTurn\(body\)\.interest\)/);
  assert.match(source, /campaign_vacancy_confirmed_interest/);
  assert.match(source, /buildVacancyInfoReply\(vacancy, \{ includeInterestPrompt: false \}\)/);
});
'''
write(p, t)

print('PR966 final functional gaps patched')
