from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba una coincidencia y se encontraron {count}')
    return text.replace(old, new, 1)


runtime_path = Path('src/services/dispatchWhatsappWebServiceV6.js')
runtime = runtime_path.read_text(encoding='utf-8')

runtime = replace_once(
    runtime,
    """function inboundKey(message = {}) {
  return String(message.id?._serialized || message.id?.id || `${message.from || ''}|${message.timestamp || ''}|${confirmationTextFromMessage(message)}`);
}
""",
    """function inboundKey(message = {}) {
  return String(message.id?._serialized || message.id?.id || `${message.from || ''}|${message.timestamp || ''}|${confirmationTextFromMessage(message)}`);
}

function isOwnWhatsappMessage(message = {}) {
  return Boolean(
    message.fromMe
    || message.id?.fromMe
    || message._data?.id?.fromMe
    || message.rawData?.id?.fromMe
  );
}

function confirmationEvidenceFromMessage(message = {}) {
  const confirmationMessageId = inboundKey(message).trim();
  const timestamp = messageTimestamp(message);
  const confirmationReceivedAt = timestamp ? new Date(timestamp * 1000) : new Date();
  if (!confirmationMessageId || Number.isNaN(confirmationReceivedAt.getTime())) return null;
  return { confirmationMessageId, confirmationReceivedAt };
}
""",
    'runtime helpers de evidencia'
)

runtime = replace_once(
    runtime,
    """  const assignment = await prisma.dispatchAssignment.findFirst({
    where: { id: link.assignmentId, serviceRequestId: link.serviceRequestId, status: { in: PENDING_ASSIGNMENT_STATUSES } },
    include: { worker: true }
  });
""",
    """  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: link.assignmentId,
      serviceRequestId: link.serviceRequestId,
      status: { in: [...PENDING_ASSIGNMENT_STATUSES, CONFIRMED_ASSIGNMENT_STATUS] }
    },
    include: { worker: true }
  });
""",
    'runtime resolución persistida de asignación'
)

old_claim = """export async function claimDispatchAssignmentConfirmation({ assignment, phone = '', chatId = '', prismaClient = prisma } = {}) {
  if (!assignment?.id) return { assignmentConfirmed: false, shouldReply: false, repaired: false };
  return prismaClient.$transaction(async (tx) => {
    const updated = await tx.dispatchAssignment.updateMany({
      where: { id: assignment.id, status: { in: PENDING_ASSIGNMENT_STATUSES } },
      data: { status: CONFIRMED_ASSIGNMENT_STATUS }
    });

    if (updated.count) {
      const links = await tx.dispatchWhatsappConfirmation.updateMany({
        where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
        data: { status: CONFIRMED_REPLY_PENDING_STATUS }
      });
      if (!links.count) {
        await tx.dispatchWhatsappConfirmation.create({
          data: {
            assignmentId: assignment.id,
            serviceRequestId: assignment.serviceRequestId,
            phone: normalizePhone(phone) || null,
            chatId: normalizeChatId(chatId) || null,
            status: CONFIRMED_REPLY_PENDING_STATUS,
            expiresAt: new Date(Date.now() + CONFIRMATION_MEMORY_TTL_MS)
          }
        });
      }
      return { assignmentConfirmed: true, shouldReply: true, repaired: false };
    }

    const current = await tx.dispatchAssignment.findUnique({
      where: { id: assignment.id },
      select: { status: true }
    });
    if (current?.status !== CONFIRMED_ASSIGNMENT_STATUS) {
      return { assignmentConfirmed: false, shouldReply: false, repaired: false };
    }

    const repaired = await tx.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
      data: { status: CONFIRMED_REPLY_PENDING_STATUS }
    });
    return { assignmentConfirmed: false, shouldReply: repaired.count > 0, repaired: repaired.count > 0 };
  });
}
"""
new_claim = """export async function claimDispatchAssignmentConfirmation({
  assignment,
  phone = '',
  chatId = '',
  confirmationMessageId = '',
  confirmationReceivedAt = null,
  prismaClient = prisma
} = {}) {
  const evidenceMessageId = String(confirmationMessageId || '').trim();
  const evidenceReceivedAt = confirmationReceivedAt instanceof Date
    ? confirmationReceivedAt
    : new Date(confirmationReceivedAt || Number.NaN);
  if (!assignment?.id || !evidenceMessageId || Number.isNaN(evidenceReceivedAt.getTime())) {
    return { assignmentConfirmed: false, shouldReply: false, repaired: false };
  }

  const replyEvidence = {
    status: CONFIRMED_REPLY_PENDING_STATUS,
    confirmationMessageId: evidenceMessageId,
    confirmationReceivedAt: evidenceReceivedAt
  };

  return prismaClient.$transaction(async (tx) => {
    const updated = await tx.dispatchAssignment.updateMany({
      where: { id: assignment.id, status: { in: PENDING_ASSIGNMENT_STATUSES } },
      data: { status: CONFIRMED_ASSIGNMENT_STATUS }
    });

    if (updated.count) {
      const links = await tx.dispatchWhatsappConfirmation.updateMany({
        where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
        data: replyEvidence
      });
      if (!links.count) {
        await tx.dispatchWhatsappConfirmation.create({
          data: {
            assignmentId: assignment.id,
            serviceRequestId: assignment.serviceRequestId,
            phone: normalizePhone(phone) || null,
            chatId: normalizeChatId(chatId) || null,
            ...replyEvidence,
            expiresAt: new Date(Date.now() + CONFIRMATION_MEMORY_TTL_MS)
          }
        });
      }
      return { assignmentConfirmed: true, shouldReply: true, repaired: false };
    }

    const current = await tx.dispatchAssignment.findUnique({
      where: { id: assignment.id },
      select: { status: true }
    });
    if (current?.status !== CONFIRMED_ASSIGNMENT_STATUS) {
      return { assignmentConfirmed: false, shouldReply: false, repaired: false };
    }

    const repaired = await tx.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
      data: replyEvidence
    });
    return { assignmentConfirmed: false, shouldReply: repaired.count > 0, repaired: repaired.count > 0 };
  });
}
"""
runtime = replace_once(runtime, old_claim, new_claim, 'runtime claim transaccional')

