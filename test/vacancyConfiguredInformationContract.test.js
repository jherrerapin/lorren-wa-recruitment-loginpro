import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';
import { buildVacancyQuestionReply } from '../src/services/dataConsentGate.js';
import { analyzeConversationTurn } from '../src/services/conversationIntent.js';

const configuredVacancy = {
  id: 'vac-configured-info', title: 'Líder de Operación', role: 'Líder de Operación', city: 'Neiva',
  roleDescription: 'Liderar y administrar personal operativo', operationAddress: 'Sector Las Brisas',
  requirements: 'Técnico o tecnólogo en logística', conditions: 'Turnos rotativos y prestaciones de ley',
  requiredDocuments: null, minAge: 23, maxAge: 45, experienceRequired: 'YES',
  experienceTimeText: 'mínimo 6 meses en operaciones logísticas', isActive: true, acceptingApplications: true,
  operation: { name: 'Operación Neiva', city: { name: 'Neiva' } }
};
const candidate = () => ({ id: 'cand-config', currentStep: 'GREETING_SENT', status: 'NUEVO', vacancyId: null, dataConsentStatus: 'PENDING', botResumeMode: null });

test('vacante identificada presenta configuración y luego pregunta interés', async () => {
  const decision = await resolveVacancyFirstGate({ prisma: null, candidate: candidate(), currentVacancy: null, inboundText: 'Líder de operación Neiva', currentStep: 'GREETING_SENT', recentMessages: [], vacancyHints: { allVacancies: [configuredVacancy], activeVacancies: [configuredVacancy] } });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST');
  assert.match(decision.reply, /23 a 45 años/i);
  assert.match(decision.reply, /mínimo 6 meses en operaciones logísticas/i);
  assert.match(decision.reply, /te interesa continuar/i);
  assert.doesNotMatch(decision.reply, /no especificado/i);
  assert.match(decision.reply, /^\*Vacante: Líder de Operación\*/);
  assert.match(decision.reply, /Ciudad: Neiva/);
  assert.match(decision.reply, /Zona de trabajo: Sector Las Brisas/);
  assert.match(decision.reply, /\*Funciones\*\nLiderar y administrar personal operativo\./);
  assert.match(decision.reply, /\*Requisitos\*/);
  assert.match(decision.reply, /Edad: 23 a 45 años\./);
  assert.match(decision.reply, /Experiencia: Mínimo 6 meses en operaciones logísticas\./);
  assert.match(decision.reply, /\*Condiciones\*/);
  assert.match(decision.reply, /\n\n¿Te interesa continuar con esta vacante\?/);
});

test('vacante sin edad configurada no menciona edad en presentación automática', async () => {
  const vacancy = { ...configuredVacancy, id: 'vac-no-age', minAge: null, maxAge: null };
  const decision = await resolveVacancyFirstGate({ prisma: null, candidate: candidate(), currentVacancy: null, inboundText: 'Líder de operación Neiva', currentStep: 'GREETING_SENT', recentMessages: [], vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] } });
  assert.doesNotMatch(decision.reply, /rango de edad|edad mínima|edad máxima/i);
});

test('pregunta de edad usa minAge/maxAge y no requisitos genéricos', () => {
  const reply = buildVacancyQuestionReply(configuredVacancy, '¿Qué edad piden para la vacante?');
  assert.match(reply, /23 a 45 años/i);
  assert.doesNotMatch(reply, /Técnico o tecnólogo/i);
});

test('pregunta de edad sin rango no inventa información', () => {
  const reply = buildVacancyQuestionReply({ ...configuredVacancy, minAge: null, maxAge: null }, '¿Qué edad piden?');
  assert.match(reply, /no especifica un rango de edad/i);
  assert.doesNotMatch(reply, /23|45/);
});

test('pregunta de empresa responde con operación asociada', () => {
  const reply = buildVacancyQuestionReply(configuredVacancy, '¿Para qué empresa u operación es?');
  assert.match(reply, /LoginPro Service/i);
  assert.match(reply, /Operación Neiva/i);
});

test('edad se reconoce como información de vacante', () => {
  assert.equal(analyzeConversationTurn('¿Qué edad piden para esta vacante?').vacancyInformationRequest, true);
});

test('antes del consentimiento no se pide localidad o residencia para identificar vacante en Bogotá', async () => {
  const v1 = { ...configuredVacancy, id: 'bog-1', title: 'Auxiliar de Bodega', role: 'Auxiliar de Bodega', city: 'Bogotá', operation: { name: 'Op 1', city: { name: 'Bogotá' } } };
  const v2 = { ...configuredVacancy, id: 'bog-2', title: 'Líder de Operación', role: 'Líder de Operación', city: 'Bogotá', operation: { name: 'Op 2', city: { name: 'Bogotá' } } };
  const decision = await resolveVacancyFirstGate({ prisma: null, candidate: candidate(), currentVacancy: null, inboundText: 'Bogotá', currentStep: 'GREETING_SENT', recentMessages: [], vacancyHints: { allVacancies: [v1, v2], activeVacancies: [v1, v2] } });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.doesNotMatch(decision.reply, /localidad|barrio|d[oó]nde vives|residencia/i);
  assert.match(decision.reply, /vacante|cargo/i);
});


test('respuestas públicas de vacante no exponen jerga interna de configuración', () => {
  const questions = [
    '¿Para qué empresa u operación es?',
    '¿Qué condiciones tiene la vacante?',
    '¿Qué requisitos piden?',
    '¿Qué edad piden?',
    '¿Qué funciones tiene?',
    '¿Dónde queda?'
  ];
  for (const question of questions) {
    const reply = buildVacancyQuestionReply(configuredVacancy, question);
    assert.doesNotMatch(reply, /registrad[oa]|configurad[oa]|cargad[oa]/i, question);
  }
});
