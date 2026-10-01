import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../src/workers/jobWorker.js';
import { JOB_TYPES } from '../src/services/jobQueue.js';

function harness({ acquired = true, candidateOverrides = {} } = {}) {
  const calls = [];
  const prisma = {
    name: 'prisma',
    candidate: {
      async findUnique() {
        calls.push(['loadPending']);
        return {
          id: 'candidate-1',
          dataConsentStatus: 'PENDING',
          recruitmentCity: null,
          recruitmentRole: null,
          locality: 'Ibagué',
          neighborhood: 'El Salado',
          vacancyId: null,
          vacancy: null,
          ...candidateOverrides
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
        extractedFields: {
          recruitmentCity: context.candidateCity || 'Ibagué',
          recruitmentRole: context.candidateRole || 'Cargue y Descargue',
          vacancyId: 'vac-1'
        }
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

test('el worker procesa un mensaje entrante mediante el pipeline completo sin releer historial', async () => {
  const h = harness();
  const payload = { messageId: 'wamid.1', from: '573001112233', type: 'text', text: 'Hola' };
  await runJob({ type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE, payload }, h.dependencies);
  assert.deepEqual(h.calls.map((entry) => entry[0]), [
    'acquire', 'loadPending', 'loadVacancies',
    'extract', 'build', 'calculate', 'execute'
  ]);
  assert.deepEqual(h.calls[0].slice(1), ['wamid.1', { prisma: h.prisma }]);
  assert.deepEqual(h.calls[3][1], 'Hola');
  assert.deepEqual(h.calls[3][2], ['recruitmentCity', 'recruitmentRole', 'vacancyId']);
  assert.deepEqual(h.calls[3][3].candidateSummary, {
    city: null,
    role: null,
    locality: 'Ibagué',
    neighborhood: 'El Salado',
    vacancyId: null
  });
  assert.equal(h.calls[3][3].candidateCity, null);
  assert.equal(h.calls[3][3].candidateRole, null);
  assert.equal(h.calls[3][3].activeVacancies[0].id, 'vac-1');
  assert.deepEqual(h.calls[4].slice(1), [{
    ...payload,
    resolvedVacancy: {
      id: 'vac-1', role: 'Cargue y Descargue', title: 'Auxiliar de bodega',
      city: 'Ibagué', isActive: true, acceptingApplications: true
    },
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      extractedFields: {
        recruitmentCity: 'Ibagué',
        recruitmentRole: 'Cargue y Descargue',
        vacancyId: 'vac-1'
      }
    }
  }, { prisma: h.prisma }]);
  assert.equal(h.calls[5][1], h.input);
  assert.deepEqual(h.calls[6].slice(1), [h.input, h.decision, {
    prisma: h.prisma, llmService: h.llmService, whatsappClient: h.whatsappClient
  }]);
});

test('usa la ciudad persistida del candidato para resolver el cargo siguiente', async () => {
  const h = harness({ candidateOverrides: { recruitmentCity: 'Ibagué' } });
  const payload = {
    messageId: 'wamid.role-after-city',
    from: '573001112233',
    type: 'text',
    text: 'Auxiliar de cargue y descargue'
  };

  await runJob({ type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE, payload }, h.dependencies);

  const extraction = h.calls.find(([name]) => name === 'extract');
  assert.equal(extraction[3].candidateCity, 'Ibagué');
  assert.equal(extraction[3].candidateRole, null);
  const build = h.calls.find(([name]) => name === 'build');
  assert.equal(build[1].resolvedVacancy.id, 'vac-1');
});

test('usa el cargo persistido del candidato para resolver la ciudad siguiente', async () => {
  const h = harness({ candidateOverrides: { recruitmentRole: 'Cargue y Descargue' } });
  await runJob({
    type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
    payload: {
      messageId: 'wamid.city-after-role',
      from: '573001112233',
      type: 'text',
      text: 'Estoy en Ibagué'
    }
  }, h.dependencies);

  const extraction = h.calls.find(([name]) => name === 'extract');
  assert.equal(extraction[3].candidateCity, null);
  assert.equal(extraction[3].candidateRole, 'Cargue y Descargue');
});

test('una localidad no se reutiliza como si fuera la ciudad de reclutamiento', async () => {
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
