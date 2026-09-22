import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBotKnowledgeEntry,
  deleteBotKnowledgeEntry,
  formatBotKnowledgeForPrompt,
  listBotKnowledgeEntries,
  loadBotKnowledgeForContext,
  normalizeKnowledgeContent,
  normalizeKnowledgeScope,
  setBotKnowledgeActive,
  updateBotKnowledgeEntry
} from '../src/services/botKnowledge.js';

test('normalizeKnowledgeScope solo permite alcances soportados', () => {
  assert.equal(normalizeKnowledgeScope('vacancy'), 'VACANCY');
  assert.equal(normalizeKnowledgeScope('candidate'), 'CANDIDATE');
  assert.equal(normalizeKnowledgeScope('otro'), 'GLOBAL');
});

test('normalizeKnowledgeContent compacta espacios y conserva líneas útiles', () => {
  assert.equal(normalizeKnowledgeContent('  regla   uno \n\n regla dos  '), 'regla uno\nregla dos');
});

test('loadBotKnowledgeForContext usa exclusivamente el contrato Prisma key/value', async () => {
  const calls = [];
  const prisma = {
    botKnowledge: {
      findMany(args) {
        calls.push(args);
        return Promise.resolve([
          {
            id: 'k1',
            key: 'recruitment:knowledge:global:1',
            value: JSON.stringify({
              scope: 'GLOBAL',
              content: 'No repetir frases.',
              tags: 'tono',
              isActive: true
            }),
            updatedAt: new Date('2026-09-22T12:00:00Z')
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

  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, 'GLOBAL');
  assert.equal(entries[0].content, 'No repetir frases.');
  assert.deepEqual(calls[0].where, {
    key: { startsWith: 'recruitment:knowledge:' }
  });
  assert.deepEqual(calls[0].select, {
    id: true,
    key: true,
    value: true,
    updatedAt: true
  });
  assert.equal(calls[0].take, 16);
});

test('loadBotKnowledgeForContext filtra alcance, inactivos y filas ajenas al conocimiento de reclutamiento', async () => {
  const prisma = {
    botKnowledge: {
      findMany: async () => [
        {
          id: 'global',
          key: 'recruitment:knowledge:global:1',
          value: JSON.stringify({ scope: 'GLOBAL', content: 'Regla global.' })
        },
        {
          id: 'vacancy-match',
          key: 'recruitment:knowledge:vacancy:1',
          value: JSON.stringify({ scope: 'VACANCY', vacancyId: 'vac2', content: 'Regla vacante.' })
        },
        {
          id: 'vacancy-other',
          key: 'recruitment:knowledge:vacancy:2',
          value: JSON.stringify({ scope: 'VACANCY', vacancyId: 'vac9', content: 'Otra vacante.' })
        },
        {
          id: 'candidate-match',
          key: 'recruitment:knowledge:candidate:1',
          value: JSON.stringify({ scope: 'CANDIDATE', candidateId: 'cand1', content: 'Regla candidato.' })
        },
        {
          id: 'inactive',
          key: 'recruitment:knowledge:global:2',
          value: JSON.stringify({ scope: 'GLOBAL', content: 'No usar.', isActive: false })
        },
        {
          id: 'foreign',
          key: 'dispatch:test-reset-marker',
          value: JSON.stringify({ scope: 'GLOBAL', content: 'Nunca debe entrar al prompt.' })
        }
      ]
    }
  };

  const entries = await loadBotKnowledgeForContext(prisma, {
    candidate: { id: 'cand1', vacancyId: 'vac1' },
    vacancy: { id: 'vac2' },
    limit: 8
  });

  assert.deepEqual(entries.map((entry) => entry.id), ['global', 'vacancy-match', 'candidate-match']);
});

test('crear aprendizaje serializa metadatos dentro de value sin inventar columnas Prisma', async () => {
  let createArgs = null;
  const prisma = {
    botKnowledge: {
      create: async (args) => {
        createArgs = args;
        return {
          id: 'k-new',
          key: args.data.key,
          value: args.data.value,
          updatedAt: new Date('2026-09-22T12:00:00Z')
        };
      }
    }
  };

  const entry = await createBotKnowledgeEntry(prisma, {
    scope: 'VACANCY',
    vacancyId: 'vac-1',
    content: '  Regla   curada  ',
    tags: 'tono',
    createdBy: 'dev'
  });

  assert.match(createArgs.data.key, /^recruitment:knowledge:vacancy:/);
  assert.deepEqual(Object.keys(createArgs.data).sort(), ['key', 'value']);
  assert.equal(entry.scope, 'VACANCY');
  assert.equal(entry.vacancyId, 'vac-1');
  assert.equal(entry.content, 'Regla curada');
  assert.equal(entry.createdBy, 'dev');
});

test('actualizar y pausar aprendizaje preserva key y modifica solo value', async () => {
  const stored = {
    id: 'k1',
    key: 'recruitment:knowledge:global:1',
    value: JSON.stringify({
      scope: 'GLOBAL',
      content: 'Regla original.',
      tags: null,
      isActive: true,
      createdBy: 'dev-original',
      updatedBy: 'dev-original'
    }),
    updatedAt: new Date('2026-09-22T12:00:00Z')
  };
  const updates = [];
  const prisma = {
    botKnowledge: {
      findUnique: async () => stored,
      update: async (args) => {
        updates.push(args);
        return { ...stored, value: args.data.value, updatedAt: new Date('2026-09-22T13:00:00Z') };
      }
    }
  };

  const updated = await updateBotKnowledgeEntry(prisma, 'k1', {
    content: 'Regla actualizada.',
    updatedBy: 'dev-nuevo'
  });
  assert.equal(updated.content, 'Regla actualizada.');
  assert.equal(updated.createdBy, 'dev-original');
  assert.equal(updated.updatedBy, 'dev-nuevo');
  assert.deepEqual(Object.keys(updates[0].data), ['value']);

  const paused = await setBotKnowledgeActive(prisma, 'k1', false, 'dev-nuevo');
  assert.equal(paused.isActive, false);
  assert.deepEqual(Object.keys(updates[1].data), ['value']);
});

test('listado y borrado ignoran filas fuera del namespace de reclutamiento', async () => {
  let deletedId = null;
  const validRow = {
    id: 'k1',
    key: 'recruitment:knowledge:global:1',
    value: JSON.stringify({ scope: 'GLOBAL', content: 'Regla.', isActive: true }),
    updatedAt: new Date('2026-09-22T12:00:00Z')
  };
  const prisma = {
    botKnowledge: {
      findMany: async () => [validRow, { id: 'foreign', key: 'other:key', value: '{}' }],
      findUnique: async ({ where }) => where.id === 'k1' ? validRow : null,
      delete: async ({ where }) => {
        deletedId = where.id;
        return validRow;
      }
    }
  };

  const entries = await listBotKnowledgeEntries(prisma);
  assert.deepEqual(entries.map((entry) => entry.id), ['k1']);
  await deleteBotKnowledgeEntry(prisma, 'k1');
  assert.equal(deletedId, 'k1');
  await assert.rejects(() => deleteBotKnowledgeEntry(prisma, 'foreign'), /bot_knowledge_not_found/);
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
