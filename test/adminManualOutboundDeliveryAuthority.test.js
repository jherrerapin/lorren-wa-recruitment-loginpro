import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/admin.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.ok(startIndex >= 0, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

const helper = between(
  source,
  'async function sendAdminOutboundMessage',
  'function buildManualInterviewReminderText'
);

const interviewReminderRoute = between(
  source,
  "router.post('/interviews/:id/manual-reminder'",
  "router.post('/interviews/:id/delete'"
);
const vacancyInfoRoute = between(
  source,
  "router.post('/candidates/:id/send-vacancy-info'",
  "router.post('/candidates/:id/assign-vacancy'"
);
const outboundRoute = between(
  source,
  "router.post('/candidates/:id/outbound'",
  "router.post('/candidates/:id/request-hv'"
);
const requestHvRoute = between(
  source,
  "router.post('/candidates/:id/request-hv'",
  "router.get('/users'"
);

test('admin importa únicamente el orquestador durable para el envío manual', () => {
  assert.match(
    source,
    /import \{\s*deliverManualOutboundText,\s*getManualOutboundUserMessage\s*\} from '\.\.\/services\/manualOutboundDeliveryService\.js';/
  );
  assert.doesNotMatch(source, /import \{[^}]*persistOutboundConversationMessage[^}]*\} from '\.\.\/services\/conversationMessageRepository\.js';/s);
  assert.doesNotMatch(source, /import \{ buildManualInterventionCandidateUpdate \} from '\.\.\/services\/adminOutboundPolicy\.js';/);
});

test('sendAdminOutboundMessage delega sin mutar Candidate ni crear Message directamente', () => {
  assert.match(helper, /return deliverManualOutboundText\(prisma,\s*\{/);
  assert.match(helper, /candidateId:\s*candidate\.id/);
  assert.match(helper, /phone:\s*candidate\.phone/);
  assert.match(helper, /body:\s*finalBody/);
  assert.match(helper, /rawPayload:\s*deliveryPayload/);
  assert.match(helper, /sendText:\s*sendTextMessage/);
  assert.doesNotMatch(helper, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(helper, /persistOutboundConversationMessage\s*\(/);
  assert.doesNotMatch(helper, /buildManualInterventionCandidateUpdate\s*\(/);

  const payloadIndex = helper.indexOf('const deliveryPayload');
  const delegationIndex = helper.indexOf('deliverManualOutboundText');
  assert.ok(payloadIndex >= 0);
  assert.ok(delegationIndex > payloadIndex);
});

test('los cuatro consumidores muestran el mensaje seguro del orquestador', () => {
  for (const [name, route] of [
    ['recordatorio de entrevista', interviewReminderRoute],
    ['información de vacante', vacancyInfoRoute],
    ['mensaje saliente', outboundRoute],
    ['solicitud de HV', requestHvRoute]
  ]) {
    assert.match(route, /getManualOutboundUserMessage\(/, `${name} no usa el mensaje seguro compartido`);
  }
});
