function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} debe ser texto no vacío`);
  }
}

function assertTenantContext(actual, expected) {
  for (const field of ['tenantId', 'channelId', 'provider']) {
    if (actual[field] !== expected[field]) {
      throw new Error(`tenant_context_mismatch:${field}`);
    }
  }
}

function tenantCandidateKey(tenantContext, candidateId) {
  return `${tenantContext.tenantId}:${candidateId}`;
}

function inboundKey(tenantContext, messageId) {
  return `${tenantContext.tenantId}:${tenantContext.channelId}:${messageId}:inbound`;
}

function outboundKey(tenantContext, idempotencyKey) {
  return `${tenantContext.tenantId}:${tenantContext.channelId}:${idempotencyKey}:outbound`;
}

function cloneMapValues(map) {
  return [...map.values()].map((value) => structuredClone(value));
}

function normalizeFailureCount(value) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function createInMemoryReplayAdapters(fixture, options = {}) {
  const expectedTenantContext = structuredClone(fixture.tenantContext);
  const candidateId = fixture.initialState.candidate.candidateId;
  const now = options.now || '2026-07-14T15:00:00.000Z';
  let remainingDeliveryFailures = normalizeFailureCount(options.failures?.deliverOutbound);
  const candidates = new Map([
    [tenantCandidateKey(expectedTenantContext, candidateId), structuredClone(fixture.initialState.candidate)]
  ]);
  const conversationState = {
    pendingFields: [...(fixture.initialState.pendingFields || [])]
  };
  const inboundMessages = new Map();
  const outboundMessages = new Map();
  const deliveryAttempts = new Map();
  const deliveries = new Map();
  const auditEvents = [];

  function validateContext(tenantContext) {
    assertTenantContext(tenantContext, expectedTenantContext);
  }

  function readCandidate(tenantContext, requestedCandidateId) {
    validateContext(tenantContext);
    assertNonEmptyString(requestedCandidateId, 'candidateId');
    const key = tenantCandidateKey(tenantContext, requestedCandidateId);
    if (!candidates.has(key)) throw new Error(`candidate_not_found:${requestedCandidateId}`);
    return structuredClone(candidates.get(key));
  }

  function claimInbound({ tenantContext, policyContext, requestedCandidateId, message }) {
    validateContext(tenantContext);
    assertNonEmptyString(requestedCandidateId, 'candidateId');
    assertNonEmptyString(message.messageId, 'message.messageId');
    const key = inboundKey(tenantContext, message.messageId);
    if (inboundMessages.has(key)) return false;

    inboundMessages.set(key, {
      key,
      tenantId: tenantContext.tenantId,
      channelId: tenantContext.channelId,
      provider: tenantContext.provider,
      candidateId: requestedCandidateId,
      messageId: message.messageId,
      direction: 'INBOUND',
      messageType: message.type,
      body: message.body,
      policyContext: structuredClone(policyContext),
      recordedAt: now
    });
    auditEvents.push({
      type: 'INBOUND_CLAIMED',
      tenantId: tenantContext.tenantId,
      candidateId: requestedCandidateId,
      messageId: message.messageId,
      recordedAt: now
    });
    return true;
  }

  function updateCandidate({ tenantContext, requestedCandidateId, patch, source }) {
    validateContext(tenantContext);
    const key = tenantCandidateKey(tenantContext, requestedCandidateId);
    if (!candidates.has(key)) throw new Error(`candidate_not_found:${requestedCandidateId}`);
    const updated = { ...candidates.get(key), ...structuredClone(patch) };
    candidates.set(key, updated);
    auditEvents.push({
      type: 'CANDIDATE_UPDATED',
      tenantId: tenantContext.tenantId,
      candidateId: requestedCandidateId,
      fields: Object.keys(patch),
      source,
      recordedAt: now
    });
    return structuredClone(updated);
  }

  function persistOutbound({ tenantContext, policyContext, requestedCandidateId, idempotencyKey, body }) {
    validateContext(tenantContext);
    assertNonEmptyString(idempotencyKey, 'idempotencyKey');
    assertNonEmptyString(body, 'body');
    const key = outboundKey(tenantContext, idempotencyKey);
    if (outboundMessages.has(key)) return false;

    outboundMessages.set(key, {
      key,
      tenantId: tenantContext.tenantId,
      channelId: tenantContext.channelId,
      provider: tenantContext.provider,
      candidateId: requestedCandidateId,
      idempotencyKey,
      direction: 'OUTBOUND',
      messageType: 'text',
      body,
      policyContext: structuredClone(policyContext),
      recordedAt: now
    });
    auditEvents.push({
      type: 'OUTBOUND_PERSISTED',
      tenantId: tenantContext.tenantId,
      candidateId: requestedCandidateId,
      idempotencyKey,
      recordedAt: now
    });
    return true;
  }

  function readOutbound({ tenantContext, idempotencyKey }) {
    validateContext(tenantContext);
    assertNonEmptyString(idempotencyKey, 'idempotencyKey');
    const record = outboundMessages.get(outboundKey(tenantContext, idempotencyKey));
    return record ? structuredClone(record) : null;
  }

  function hasDelivery({ tenantContext, idempotencyKey }) {
    validateContext(tenantContext);
    assertNonEmptyString(idempotencyKey, 'idempotencyKey');
    return deliveries.has(outboundKey(tenantContext, idempotencyKey));
  }

  function deliverOutbound({ tenantContext, requestedCandidateId, idempotencyKey, body }) {
    validateContext(tenantContext);
    const key = outboundKey(tenantContext, idempotencyKey);
    if (deliveries.has(key)) return false;
    if (!outboundMessages.has(key)) throw new Error(`outbound_not_persisted:${idempotencyKey}`);

    const previousAttempts = deliveryAttempts.get(key)?.attempts || 0;
    const attempt = previousAttempts + 1;
    deliveryAttempts.set(key, {
      key,
      tenantId: tenantContext.tenantId,
      channelId: tenantContext.channelId,
      provider: tenantContext.provider,
      candidateId: requestedCandidateId,
      idempotencyKey,
      attempts: attempt,
      lastAttemptAt: now
    });

    if (remainingDeliveryFailures > 0) {
      remainingDeliveryFailures -= 1;
      auditEvents.push({
        type: 'OUTBOUND_DELIVERY_FAILED',
        tenantId: tenantContext.tenantId,
        candidateId: requestedCandidateId,
        idempotencyKey,
        attempt,
        recordedAt: now
      });
      throw new Error(`simulated_delivery_failure:${idempotencyKey}`);
    }

    deliveries.set(key, {
      key,
      tenantId: tenantContext.tenantId,
      channelId: tenantContext.channelId,
      provider: tenantContext.provider,
      candidateId: requestedCandidateId,
      idempotencyKey,
      body,
      deliveredAt: now,
      attempt
    });
    auditEvents.push({
      type: 'OUTBOUND_DELIVERED',
      tenantId: tenantContext.tenantId,
      candidateId: requestedCandidateId,
      idempotencyKey,
      attempt,
      recordedAt: now
    });
    return true;
  }

  function snapshot() {
    return {
      now,
      candidates: cloneMapValues(candidates),
      conversationState: structuredClone(conversationState),
      inboundMessages: cloneMapValues(inboundMessages),
      outboundMessages: cloneMapValues(outboundMessages),
      deliveryAttempts: cloneMapValues(deliveryAttempts),
      deliveries: cloneMapValues(deliveries),
      auditEvents: structuredClone(auditEvents)
    };
  }

  return {
    now,
    claimInbound,
    readCandidate,
    updateCandidate,
    persistOutbound,
    readOutbound,
    hasDelivery,
    deliverOutbound,
    snapshot
  };
}
