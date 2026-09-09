import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DATA_CONSENT_BUTTONS, DATA_CONSENT_VERSION, requestDataConsent } from '../src/services/dataConsentGate.js';
import { extractMessages, buildReplyButtonsPayload } from '../src/services/whatsapp.js';
import { runCandidateProcessReminderDispatcher } from '../src/services/reminder.js';
import { createConsentGateHarness } from './helpers/consentGateHarness.js';
const originalPost = axios.post;
after(() => { axios.post = originalPost; });
const text = (id, body) => ({ id, from: 'TEST-PHONE', type: 'text', text: { body } });
const button = (id, index, title = DATA_CONSENT_BUTTONS[index].title) => ({ id, from: 'TEST-PHONE', type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id: DATA_CONSENT_BUTTONS[index].id, title } } });
const prompts = (h) => h.sent.filter((p) => p.type === 'interactive' && p.interactive.body.text.includes('Autorizo a LoginPro'));
async function pending(h) { assert.equal((await h.run(text('TEST-INTEREST', 'Quiero postularme'))).status, 200); }

test('A/B/C: one interactive consent across duplicate and concurrent interest deliveries', async () => {
  const h = createConsentGateHarness();
  await Promise.all([h.run(text('TEST-A', 'Quiero postularme')), h.run(text('TEST-A', 'Quiero postularme')),
    h.run(text('TEST-B', 'Quiero continuar con el proceso'))]);
  assert.equal(prompts(h).length, 1);
  assert.deepEqual(prompts(h)[0].interactive.action.buttons.map((b) => b.reply), DATA_CONSENT_BUTTONS);
  assert.ok(h.transactions.some((t) => t?.isolationLevel === 'Serializable'));
});

test('D: no new inbound at t+2/t+5 minutes, including an internal request, means silence', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-09-08T12:00:00Z') });
  const h = createConsentGateHarness(); await pending(h);
  for (const minutes of [2, 3]) {
    t.mock.timers.tick(minutes * 60000);
    await runCandidateProcessReminderDispatcher(h.prisma);
    await requestDataConsent(h.prisma, { candidate: h.getCandidate(), to: 'TEST-PHONE' });
    await h.run(text('TEST-INTEREST', 'Quiero postularme'));
  }
  assert.equal(h.sent.length, 1);
});

test('E/F/K: button ID authorizes once, despite conflicting title and retry, preserving vacancy and persisted fields', async () => {
  const h = createConsentGateHarness({ candidate: { fullName: 'Nombre Sintético', documentType: 'CC', documentNumber: 'TEST-DOCUMENT' } });
  await pending(h);
  const inbound = button('TEST-ACCEPT', 0, 'No autorizo');
  const normalized = extractMessages({ entry: [{ changes: [{ value: { messages: [inbound] } }] }] })[0];
  await Promise.all([h.run(normalized), h.run(normalized)]);
  await h.run(button('TEST-SECOND-CLICK', 0));
  assert.equal(h.events.length, 1);
  assert.equal(h.getCandidate().dataConsentStatus, 'ACCEPTED');
  assert.equal(h.getCandidate().dataConsentVersion, DATA_CONSENT_VERSION);
  assert.equal(h.getCandidate().vacancyId, 'TEST-VACANCY');
  assert.equal(h.getCandidate().currentStep, 'COLLECTING_DATA');
  assert.equal(h.sent.length, 2);
  const response = h.sent[1].text.body;
  assert.match(response, /edad/i);
  assert.doesNotMatch(response, /hola|ciudad|cargo|nombre completo|número de documento|te interesa/i);
});

test('G: decline is a single semantic transition and closure, then no data/CV/scheduling', async () => {
  const h = createConsentGateHarness(); await pending(h);
  await Promise.all([h.run(button('TEST-NO', 1)), h.run(button('TEST-NO', 1)), h.run(button('TEST-NO-2', 1))]);
  await h.run(text('TEST-HELLO', 'hola'));
  await h.run({ id: 'TEST-CV', from: 'TEST-PHONE', type: 'document', document: { id: 'TEST-MEDIA' } });
  assert.equal(h.events.length, 1); assert.equal(h.getCandidate().dataConsentStatus, 'REVOKED');
  assert.equal(h.getCandidate().currentStep, 'DONE'); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text.body, /No continuaré/);
});

