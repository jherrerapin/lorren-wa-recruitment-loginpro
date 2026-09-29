import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationDecisionExecutionError,
  executeConversationDecision
} from '../src/core/shell/executeConversationDecision.js';

function input(execution = {
  mayReply: true,
  mayPersistCandidate: true,
  maySendOutbound: true
}) {
  return {
    turn: { id: 'turn-1', rawText: 'Ana', receivedAt: '2026-09-23T12:00:00.000Z' },
    candidate: { id: 'candidate-1', facts: { phone: '573001112233' }, updatedAt: null },
    history: { messages: [], lastBotQuestion: '¿Cuál es tu nombre?' },
    pending: { fields: ['fullName', 'city'], actions: [] },
    execution
  };
}

function decision(reply = { directive: 'ASK_FOR_CITY' }) {
  return {
    reply,
    mutations: {
      fieldsToPersist: { fullName: 'Ana Pérez' },
      nextStep: 'COLLECTING_DATA',
      nextStage: null
    },
    transitions: {
      keepCurrentStep: false,
      handoffToHuman: false,
      endConversation: false
    },
    scheduling: { action: 'none' }
  };
}

function dependencies(calls) {
  return {
    prisma: {
      candidate: {
        async update(args) {
          calls.push(['persist', args]);
        }
      }
    },
    llmService: {
      async generateReply(...args) {
        calls.push(['generate', ...args]);
        return '¿En qué ciudad resides?';
      }
    },
    whatsappClient: {
      async sendMessage(...args) {
        calls.push(['deliver', ...args]);
      }
    },
    async automaticOutboundDelivery(_prisma, outbound, adapters) {
      return adapters.sendText(outbound.to, outbound.body);
    }
  };
}

test('ejecuta persistencia, generación y entrega en ese orden', async () => {
  const calls = [];
  const result = await executeConversationDecision(input(), decision(), dependencies(calls));

  assert.deepEqual(calls.map(([phase]) => phase), ['persist', 'generate', 'deliver']);
  assert.deepEqual(calls[0][1], {
    where: { id: 'candidate-1' },
    data: { fullName: 'Ana Pérez', currentStep: 'COLLECTING_DATA' }
  });
  assert.equal(calls[1][1], 'ASK_FOR_CITY');
  assert.deepEqual(calls[1][2].pendingFields, ['city']);
  assert.deepEqual(calls[2].slice(1), ['573001112233', '¿En qué ciudad resides?', []]);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.persistence, { status: 'applied' });
  assert.deepEqual(result.generation, { status: 'generated' });
  assert.deepEqual(result.delivery, { status: 'sent' });
});

test('entrega al LLM los parámetros declarados por la política', async () => {
  const calls = [];
  await executeConversationDecision(
    input(),
    decision({
      directive: 'ASK_MISSING_FIELDS',
      parameters: { missingFields: ['fullName', 'city'] }
    }),
    dependencies(calls)
  );

  assert.deepEqual(calls[1][2].missingFields, ['fullName', 'city']);
});

test('persiste género silenciosamente pero nunca lo expone al redactor', async () => {
  const calls = [];
  const genderInput = input();
  genderInput.pending.fields = ['gender', 'city'];
  const genderDecision = decision({ directive: 'ASK_MISSING_FIELDS' });
  genderDecision.mutations.fieldsToPersist = { gender: 'FEMALE' };

  await executeConversationDecision(genderInput, genderDecision, dependencies(calls));

  assert.equal(calls[0][1].data.gender, 'FEMALE');
  assert.deepEqual(calls[1][2].fieldsToPersist, {});
  assert.deepEqual(calls[1][2].pendingFields, ['city']);
});

test('los textos estrictos se entregan sin llamar al LLM', async () => {
  const calls = [];
  const legalReply = {
    text: 'Texto legal estricto.',
    interactiveOptions: [{ id: 'accept', label: 'Acepto' }]
  };

  const result = await executeConversationDecision(input(), decision(legalReply), dependencies(calls));

  assert.deepEqual(calls.map(([phase]) => phase), ['persist', 'deliver']);
  assert.deepEqual(calls[1].slice(1), [
    '573001112233',
    'Texto legal estricto.',
    [{ id: 'accept', label: 'Acepto' }]
  ]);
  assert.deepEqual(result.generation, { status: 'provided' });
});