runtime = replace_once(
    runtime,
    """async function applyAssignmentConfirmation({ activeClient, assignment, phone = '', chatId = '', eventName = 'message' } = {}) {
  if (!assignment?.id || !chatId) return false;
  const claim = await claimDispatchAssignmentConfirmation({ assignment, phone, chatId });
""",
    """async function applyAssignmentConfirmation({ activeClient, assignment, phone = '', chatId = '', message = {}, eventName = 'message' } = {}) {
  if (!assignment?.id || !chatId) return false;
  const evidence = confirmationEvidenceFromMessage(message);
  if (!evidence) return false;
  const claim = await claimDispatchAssignmentConfirmation({ assignment, phone, chatId, ...evidence });
""",
    'runtime aplicación con evidencia'
)

runtime = replace_once(
    runtime,
    """async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {
  if (message?.fromMe) return false;
""",
    """async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {
  if (isOwnWhatsappMessage(message)) return false;
""",
    'runtime filtro de mensajes propios'
)

runtime = replace_once(
    runtime,
    """    return await applyAssignmentConfirmation({ activeClient, assignment, phone, chatId: sender, eventName });
""",
    """    return await applyAssignmentConfirmation({ activeClient, assignment, phone, chatId: sender, message, eventName });
""",
    'runtime entrega del mensaje a claim'
)

repair_start = runtime.find('async function repairConfirmedAssignmentsAwaitingReply() {')
retry_start = runtime.find('async function retryPendingAutomaticReplies(activeClient) {')
if repair_start < 0 or retry_start < 0 or retry_start <= repair_start:
    raise SystemExit('runtime: no se encontró el bloque de reparación masiva')
runtime = runtime[:repair_start] + runtime[retry_start:]

runtime = replace_once(
    runtime,
    """  const pendingReplyLinks = await prisma.dispatchWhatsappConfirmation.findMany({
    where: { status: CONFIRMED_REPLY_PENDING_STATUS },
""",
    """  const pendingReplyLinks = await prisma.dispatchWhatsappConfirmation.findMany({
    where: {
      status: CONFIRMED_REPLY_PENDING_STATUS,
      confirmationMessageId: { not: null },
      confirmationReceivedAt: { not: null },
      assignment: { status: CONFIRMED_ASSIGNMENT_STATUS }
    },
""",
    'runtime filtro de reintentos autorizados'
)

runtime = replace_once(
    runtime,
    """    for (const target of targets) processed += await processPersistedConfirmationTarget(activeClient, target);
    const orphanedRepliesRepaired = await repairConfirmedAssignmentsAwaitingReply();
    repliesRetried = await retryPendingAutomaticReplies(activeClient);
    if (orphanedRepliesRepaired) console.log(`[dispatch-wa] Respuestas automáticas huérfanas reparadas=${orphanedRepliesRepaired}.`);
""",
    """    for (const target of targets) processed += await processPersistedConfirmationTarget(activeClient, target);
    repliesRetried = await retryPendingAutomaticReplies(activeClient);
""",
    'runtime retiro de promoción sin evidencia'
)

runtime_path.write_text(runtime.rstrip() + '\n', encoding='utf-8')