test('H: natural acceptance and rejection retain the same semantic authority', async () => {
  for (const [body, status] of [['sí', 'ACCEPTED'], ['si', 'ACCEPTED'], ['autorizo', 'ACCEPTED'],
    ['sí autorizo', 'ACCEPTED'], ['acepto', 'ACCEPTED'], ['no autorizo', 'REVOKED']]) {
    const h = createConsentGateHarness(); await pending(h); await h.run(text('TEST-DECISION', body));
    assert.equal(h.getCandidate().dataConsentStatus, status, body); assert.equal(h.events.length, 1, body);
  }
});

test('I: ACCEPTED suppresses consent even with a stale campaign-confirmation mode', async () => {
  const h = createConsentGateHarness({ candidate: { dataConsentStatus: 'ACCEPTED', dataConsentVersion: DATA_CONSENT_VERSION, botResumeMode: 'campaign_vacancy_pending_confirmation' } });
  await h.run(text('TEST-ALREADY', 'Quiero postularme'));
  await requestDataConsent(h.prisma, { candidate: h.getCandidate(), to: 'TEST-PHONE', inboundMessageId: 'TEST-ALREADY' });
  assert.equal(h.sent.length, 0); assert.equal(h.events.length, 0);
});

test('J: preconsent attachment gets at most one contextual reply and stores no media', async () => {
  const h = createConsentGateHarness(); await pending(h);
  const attachment = { id: 'TEST-ATTACHMENT', from: 'TEST-PHONE', type: 'document',
    document: { id: 'TEST-MEDIA-NEVER-SAVED', filename: 'TEST-PRIVATE-FILENAME.pdf' } };
  await Promise.all([h.run(attachment), h.run(attachment)]);
  assert.equal(h.sent.length, 2); assert.equal(prompts(h).length, 1);
  assert.match(h.sent[1].interactive.body.text, /no lo descargué ni lo guardé/);
  assert.doesNotMatch(JSON.stringify(h.messages), /TEST-MEDIA-NEVER-SAVED|TEST-PRIVATE-FILENAME/);
});

test('production replay: old ordinary webhook retries cannot repeat interest before consent', async () => {
  const h = createConsentGateHarness();
  for (let i = 0; i < 3; i++) await h.run(text('TEST-OLD', 'hola'));
  assert.equal(h.sent.length, 1); assert.equal(h.messages.filter((m) => m.direction === 'INBOUND').length, 1);
});

test('unknown consent version cannot authorize through visible title', async () => {
  const h = createConsentGateHarness(); await pending(h);
  const stale = button('TEST-STALE', 0); stale.interactive.button_reply.id = 'data_consent:old-version:accept';
  await h.run(stale); assert.equal(h.events.length, 0);
});

test('uncertain provider outcome is durable and cannot resend on webhook retry', async () => {
  const h = createConsentGateHarness({ failSend: true });
  await h.run(text('TEST-TIMEOUT', 'Quiero postularme'));
  await h.run(text('TEST-TIMEOUT', 'Quiero postularme'));
  assert.equal(h.sent.length, 1);
  assert.equal(h.messages.find((m) => m.direction === 'OUTBOUND').rawPayload.delivery.state, 'UNKNOWN');
});

test('generic interactive payload validates stable IDs and button bounds', () => {
  assert.equal(buildReplyButtonsPayload('TEST-PHONE', 'TEST-BODY', DATA_CONSENT_BUTTONS).type, 'interactive');
  assert.throws(() => buildReplyButtonsPayload('TEST-PHONE', 'x'.repeat(1025), DATA_CONSENT_BUTTONS));
  assert.throws(() => buildReplyButtonsPayload('TEST-PHONE', 'TEST', [DATA_CONSENT_BUTTONS[0], DATA_CONSENT_BUTTONS[0]]));
});

test('a committed decision survives failure before its reply is reserved', async () => {
  for (const index of [0, 1]) {
    const h = createConsentGateHarness(); await pending(h);
    const create = h.prisma.message.create;
    let fail = true;
    h.prisma.message.create = async (args) => {
      if (args.data.direction === 'OUTBOUND' && fail) { fail = false; throw new Error('TEST-outbox-unavailable'); }
      return create(args);
    };
    const message = button(`TEST-RECOVER-${index}`, index);
    assert.equal((await h.run(message)).status, 503);
    assert.equal(h.events.length, 1);
    assert.equal((await h.run(message)).status, 200);
    assert.equal(h.events.length, 1); assert.equal(h.sent.length, 2);
    assert.equal(h.getCandidate().currentStep, index === 0 ? 'COLLECTING_DATA' : 'DONE');
  }
});

