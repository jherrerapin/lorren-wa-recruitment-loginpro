import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBotKnowledgeForPrompt,
  loadBotKnowledgeForContext,
  normalizeKnowledgeContent,
  normalizeKnowledgeScope
} from '../src/services/botKnowledge.js';

test('normalizeKnowledgeScope solo permite alcances soportados', () => {
  assert.equal(normalizeKnowledgeScope('vacancy'), 'VACANCY');
  assert.equal(normalizeKnowledgeScope('candidate'), 'CANDIDATE');
  assert.equal(normalizeKnowledgeScope('otro'), 'GLOBAL');
});

test('normalizeKnowledgeContent compacta espacios y conserva líneas útiles', () => {
  assert.equal(normalizeKnowledgeContent('  regla   uno \n\n regla dos  '), 'regla uno\nregla dos');
});

test('loadBotKnowledgeForContext usa únicamente filas key/value de conocimiento conversacional', async () => {
  const calls = [];
  const prisma = {
    botKnowledge: {
      findMany(args) {
        calls.push(args);
        return Promise.resolve([
          {
            id: 'knowledge-global',
            key: 'recruitment:knowledge:global:1',
            value: JSON.stringify({ scope: 'GLOBAL', content: 'No repetir frases.', tags: ['tono'] }),
            updatedAt: new Date('2026-09-22T12:00:00.000Z')
          },
          {
            id: 'knowledge-vacancy',
            key: 'recruitment:knowledge:vacancy:vac2:1',
            value: JSON.stringify({ scope: 'VACANCY', vacancyId: 'vac2', content: 'Usar ubicación vigente.' }),
            updatedAt: new Date('2026-09-22T11:00:00.000Z')
          },
          {
            id: 'dispatch-marker',
            key: 'dispatch:test-reset-marker',
            value: JSON.stringify({ resetId: 'reset-1' }),
            updatedAt: new Date('2026-09-22T10:00:00.000Z')
          }
        ]);
      }
    }
  };

  const entries = await loadBotKnowledgeForContext(prisma, {
    candidate: { id: 'cand1', vacancyId: 'vac1' },
    vacancy: { id: 'vac2' },
    limit: 4
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].scope, 'GLOBAL');
  assert.equal(entries[1].scope, 'VACANCY');
  assert.deepEqual(calls[0].where, { key: { startsWith: 'recruitment:knowledge:' } });
  assert.deepEqual(calls[0].select, { id: true, key: true, value: true, updatedAt: true });
  assert.equal(Object.hasOwn(calls[0].where, 'isActive'), false);
});

test('loadBotKnowledgeForContext descarta conocimiento de otro candidato o vacante', async () => {
  const prisma = {
    botKnowledge: {
      findMany() {
        return Promise.resolve([
          {
            id: 'other-vacancy',
            key: 'recruitment:knowledge:vacancy:other:1',
            value: JSON.stringify({ scope: 'VACANCY', vacancyId: 'other', content: 'No aplica.' }),
            updatedAt: new Date()
          },
          {
            id: 'candidate',
            key: 'recruitment:knowledge:candidate:cand1:1',
            value: JSON.stringify({ scope: 'CANDIDATE', candidateId: 'cand1', content: 'Contexto puntual.' }),
            updatedAt: new Date()
          }
        ]);
      }
    }
  };

  const entries = await loadBotKnowledgeForContext(prisma, {
    candidate: { id: 'cand1' },
    vacancy: { id: 'vac2' }
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, 'CANDIDATE');
});

test('formatBotKnowledgeForPrompt no convierte aprendizajes en plantilla literal', () => {
  const text = formatBotKnowledgeForPrompt([
    { scope: 'GLOBAL', tags: 'tono', content: 'Si solo agradece, no insistir.' }
  ]);
  assert.match(text, /alcance=GLOBAL/);
  assert.match(text, /memoria contextual prioritaria/);
  assert.match(text, /sin copiarlo literal/);
  assert.match(text, /Si solo agradece/);
});
