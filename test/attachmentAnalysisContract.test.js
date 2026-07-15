import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  analyzeCandidateCv,
  groupCandidateReviewResults,
  parseCvAnalysisEvidence,
  reviewVacancyCandidates,
  safeErrorMessage,
  shouldUseVisualPdfFallback
} from '../src/services/cvIntelligence.js';
import { lorenV2CvAnalysisRouter } from '../src/routes/lorenV2CvAnalysis.js';

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

function createLegacyWordBuffer(text) {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return Buffer.concat([signature, Buffer.alloc(16), Buffer.from(text, 'utf16le')]);
}

test('un archivo DOC legible avanza a análisis de IA y persiste campos reales de Prisma', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const candidate = {
    id: 'candidate-test-attachment-1',
    phone: 'TEST-PHONE-1',
    fullName: 'Persona Prueba',
    documentNumber: 'TEST-DOC-1',
    locality: 'Zona Prueba',
    cvData: createLegacyWordBuffer('Hoja de vida Persona Prueba experiencia laboral'),
    cvStorageKey: null,
    cvOriginalName: 'hoja-de-vida.doc',
    cvMimeType: 'application/msword',
    vacancy: null
  };
  const prisma = createPrismaForCandidate(candidate);

  try {
    const result = await analyzeCandidateCv(prisma, candidate.id);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ai_not_configured');
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
    assert.match(persisted.extractedText, /Hoja de vida Persona Prueba/i);
    assert.equal(persisted.rawResponse.stage, 'ai_extraction');
    assert.equal(persisted.rawResponse.reason, 'ai_not_configured');
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

test('los errores conservan un stack limitado sin exponer credenciales', () => {
  const error = new Error('Fallo Bearer sk-super-secreto');
  error.stack = `${error.stack}\naccess_token=token-privado`;
  const summary = safeErrorMessage(error);

  assert.match(summary, /Stack:/);
  assert.doesNotMatch(summary, /sk-super-secreto/);
  assert.doesNotMatch(summary, /token-privado/);
  assert.ok(summary.length <= 1000);
});

test('la vista usa analysedAt y no consulta createdAt en AttachmentAnalysis', () => {
  const routePath = fileURLToPath(new URL('../src/routes/lorenV2CvAnalysis.js', import.meta.url));
  const source = readFileSync(routePath, 'utf8');

  assert.match(source, /formatDate\(latestAnalysis\(candidate\)\.analysedAt\)/);
  assert.match(source, /attachmentAnalyses:\s*\{\s*orderBy:\s*\{\s*analysedAt:\s*'desc'/);
  assert.doesNotMatch(source, /attachmentAnalyses:\s*\{\s*orderBy:\s*\{\s*createdAt:/);
  assert.doesNotMatch(source, /formatDate\(analysis\.createdAt\)/);
});

test('la migración alinea AttachmentAnalysis sin borrar sus columnas antiguas', () => {
  const migrationPath = fileURLToPath(new URL(
    '../prisma/migrations/20260715190000_align_attachment_analysis_cv_fields/migration.sql',
    import.meta.url
  ));
  const migration = readFileSync(migrationPath, 'utf8');

  for (const column of ['originalName', 'extractedText', 'summary', 'analysedAt', 'modelUsed', 'rawResponse']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.match(migration, /"originalName" = COALESCE\("originalName", "fileName"\)/);
  assert.match(migration, /"analysedAt" = COALESCE\("analysedAt", "createdAt", CURRENT_TIMESTAMP\)/);
  assert.match(migration, /jsonb_build_object\('legacyEvidenceText', "evidence"\)/);
  assert.doesNotMatch(migration, /"evidence"::jsonb/);
  assert.doesNotMatch(migration, /DROP (?:COLUMN|TABLE)/i);
});

test('la revisión evita la consulta duplicada y responde con la página ante errores inesperados', () => {
  const routePath = fileURLToPath(new URL('../src/routes/lorenV2CvAnalysis.js', import.meta.url));
  const source = readFileSync(routePath, 'utf8');
  const startIndex = source.indexOf("router.post('/run'");
  const endIndex = source.indexOf("router.post('/:candidateId/analyze'");
  assert.ok(startIndex >= 0, 'No se encontró el inicio de la ruta /run');
  assert.ok(endIndex > startIndex, 'No se encontró el final de la ruta /run');
  const runRoute = source.slice(startIndex, endIndex);

  assert.doesNotMatch(runRoute, /loadCandidates\(/);
  assert.match(runRoute, /try\s*\{/);
  assert.match(runRoute, /res\.status\(500\)\.send\(renderPage\(/);
  assert.match(runRoute, /showCandidates:\s*false/);
});

test('POST /run conserva el formulario y devuelve un mensaje legible si falla la base', async () => {
  const prisma = {
    vacancy: {
      findMany: async () => {
        throw new Error('simulated database failure');
      }
    }
  };
  const router = lorenV2CvAnalysisRouter(prisma);
  const runLayer = router.stack.find((layer) => layer.route?.path === '/run');
  const handler = runLayer.route.stack[0].handle;
  const response = {
    statusCode: 200,
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handler({ body: { vacancyId: 'vacancy-test', desiredProfile: 'Perfil suficientemente detallado' } }, response);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 500);
  assert.match(response.body, /No fue posible revisar las hojas de vida en este momento/);
  assert.match(response.body, /<form method="post" action="\/admin\/estadisticas\/cv-analysis\/run">/);
  assert.doesNotMatch(response.body, /internal_server_error/);
});

test('los PDF sin texto o con texto insuficiente activan el segundo intento visual', () => {
  assert.equal(shouldUseVisualPdfFallback(
    { cvMimeType: 'application/pdf', cvOriginalName: 'hv.pdf' },
    { ok: false, reason: 'empty_pdf_text' }
  ), true);
  assert.equal(shouldUseVisualPdfFallback(
    { cvMimeType: 'application/pdf', cvOriginalName: 'hv.pdf' },
    { ok: false, reason: 'text_extraction_failed' }
  ), true);
  assert.equal(shouldUseVisualPdfFallback(
    { cvMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', cvOriginalName: 'hv.docx' },
    { ok: false, reason: 'empty_docx_text' }
  ), false);
  assert.equal(shouldUseVisualPdfFallback(
    { cvMimeType: 'application/pdf', cvOriginalName: 'minerva-fotos.pdf' },
    { ok: true, reason: 'pdf_text_extracted', text: 'Página 1' }
  ), true);
  assert.equal(shouldUseVisualPdfFallback(
    { cvMimeType: 'application/pdf', cvOriginalName: 'hv-digital.pdf' },
    { ok: true, reason: 'pdf_text_extracted', text: 'Experiencia laboral verificable '.repeat(5) }
  ), false);
});

test('los resultados se agrupan por utilidad y nunca convierten revisión manual en rechazo', () => {
  const grouped = groupCandidateReviewResults([
    { candidate: { id: 'possible' }, match: { level: 'POSSIBLE', score: 63 } },
    { candidate: { id: 'strong-low' }, match: { level: 'STRONG', score: 79 } },
    { candidate: { id: 'strong-high' }, match: { level: 'STRONG', score: 91 } },
    { candidate: { id: 'manual' }, match: null, manualReason: 'No fue posible leer el documento.' },
    { candidate: { id: 'low' }, match: { level: 'LOW', score: 20 } }
  ]);

  assert.deepEqual(grouped.strong.map((item) => item.candidate.id), ['strong-high', 'strong-low']);
  assert.deepEqual(grouped.possible.map((item) => item.candidate.id), ['possible']);
  assert.deepEqual(grouped.low.map((item) => item.candidate.id), ['low']);
  assert.deepEqual(grouped.manual.map((item) => item.candidate.id), ['manual']);
  assert.equal(JSON.stringify(grouped).includes('RECHAZADO'), false);
});

function cachedCandidate(id, experienceSummary) {
  return {
    id,
    fullName: `Persona ${id}`,
    phone: `TEST-${id}`,
    vacancyId: 'vacancy-1',
    cvStorageKey: `test/${id}.pdf`,
    cvData: null,
    cvOriginalName: `${id}.pdf`,
    cvMimeType: 'application/pdf',
    locality: 'Suba',
    neighborhood: null,
    transportMode: id === 'candidate-strong' ? 'Motocicleta propia' : 'Transporte público',
    experienceInfo: 'Sí',
    experienceTime: id === 'candidate-strong' ? '2 años' : '6 meses',
    experienceSummary: `Registro: ${experienceSummary}`,
    availability: 'Tiempo completo',
    age: 29,
    gender: 'FEMALE',
    medicalRestrictions: 'Dato que no debe enviarse',
    updatedAt: new Date('2026-07-15T12:00:00.000Z'),
    vacancy: { id: 'vacancy-1', title: 'Auxiliar de inventarios', city: 'Bogotá' },
    attachmentAnalyses: [{
      id: `analysis-${id}`,
      classification: 'CV_VALID',
      confidence: 0.9,
      analysedAt: new Date('2026-07-15T12:00:00.000Z'),
      rawResponse: {
        documentReference: `storage:test/${id}.pdf`,
        extracted: {
          city: 'Bogotá',
          locality: null,
          experienceSummary,
          lastRole: 'Auxiliar',
          educationSummary: 'Bachiller',
          estimatedExperienceMonths: 18,
          skills: ['Excel', 'Inventarios'],
          certifications: [],
          experience: []
        }
      }
    }]
  };
}

test('la revisión por vacante interpreta el perfil, ordena coincidencias y separa comparaciones faltantes', async () => {
  const candidates = [
    cachedCandidate('candidate-strong', 'Dos años manejando inventarios y Excel.'),
    cachedCandidate('candidate-possible', 'Seis meses apoyando bodega.'),
    cachedCandidate('candidate-unmatched', 'Experiencia en atención al cliente.')
  ];
  const calls = [];
  const openAiPost = async (payload) => {
    calls.push(payload);
    const schemaName = payload.text.format.name;
    if (schemaName === 'loren_desired_candidate_profile') {
      return { data: { output: [{ content: [{ parsed: {
        summary: 'Experiencia en inventarios y manejo de Excel.',
        criteria: [{
          id: 'inventarios',
          label: 'Experiencia en inventarios',
          description: 'Ha trabajado controlando o recibiendo mercancía.',
          priority: 'REQUIRED',
          minimumMonths: 12,
          keywords: ['inventarios', 'mercancía']
        }],
        warnings: []
      } }] }] } };
    }
    return { data: { output: [{ content: [{ parsed: { results: [
      {
        candidateId: 'candidate-possible',
        level: 'POSSIBLE',
        score: 58,
        reasons: ['Tiene experiencia relacionada con bodega.'],
        evidence: ['Hoja de vida: seis meses apoyando bodega.', 'Registro: transporte público.'],
        gaps: ['Falta confirmar un año de experiencia.']
      },
      {
        candidateId: 'candidate-strong',
        level: 'STRONG',
        score: 92,
        reasons: ['Cumple experiencia y Excel.'],
        evidence: ['Hoja de vida: dos años manejando inventarios y Excel.', 'Registro: medio de transporte Moto.'],
        gaps: []
      }
    ] } }] }] } };
  };
  const prisma = {
    vacancy: {
      findUnique: async () => ({
        id: 'vacancy-1',
        title: 'Auxiliar de inventarios',
        city: 'Bogotá',
        requirements: 'Debe contar con moto propia.',
        roleDescription: null
      })
    },
    candidate: {
      findMany: async () => candidates
    }
  };

  const review = await reviewVacancyCandidates(prisma, {
    vacancyId: 'vacancy-1',
    desiredProfile: 'Busco experiencia de un año en inventarios y manejo de Excel.'
  }, { openAiPost });

  assert.equal(review.ok, true);
  assert.equal(review.modelUsed, 'gpt-5.6-terra');
  assert.equal(review.stats.total, 3);
  assert.equal(review.stats.strong, 1);
  assert.equal(review.stats.possible, 1);
  assert.equal(review.stats.manual, 1);
  assert.equal(review.groups.strong[0].candidate.id, 'candidate-strong');
  assert.deepEqual(review.groups.strong[0].match.evidence, [
    'dos años manejando inventarios y Excel.',
    'Registro: medio de transporte Moto.'
  ]);
  assert.equal(review.groups.manual[0].candidate.id, 'candidate-unmatched');
  assert.match(review.groups.manual[0].manualReason, /no fue posible compararla/i);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((payload) => payload.model === 'gpt-5.6-terra'), true);

  const profileInput = JSON.parse(calls[0].input[1].content[0].text);
  assert.equal(profileInput.vacancy.requirements, 'Debe contar con moto propia.');

  const matchInput = JSON.parse(calls[1].input[1].content[0].text);
  const strongInput = matchInput.candidates.find((candidate) => candidate.candidateId === 'candidate-strong');
  assert.equal(strongInput.sources.cv.experienceSummary, 'Dos años manejando inventarios y Excel.');
  assert.deepEqual(strongInput.sources.registration, {
    transportMode: 'Moto',
    residence: 'Suba'
  });
  for (const excludedField of ['fullName', 'phone', 'documentNumber', 'age', 'gender', 'medicalRestrictions']) {
    assert.equal(JSON.stringify(strongInput).includes(`"${excludedField}"`), false);
  }
  assert.match(calls[1].input[0].content[0].text, /sources\.cv/);
  assert.match(calls[1].input[0].content[0].text, /sources\.registration/);
  assert.match(calls[1].input[0].content[0].text, /No antepongas "Hoja de vida:"/);
  assert.match(calls[1].input[0].content[0].text, /Usa "Registro:" solo/);
});

test('Terra es el modelo por defecto y las tareas especializadas permiten overrides', () => {
  const conversationPath = fileURLToPath(new URL('../src/services/conversationEngine.js', import.meta.url));
  const extractionPath = fileURLToPath(new URL('../src/ai/extractRecruitmentTurn.js', import.meta.url));
  const configPath = fileURLToPath(new URL('../src/services/openAiModelConfig.js', import.meta.url));
  const routePath = fileURLToPath(new URL('../src/routes/lorenV2CvAnalysis.js', import.meta.url));
  const conversationSource = readFileSync(conversationPath, 'utf8');
  const extractionSource = readFileSync(extractionPath, 'utf8');
  const configSource = readFileSync(configPath, 'utf8');
  const routeSource = readFileSync(routePath, 'utf8');

  assert.match(configSource, /DEFAULT_OPENAI_MODEL = 'gpt-5\.6-terra'/);
  assert.match(configSource, /resolveModel\(\['OPENAI_EXTRACTION_MODEL', 'OPENAI_MODEL'\]\)/);
  assert.match(configSource, /resolveModel\(\['OPENAI_CV_MODEL', 'OPENAI_EXTRACTION_MODEL', 'OPENAI_MODEL'\]\)/);
  assert.match(conversationSource, /const DEFAULT_MODEL = OPENAI_CONVERSATION_MODEL/);
  assert.match(extractionSource, /const MODEL = OPENAI_EXTRACTION_MODEL/);
  assert.match(routeSource, /name="vacancyId" required/);
  assert.match(routeSource, /name="desiredProfile"/);
  assert.match(routeSource, /Revisión manual/);
  assert.match(routeSource, /Datos registrados por el candidato/);
  assert.match(routeSource, /Medio de transporte/);
  assert.match(routeSource, /medio de transporte y la residencia registrados/);
  assert.doesNotMatch(routeSource, /datos laborales y operativos del registro/);
  assert.doesNotMatch(routeSource, /Experiencia declarada/);
  assert.doesNotMatch(routeSource, /Disponibilidad/);
  assert.match(routeSource, /Evidencia encontrada \(HV o registro\)/);
  assert.doesNotMatch(routeSource, /cambiar.*estado.*candidato/i);
});
