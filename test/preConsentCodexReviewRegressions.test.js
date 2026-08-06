import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import {
  APPLICATION_INTEREST_PENDING_MODE,
  dataConsentGateMiddleware,
  evaluateProfileDataEvidence
} from '../src/services/dataConsentGate.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

const evidenceContext = {
  candidate: {
    vacancyId: 'TEST-CODEX-VACANCY',
    currentStep: 'GREETING_SENT'
  }
};

function hasEvidence(body, field) {
  return evaluateProfileDataEvidence(body, evidenceContext)
    .evidence
    .some((item) => item.field === field);
}

test('TEST-CODEX-DOCUMENT-LABELS: protege documentos explícitos sin separador', () => {
  for (const body of [
    'Cédula 1012345678',
    'Mi cédula 1012345678',
    'Documento 1012345678'
  ]) {
    assert.equal(hasEvidence(body, 'documentNumber'), true, body);
  }
});

test('TEST-CODEX-LOWERCASE-NAME: protege una presentación nominal explícita en minúscula', () => {
  assert.equal(hasEvidence('soy juan pérez', 'fullName'), true);
});

test('TEST-CODEX-NAME-SUFFIXES: conserva nombres que comparten sufijos ocupacionales', () => {
  for (const body of ['Salvador Pérez', 'Rosario Gómez', 'Vicente López']) {
    assert.equal(hasEvidence(body, 'fullName'), true, body);
  }

  for (const body of [
    'Soy administrador logístico de operaciones',
    'Soy administrador logístico retirado',
    'Soy responsable puntual'
  ]) {
    assert.equal(hasEvidence(body, 'fullName'), false, body);
  }
});

test('TEST-CODEX-EXPERIENCE-DECLARATIONS: protege experiencia explícita sin duración', () => {
  for (const body of ['Tengo experiencia en logística', 'No tengo experiencia']) {
    assert.equal(hasEvidence(body, 'experienceInfo'), true, body);
    assert.equal(hasEvidence(body, 'experienceSummary'), true, body);
  }
});

test('TEST-CODEX-MEDICAL-LABELS: protege divulgaciones médicas etiquetadas', () => {
  for (const body of [
    'Restricción médica: diabetes',
    'Condición médica: epilepsia'
  ]) {
    assert.equal(hasEvidence(body, 'medicalRestrictions'), true, body);
  }
});

test('TEST-CODEX-CANONICAL-WRITER-RACE: la escritura verifica ACCEPTED en la fila persistida', async () => {
  const candidate = {
    id: 'TEST-CODEX-CANDIDATE',
    dataConsentStatus: 'ACCEPTED',
    fullName: null
  };
  let directUpdates = 0;
  let guardedUpdates = 0;

  const result = await captureConsentedProfileData({
    prisma: {
      candidate: {
        update: async ({ data }) => {
          directUpdates += 1;
          return { ...candidate, ...data };
        },
        updateMany: async ({ where }) => {
          guardedUpdates += 1;
          assert.equal(where.id, candidate.id);
          assert.equal(where.dataConsentStatus, 'ACCEPTED');
          return { count: 0 };
        },
        findUnique: async () => ({
          ...candidate,
          dataConsentStatus: 'REVOKED'
        })
      }
    },
    candidate,
    currentText: 'Me llamo Nombre de Prueba'
  });

  assert.equal(directUpdates, 0);
  assert.equal(guardedUpdates, 1);
  assert.equal(result.reason, 'consent_changed_before_write');
  assert.deepEqual(result.capturedFields, []);
});

