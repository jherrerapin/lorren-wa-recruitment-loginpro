import test from 'node:test';
import assert from 'node:assert/strict';

import { saveInboundMessage } from '../src/routes/webhook.js';

test('saveInboundMessage cae a UNKNOWN si la base rechaza IMAGE en MessageType', async () => {
  const createManyCalls = [];
  const prisma = {
    message: {
      async createMany({ data }) {
        createManyCalls.push(data[0]);
        if (createManyCalls.length === 1) {
          throw new Error('invalid input value for enum "MessageType": "IMAGE"');
        }
        return { count: 1 };
      },
      async findUnique() {
        return { id: 'msg-1' };
      }
    },
    candidate: {
      async update() {
        return null;
      }
    }
  };

  const result = await saveInboundMessage(
    prisma,
    'candidate-1',
    { id: 'wa-1', type: 'image', image: { caption: 'soporte' } },
    'soporte',
    'IMAGE',
    '573001112233'
  );

  assert.equal(result.isNew, true);
  assert.equal(result.id, 'msg-1');
  assert.equal(createManyCalls.length, 2);
  assert.equal(createManyCalls[0].messageType, 'IMAGE');
  assert.equal(createManyCalls[1].messageType, 'UNKNOWN');
});
