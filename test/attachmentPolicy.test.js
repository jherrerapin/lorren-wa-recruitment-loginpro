import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPolicy } from '../src/core/engine/policies/attachmentPolicy.js';

function input(overrides = {}) {
  return {
    candidate: {
      facts: {
        dataConsentStatus: 'ACCEPTED',
        currentStep: 'ASK_CV',
        vacancyId: 'vacancy-1'
      }
    },
    interpretation: { fields: {} },
    pending: { fields: [], actions: [] },
    attachments: { items: [], current: [], hasCv: false },
    execution: { mayReply: true },
    ...overrides
  };
}

test('una imagen no se acepta como CV y responde con formatos permitidos', async () => {
  const decision = await attachmentPolicy(input({
    attachments: {
      hasCv: false,
      current: [],
      items: [{ type: 'image', isCv: false }]
    }
  }));
  assert.match(decision.reply.text, /PDF o Word \(DOC o DOCX\)/i);
});

test('un CV reconocido no genera una segunda solicitud de archivo', async () => {
  assert.deepEqual(await attachmentPolicy(input({
    attachments: {
      hasCv: true,
      current: [],
      items: [{ type: 'document', isCv: true }]
    }
  })), {});
});

test('audio conserva su autoridad separada de revisión humana', async () => {
  assert.deepEqual(await attachmentPolicy(input({
    attachments: {
      hasCv: false,
      current: [],
      items: [{ type: 'audio', isCv: false }]
    }
  })), {});
});

test('mayReply false impide cualquier respuesta sobre el adjunto', async () => {
  assert.deepEqual(await attachmentPolicy(input({
    execution: { mayReply: false },
    attachments: {
      hasCv: false,
      current: [],
      items: [{ type: 'image', isCv: false }]
    }
  })), {});
});
