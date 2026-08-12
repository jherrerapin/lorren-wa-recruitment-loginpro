import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversationTurn } from '../src/services/conversationIntent.js';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate,
  inferContextualSemanticIntent
} from '../src/services/contextualResponseGate.js';

const vacancy = {
  id: 'vacancy-synthetic-cv-question',
  title: 'Auxiliar operativo',
  city: 'Bogotá',
  schedulingEnabled: false
};

const candidate = {
  id: 'candidate-synthetic-cv-question',
  vacancyId: vacancy.id,
  currentStep: 'COLLECTING_DATA',
  fullName: null,
  documentType: null,
  documentNumber: null,
  age: null,
  locality: null,
  medicalRestrictions: null,
  transportMode: null,
  cvStorageKey: null
};

test('preguntar dónde enviar la hoja de vida no se interpreta como si el archivo hubiera sido enviado', () => {
  const text = '¿Dónde envío la hoja de vida?';
  const turn = analyzeConversationTurn(text, { currentStep: 'COLLECTING_DATA' });
  const semanticIntent = inferContextualSemanticIntent({
    text,
    resolvedIntent: turn.primaryIntent,
    isQuestion: turn.question,
    hasCvAttachment: false
  });

  assert.equal(turn.question, true);
  assert.equal(turn.primaryIntent, 'faq');
  assert.equal(semanticIntent, 'ASK_CV_SUBMISSION');
});

test('la pregunta de envío de HV se responde sin afirmar que el archivo ya llegó ni reiniciar el formulario', () => {
  const text = '¿Cómo puedo mandar mi CV?';
  const turn = analyzeConversationTurn(text, { currentStep: 'COLLECTING_DATA' });
  const semanticIntent = inferContextualSemanticIntent({
    text,
    resolvedIntent: turn.primaryIntent,
    isQuestion: turn.question,
    hasCvAttachment: false
  });
  const gate = evaluateContextualResponseGate({
    candidate,
    vacancy,
    recentMessages: [],
    semanticIntent
  });

  assert.equal(gate.shouldReply, true);
  assert.equal(gate.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.match(gate.reply, /aquí mismo en este chat/i);
  assert.match(gate.reply, /PDF, DOC o DOCX/i);
  assert.doesNotMatch(gate.reply, /recib|ya (?:lleg|tenemos)|nombre completo|documento|edad|barrio|localidad/i);
});

test('una declaración de envío sin pregunta conserva la acción de CV', () => {
  const text = 'Te envío mi hoja de vida';
  const turn = analyzeConversationTurn(text, { currentStep: 'ASK_CV' });
  const semanticIntent = inferContextualSemanticIntent({
    text,
    resolvedIntent: turn.primaryIntent,
    isQuestion: turn.question,
    hasCvAttachment: false
  });

  assert.equal(turn.question, false);
  assert.equal(turn.primaryIntent, 'cv_intent');
  assert.equal(semanticIntent, 'SEND_CV');
});