test('sanea una alucinación del LLM antes de la entrega durable', async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.llmService.generateReply = async (...args) => {
    calls.push(['generate', ...args]);
    return 'La vacante tiene contrato directo y pagos quincenales.';
  };

  await executeConversationDecision(input(), decision(), deps);

  const deliveredText = calls.find(([phase]) => phase === 'deliver')?.[2];
  assert.ok(deliveredText);
  assert.doesNotMatch(deliveredText, /contrato directo|pagos quincenales/i);
  assert.match(deliveredText, /no puedo confirmar información que no esté registrada/i);
});

test('dryRun no ejecuta ningún efecto secundario', async () => {
  const calls = [];
  const result = await executeConversationDecision(
    input({ mayReply: true, dryRun: true }),
    decision(),
    dependencies(calls)
  );

  assert.deepEqual(calls, []);
  assert.equal(result.dryRun, true);
});

test('mayReply false permite persistir pero bloquea generación y entrega', async () => {
  const calls = [];
  const result = await executeConversationDecision(
    input({ mayReply: false, dryRun: false }),
    decision(),
    dependencies(calls)
  );

  assert.deepEqual(calls.map(([phase]) => phase), ['persist']);
  assert.deepEqual(result.persistence, { status: 'applied' });
  assert.deepEqual(result.generation, { status: 'skipped' });
  assert.deepEqual(result.delivery, { status: 'skipped' });
});

test('los permisos de persistencia y salida restringen cada efecto por separado', async () => {
  const noPersistenceCalls = [];
  const noPersistence = await executeConversationDecision(
    input({ mayReply: true, mayPersistCandidate: false, maySendOutbound: true }),
    decision({ text: 'Mensaje seguro.' }),
    dependencies(noPersistenceCalls)
  );
  assert.deepEqual(noPersistenceCalls.map(([phase]) => phase), ['deliver']);
  assert.deepEqual(noPersistence.persistence, { status: 'skipped' });
  assert.deepEqual(noPersistence.delivery, { status: 'sent' });

  const noOutboundCalls = [];
  const noOutbound = await executeConversationDecision(
    input({ mayReply: true, mayPersistCandidate: true, maySendOutbound: false }),
    decision({ text: 'Mensaje seguro.' }),
    dependencies(noOutboundCalls)
  );
  assert.deepEqual(noOutboundCalls.map(([phase]) => phase), ['persist']);
  assert.deepEqual(noOutbound.persistence, { status: 'applied' });
  assert.deepEqual(noOutbound.generation, { status: 'provided' });
  assert.deepEqual(noOutbound.delivery, { status: 'skipped' });
});

test('un error de persistencia detiene las fases posteriores e identifica la fase', async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.prisma.candidate.update = async () => {
    calls.push(['persist']);
    throw new Error('database unavailable');
  };

  await assert.rejects(
    executeConversationDecision(input(), decision(), deps),
    (error) => error instanceof ConversationDecisionExecutionError
      && error.phase === 'persistence'
      && error.cause?.message === 'database unavailable'
  );
  assert.deepEqual(calls.map(([phase]) => phase), ['persist']);
});

test('un error de generación impide entregar un mensaje vacío', async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.llmService.generateReply = async () => {
    calls.push(['generate']);
    throw new Error('llm unavailable');
  };

  await assert.rejects(
    executeConversationDecision(input(), decision(), deps),
    (error) => error instanceof ConversationDecisionExecutionError
      && error.phase === 'generation'
  );
  assert.deepEqual(calls.map(([phase]) => phase), ['persist', 'generate']);
});

test('un error de WhatsApp se reporta como fallo de entrega', async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.whatsappClient.sendMessage = async () => {
    calls.push(['deliver']);
    throw new Error('provider rejected message');
  };

  await assert.rejects(
    executeConversationDecision(input(), decision({ text: 'Mensaje seguro.' }), deps),
    (error) => error instanceof ConversationDecisionExecutionError
      && error.phase === 'delivery'
  );
  assert.deepEqual(calls.map(([phase]) => phase), ['persist', 'deliver']);
});
