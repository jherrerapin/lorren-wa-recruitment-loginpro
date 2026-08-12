import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContacts, extractMessages, isRecruitmentWhatsappPayload } from '../src/services/whatsapp.js';

function inboundPayload(phoneNumberId, messageId = 'wamid.TEST') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '573001234567' }],
              messages: [
                {
                  id: messageId,
                  from: '573001234567',
                  type: 'text',
                  text: { body: 'hola' }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

test('reclutamiento acepta únicamente su phone_number_id cuando está configurado', () => {
  const payload = inboundPayload('RECRUITMENT_ID');
  assert.equal(isRecruitmentWhatsappPayload(payload, 'RECRUITMENT_ID'), true);
  assert.equal(isRecruitmentWhatsappPayload(payload, 'DISPATCH_ID'), false);
});

test('extractMessages ignora eventos de otra línea antes de entrar al pipeline de reclutamiento', () => {
  const previous = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'RECRUITMENT_ID';
  try {
    const dispatchPayload = inboundPayload('1050989508092273', 'wamid.DISPATCH');
    assert.deepEqual(extractMessages(dispatchPayload), []);
    assert.deepEqual(extractContacts(dispatchPayload), []);
  } finally {
    if (previous === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previous;
  }
});

test('extractMessages conserva el comportamiento normal para la línea de reclutamiento', () => {
  const previous = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'RECRUITMENT_ID';
  try {
    const payload = inboundPayload('RECRUITMENT_ID', 'wamid.RECRUITMENT');
    const messages = extractMessages(payload);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'wamid.RECRUITMENT');
    assert.equal(messages[0].text.body, 'hola');
    assert.equal(extractContacts(payload).length, 1);
  } finally {
    if (previous === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previous;
  }
});

test('scope falla abierto si falta configuración o metadata para no romper webhooks heredados', () => {
  assert.equal(isRecruitmentWhatsappPayload(inboundPayload('ANY'), ''), true);
  assert.equal(isRecruitmentWhatsappPayload({ entry: [{ changes: [{ value: {} }] }] }, 'RECRUITMENT_ID'), true);
});