schema_path = Path('prisma/schema.prisma')
schema = schema_path.read_text(encoding='utf-8')
schema = replace_once(
    schema,
    """  providerMessageId String?
  status            String             @default("PENDING")
  expiresAt         DateTime
""",
    """  providerMessageId       String?
  confirmationMessageId String?
  confirmationReceivedAt DateTime?
  status                  String             @default("PENDING")
  expiresAt               DateTime
""",
    'schema evidencia de confirmación'
)
schema = replace_once(
    schema,
    """  @@index([providerMessageId])
}
""",
    """  @@index([providerMessageId])
  @@index([status, confirmationReceivedAt], map: "DispatchWaConfirmation_reply_evidence_idx")
}
""",
    'schema índice de evidencia'
)
schema_path.write_text(schema.rstrip() + '\n', encoding='utf-8')

migration_path = Path('prisma/migrations/20260725004500_dispatch_whatsapp_reply_evidence/migration.sql')
migration_path.parent.mkdir(parents=True, exist_ok=True)
migration_path.write_text("""-- Solo una confirmación entrante real puede autorizar el agradecimiento automático.
ALTER TABLE "DispatchWhatsappConfirmation"
  ADD COLUMN "confirmationMessageId" TEXT,
  ADD COLUMN "confirmationReceivedAt" TIMESTAMP(3);

-- La cola heredada no distingue respuestas reales de confirmaciones manuales.
-- Se cierra antes de iniciar el nuevo runtime para impedir otro envío masivo.
UPDATE "DispatchWhatsappConfirmation"
SET
  "status" = 'CONFIRMED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'CONFIRMED_REPLY_PENDING'
  AND "confirmationReceivedAt" IS NULL;

CREATE INDEX "DispatchWaConfirmation_reply_evidence_idx"
  ON "DispatchWhatsappConfirmation"("status", "confirmationReceivedAt");
""", encoding='utf-8')

test_path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
tests = test_path.read_text(encoding='utf-8')

old_static_test = """test('automatic thanks are persisted before sending and orphaned confirmations are repaired', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const applyBlock = between(
    source,
    'async function applyAssignmentConfirmation',
    'async function resolveAssignmentForInboundConfirmation'
  );
  assert.match(source, /CONFIRMED_REPLY_PENDING_STATUS = 'CONFIRMED_REPLY_PENDING'/);
  assert.match(source, /export async function claimDispatchAssignmentConfirmation/);
  assert.ok(applyBlock.indexOf('claimDispatchAssignmentConfirmation') < applyBlock.indexOf('sendAutomaticConfirmationReply'));
  assert.match(source, /async function repairConfirmedAssignmentsAwaitingReply/);
  assert.match(source, /assignment: \{ status: CONFIRMED_ASSIGNMENT_STATUS \}/);
  assert.match(source, /await repairConfirmedAssignmentsAwaitingReply\(\)/);
});
"""
new_static_test = """test('automatic thanks require inbound evidence and ready reconciliation cannot manufacture replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const schema = readSource('prisma/schema.prisma');
  const migration = readSource('prisma/migrations/20260725004500_dispatch_whatsapp_reply_evidence/migration.sql');
  const applyBlock = between(
    source,
    'async function applyAssignmentConfirmation',
    'async function resolveAssignmentForInboundConfirmation'
  );
  const retryBlock = between(
    source,
    'async function retryPendingAutomaticReplies',
    'async function processPersistedPendingConfirmations'
  );
  assert.match(source, /CONFIRMED_REPLY_PENDING_STATUS = 'CONFIRMED_REPLY_PENDING'/);
  assert.match(source, /function confirmationEvidenceFromMessage/);
  assert.match(source, /export async function claimDispatchAssignmentConfirmation/);
  assert.ok(applyBlock.indexOf('confirmationEvidenceFromMessage') < applyBlock.indexOf('sendAutomaticConfirmationReply'));
  assert.match(retryBlock, /confirmationMessageId: \{ not: null \}/);
  assert.match(retryBlock, /confirmationReceivedAt: \{ not: null \}/);
  assert.match(retryBlock, /assignment: \{ status: CONFIRMED_ASSIGNMENT_STATUS \}/);
  assert.doesNotMatch(source, /repairConfirmedAssignmentsAwaitingReply|orphanedRepliesRepaired/);
  assert.match(schema, /confirmationMessageId\s+String\?/);
  assert.match(schema, /confirmationReceivedAt\s+DateTime\?/);
  assert.match(migration, /WHERE "status" = 'CONFIRMED_REPLY_PENDING'/);
  assert.match(migration, /"confirmationReceivedAt" IS NULL/);
});
"""
tests = replace_once(tests, old_static_test, new_static_test, 'test estático de autorización')

