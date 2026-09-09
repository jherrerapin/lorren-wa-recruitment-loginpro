import axios from 'axios';
import { dataConsentGateMiddleware } from '../../src/services/dataConsentGate.js';

const clone = (v) => structuredClone(v);
export function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((part) => matches(row, part));
    if (key === 'AND') return condition.every((part) => matches(row, part));
    let value = row[key] ?? null;
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if (condition.path) value = condition.path.reduce((v, p) => v?.[p], value);
      if ('equals' in condition) return JSON.stringify(value) === JSON.stringify(condition.equals);
      if ('not' in condition) return value !== condition.not;
      if ('in' in condition) return condition.in.includes(value);
      if ('lt' in condition) return value !== null && value < condition.lt;
      if ('lte' in condition) return value !== null && value <= condition.lte;
      if ('gte' in condition) return value !== null && value >= condition.gte;
    }
    return value === (condition ?? null);
  });
}

export function createConsentGateHarness({ candidate: seed = {}, vacancy: vacancySeed = {}, failSend = false } = {}) {
  let candidate = { id: 'TEST-CANDIDATE', phone: 'TEST-PHONE', status: 'NUEVO',
    vacancyId: 'TEST-VACANCY', currentStep: 'GREETING_SENT', botResumeMode: 'awaiting_application_interest',
    botPaused: false, dataConsentStatus: 'PENDING', dataConsentVersion: null, lastOutboundAt: null,
    ...clone(seed) };
  const vacancy = { id: candidate.vacancyId, title: 'Auxiliar de Operación', city: 'Neiva',
    role: 'Auxiliar de Operación', isActive: true, acceptingApplications: true,
    roleDescription: 'Apoyar la operación asignada.', operation: { city: { name: 'Neiva' } }, ...clone(vacancySeed) };
  const messages = [], events = [], sent = [], transactions = [];
  let sequence = 0, tail = Promise.resolve();
  const client = {
    candidate: {
      upsert: async () => clone(candidate),
      findUnique: async () => clone(candidate),
      findMany: async ({ where = {} } = {}) => matches(candidate, where) ? [clone(candidate)] : [],
      update: async ({ data }) => { Object.assign(candidate, clone(data)); return clone(candidate); },
      updateMany: async ({ where, data }) => {
        if (!matches(candidate, where)) return { count: 0 };
        Object.assign(candidate, clone(data)); return { count: 1 };
      }
    },
    vacancy: { findUnique: async () => clone(vacancy), findFirst: async () => null },
    candidateDataConsentEvent: { create: async ({ data }) => {
      const event = { id: `TEST-EVENT-${events.length}`, ...clone(data) }; events.push(event); return clone(event);
    } },
    interviewBooking: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    message: {
      findFirst: async ({ where }) => clone(messages.find((row) => matches(row, where)) || null),
      findUnique: async ({ where }) => clone(messages.find((row) => matches(row, where)) || null),
      findMany: async ({ where = {}, orderBy, take } = {}) => {
        let found = messages.filter((row) => matches(row, where));
        if (orderBy?.createdAt === 'desc') found = [...found].reverse();
        return clone(found.slice(0, take || found.length));
      },
      create: async ({ data }) => {
        const row = { id: `TEST-ROW-${++sequence}`, createdAt: new Date(), ...clone(data) };
        messages.push(row); return clone(row);
      },
      createMany: async ({ data }) => {
        let count = 0;
        for (const row of data) {
          if (row.waMessageId && messages.some((m) => m.waMessageId === row.waMessageId)) continue;
          await client.message.create({ data: row }); count++;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const row = messages.find((m) => matches(m, where));
        if (!row) throw new Error('TEST-message-not-found'); Object.assign(row, clone(data)); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        const found = messages.filter((m) => matches(m, where));
        for (const row of found) Object.assign(row, clone(data)); return { count: found.length };
      }
    }
  };
  const prisma = { ...client, $transaction: (fn, options) => {
    transactions.push(options);
    const run = async () => {
      const snapshot = clone({ candidate, messages, events });
      try { return await fn(client); } catch (error) {
        candidate = snapshot.candidate; messages.splice(0, messages.length, ...snapshot.messages);
        events.splice(0, events.length, ...snapshot.events); throw error;
      }
    };
    const current = tail.then(run, run); tail = current.catch(() => {}); return current;
  } };
  axios.post = async (_url, payload) => {
    sent.push(clone(payload));
    if (failSend) throw new Error('TEST-provider-timeout');
    return { data: { messages: [{ id: `TEST-PROVIDER-${sent.length}` }] } };
  };
  const run = async (message) => {
    const req = { body: { entry: [{ changes: [{ value: { messages: [clone(message)] } }] }] }, headers: {} };
    const result = { status: null, next: 0 };
    await dataConsentGateMiddleware(prisma)(req, { sendStatus: (s) => { result.status = s; } }, () => { result.next++; });
    return result;
  };
  return { prisma, messages, events, sent, transactions, run, getCandidate: () => clone(candidate) };
}
