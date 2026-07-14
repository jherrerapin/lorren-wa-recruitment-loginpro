import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsentAcceptedReply,
  buildConsentPendingMode,
  deriveConsentResumeUpdate,
  evaluateConsentBoundary,
  parseConsentPendingMode
} from '../src/services/dataConsentGate.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';
import { getSupervisorPhone } from '../src/services/adminSupervisor.js';

test('el gate no intercepta mensajes del supervisor', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'COLLECTING_DATA' },
    { from: getSupervisorPhone(), type: 'text', text: { body: 'Debe llevar copia de la cédula' } }
  );

  assert.deepEqual(decision, { block: false, reason: 'supervisor_message' });
});

test('interés o nombre de un cargo no se confunden con datos personales en MENU', () => {
  const baseCandidate = {
    dataConsentStatus: 'PENDING',
    currentStep: 'MENU',
    botResumeMode: null
  };

  assert.deepEqual(
    evaluateConsentBoundary(baseCandidate, { type: 'text', text: { body: 'Estoy interesado' } }),
    { block: false, reason: 'consent_not_required_for_this_turn' }
  );
  assert.deepEqual(
    evaluateConsentBoundary(baseCandidate, { type: 'text', text: { body: 'Servicios generales' } }),
    { block: false, reason: 'consent_not_required_for_this_turn' }
  );
});

test('los datos personales explícitos continúan protegidos antes del consentimiento', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'MENU', botResumeMode: null },
    { type: 'text', text: { body: 'Mi nombre es Laura Pérez y mi cédula es 1020304050' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'profile_data_before_consent' });
});

test('la presentación natural con soy nombre queda protegida antes del consentimiento', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'MENU', botResumeMode: null },
    { type: 'text', text: { body: 'Soy Laura Pérez, quiero aplicar a auxiliar de bodega' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'profile_data_before_consent' });
});

test('una declaración explícita de género queda protegida antes del consentimiento', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'MENU', botResumeMode: null },
    { type: 'text', text: { body: 'Soy mujer, quiero aplicar a auxiliar de bodega' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'profile_data_before_consent' });
});

test('el modo pendiente conserva contexto de vacante alternativa y reenvío de HV', () => {
  const encoded = buildConsentPendingMode({
    resumeMode: 'alternative_vacancy_offer:vacancy-77',
    cvResendRequired: true
  });

  assert.deepEqual(parseConsentPendingMode(encoded), {
    pending: true,
    resumeMode: 'alternative_vacancy_offer:vacancy-77',
    cvResendRequired: true
  });
});

test('al autorizar se recupera la vacante alternativa aceptada', () => {
  assert.deepEqual(deriveConsentResumeUpdate('alternative_vacancy_offer:vacancy-77'), {
    vacancyId: 'vacancy-77',
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null
  });
});

test('si una HV fue descartada antes de autorizar se solicita reenviarla', () => {
  const reply = buildConsentAcceptedReply(
    {
      fullName: 'Laura Pérez',
      documentType: 'CC',
      documentNumber: '1020304050',
      age: 30,
      neighborhood: 'Canaima',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto'
    },
    { city: 'Neiva', experienceRequired: 'NO' },
    { cvResendRequired: true }
  );

  assert.match(reply, /archivo anterior.*no fue guardado/i);
  assert.match(reply, /vuelve a adjuntar tu hoja de vida/i);
});

test('la captura admite varios prefijos naturales antes de autorizar', async () => {
  const candidate = { id: 'candidate-1', documentType: null, documentNumber: null };
  let persisted = null;
  const prisma = {
    candidate: {
      update: async ({ data }) => {
        persisted = data;
        return { ...candidate, ...data };
      }
    }
  };

  const result = await captureConsentedProfileData({
    prisma,
    candidate,
    vacancy: { city: 'Neiva' },
    currentText: 'Sí, claro, autorizo. CC 1020304050'
  });

  assert.equal(result.reason, 'profile_data_captured_from_consent_message');
  assert.equal(persisted.documentType, 'CC');
  assert.equal(persisted.documentNumber, '1020304050');
});
