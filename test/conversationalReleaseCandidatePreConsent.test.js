import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProfileDataEvidence } from '../src/services/dataConsentGate.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';

const positiveEvidenceCases = [
  ['TEST-RC-DOCUMENT-ISOLATED', '100000001', ['documentNumber']],
  ['TEST-RC-MEDICAL', 'Tengo una restricción médica de prueba', ['medicalRestrictions']],
  ['TEST-RC-EXPERIENCE', 'Tengo 2 años de experiencia en logística', ['experienceInfo', 'experienceTime', 'experienceSummary']]
];

for (const [id, body, expectedFields] of positiveEvidenceCases) {
  test(`${id}: los datos protegidos del inbound actual se reconocen antes del consentimiento`, () => {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });

    assert.equal(result.containsProfileData, true);
    for (const field of expectedFields) {
      assert.ok(result.evidence.some((item) => item.field === field), `${id}: falta evidencia para ${field}`);
    }
    for (const evidence of result.evidence) {
      assert.equal(evidence.source, 'CURRENT_INBOUND_EXPLICIT');
      assert.ok(evidence.value !== undefined && evidence.value !== null && String(evidence.value).trim());
      assert.ok(evidence.rule);
      assert.ok(evidence.fragment);
      assert.ok(body.includes(evidence.fragment), `${id}: el fragmento debe existir en el inbound actual`);
    }
  });
}

test('TEST-RC-DOCUMENT-QUESTION: una pregunta sobre documentos no contiene documento personal', () => {
  const cases = [
    ['¿Qué documentos son 2 copias?', false],
    ['¿Qué documentos piden?', false],
    ['¿Son 2 copias del documento?', false],
    ['¿El documento debe estar ampliado al 150?', false],
    ['Tengo 2 copias', false],
    ['Documento: 1012345678', true],
    ['Mi cédula es 1012345678', true],
    ['1012345678', true]
  ];

  for (const [body, expected] of cases) {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });
    assert.equal(result.evidence.some((item) => item.field === 'documentNumber'), expected, body);
  }
});

test('TEST-RC-NAME-STRUCTURE: profesión larga y rasgos consecutivos no son nombre', () => {
  for (const body of [
    'Administrador Logístico de Operaciones',
    'Responsable puntual comprometido organizado',
    'Trabajo como coordinador de despachos y almacenamiento',
    'Soy administrador logístico de operaciones',
    'Soy administrador logístico retirado',
    'Soy responsable puntual',
    'Soy muy enfocado responsable'
  ]) {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });
    assert.equal(result.evidence.some((item) => item.field === 'fullName'), false, body);
  }

  for (const body of [
    'Me llamo Andrés Felipe Gómez',
    'Soy Andrés Felipe Gómez',
    'Nombre: María del Pilar Rojas'
  ]) {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });
    assert.equal(result.evidence.some((item) => item.field === 'fullName'), true, body);
  }
});

test('TEST-RC-LOCATION-STRUCTURE: un nombre explícito no se propone también como residencia', () => {
  const result = evaluateProfileDataEvidence('Me llamo Nombre de Prueba');
  assert.deepEqual(result.evidence.map((item) => item.field), ['fullName']);
});

test('TEST-RC-CANONICAL-WRITER: la captura canónica falla cerrada sin consentimiento ACCEPTED', async () => {
  const updates = [];
  const candidate = {
    id: 'TEST-RC-CANDIDATE',
    dataConsentStatus: 'PENDING',
    fullName: null,
    documentNumber: null,
    age: null
  };

  const result = await captureConsentedProfileData({
    prisma: {
      candidate: {
        update: async ({ data }) => {
          updates.push(structuredClone(data));
          return { ...candidate, ...data };
        }
      }
    },
    candidate,
    currentText: 'Me llamo Nombre de Prueba, mi cédula es TEST-100000001 y tengo 30 años'
  });

  assert.deepEqual(updates, []);
  assert.equal(result.reason, 'consent_not_accepted');
  assert.deepEqual(result.capturedFields, []);
});
