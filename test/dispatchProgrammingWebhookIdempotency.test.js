import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPreviouslyAuditedProgrammingMessageIds,
  processProgrammingContacts
} from '../src/routes/dispatchWhatsappWebhook.js';

const OPERATIONAL_PHONE_ID = 'dispatch-phone-id-test';
const CONTACT_PHONE = '570000000000';

function programmingPayload(message) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: OPERATIONAL_PHONE_ID },
          messages: [message]
        }
      }]
    }]
  };
}

function storedProgrammingConfig() {
  return {
    entityType: 'DISPATCH_PROGRAMMING_CONTACT_CONFIG',
    entityId: 'operational',
    action: 'SET_DISPATCH_PROGRAMMING_CONTACTS',
    metadata: {
      contacts: [{ name: 'Contacto Prueba', phone: CONTACT_PHONE }],
      formats: ['pdf']
    },
    createdAt: new Date('2026-08-14T12:00:00.000Z')
  };
}

function prismaFixture({ previouslyAudited = [] } = {}) {
  const claimIds = new Set();
  const config = storedProgrammingConfig();
  return {
    claimIds,
    devAuditEvent: {
      findFirst: async ({ where }) => (
        where?.entityType === 'DISPATCH_PROGRAMMING_CONTACT_CONFIG' ? config : null
      ),
      findMany: async ({ where }) => {
        const requested = new Set(where?.entityId?.in || []);
        return previouslyAudited
          .map((messageId) => ({ entityId: `dispatch-wa:inbound:${messageId}` }))
          .filter((row) => requested.has(row.entityId));
      },
      create: async ({ data }) => {
        if (claimIds.has(data.id)) {
          const error = new Error('duplicate claim');
          error.code = 'P2002';
          throw error;
        }
        claimIds.add(data.id);
        return data;
      }
    }
  };
}

async function withOperationalPhoneId(callback) {
  const previous = process.env.DISPATCH_META_PHONE_NUMBER_ID;
  process.env.DISPATCH_META_PHONE_NUMBER_ID = OPERATIONAL_PHONE_ID;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.DISPATCH_META_PHONE_NUMBER_ID;
    else process.env.DISPATCH_META_PHONE_NUMBER_ID = previous;
  }
}

test('un mismo botón inbound de Programación solo produce una respuesta aunque Meta lo reentregue', async () => {
  await withOperationalPhoneId(async () => {
    const prisma = prismaFixture();
    const sends = [];
    const payload = programmingPayload({
      id: 'wamid-programming-menu-1',
      from: CONTACT_PHONE,
      type: 'interactive',
      interactive: { button_reply: { id: 'dispatch_report:programming_today', title: 'Programación' } }
    });
    const handlers = {
      sendReportDateMenu: async (_prisma, contact, reportType) => {
        sends.push({ phone: contact.phone, reportType });
      }
    };

    const first = await processProgrammingContacts(prisma, payload, { handlers });
    const second = await processProgrammingContacts(prisma, payload, { handlers });

    assert.deepEqual(first, { handled: 1, skipped: 0 });
    assert.deepEqual(second, { handled: 0, skipped: 1 });
    assert.deepEqual(sends, [{ phone: CONTACT_PHONE, reportType: 'programming' }]);
    assert.ok(prisma.claimIds.has('dispatch-programming-inbound:wamid-programming-menu-1'));
  });
});

test('texto libre de un destinatario registrado abre el menú una sola vez por message.id', async () => {
  await withOperationalPhoneId(async () => {
    const prisma = prismaFixture();
    let menuSends = 0;
    const payload = programmingPayload({
      id: 'wamid-generic-menu-1',
      from: CONTACT_PHONE,
      type: 'text',
      text: { body: 'Hola' }
    });
    const handlers = {
      sendProgrammingMenu: async () => { menuSends += 1; }
    };

    await processProgrammingContacts(prisma, payload, { allowGenericMenu: true, handlers });
    await processProgrammingContacts(prisma, payload, { allowGenericMenu: true, handlers });

    assert.equal(menuSends, 1);
  });
});

test('un inbound ya auditado antes de este webhook no vuelve a disparar documentos ni menús', async () => {
  await withOperationalPhoneId(async () => {
    const prisma = prismaFixture({ previouslyAudited: ['wamid-old-action'] });
    const payload = programmingPayload({
      id: 'wamid-old-action',
      from: CONTACT_PHONE,
      type: 'interactive',
      interactive: { button_reply: { id: 'dispatch_report:programming_today_pdf', title: 'PDF' } }
    });
    const previouslyAudited = await loadPreviouslyAuditedProgrammingMessageIds(prisma, payload);
    let documentSends = 0;

    const result = await processProgrammingContacts(prisma, payload, {
      skipMessageIds: previouslyAudited,
      handlers: {
        sendProgrammingContactDocuments: async () => { documentSends += 1; }
      }
    });

    assert.deepEqual([...previouslyAudited], ['wamid-old-action']);
    assert.deepEqual(result, { handled: 0, skipped: 1 });
    assert.equal(documentSends, 0);
    assert.equal(prisma.claimIds.size, 0);
  });
});

test('mensajes sin message.id no pueden producir efectos externos de Programación', async () => {
  await withOperationalPhoneId(async () => {
    const prisma = prismaFixture();
    const payload = programmingPayload({
      from: CONTACT_PHONE,
      type: 'interactive',
      interactive: { button_reply: { id: 'dispatch_report:programming_today', title: 'Programación' } }
    });
    let sends = 0;

    const result = await processProgrammingContacts(prisma, payload, {
      handlers: { sendReportDateMenu: async () => { sends += 1; } }
    });

    assert.deepEqual(result, { handled: 0, skipped: 1 });
    assert.equal(sends, 0);
  });
});
