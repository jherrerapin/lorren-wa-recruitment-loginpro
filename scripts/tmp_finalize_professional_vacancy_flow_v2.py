from pathlib import Path
import re


def read(path): return Path(path).read_text(encoding='utf-8')
def write(path, text): Path(path).write_text(text, encoding='utf-8')
def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)
def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return updated

# Shared professional vacancy presentation.
p='src/services/vacancyPublicInfo.js'; t=read(p)
t=t.replace('la edad configurada es','la edad requerida es')
t=t.replace('el rango de edad configurado es de','el rango de edad es de')
t=t.replace('la edad mínima configurada es','la edad mínima es')
t=t.replace('la edad máxima configurada es','la edad máxima es')
if 'export function buildProfessionalVacancyPresentation' not in t:
    t += r'''

function publicVacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function publicVacancyTitle(vacancy = {}) {
  return String(vacancy?.title || vacancy?.role || 'Vacante disponible').trim();
}

function professionalSentence(value = '') {
  const cleaned = cleanConfiguredFragment(value);
  return cleaned ? `${cleaned}.` : '';
}

function professionalAgeLine(vacancy = {}, requirements = '') {
  if (/\bedad\b|\b\d{1,2}\s*(?:a|-)\s*\d{1,2}\s*a[nñ]os?\b/i.test(requirements)) return '';
  const minAge = configuredInteger(vacancy?.minAge);
  const maxAge = configuredInteger(vacancy?.maxAge);
  if (minAge !== null && maxAge !== null) {
    return minAge === maxAge ? `Edad: ${minAge} años.` : `Edad: ${minAge} a ${maxAge} años.`;
  }
  if (minAge !== null) return `Edad mínima: ${minAge} años.`;
  if (maxAge !== null) return `Edad máxima: ${maxAge} años.`;
  return '';
}

function professionalExperienceLine(vacancy = {}, requirements = '') {
  if (/\bexperiencia\b/i.test(requirements)) return '';
  const mode = String(vacancy?.experienceRequired || '').trim().toUpperCase();
  const time = cleanConfiguredFragment(vacancy?.experienceTimeText);
  if (mode === 'YES') return time ? `Experiencia: ${time.charAt(0).toUpperCase()}${time.slice(1)}.` : 'Experiencia: Requerida.';
  if (mode === 'NO') return 'Experiencia: No requerida.';
  return '';
}

export function buildProfessionalVacancyPresentation(vacancy = {}, { includeInterestPrompt = false } = {}) {
  const title = publicVacancyTitle(vacancy);
  const city = publicVacancyCity(vacancy);
  const roleDescription = cleanConfiguredFragment(vacancy?.roleDescription);
  const requirements = cleanConfiguredFragment(vacancy?.requirements);
  const conditions = cleanConfiguredFragment(vacancy?.conditions);
  const address = cleanConfiguredFragment(vacancy?.operationAddress);
  const documents = cleanConfiguredFragment(vacancy?.requiredDocuments);
  const sections = [`*Vacante: ${title}*`];
  if (city) sections.push(`*Ciudad:* ${city}`);
  if (address) sections.push(`*Zona de trabajo:* ${address}`);
  if (roleDescription) sections.push(`*Funciones del cargo*\n${professionalSentence(roleDescription)}`);
  const requirementLines = [
    requirements ? professionalSentence(requirements) : '',
    professionalAgeLine(vacancy, requirements),
    professionalExperienceLine(vacancy, requirements)
  ].filter(Boolean);
  if (requirementLines.length) sections.push(`*Requisitos*\n${requirementLines.join('\n')}`);
  if (conditions) sections.push(`*Condiciones*\n${professionalSentence(conditions)}`);
  if (documents) sections.push(`*Documentación para el proceso*\n${professionalSentence(documents)}`);
  const hasDetails = Boolean(roleDescription || requirements || conditions || address || documents
    || Number.isInteger(vacancy?.minAge) || Number.isInteger(vacancy?.maxAge)
    || ['YES', 'NO'].includes(String(vacancy?.experienceRequired || '').trim().toUpperCase()));
  if (!hasDetails) sections.push('La vacante está activa para recibir postulaciones.');
  const parts = ['Te comparto la información de la vacante:', sections.join('\n\n')];
  if (includeInterestPrompt) parts.push('¿Te interesa continuar con esta vacante? Si es así, confírmame y seguimos con la postulación.');
  return parts.join('\n\n');
}
'''
write(p,t)

