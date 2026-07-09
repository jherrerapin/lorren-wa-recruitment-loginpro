import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecentHumanIntervention } from '../src/services/conversationEngine.js';
import { getLastOutboundContext } from '../src/services/contextualResponseGate.js';
import { classifyOutboundActor } from '../src/services/manualSourcePolicy.js';

function outboundWithRaw(rawPayload = {}) {
  return {
    direction: 'OUTBOUND',
    body: 'Outbound de caracterización',
    rawPayload,
    createdAt: new Date('2026-05-16T13:00:00.000Z')
  };
}

const actorSourceCases = [
  ['último outbound sin source conserva compatibilidad manual', {}, true, 'RECRUITER'],
  ['admin_* es humano/recruiter', { source: 'admin_manual_vacancy_info' }, true, 'RECRUITER'],
  ['manual_* es humano/recruiter', { source: 'manual_followup' }, true, 'RECRUITER'],
  ['MANUAL_AUTHORIZED es humano/recruiter', { source: 'MANUAL_AUTHORIZED' }, true, 'RECRUITER'],
  ['MANUAL_AUTHORIZED por sourceCategory es humano/recruiter', { sourceCategory: 'MANUAL_AUTHORIZED' }, true, 'RECRUITER'],
  ['reminder* no es humano', { source: 'reminder_interview' }, false, 'REMINDER'],
  ['system* no es humano', { source: 'system_notification' }, false, 'SYSTEM'],
  ['source bot normal no es humano', { source: 'bot_flow' }, false, 'BOT'],
  ['rawPayload.actor RECRUITER gana sobre source ambiguo', { source: 'bot_flow', actor: 'RECRUITER' }, true, 'RECRUITER'],
  ['rawPayload.actorRole RECRUITER gana sobre source ambiguo', { source: 'bot_flow', actorRole: 'RECRUITER' }, true, 'RECRUITER']
];

test('política única actor/source clasifica la matriz requerida de outbound', () => {
  for (const [label, rawPayload, expectedManual, expectedActor] of actorSourceCases) {
    const classification = classifyOutboundActor(rawPayload);

    assert.equal(classification.isManual, expectedManual, label);
    assert.equal(classification.actor, expectedActor, label);
  }
});

test('hasRecentHumanIntervention y getLastOutboundContext usan la misma clasificación actor/source', () => {
  for (const [label, rawPayload, expectedManual, expectedActor] of actorSourceCases) {
    const recentMessages = [outboundWithRaw(rawPayload)];
    const outboundContext = getLastOutboundContext(recentMessages);

    assert.equal(hasRecentHumanIntervention(recentMessages), expectedManual, label);
    assert.equal(outboundContext.isManual, expectedManual, label);
    assert.equal(outboundContext.actor, expectedActor, label);
  }
});
