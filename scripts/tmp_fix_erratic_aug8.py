from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'No se encontró patrón: {label}')
    p.write_text(text.replace(old, new, 1))


# Parser: "cuatro" no puede convertirse en 3 y "sí, más de 4 años" debe conservarse.
replace_once(
    'src/services/candidateData.js',
    'un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 3, cinco: 5,',
    'un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,',
    'cuatro años'
)
replace_once(
    'src/services/candidateData.js',
    r"  const hasShortAffirmativeContext = /\bsi\s+tengo\s+/.test(compact);",
    r"  const hasShortAffirmativeContext = /\bsi(?:\s+tengo)?\b/.test(compact) && /\bmas\s+de\b/.test(compact);",
    'experiencia corta afirmativa'
)

# Frontera para consultas comerciales y prioridad de preguntas de vacante.
p = Path('src/services/vacancyFirstGate.js')
text = p.read_text()
marker = """function requiresConsentBeforeCollection(candidate = {}) {
  return String(candidate?.dataConsentStatus || '') !== 'ACCEPTED';
}
"""
insertion = marker + """
function isLikelyCommercialInquiry(text = '') {
  const normalized = normalizeResolverText(text);
  const hasBusinessIdentity = /\\b(tengo una empresa|tenemos una empresa|somos una empresa|mi empresa|ofrecemos|prestamos servicios|proveedor|propuesta comercial|alianza comercial)\\b/.test(normalized);
  const hasServiceContext = /\\b(ultima milla|servicios?|operamos|cobertura|distribucion|transporte|logistica|descargue|cargue)\\b/.test(normalized);
  const hasCandidateIntent = /\\b(postular|postulacion|vacante|empleo|buscar trabajo|busco trabajo|cargo|hoja de vida|hv)\\b/.test(normalized);
  return hasBusinessIdentity && hasServiceContext && !hasCandidateIntent;
}
"""
if marker not in text:
    raise SystemExit('No se encontró patrón: helper consentimiento')
text = text.replace(marker, insertion, 1)

attachment_block = """  if (attachmentContext?.isAttachment && hasRecentAttachmentGuidance(recentMessages)) {
    return { action: VacancyFirstGateAction.SUPPRESS_REPLY, reason: 'RECENT_ATTACHMENT_GUIDANCE_ALREADY_SENT' };
  }
"""
commercial_block = attachment_block + """
  if (requiresConsentBeforeCollection(candidate) && START_OR_INTAKE_STEPS.has(currentStep) && isLikelyCommercialInquiry(inboundText)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'COMMERCIAL_INQUIRY_OUTSIDE_RECRUITMENT_FLOW',
      replyKind: 'COMMERCIAL_INQUIRY_BOUNDARY',
      candidateUpdates: { reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: 'Este canal automatizado está enfocado en procesos de selección. Tu mensaje parece corresponder a una propuesta comercial, por lo que no voy a solicitarte datos ni hoja de vida como candidato.'
    };
  }
"""
if attachment_block not in text:
    raise SystemExit('No se encontró patrón: attachment guard')
text = text.replace(attachment_block, commercial_block, 1)

assigned_marker = """  const assignedVacancyChangeDecision = await evaluateAssignedVacancyChange({
    prisma,
    candidate,
    currentVacancy,
    inboundText,
    currentStep,
    vacancyHints
  });
"""
question_guard = """  const currentTurn = analyzeConversationTurn(inboundText, { currentStep });
  if (currentVacancy && isOpenVacancy(currentVacancy)
    && (currentTurn.vacancyInformationRequest || currentTurn.question)
    && currentTurn.primaryIntent !== 'change_intent') {
    const informationReply = buildVacancyInformationAnswer(currentVacancy, inboundText);
    if (informationReply) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_INFORMATION_ANSWER',
        replyKind: 'VACANCY_INFORMATION_ANSWER',
        vacancyId: currentVacancy.id || candidate?.vacancyId,
        vacancy: currentVacancy,
        reply: informationReply
      };
    }
  }

""" + assigned_marker
if assigned_marker not in text:
    raise SystemExit('No se encontró patrón: assigned vacancy change')