# Vacancy-first gate uses shared presentation and explicit interest -> consent.
p='src/services/vacancyFirstGate.js'; t=read(p)
t=once(t,
  "import { cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
  "import { buildProfessionalVacancyPresentation, cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
  'vacancy import')
t=regex_once(t,
  r"function ensureProfessionalSentence\(value = ''\) \{.*?\n\}\n\nfunction buildActiveVacancyInterestReply\(vacancy = \{\}, inboundText = ''\) \{.*?\n\}",
  r'''function buildVacancyOverview(vacancy = {}) {
  return buildProfessionalVacancyPresentation(vacancy);
}

function buildActiveVacancyInterestReply(vacancy = {}, inboundText = '') {
  const answer = buildVacancyInformationAnswer(vacancy, inboundText);
  return [answer, buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt: true })]
    .filter(Boolean)
    .join('\n\n');
}''',
  'vacancy formatter block')
for a,b in {
  'La operación registrada para esta vacante es':'La operación asociada a esta vacante es',
  'La función registrada para':'Las funciones del cargo para',
  'pero no hay una descripción adicional registrada.':'pero la información disponible no incluye una descripción adicional de funciones.',
  'Los requisitos registrados para':'Los requisitos para',
  'No hay un requisito específico de experiencia configurado para':'La información disponible no especifica un requisito adicional de experiencia para',
  'No tengo requisitos adicionales registrados para':'La información disponible no incluye requisitos adicionales para',
  'Los documentos registrados para':'Los documentos requeridos para',
  'No tengo documentos específicos registrados para':'La información disponible no especifica documentos adicionales para',
  'Las condiciones registradas para':'Las condiciones para',
  'No tengo condiciones adicionales registradas para':'La información disponible no especifica ese detalle para',
  'La ubicación registrada para':'El lugar de trabajo para',
  'No tengo una ubicación específica registrada para':'La información disponible no incluye una ubicación más específica para',
  'No hay un rango de edad configurado para':'La información disponible no especifica un rango de edad para'
}.items(): t=t.replace(a,b)
old=r'''  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {
    if (requiresConsentBeforeCollection(candidate)) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
        replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
        vacancyId: resolution.vacancy.id,
        vacancy: resolution.vacancy,
        candidateUpdates: buildAwaitingApplicationInterestUpdates(resolution.vacancy.id),
        reply: buildActiveVacancyInterestReply(resolution.vacancy, inboundText),
        resolution
      };
    }
    return { action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE, reason: 'ACTIVE_VACANCY_RESOLVED', vacancyId: resolution.vacancy.id, vacancy: resolution.vacancy, resolution };
  }
'''
new=r'''  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {
    if (requiresConsentBeforeCollection(candidate)) {
      const initialTurn = analyzeConversationTurn(inboundText);
      if (initialTurn.interest) {
        const informationAnswer = buildVacancyInformationAnswer(resolution.vacancy, inboundText);
        return {
          action: VacancyFirstGateAction.REPLY,
          reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT',
          replyKind: 'DATA_CONSENT_PROMPT',
          vacancyId: resolution.vacancy.id,
          vacancy: resolution.vacancy,
          candidateUpdates: {
            vacancyId: resolution.vacancy.id,
            currentStep: GREETING_SENT,
            botResumeMode: buildConsentPendingMode(),
            reminderScheduledFor: null,
            reminderState: 'SKIPPED'
          },
          reply: [informationAnswer, buildProfessionalVacancyPresentation(resolution.vacancy), buildDataConsentPromptReply()]
            .filter(Boolean)
            .join('\n\n'),
          resolution
        };
      }
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
        replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
        vacancyId: resolution.vacancy.id,
        vacancy: resolution.vacancy,
        candidateUpdates: buildAwaitingApplicationInterestUpdates(resolution.vacancy.id),
        reply: buildActiveVacancyInterestReply(resolution.vacancy, inboundText),
        resolution
      };
    }
    return { action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE, reason: 'ACTIVE_VACANCY_RESOLVED', vacancyId: resolution.vacancy.id, vacancy: resolution.vacancy, resolution };
  }
'''
t=once(t,old,new,'resolved vacancy explicit interest'); write(p,t)

