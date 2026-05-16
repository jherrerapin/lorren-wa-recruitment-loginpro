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

test('loadBotKnowledgeForContext consulta memoria global, vacante y candidato', async () => {
  const calls = [];
  const prisma = {
    botKnowledge: {
      findMany(args) {
        calls.push(args);
        return Promise.resolve([{ scope: 'GLOBAL', content: 'No repetir frases.' }]);
      }
    }
  };

  const entries = await loadBotKnowledgeForContext(prisma, {
    candidate: { id: 'cand1', vacancyId: 'vac1' },
    vacancy: { id: 'vac2' },
    limit: 4
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(calls[0].where.OR, [
    { scope: 'GLOBAL' },
    { scope: 'VACANCY', vacancyId: 'vac2' },
    { scope: 'CANDIDATE', candidateId: 'cand1' }
  ]);
  assert.equal(calls[0].take, 4);
});

test('formatBotKnowledgeForPrompt no convierte aprendizajes en plantilla literal', () => {
  const text = formatBotKnowledgeForPrompt([
    { scope: 'GLOBAL', tags: 'tono', content: 'Si solo agradece, no insistir.' }
  ]);
  assert.match(text, /alcance=GLOBAL/);
  assert.match(text, /Si solo agradece/);
});