test('REVOKED only reopens on a new explicit authorization, through the same writer', async () => {
  const h = createConsentGateHarness(); await pending(h);
  await h.run(button('TEST-DECLINE', 1));
  await h.run(text('TEST-INTEREST-LATER', 'Quiero postularme'));
  assert.equal(h.getCandidate().dataConsentStatus, 'REVOKED');
  await h.run(text('TEST-REAUTHORIZE', 'Ahora sí autorizo el tratamiento de mis datos'));
  assert.equal(h.getCandidate().dataConsentStatus, 'ACCEPTED');
  assert.deepEqual(h.events.map((e) => e.status), ['REVOKED', 'ACCEPTED']);
  assert.equal(prompts(h).length, 1);
});

test('legacy confirmed consent is recognized without a new legal message', async () => {
  const h = createConsentGateHarness();
  await h.prisma.message.create({ data: { candidateId: 'TEST-CANDIDATE', direction: 'OUTBOUND',
    messageType: 'TEXT', body: 'TEST-LEGACY-CONSENT',
    rawPayload: { source: 'data_consent_prompt', consentVersion: DATA_CONSENT_VERSION } } });
  await h.run(text('TEST-LEGACY-INTEREST', 'Quiero postularme'));
  assert.equal(h.sent.length, 0);
});

test('the webhook resolver and middleware share the same durable request reservation', async () => {
  const h = createConsentGateHarness();
  const stale = h.getCandidate();
  await pending(h);
  await requestDataConsent(h.prisma, { candidate: stale, to: 'TEST-PHONE', inboundMessageId: 'TEST-INTEREST' });
  assert.equal(prompts(h).length, 1);
});

test('acceptance asks for the CV when all canonical profile fields are complete', async () => {
  const h = createConsentGateHarness({ candidate: {
    fullName: 'Persona Sintética', documentType: 'CC', documentNumber: 'TEST-DOCUMENT',
    age: 30, neighborhood: 'Barrio sintético', medicalRestrictions: 'Ninguna',
    transportMode: 'Público', experienceInfo: 'No'
  }, vacancy: { experienceRequired: 'NO' } });
  await pending(h); await h.run(button('TEST-CV-NEXT', 0));
  assert.match(h.sent[1].text.body, /adjunta tu hoja de vida/i);
  assert.doesNotMatch(h.sent[1].text.body, /hola|ciudad|cargo|te interesa/i);
});

test('HTTP 429/400: requestDataConsent outbox retries the same inbound and delivers only once', async () => {
  for (const status of [429, 400]) {
    const h = createConsentGateHarness();
    let attempts = 0, delivered = 0;
    axios.post = async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('TEST-confirmed-rejection'), { response: { status } });
      delivered++;
      return { data: { messages: [{ id: 'TEST-RECOVERED' }] } };
    };
    const inbound = text('TEST-FAILED-RETRY', 'Quiero postularme');
    assert.equal((await h.run(inbound)).status, 503);
    assert.deepEqual(h.messages.filter(m => m.direction === 'OUTBOUND').map(m => m.rawPayload.delivery.state), ['FAILED']);
    await Promise.all([h.run(inbound), h.run(inbound)]);
    await h.run(inbound);
    assert.equal(attempts, 2); assert.equal(delivered, 1); assert.equal(h.events.length, 0);
    assert.deepEqual(h.messages.filter(m => m.direction === 'OUTBOUND').map(m => m.rawPayload.delivery.state), ['FAILED', 'SENT']);
  }
});

test('current-version acceptance preserves fields, vacancy and step without another prompt', async () => {
  const h = createConsentGateHarness({ candidate: { dataConsentStatus: 'ACCEPTED',
    dataConsentVersion: DATA_CONSENT_VERSION, fullName: 'Persona Sintética',
    currentStep: 'ASK_CV', botResumeMode: null } });
  const before = h.getCandidate();
  await h.run(text('TEST-CURRENT', 'Quiero continuar'));
  assert.deepEqual(h.getCandidate(), before); assert.equal(h.sent.length, 0); assert.equal(h.events.length, 0);
});