# Give normal vacancy-first replies their vacancy context in reply safety.
p='src/routes/webhook.js'; t=read(p)
old="""      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      replyKind: vacancyFirstGateDecision.replyKind
    });
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT) {"""
new="""      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      replyKind: vacancyFirstGateDecision.replyKind,
      safetyVacancy: currentVacancy || vacancyFirstGateDecision.vacancy || null
    });
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT) {"""
t=once(t,old,new,'reply safety vacancy context'); write(p,t)

# Meta confirmation path uses the same public presentation and skips repeated interest prompt.
p='src/services/dataConsentGate.js'; t=read(p)
t=once(t,
  "import { cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText, getConfiguredPublicRequirementSentences } from './vacancyPublicInfo.js';",
  "import { buildProfessionalVacancyPresentation, cleanConfiguredFragment, getConfiguredAgeRequirementText, getConfiguredExperienceRequirementText } from './vacancyPublicInfo.js';",
  'consent import')
t=regex_once(t,
  r"function buildVacancyInfoReply\(vacancy = \{\}\) \{.*?\n\}\n\nexport function buildVacancyQuestionReply",
  "function buildVacancyInfoReply(vacancy = {}, { includeInterestPrompt = true } = {}) {\n  return buildProfessionalVacancyPresentation(vacancy, { includeInterestPrompt });\n}\n\nexport function buildVacancyQuestionReply",
  'meta vacancy formatter')
for a,b in {
  'La operación registrada para esta vacante es':'La operación asociada a esta vacante es',
  'las condiciones registradas son:':'las condiciones son:',
  'No tengo un salario registrado para esta vacante.':'La información disponible de esta vacante no especifica el salario.',
  'No tengo esas condiciones registradas para esta vacante.':'La información disponible de esta vacante no especifica ese detalle.',
  'No hay un rango de edad configurado para esta vacante.':'La información disponible de esta vacante no especifica un rango de edad.',
  'los requisitos registrados son:':'los requisitos son:',
  'No hay un requisito específico de experiencia configurado para esta vacante.':'La información disponible de esta vacante no especifica un requisito adicional de experiencia.',
  'No tengo ese requisito registrado para esta vacante.':'Ese requisito no aparece en la información disponible de esta vacante.',
  'el cargo consiste en':'las funciones del cargo son:',
  'El cargo registrado es':'El cargo es',
  'la ubicación registrada es':'el lugar de trabajo es:',
  'No tengo una ubicación específica registrada para esta vacante.':'La información disponible de esta vacante no incluye una ubicación más específica.',
  'No tengo ese dato registrado en la vacante. Puedo continuar con la información disponible.':'Ese detalle no aparece en la información disponible de esta vacante.'
}.items(): t=t.replace(a,b)
old=r'''  if (isAffirmativeVacancyConfirmation(body)) {
    const cvResendRequired = candidate.botResumeMode === CAMPAIGN_CONFIRMATION_CV_MODE;
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.GREETING_SENT,
        botResumeMode: cvResendRequired ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE
      }
    });
    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id, cvResendRequired });
    return true;
  }
'''
new=r'''  if (isAffirmativeVacancyConfirmation(body)) {
    const cvResendRequired = candidate.botResumeMode === CAMPAIGN_CONFIRMATION_CV_MODE;
    const explicitApplicationInterest = Boolean(analyzeConversationTurn(body).interest);
    if (explicitApplicationInterest) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.GREETING_SENT,
          botResumeMode: buildConsentPendingMode({ cvResendRequired })
        }
      });
      const reply = [questionReply, buildVacancyInfoReply(vacancy, { includeInterestPrompt: false }), buildDataConsentPromptReply()]
        .filter(Boolean)
        .join('\n\n');
      await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed_interest', { vacancyId: vacancy.id, cvResendRequired });
      return true;
    }
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.GREETING_SENT,
        botResumeMode: cvResendRequired ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE
      }
    });
    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id, cvResendRequired });
    return true;
  }
'''
t=once(t,old,new,'meta explicit interest'); write(p,t)