old_claim_test = """test('confirmation claim atomically leaves the automatic reply pending and repairs confirmed assignments', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?claim-test=677');
  const operations = [];
  const tx = {
    dispatchAssignment: {
      updateMany: async () => { operations.push('assignment-confirmed'); return { count: 1 }; },
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async ({ data }) => { operations.push(`links-${data.status}`); return { count: 1 }; },
      create: async () => { operations.push('link-created'); return { id: 'link' }; }
    }
  };
  const prismaClient = { $transaction: async (callback) => callback(tx) };
  const result = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a1', serviceRequestId: 'r1' },
    phone: '3001234567',
    chatId: '573001234567@c.us',
    prismaClient
  });
  assert.deepEqual(result, { assignmentConfirmed: true, shouldReply: true, repaired: false });
  assert.deepEqual(operations, ['assignment-confirmed', 'links-CONFIRMED_REPLY_PENDING']);

  const repairTx = {
    dispatchAssignment: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: 'unused' })
    }
  };
  const repaired = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a2', serviceRequestId: 'r2' },
    prismaClient: { $transaction: async (callback) => callback(repairTx) }
  });
  assert.deepEqual(repaired, { assignmentConfirmed: false, shouldReply: true, repaired: true });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});
"""
new_claim_test = """test('confirmation claim requires inbound evidence and remains durable across a restart', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?claim-test=704');
  const operations = [];
  const tx = {
    dispatchAssignment: {
      updateMany: async () => { operations.push('assignment-confirmed'); return { count: 1 }; },
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async ({ data }) => {
        operations.push(`links-${data.status}-${Boolean(data.confirmationMessageId)}-${data.confirmationReceivedAt instanceof Date}`);
        return { count: 1 };
      },
      create: async () => { operations.push('link-created'); return { id: 'link' }; }
    }
  };
  const prismaClient = { $transaction: async (callback) => callback(tx) };
  const result = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a1', serviceRequestId: 'r1' },
    phone: '3001234567',
    chatId: '573001234567@c.us',
    confirmationMessageId: 'incoming-message-1',
    confirmationReceivedAt: new Date('2026-07-25T00:20:00.000Z'),
    prismaClient
  });
  assert.deepEqual(result, { assignmentConfirmed: true, shouldReply: true, repaired: false });
  assert.deepEqual(operations, ['assignment-confirmed', 'links-CONFIRMED_REPLY_PENDING-true-true']);

  let transactionCalled = false;
  const withoutEvidence = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'manual-confirmed', serviceRequestId: 'r2' },
    prismaClient: {
      $transaction: async () => {
        transactionCalled = true;
        return null;
      }
    }
  });
  assert.deepEqual(withoutEvidence, { assignmentConfirmed: false, shouldReply: false, repaired: false });
  assert.equal(transactionCalled, false);

  const repairTx = {
    dispatchAssignment: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async ({ data }) => ({
        count: data.confirmationMessageId === 'incoming-after-manual' && data.confirmationReceivedAt instanceof Date ? 1 : 0
      }),
      create: async () => ({ id: 'unused' })
    }
  };
  const repairedFromRealInbound = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a2', serviceRequestId: 'r2' },
    confirmationMessageId: 'incoming-after-manual',
    confirmationReceivedAt: new Date('2026-07-25T00:21:00.000Z'),
    prismaClient: { $transaction: async (callback) => callback(repairTx) }
  });
  assert.deepEqual(repairedFromRealInbound, { assignmentConfirmed: false, shouldReply: true, repaired: true });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});
"""
tests = replace_once(tests, old_claim_test, new_claim_test, 'test unitario de claim')

own_guard_anchor = """test('an incomplete duplicate event cannot reserve the inbound lock before assignment resolution', () => {
"""
own_guard_test = """test('message_create cannot treat outbound messages as confirmations', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const inbound = between(
    source,
    'async function confirmAssignmentFromInboundMessage',
    'function bindInboundMessageListeners'
  );
  assert.match(source, /function isOwnWhatsappMessage/);
  assert.match(source, /message\.id\?\.fromMe/);
  assert.match(source, /message\._data\?\.id\?\.fromMe/);
  assert.match(inbound, /if \(isOwnWhatsappMessage\(message\)\) return false/);
});

""" + own_guard_anchor
if own_guard_anchor not in tests:
    raise SystemExit('test: no se encontró ancla para mensajes propios')
tests = tests.replace(own_guard_anchor, own_guard_test, 1)
test_path.write_text(tests.rstrip() + '\n', encoding='utf-8')

print('Corrección #704 aplicada correctamente.')