test('old/null acceptance requires current terms; old prompt or button cannot authorize the new version', async () => {
  for (const version of ['TEST-OLD-VERSION', null]) {
    const h = createConsentGateHarness({ candidate: { dataConsentStatus: 'ACCEPTED',
      dataConsentVersion: version, fullName: 'Persona Sintética', botResumeMode: 'awaiting_data_consent' } });
    const historicalEvent = { status: 'ACCEPTED', version };
    h.events.push(structuredClone(historicalEvent));
    await h.prisma.message.create({ data: { candidateId: 'TEST-CANDIDATE', direction: 'OUTBOUND',
      rawPayload: { replyKind: 'DATA_CONSENT_PROMPT', ...(version ? { consentVersion: version } : {}) } } });
    await h.run(text('TEST-OLD-PENDING-YES', 'sí autorizo'));
    assert.equal(prompts(h).length, 1); assert.deepEqual(h.events, [historicalEvent]);
    assert.equal(h.getCandidate().dataConsentVersion, version);
    const oldButton = button('TEST-OLD-BUTTON', 0);
    oldButton.interactive.button_reply.id = 'data_consent:TEST-OLD-VERSION:accept';
    await h.run(oldButton);
    assert.deepEqual(h.events, [historicalEvent]);
    await Promise.all([h.run(button('TEST-NEW-BUTTON', 0)), h.run(button('TEST-NEW-BUTTON', 0))]);
    assert.equal(h.events.length, 2); assert.deepEqual(h.events[0], historicalEvent);
    assert.equal(h.getCandidate().dataConsentVersion, DATA_CONSENT_VERSION);
    assert.equal(h.getCandidate().fullName, 'Persona Sintética');
    assert.equal(h.getCandidate().vacancyId, 'TEST-VACANCY');
    assert.equal(prompts(h).length, 1);
  }
});

test('a later real inbound also recovers FAILED without duplicating the delivered prompt', async () => {
  const h = createConsentGateHarness();
  let attempts = 0;
  axios.post = async () => {
    if (++attempts === 1) throw Object.assign(new Error('TEST-429'), { response: { status: 429 } });
    return { data: { messages: [{ id: 'TEST-RETRY-NEW-INBOUND' }] } };
  };
  await h.run(text('TEST-FIRST-429', 'Quiero postularme'));
  await h.run(text('TEST-NEW-INBOUND', 'Hola'));
  await h.run(text('TEST-NEW-INBOUND', 'Hola'));
  assert.equal(attempts, 2); assert.equal(h.events.length, 0);
});

test('FAILED recovery honors a human pause before the next provider attempt', async () => {
  const h = createConsentGateHarness();
  let attempts = 0;
  axios.post = async () => {
    attempts++;
    throw Object.assign(new Error('TEST-429'), { response: { status: 429 } });
  };
  const inbound = text('TEST-PAUSED-429', 'Quiero postularme');
  await h.run(inbound);
  await h.prisma.candidate.update({ data: { botPaused: true } });
  const result = await requestDataConsent(h.prisma, {
    candidate: h.getCandidate(), to: 'TEST-PHONE', inboundMessageId: inbound.id
  });
  assert.equal(result.suppressed, true); assert.equal(attempts, 1);
  assert.equal(h.getCandidate().botPaused, true); assert.equal(h.events.length, 0);
});

test('renewal can be rejected once without altering historical acceptance', async () => {
  const h = createConsentGateHarness({ candidate: { dataConsentStatus: 'ACCEPTED', dataConsentVersion: 'TEST-OLD' } });
  h.events.push({ status: 'ACCEPTED', version: 'TEST-OLD' });
  await h.run(text('TEST-RENEW', 'Quiero continuar'));
  await Promise.all([h.run(button('TEST-RENEW-REJECT', 1)), h.run(button('TEST-RENEW-REJECT', 1))]);
  await h.run(text('TEST-AFTER-REJECT', 'Hola'));
  assert.deepEqual(h.events.map(e => e.status), ['ACCEPTED', 'REVOKED']);
  assert.equal(h.events[0].version, 'TEST-OLD'); assert.equal(h.getCandidate().dataConsentStatus, 'REVOKED');
  assert.equal(h.sent.length, 2);
});