# Align stale wording expectations and add focused regressions.
p='test/vacancyFirstGate.test.js'; t=read(p)
t=t.replace("assert.match(decision.reply, /requisitos registrados/i);","assert.match(decision.reply, /Los requisitos para .* son:/i);")
write(p,t)

p='test/productionPaidAdFlowRegressions.test.js'; t=read(p)
if "import { readFileSync } from 'node:fs';" not in t:
    t=t.replace("import assert from 'node:assert/strict';","import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';")
t=t.replace("assert.match(decision.reply, /te interesa continuar/i);","assert.match(decision.reply, /interesa continuar|continuar con esta vacante/i);")
if "producción: interés explícito al resolver vacante pasa a consentimiento" not in t:
    t += r'''

test('producción: interés explícito al resolver vacante pasa a consentimiento sin repetir pregunta de interés', async () => {
  const decision = await resolveVacancyFirstGate({ prisma: null, candidate: candidate(), currentVacancy: null,
    inboundText: 'Quiero postularme a Líder de Operación en Neiva', currentStep: 'GREETING_SENT', recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] } });
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_CONSENT');
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.match(decision.reply, /\*Vacante: Líder de Operación\*/);
  assert.match(decision.reply, /Antes de recibir o guardar datos personales/i);
  assert.doesNotMatch(decision.reply, /¿Te interesa continuar con esta vacante\?/i);
  assert.match(String(decision.candidateUpdates.botResumeMode), new RegExp(`^${DATA_CONSENT_PENDING_MODE}`));
});

test('defensa: vacancy-first entrega contexto de vacante al filtro de seguridad', () => {
  const source = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.match(source, /replyKind: vacancyFirstGateDecision\.replyKind,[\s\S]{0,180}safetyVacancy: currentVacancy \|\| vacancyFirstGateDecision\.vacancy \|\| null/);
});

test('Meta: la confirmación con interés explícito prepara consentimiento sin preguntar interés otra vez', () => {
  const source = readFileSync(new URL('../src/services/dataConsentGate.js', import.meta.url), 'utf8');
  assert.match(source, /explicitApplicationInterest = Boolean\(analyzeConversationTurn\(body\)\.interest\)/);
  assert.match(source, /campaign_vacancy_confirmed_interest/);
  assert.match(source, /buildVacancyInfoReply\(vacancy, \{ includeInterestPrompt: false \}\)/);
});
'''
write(p,t)

p='test/vacancyConfiguredInformationContract.test.js'; t=read(p)
t=t.replace("assert.match(decision.reply, /te interesa continuar/i);","assert.match(decision.reply, /interesa continuar|continuar con esta vacante/i);")
t=t.replace("assert.match(reply, /no hay un rango de edad configurado/i);","assert.match(reply, /no especifica un rango de edad/i);")
if "respuestas públicas de vacante no exponen jerga interna" not in t:
    t += r'''

test('respuestas públicas de vacante no exponen jerga interna de configuración', () => {
  const conditionsReply = buildVacancyQuestionReply(configuredVacancy, '¿Qué condiciones tiene la vacante?');
  const companyReply = buildVacancyQuestionReply(configuredVacancy, '¿Para qué empresa u operación es?');
  assert.doesNotMatch(conditionsReply, /registrad[oa]|configurad[oa]|cargad[oa]/i);
  assert.doesNotMatch(companyReply, /operación registrada/i);
});
'''
write(p,t)

print('professional vacancy flow v2 applied')
