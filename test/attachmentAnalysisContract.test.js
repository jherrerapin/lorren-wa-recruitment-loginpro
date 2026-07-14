import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeCandidateCv, parseCvAnalysisEvidence } from '../src/services/cvIntelligence.js';

function createPrismaForCandidate(candidate) {
  const created = [];
  return {
    created,
    candidate: {
      findUnique: async () => candidate
    },
    attachmentAnalysis: {
      create: async ({ data }) => {
        created.push(data);
        return {
          id: 'analysis-test-1',
          analysedAt: new Date('2026-07-14T12:00:00.000Z'),
          ...data
        };
      }
    }
  };
}

test('un archivo DOC heredado persiste un análisis no exitoso con campos reales de Prisma', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const candidate = {
    id: 'candidate-test-attachment-1',
    phone: 'TEST-PHONE-1',
    fullName: 'Persona Prueba',
    documentNumber: 'TEST-DOC-1',
    locality: 'Zona Prueba',
    cvData: Buffer.from('legacy word bytes'),
    cvStorageKey: null,
    cvOriginalName: 'hoja-de-vida.doc',
    cvMimeType: 'application/msword',
    vacancy: null
  };
  const prisma = createPrismaForCandidate(candidate);

  try {
    const result = await analyzeCandidateCv(prisma, candidate.id);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported_file_type');
    assert.equal(prisma.created.length, 1);

    const persisted = prisma.created[0];
    assert.deepEqual(Object.keys(persisted).sort(), [
      'candidateId',
      'classification',
      'confidence',
      'extractedText',
      'mimeType',
      'modelUsed',
      'originalName',
      'rawResponse',
      'summary'
    ]);
    assert.equal(persisted.candidateId, candidate.id);
    assert.equal(persisted.originalName, 'hoja-de-vida.doc');
    assert.equal(persisted.mimeType, 'application/msword');
    assert.equal(persisted.classification, 'OTHER');
    assert.equal(persisted.confidence, 0);
    assert.match(persisted.summary, /PDF o DOCX/i);
    assert.equal(persisted.rawResponse.stage, 'text_extraction');
    assert.equal(persisted.rawResponse.reason, 'unsupported_file_type');
    assert.equal(Object.hasOwn(persisted, 'evidence'), false);
    assert.equal(Object.hasOwn(persisted, 'fileName'), false);
    assert.equal(Object.hasOwn(persisted, 'createdAt'), false);
  } finally {
    if (previousApiKey) process.env.OPENAI_API_KEY = previousApiKey;
    else delete process.env.OPENAI_API_KEY;
  }
});

test('la evidencia se lee desde rawResponse y conserva compatibilidad con registros antiguos', () => {
  const current = { rawResponse: { extracted: { fullName: 'Persona Prueba' }, mismatches: [] } };
  assert.deepEqual(parseCvAnalysisEvidence(current), current.rawResponse);

  const legacy = { evidence: JSON.stringify({ warnings: ['registro_anterior'] }) };
  assert.deepEqual(parseCvAnalysisEvidence(legacy), { warnings: ['registro_anterior'] });

  assert.deepEqual(parseCvAnalysisEvidence({ rawResponse: 'json inválido' }), {});
});

test('la vista usa analysedAt y no consulta createdAt en AttachmentAnalysis', () => {
  const routePath = fileURLToPath(new URL('../src/routes/lorenV2CvAnalysis.js', import.meta.url));
  const source = readFileSync(routePath, 'utf8');

  assert.match(source, /analysis\.analysedAt/);
  assert.match(source, /attachmentAnalyses:\s*\{\s*orderBy:\s*\{\s*analysedAt:\s*'desc'/);
  assert.doesNotMatch(source, /attachmentAnalyses:\s*\{\s*orderBy:\s*\{\s*createdAt:/);
  assert.doesNotMatch(source, /formatDate\(analysis\.createdAt\)/);
});
