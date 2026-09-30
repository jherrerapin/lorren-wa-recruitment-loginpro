import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../src/workers/jobWorker.js';
import { JOB_TYPES } from '../src/services/jobQueue.js';

function harness({ acquired = true, recentMessages = [] } = {}) {
  const calls = [];
  const prisma = {
    name: 'prisma',
    candidate: {
      async findUnique() {
        calls.push(['loadPending']);
        return {
          id: 'candidate-1',
          dataConsentStatus: 'PENDING',
          locality: 'Ibagué',
          neighborhood: 'El Salado',
          vacancyId: null
        };
      }
    },
    vacancy: {
      async findMany(query) {
        calls.push(['loadVacancies', query]);
        return [{
          id: 'vac-1', role: 'Cargue y Descargue', title: 'Auxiliar de bodega',
          city: 'Ibagué', isActive: true, acceptingApplications: true
        }];
      }
    },
    message: {
      async findMany(query) {
        calls.push(['loadRecentInbound', query]);
        return recentMessages;
      }
    }
  };
  const llmService = { name: 'llm' };
  const whatsappClient = { name: 'whatsapp' };
  const input = { candidate: { id: 'candidate-1' } };
  const decision = { reply: null };
  const dependencies = {
    prisma, llmService, whatsappClient,
    async acquireMessageLock(messageId, receivedDependencies) {
      calls.push(['acquire', messageId, receivedDependencies]); return acquired;
    },
    async releaseMessageLock(messageId, receivedDependencies) {
      calls.push(['release', messageId, receivedDependencies]);
    },
    async extractCandidateData(text, pendingFields, context) {
      calls.push(['extract', text, pendingFields, context]);
      return {
        intent: 'PROVIDE_CANDIDATE_DATA',
        extractedFields: { gender: 'FEMALE', vacancyId: 'vac-1' }
      };
    },
    async buildConversationTurnInput(payload, receivedDependencies) {
      calls.push(['build', payload, receivedDependencies]); return input;
    },
    async calculateConversationDecision(receivedInput) {
      calls.push(['calculate', receivedInput]); return decision;
    },
    async executeConversationDecision(receivedInput, receivedDecision, receivedDependencies) {
      calls.push(['execute', receivedInput, receivedDecision, receivedDependencies]);
    }
  };
  return { calls, dependencies, prisma, llmService, whatsappClient, input, decision };
}

test('el worker procesa un mensaje entrante mediante el pipeline completo', async () => {
  const h = harness();
  const payload = { messageId: 'wamid.1', from: '573001112233', type: 'text', text: 'Hola' };
  await runJob({ type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE, payload }, h.dependencies);
  assert.deepEqual(h.calls.map((entry) => entry[0]), [
    'acquire', 'loadPending', 'loadVacancies', 'loadRecentInbound',
    'extract', 'build', 'calculate', 'execute'
  ]);
  assert.deepEqual(h.calls[0].slice(1), ['wamid.1', { prisma: h.prisma }]);
  assert.deepEqual(h.calls[4][1], 'Hola');
  assert.deepEqual(h.calls[4][2], ['dataConsent']);
  assert.deepEqual(h.calls[4][3].candidateSummary, {
    city: null,
    locality: 'Ibagué',
    neighborhood: 'El Salado',
    vacancyId: null
  });
  assert.equal(h.calls[4][3].candidateCity, null);
  assert.equal(h.calls[4][3].activeVacancies[0].id, 'vac-1');
  assert.deepEqual(h.calls[5].slice(1), [{
    ...payload,
    resolvedVacancy: {
      id: 'vac-1', role: 'Cargue y Descargue', title: 'Auxiliar de bodega',
      city: 'Ibagué', isActive: true, acceptingApplications: true
    },
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      extractedFields: { gender: 'FEMALE', vacancyId: 'vac-1' }
    }
  }, { prisma: h.prisma }]);
  assert.equal(h.calls[6][1], h.input);
  assert.deepEqual(h.calls[7].slice(1), [h.input, h.decision, {
    prisma: h.prisma, llmService: h.llmService, whatsappClient: h.whatsappClient
  }]);
});

test('conserva la ciudad explícita de un turno reciente para resolver el cargo siguiente', async () => {
  const h = harness({ recentMessages: [{ body: 'Estoy en Ibagué' }] });
  const payload = {
    messageId: 'wamid.role-after-city',
    from: '573001112233',
    type: 'text',
    text: 'Auxiliar de cargue y descargue'
  };

  await runJob({ type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE, payload }, h.dependencies);

  const extraction = h.calls.find(([name]) => name === 'extract');
  assert.equal(extraction[3].candidateCity, 'Ibagué');
  const build = h.calls.find(([name]) => name === 'build');
  assert.equal(build[1].resolvedVacancy.id, 'vac-1');
});

test('una localidad no se reutiliza como si fuera la ciudad de la vacante', async () => {
  const h = harness();
  await runJob({
    type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
    payload: {
      messageId: 'wamid.locality-is-not-city',
      from: '573001112233',
      type: 'text',
      text: 'Auxiliar de cargue y descargue'
    }
  }, h.dependencies);

  const extraction = h.calls.find(([name]) => name === 'extract');
  assert.equal(extraction[3].candidateCity, null);
});

test('un messageId ya adquirido detiene el pipeline silenciosamente', async () => {
  const h = harness({ acquired: false });
  await runJob({
    type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
    payload: { messageId: 'wamid.duplicate' }
  }, h.dependencies);
  assert.deepEqual(h.calls.map((entry) => entry[0]), ['acquire']);
});

test('un fallo libera el candado para que el trabajo durable pueda reintentarse', async () => {
  const h = harness();
  h.dependencies.calculateConversationDecision = async () => {
    throw new Error('temporary_engine_failure');
  };

  await assert.rejects(
    runJob({
      type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
      payload: { messageId: 'wamid.retry', from: '573001112233', type: 'text', text: 'Hola' }
    }, h.dependencies),
    /temporary_engine_failure/
  );

  const release = h.calls.find(([name]) => name === 'release');
  assert.deepEqual(release.slice(1), ['wamid.retry', { prisma: h.prisma }]);
});

test('un evento de sistema omite NLU y entra directamente al constructor', async () => {
  const h = harness();
  const payload = {
    messageId: 'system:interview:booking-1',
    from: '573001112233',
    type: 'system',
    isSystemAction: true,
    intent: 'INTERVIEW_REMINDER'
  };

  await runJob({ type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE, payload }, h.dependencies);

  assert.deepEqual(h.calls.map(([name]) => name), ['acquire', 'build', 'calculate', 'execute']);
  assert.deepEqual(h.calls[1].slice(1), [payload, { prisma: h.prisma }]);
});