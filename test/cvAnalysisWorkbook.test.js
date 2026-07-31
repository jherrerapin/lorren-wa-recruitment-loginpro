import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCvAnalysisWorkbook,
  buildWhatsappWebUrl,
  createCvReviewExportSnapshot
} from '../src/services/cvAnalysisWorkbook.js';

function sampleReview() {
  const candidate = {
    id: 'candidate-excel',
    fullName: 'María de Prueba',
    phone: '300 123 4567',
    documentType: 'CC',
    documentNumber: '1234567890',
    cvOriginalName: 'maria-prueba.pdf',
    cvData: Buffer.from('contenido pesado que no debe ir en la instantánea'),
    vacancy: { id: 'vacancy-excel', title: 'Líder de operación' }
  };
  const strong = {
    candidate,
    analysis: { summary: 'Perfil con liderazgo e inventarios.' },
    match: {
      level: 'STRONG',
      score: 91.4,
      reasons: ['Experiencia clara coordinando personal operativo.'],
      evidence: ['Dos años como líder de operación.', 'Registro: medio de transporte Moto.'],
      gaps: ['Confirmar disponibilidad para turnos.']
    },
    manualReason: null
  };
  const possible = {
    candidate: { ...candidate, id: 'candidate-possible', fullName: 'Persona Posible', phone: '573112223333' },
    analysis: { summary: 'Experiencia relacionada.' },
    match: {
      level: 'POSSIBLE',
      score: 63,
      reasons: ['Tiene experiencia logística.'],
      evidence: ['Auxiliar logístico durante un año.'],
      gaps: ['No se evidencia manejo de personal.']
    },
    manualReason: null
  };
  const low = {
    candidate: { ...candidate, id: 'candidate-low', fullName: 'Persona Baja', phone: '' },
    analysis: { summary: 'Poca relación con el perfil.' },
    match: {
      level: 'LOW',
      score: 20,
      reasons: ['La experiencia registrada pertenece a otro sector.'],
      evidence: ['Experiencia comercial.'],
      gaps: ['No se evidencia experiencia logística.']
    },
    manualReason: null
  };
  const manual = {
    candidate: { ...candidate, id: 'candidate-manual', fullName: 'Persona Manual' },
    analysis: { summary: 'PDF sin texto legible.' },
    match: null,
    manualReason: 'No fue posible leer el documento con suficiente claridad.'
  };

  return {
    ok: true,
    vacancy: { id: 'vacancy-excel', title: 'Líder de operación', city: 'Medellín' },
    desiredProfile: 'Busco liderazgo operativo, inventarios y Excel.',
    interpretedProfile: {
      summary: 'Liderazgo operativo con experiencia en inventarios.',
      criteria: [{
        id: 'leadership',
        label: 'Manejo de personal',
        description: 'Debe coordinar personal operativo.',
        priority: 'REQUIRED',
        minimumMonths: 12,
        keywords: ['coordinación']
      }],
      warnings: []
    },
    modelUsed: 'test-cv-model',
    warnings: [],
    stats: { total: 4, readable: 3, strong: 1, possible: 1, low: 1, manual: 1 },
    groups: { strong: [strong], possible: [possible], low: [low], manual: [manual] },
    truncated: false
  };
}

test('normaliza celulares colombianos y construye enlace clicable a WhatsApp Web', () => {
  assert.equal(buildWhatsappWebUrl('300 123 4567'), 'https://web.whatsapp.com/send?phone=573001234567');
  assert.equal(buildWhatsappWebUrl('+57 311 222 3333'), 'https://web.whatsapp.com/send?phone=573112223333');
  assert.equal(buildWhatsappWebUrl(''), null);
});

test('la instantánea conserva solo datos exportables y excluye el archivo binario', () => {
  const snapshot = createCvReviewExportSnapshot(sampleReview());
  const candidate = snapshot.groups.strong[0].candidate;

  assert.equal(candidate.fullName, 'María de Prueba');
  assert.equal(candidate.documentType, 'CC');
  assert.equal(candidate.documentNumber, '1234567890');
  assert.equal(Object.hasOwn(candidate, 'cvData'), false);
  assert.equal(snapshot.desiredProfile, 'Busco liderazgo operativo, inventarios y Excel.');
  assert.equal(snapshot.interpretedProfile.criteria[0].label, 'Manejo de personal');
});

test('el Excel completo separa las cuatro secciones y conserva campos editables', async () => {
  const snapshot = createCvReviewExportSnapshot(sampleReview());
  const workbook = buildCvAnalysisWorkbook(snapshot, { group: 'all' });

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['Resumen', 'Coincidencia alta', 'Pueden encajar', 'Poca evidencia', 'Revisión manual']
  );

  const summary = workbook.getWorksheet('Resumen');
  assert.equal(summary.getCell('A1').value, 'Análisis de hojas de vida');
  assert.equal(summary.getCell('A8').value, 'Texto escrito por el coordinador');
  assert.equal(summary.getCell('K18').value, 'Mínimo meses');

  const sheet = workbook.getWorksheet('Coincidencia alta');
  assert.equal(sheet.getCell('A1').value, 'Coincidencia alta');
  assert.equal(sheet.getCell('A4').value, 'Sección');
  assert.equal(sheet.getCell('D4').value, 'Número de celular');
  const row = sheet.getRow(5);
  assert.equal(row.getCell('fullName').value, 'María de Prueba');
  assert.equal(row.getCell('documentType').value, 'CC');
  assert.equal(row.getCell('documentNumber').value, '1234567890');
  assert.equal(row.getCell('score').value, 91);
  assert.equal(row.getCell('reviewer').value, '');
  assert.equal(row.getCell('reviewerObservation').value, '');
  assert.equal(row.getCell('reviewer').fill.fgColor.argb, 'FFF8D6');
  assert.equal(row.getCell('reviewerObservation').fill.fgColor.argb, 'FFF8D6');

  const phone = row.getCell('phone').value;
  assert.equal(phone.text, '300 123 4567');
  assert.equal(phone.hyperlink, 'https://web.whatsapp.com/send?phone=573001234567');
  assert.match(row.getCell('analysis').value, /Experiencia clara coordinando personal operativo/i);
  assert.match(row.getCell('evidence').value, /Dos años como líder de operación/i);
  assert.match(row.getCell('gaps').value, /Confirmar disponibilidad/i);

  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 0);
});

test('la descarga de una sección no agrega hojas de otras clasificaciones', () => {
  const snapshot = createCvReviewExportSnapshot(sampleReview());
  const workbook = buildCvAnalysisWorkbook(snapshot, { group: 'low' });
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Resumen', 'Poca evidencia']);
});
