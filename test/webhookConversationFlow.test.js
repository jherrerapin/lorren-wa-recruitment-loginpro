import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { webhookRouter } from '../src/routes/webhook.js';

const MessageDirection = { INBOUND: 'INBOUND', OUTBOUND: 'OUTBOUND' };
const MessageType = { TEXT: 'TEXT', DOCUMENT: 'DOCUMENT' };

function getPostHandler(router) {
  return router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post)?.route?.stack?.[0]?.handle;
}

function createPrismaMock(initialCandidate = {}) {
  const candidate = {
    id: 'cand-1',
    phone: '573001112233',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    multilineBatchVersion: 0,
    multilineWindowUntil: null,
    ...initialCandidate
  };
  const messages = [];

  const prisma = {
    candidate: {
      async upsert() { return candidate; },
      async findUnique() { return { ...candidate }; },
      async update({ data }) {
        Object.assign(candidate, data);
        if (data.multilineBatchVersion?.increment) {
          candidate.multilineBatchVersion += data.multilineBatchVersion.increment;
        }
        return { ...candidate };
      },
      async updateMany({ where, data }) {
        if (where.multilineBatchVersion !== undefined && where.multilineBatchVersion !== candidate.multilineBatchVersion) return { count: 0 };
        if (data.multilineBatchVersion?.increment) {
          candidate.multilineBatchVersion += data.multilineBatchVersion.increment;
          const cloned = { ...data };
          delete cloned.multilineBatchVersion;
          Object.assign(candidate, cloned);
        } else {
          Object.assign(candidate, data);
        }
        return { count: 1 };
      }
    },
    message: {
      async createMany({ data }) {
        const row = { id: `m-${messages.length + 1}`, createdAt: new Date(), respondedAt: null, ...data[0] };
        messages.push(row);
        return { count: 1 };
      },
      async create({ data }) {
        messages.push({ id: `m-${messages.length + 1}`, createdAt: new Date(), respondedAt: null, ...data });
        return { id: `m-${messages.length}` };
      },
      async findUnique({ where }) {
        if (where.waMessageId) return messages.find((m) => m.waMessageId === where.waMessageId) || null;
        if (where.id) return messages.find((m) => m.id === where.id) || null;
        return null;
      },
      async findMany({ where, orderBy, take }) {
        let rows = [...messages];
        if (where?.candidateId) rows = rows.filter((m) => m.candidateId === where.candidateId);
        if (where?.direction) rows = rows.filter((m) => m.direction === where.direction);
        if (where?.messageType) rows = rows.filter((m) => m.messageType === where.messageType);
        if (where?.respondedAt === null) rows = rows.filter((m) => m.respondedAt === null);
        rows.sort((a, b) => orderBy?.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
        return rows.slice(0, take || rows.length);
      },
      async update({ where, data }) {
        const idx = messages.findIndex((m) => m.id === where.id);
        if (idx >= 0) messages[idx] = { ...messages[idx], ...data };
        return messages[idx];
      },
      async updateMany({ where, data }) {
        for (const m of messages) {
          if (where?.id?.in?.includes(m.id)) Object.assign(m, data);
        }
        return { count: where?.id?.in?.length || 0 };
      }
    }
  };

  return { prisma, candidate, messages };
}

async function invokeWebhook(handler, body) {
  let status = null;
  await handler(
    { body },
    { sendStatus(code) { status = code; return code; } },
    (error) => { if (error) throw error; }
  );
  return status;
}

test('webhook respeta edad vs experiencia y transporte negativo', async (t) => {
  const { prisma, candidate, messages } = createPrismaMock({ currentStep: 'GREETING_SENT' });
  const router = webhookRouter(prisma);
  const handler = getPostHandler(router);

  const originalPost = axios.post;
  const outbound = [];
  axios.post = async (_url, payload) => {
    outbound.push(payload.text.body);
    return { data: { ok: true } };
  };
  t.after(() => { axios.post = originalPost; });

  const status = await invokeWebhook(handler, {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid-1', from: candidate.phone, type: 'text', text: { body: 'edad 22 años, no tengo experiencia y no tengo moto, barrio jordan' } }] } }] }]
  });

  assert.equal(status, 200);
  assert.equal(candidate.age, 22);
  assert.equal(candidate.experienceInfo, 'No');
  assert.equal(candidate.experienceTime, '0');
  assert.equal(candidate.transportMode, 'Sin medio de transporte');
  assert.equal(outbound.length, 1);
  const outboundMessage = messages.find((item) => item.direction === MessageDirection.OUTBOUND);
  assert.equal(outboundMessage?.rawPayload?.source, 'bot_flow');
});

test('DONE responde ack breve una sola vez ante ok gracias', async (t) => {
  const { prisma, candidate } = createPrismaMock({ currentStep: 'DONE', status: 'REGISTRADO' });
  const router = webhookRouter(prisma);
  const handler = getPostHandler(router);

  const originalPost = axios.post;
  const outbound = [];
  axios.post = async (_url, payload) => { outbound.push(payload.text.body); return { data: { ok: true } }; };
  t.after(() => { axios.post = originalPost; });

  await invokeWebhook(handler, { entry: [{ changes: [{ value: { messages: [{ id: 'wamid-2', from: candidate.phone, type: 'text', text: { body: 'ok gracias' } }] } }] }] });
  await invokeWebhook(handler, { entry: [{ changes: [{ value: { messages: [{ id: 'wamid-3', from: candidate.phone, type: 'text', text: { body: 'ok gracias' } }] } }] }] });

  assert.equal(outbound.length, 1);
  assert.match(outbound[0], /registro completo/i);
});

test('multiline evita respuestas redundantes en correcciones encadenadas', async (t) => {
  const { prisma, candidate } = createPrismaMock({
    currentStep: 'CONFIRMING_DATA',
    fullName: 'Ana Lopez', documentType: 'CC', documentNumber: '12345678', age: 25,
    neighborhood: 'Picalena', experienceInfo: 'Sí', experienceTime: '1 año', medicalRestrictions: 'Sin restricciones médicas', transportMode: 'Moto'
  });
  const router = webhookRouter(prisma);
  const handler = getPostHandler(router);

  const originalPost = axios.post;
  const outbound = [];
  axios.post = async (_url, payload) => { outbound.push(payload.text.body); return { data: { ok: true } }; };
  t.after(() => { axios.post = originalPost; });

  await invokeWebhook(handler, { entry: [{ changes: [{ value: { messages: [{ id: 'wamid-4', from: candidate.phone, type: 'text', text: { body: 'barrio jordan' } }] } }] }] });
  await invokeWebhook(handler, { entry: [{ changes: [{ value: { messages: [{ id: 'wamid-5', from: candidate.phone, type: 'text', text: { body: 'y todo está correcto' } }] } }] }] });

  assert.equal(outbound.length, 1);
  assert.equal(candidate.currentStep, 'ASK_CV');
});

test('si ya está registrado y envía HV de nuevo, responde mensaje contextual corto', async (t) => {
  const { prisma, candidate } = createPrismaMock({ currentStep: 'DONE', status: 'REGISTRADO' });
  const router = webhookRouter(prisma);
  const handler = getPostHandler(router);

  const originalPost = axios.post;
  const outbound = [];
  axios.post = async (_url, payload) => { outbound.push(payload.text.body); return { data: { ok: true } }; };
  t.after(() => { axios.post = originalPost; });

  await invokeWebhook(handler, {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid-6', from: candidate.phone, type: 'document', document: { id: 'doc-1', mime_type: 'application/pdf', filename: 'hv.pdf' } }] } }] }]
  });

  assert.equal(outbound.length, 1);
  assert.match(outbound[0], /actualizar tu hoja de vida/i);
  assert.doesNotMatch(outbound[0], /entrevistas estan previstas/i);
});
