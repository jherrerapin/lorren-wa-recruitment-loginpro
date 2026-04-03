import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalData, normalizeCandidateFields } from '../src/services/candidateData.js';
import { splitFieldDecisions } from '../src/services/debugTrace.js';
import { describeResumeBehavior, shouldBlockAutomation } from '../src/services/botAutomationPolicy.js';

function applyInboundToQueue(queue, inboundText) {
  queue.push(inboundText);
  return queue;
}

test('Caso A: botPaused=true bloquea respuesta/avance de flujo', () => {
  const candidate = { botPaused: true, currentStep: 'COLLECTING_DATA', status: 'NUEVO' };
  const shouldSkip = shouldBlockAutomation(candidate);
  assert.equal(shouldSkip, true);
  assert.equal(candidate.currentStep, 'COLLECTING_DATA');
  assert.equal(candidate.status, 'NUEVO');
});

test('Caso C: al reanudar conserva contexto pendiente y procesa corrección con overwrite explícito', () => {
  const pendingQueue = [];
  applyInboundToQueue(pendingQueue, 'sin experiencia y no tengo moto');
  applyInboundToQueue(pendingQueue, 'corrijo: tengo moto');

  const first = normalizeCandidateFields(parseNaturalData(pendingQueue[0]));
  const second = normalizeCandidateFields(parseNaturalData(pendingQueue[1]));
  const candidate = { experienceInfo: null, experienceTime: null, transportMode: 'Sin medio de transporte' };

  const firstDecision = splitFieldDecisions(first, candidate);
  Object.assign(candidate, firstDecision.persistedData);

  const secondDecision = splitFieldDecisions(second, candidate, { allowOverwriteFields: ['transportMode'] });
  Object.assign(candidate, secondDecision.persistedData);

  assert.equal(candidate.experienceInfo, 'No');
  assert.equal(candidate.experienceTime, '0');
  assert.equal(candidate.transportMode, 'Moto');
  assert.equal(pendingQueue.length, 2);
});

test('Caso D: reanudación con pendientes queda en modo que requiere trigger posterior', () => {
  const behavior = describeResumeBehavior({ pendingInboundCount: 3, supportsImmediateReplay: false });
  assert.equal(behavior.requiresTrigger, true);
  assert.equal(behavior.resumeMode, 'awaiting_inbound_trigger_with_pending_context');
});