text = text.replace(assigned_marker, question_guard, 1)
p.write_text(text)

# Reminder tests: after the policy change, only accepted consent is eligible.
p = Path('test/reminderPolicy.test.js')
text = p.read_text()
if "dataConsentStatus: 'ACCEPTED'" not in text:
    text = text.replace(
        "    botPaused: false,\n    ...overrides",
        "    botPaused: false,\n    dataConsentStatus: 'ACCEPTED',\n    ...overrides",
        1
    )
text += """

test('no programa recordatorio mientras espera consentimiento', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ currentStep: 'COLLECTING_DATA', dataConsentStatus: 'PENDING' })), false);
});

test('no programa recordatorio desde GREETING_SENT aunque exista consentimiento', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ currentStep: 'GREETING_SENT', dataConsentStatus: 'ACCEPTED' })), false);
});
"""
p.write_text(text)

# Regresiones exactas de las conversaciones del 8 de agosto.
Path('test/erraticBehaviorAug8Regression.test.js').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { VacancyFirstGateAction, resolveVacancyFirstGate } from '../src/services/vacancyFirstGate.js';

const vacancy = {
  id: 'vac-neiva', title: 'Líder de Operación', role: 'Líder de Operación',
  roleDescription: 'Liderar y administrar equipos de trabajo.',
  requirements: 'Experiencia mínima de 6 meses en operaciones logísticas y manejo de personal.',
  conditions: 'Salario a convenir. Turnos rotativos.', operationAddress: 'Sector Las Brisas',
  city: 'Neiva', isActive: true, acceptingApplications: true,
  operation: { id: 'op-neiva', name: 'Operación Isimo Neiva', city: { id: 'city-neiva', name: 'Neiva' } }
};

function candidate(overrides = {}) {
  return {
    id: 'cand-aug8', status: 'NUEVO', currentStep: 'GREETING_SENT', vacancyId: vacancy.id, vacancy,
    botPaused: false, botResumeMode: 'awaiting_application_interest', reminderState: 'SKIPPED',
    reminderScheduledFor: null, dataConsentStatus: 'PENDING', ...overrides
  };
}

test('confirmar interés nunca pide datos antes del consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null, candidate: candidate(), currentVacancy: vacancy, currentStep: 'GREETING_SENT',
    inboundText: 'Si deseo postularme a la vacante', recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'DATA_CONSENT_PROMPT');
  assert.match(decision.reply, /autorización|autorizo/i);
  assert.doesNotMatch(decision.reply, /compárteme nombre|numero de documento|edad, el barrio|restricciones medicas/i);
});

test('pregunta sobre tipo de operación se responde antes de reinterpretar la vacante', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null, candidate: candidate(), currentVacancy: vacancy, currentStep: 'GREETING_SENT',
    inboundText: 'Pero que tipo de operación es?', recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'VACANCY_INFORMATION_ANSWER');
  assert.match(decision.reply, /Operación Isimo Neiva/i);
  assert.doesNotMatch(decision.reply, /ya es la que tienes asociada/i);
});

test('consulta comercial no entra al flujo de candidato ni solicita hoja de vida', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ currentStep: 'MENU', vacancyId: null, vacancy: null, botResumeMode: null }),
    currentVacancy: null, currentStep: 'MENU',
    inboundText: 'Soy Miguel y tengo una empresa de última milla y descargue; operamos en Huila, Caquetá y Putumayo',
    recentMessages: [], vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.replyKind, 'COMMERCIAL_INQUIRY_BOUNDARY');
  assert.match(decision.reply, /propuesta comercial/i);
  assert.doesNotMatch(decision.reply, /compárteme|hoja de vida como archivo|postulación aún/i);
});

test('bloque corto conserva edad, restricción y más de cuatro años de experiencia', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('28, no tengo restricción médica, sí, más de 4 años'));
  assert.equal(normalized.age, 28);
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '4 años');
});

test('cuatro años nunca se normaliza como tres años', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('Tengo cuatro años de experiencia en logística'));
  assert.equal(normalized.experienceTime, '4 años');
});
''')