function textMessage(body, id) {
  return {
    id,
    from: 'TEST-CODEX-PHONE',
    type: 'text',
    text: { body }
  };
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesMessageWhere(row, where = {}) {
  if (where.id && row.id !== where.id) return false;
  if (where.candidateId && row.candidateId !== where.candidateId) return false;
  if (where.waMessageId && row.waMessageId !== where.waMessageId) return false;
  if (where.direction && row.direction !== where.direction) return false;
  if (where.body !== undefined && row.body !== where.body) return false;
  if (where.createdAt?.gte && new Date(row.createdAt) < new Date(where.createdAt.gte)) return false;

  if (where.rawPayload?.equals !== undefined
      && !jsonEquals(row.rawPayload, where.rawPayload.equals)) {
    return false;
  }
  return true;
}

function buildIdempotencyHarness({
  seedPending = false,
  failOutboundCreateTimes = 0
} = {}) {
  let candidate = {
    id: 'TEST-CODEX-CANDIDATE',
    phone: 'TEST-CODEX-PHONE',
    status: 'NUEVO',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-CODEX-VACANCY',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false
  };
  let outboundFailuresRemaining = failOutboundCreateTimes;
  const inboundRows = [];
  const outboundRows = [];
  const providerOutbound = [];

  if (seedPending) {
    inboundRows.push({
      id: 'TEST-CODEX-INBOUND-PENDING',
      candidateId: candidate.id,
      waMessageId: 'TEST-CODEX-CONCURRENT',
      direction: 'INBOUND',
      messageType: 'TEXT',
      body: '[REDACTED_PRECONSENT]',
      rawPayload: {
        source: 'data_consent_gate',
        consentGateProcessing: {
          state: 'PENDING',
          decision: 'PREREQUISITE_profile_data_before_consent'
        }
      },
      createdAt: new Date()
    });
  }

  axios.post = async (_url, payload) => {
    providerOutbound.push(payload?.text?.body || '');
    return {
      data: {
        messages: [{ id: `TEST-CODEX-PROVIDER-${providerOutbound.length}` }]
      }
    };
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      findUnique: async () => structuredClone(candidate),
      update: async ({ data }) => {
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async ({ where = {}, data = {} }) => {
        if (where.id && where.id !== candidate.id) return { count: 0 };
        if (where.dataConsentStatus
            && where.dataConsentStatus !== candidate.dataConsentStatus) {
          return { count: 0 };
        }
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      }
    },
    vacancy: {
      findUnique: async () => ({
        id: 'TEST-CODEX-VACANCY',
        title: 'Cargo de Prueba',
        city: 'Neiva',
        isActive: true,
        acceptingApplications: true,
        operation: { city: { name: 'Neiva' } }
      })
    },
    message: {
      findFirst: async ({ where }) => {
        const row = inboundRows.find((item) => matchesMessageWhere(item, where));
        return row ? structuredClone(row) : null;
      },
      createMany: async ({ data }) => {
        const row = {
          id: `TEST-CODEX-INBOUND-${inboundRows.length + 1}`,
          createdAt: new Date(),
          ...structuredClone(data[0])
        };
        if (inboundRows.some((item) => (
          item.candidateId === row.candidateId
          && item.waMessageId === row.waMessageId
        ))) {
          return { count: 0 };
        }
        inboundRows.push(row);
        return { count: 1 };
      },
      create: async ({ data }) => {
        if (outboundFailuresRemaining > 0) {
          outboundFailuresRemaining -= 1;
          throw new Error('TEST-CODEX-OUTBOUND-PERSISTENCE-FAILURE');
        }
        const row = {
          id: `TEST-CODEX-OUTBOUND-${outboundRows.length + 1}`,
          createdAt: new Date(),
          ...structuredClone(data)
        };
        outboundRows.push(row);
        return structuredClone(row);
      },
      findMany: async ({ where = {}, orderBy, take } = {}) => {
        let rows = outboundRows.filter((item) => matchesMessageWhere(item, where));
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
        }
        if (take) rows = rows.slice(0, take);
        return structuredClone(rows);
      },
      findUnique: async ({ where }) => {
        const row = [...inboundRows, ...outboundRows]
          .find((item) => item.id === where.id);
        return row ? structuredClone(row) : null;
      },
      updateMany: async ({ where = {}, data = {} }) => {
        const row = [...inboundRows, ...outboundRows]
          .find((item) => matchesMessageWhere(item, where));
        if (!row) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        const row = [...inboundRows, ...outboundRows]
          .find((item) => item.id === where.id);
        if (!row) throw new Error('TEST-CODEX-MESSAGE-NOT-FOUND');
        Object.assign(row, structuredClone(data));
        return structuredClone(row);
      }
    },
    candidateDataConsentEvent: {
      create: async () => ({ id: 'TEST-CODEX-CONSENT-EVENT' })
    },
    interviewBooking: {
      updateMany: async () => ({ count: 0 })
    }
  };

  return {
    prisma,
    inboundRows,
    outboundRows,
    providerOutbound
  };
}

async function runMiddleware(harness, body, id) {
  const req = {
    body: {
      entry: [{
        changes: [{
          value: {
            messages: [textMessage(body, id)]
          }
        }]
      }]
    },
    headers: {},
    ip: '127.0.0.1'
  };
  const observed = {
    nextCalls: 0,
    statuses: []
  };
  const res = {
    sendStatus: (status) => observed.statuses.push(status)
  };
  await dataConsentGateMiddleware(harness.prisma)(
    req,
    res,
    () => {
      observed.nextCalls += 1;
    }
  );
  return observed;
}

test('TEST-CODEX-ATOMIC-PENDING-CLAIM: dos recuperaciones no adquieren ni responden dos veces', async () => {
  const harness = buildIdempotencyHarness({ seedPending: true });

  await Promise.all([
    runMiddleware(
      harness,
      'Mi cédula es 1012345678',
      'TEST-CODEX-CONCURRENT'
    ),
    runMiddleware(
      harness,
      'Mi cédula es 1012345678',
      'TEST-CODEX-CONCURRENT'
    )
  ]);

  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.providerOutbound.length, 1);
  assert.equal(harness.outboundRows.length, 1);
  assert.equal(
    harness.inboundRows[0].rawPayload?.consentGateProcessing?.state,
    'COMPLETED'
  );
});

test('TEST-CODEX-OUTBOUND-RECOVERY: una falla de persistencia no duplica el envío al reintentar', async () => {
  const harness = buildIdempotencyHarness({
    failOutboundCreateTimes: 1
  });

  const first = await runMiddleware(
    harness,
    'Mi cédula es 1012345678',
    'TEST-CODEX-OUTBOUND-RECOVERY'
  );
  const retry = await runMiddleware(
    harness,
    'Mi cédula es 1012345678',
    'TEST-CODEX-OUTBOUND-RECOVERY'
  );

  assert.deepEqual(first.statuses, [503]);
  assert.deepEqual(retry.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.providerOutbound.length, 1);
  assert.equal(harness.outboundRows.length, 1);
  assert.equal(
    harness.inboundRows[0].rawPayload?.consentGateProcessing?.state,
    'COMPLETED'
  );
});

test('TEST-CODEX-CI-FAILURE-IDENTITIES: la suite completa bloquea identidades no aprobadas', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  );

  assert.match(workflow, /legacy[-_]test[-_]failures|failure[-_]allowlist/i);
  assert.match(workflow, /comm\s+-23|unexpected[-_]failures/i);
  assert.doesNotMatch(
    workflow,
    /if\s+\[\s*"\$fail_count"\s+-gt\s+71\s*\][\s\S]*legacy test failures remain[\s\S]*exit 0/
  );
});
