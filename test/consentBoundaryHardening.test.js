import test from 'node:test';
import assert from 'node:assert/strict';
import './dataConsentRevocationStabilization.test.js';
import {
  buildConsentAcceptedReply,
  buildConsentPendingMode,
  deriveConsentResumeUpdate,
  evaluateConsentBoundary,
  isConsentAcceptance,
  isConsentRejection,
  parseConsentPendingMode,
  resolveConsentResumeContext,
  shouldRecordConsentAcceptance,
  shouldRecordConsentRejection
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

test('un nombre completo enviado solo queda protegido antes del consentimiento', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'GREETING_SENT', botResumeMode: null, vacancyId: 'vacancy-1' },
    { type: 'text', text: { body: 'Laura Pérez' } }
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

test('una inferencia gramatical de género no convierte el interés en datos de perfil', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'PENDING', currentStep: 'MENU', botResumeMode: null },
    { type: 'text', text: { body: 'Estoy interesada en la vacante' } }
  );

  assert.deepEqual(decision, { block: false, reason: 'consent_not_required_for_this_turn' });
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

test('un sí a una oferta no se registra como consentimiento antes de mostrar el aviso', () => {
  assert.equal(shouldRecordConsentAcceptance('Sí', { consentPromptPending: false }), false);
  assert.equal(shouldRecordConsentAcceptance('Sí, me interesa', { consentPromptPending: false }), false);
  assert.equal(shouldRecordConsentAcceptance('Sí, autorizo el tratamiento de mis datos', { consentPromptPending: false }), true);
  assert.equal(shouldRecordConsentAcceptance('Sí', { consentPromptPending: true }), true);
});

test('aceptar una vacante no equivale a aceptar el tratamiento de datos', () => {
  assert.equal(shouldRecordConsentAcceptance('Acepto la vacante', { consentPromptPending: false }), false);
  assert.equal(shouldRecordConsentAcceptance('Acepto la vacante', { consentPromptPending: true }), false);
  assert.equal(shouldRecordConsentAcceptance('Acepto el tratamiento de mis datos', { consentPromptPending: false }), true);
  assert.equal(shouldRecordConsentAcceptance('Estoy de acuerdo con el tratamiento de datos', { consentPromptPending: false }), true);
});

test('las negativas explícitas nunca se interpretan como aceptación', () => {
  for (const text of [
    'No consiento',
    'No doy consentimiento',
    'No autorizo el tratamiento de mis datos',
    'No estoy de acuerdo con el tratamiento de datos'
  ]) {
    assert.equal(isConsentAcceptance(text), false, text);
    assert.equal(isConsentRejection(text), true, text);
    assert.equal(shouldRecordConsentAcceptance(text, { consentPromptPending: true }), false, text);
    assert.equal(shouldRecordConsentRejection(text, { consentPromptPending: false }), true, text);
  }
});

test('un no a una oferta no se registra como revocatoria sin aviso de consentimiento pendiente', () => {
  assert.equal(shouldRecordConsentRejection('No', { consentPromptPending: false }), false);
  assert.equal(shouldRecordConsentRejection('No autorizo el tratamiento de mis datos', { consentPromptPending: false }), true);
  assert.equal(shouldRecordConsentRejection('No', { consentPromptPending: true }), true);
});

test('rechazar una vacante no equivale a rechazar el tratamiento de datos', () => {
  assert.equal(shouldRecordConsentRejection('No acepto la vacante', { consentPromptPending: false }), false);
  assert.equal(shouldRecordConsentRejection('No acepto la vacante', { consentPromptPending: true }), false);
  assert.equal(shouldRecordConsentRejection('No acepto el tratamiento de mis datos', { consentPromptPending: false }), true);
  assert.equal(shouldRecordConsentRejection('No estoy de acuerdo con el tratamiento de datos', { consentPromptPending: false }), true);
});

test('al autorizar se recupera la vacante alternativa aceptada', () => {
  assert.deepEqual(deriveConsentResumeUpdate('alternative_vacancy_offer:vacancy-77'), {
    vacancyId: 'vacancy-77',
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null
  });
});

test('al autorizar un perfil futuro se restaura el modo de captura correspondiente', () => {
  assert.deepEqual(deriveConsentResumeUpdate('future_profile_offer'), {
    currentStep: 'COLLECTING_DATA',
    botResumeMode: 'future_profile_capture'
  });
  assert.deepEqual(deriveConsentResumeUpdate('paused_vacancy'), {
    currentStep: 'COLLECTING_DATA',
    botResumeMode: 'paused_vacancy_capture'
  });
});

test('la vacante alternativa se revalida antes de asignarla después del consentimiento', async () => {
  const openVacancy = {
    id: 'vacancy-77',
    isActive: true,
    acceptingApplications: true
  };
  const prisma = {
    vacancy: {
      findUnique: async () => openVacancy
    }
  };

  const result = await resolveConsentResumeContext(prisma, 'alternative_vacancy_offer:vacancy-77');

  assert.equal(result.alternativeUnavailable, false);
  assert.equal(result.vacancy, openVacancy);
  assert.deepEqual(result.resumeUpdate, {
    vacancyId: 'vacancy-77',
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null
  });
});

test('una vacante alternativa cerrada no se asigna después del consentimiento', async () => {
  const prisma = {
    vacancy: {
      findUnique: async () => ({
        id: 'vacancy-77',
        isActive: false,
        acceptingApplications: false
      })
    }
  };

  const result = await resolveConsentResumeContext(prisma, 'alternative_vacancy_offer:vacancy-77');

  assert.equal(result.alternativeUnavailable, true);
  assert.equal(result.vacancy, null);
  assert.equal(result.requestedVacancyId, 'vacancy-77');
  assert.deepEqual(result.resumeUpdate, {
    vacancyId: null,
    currentStep: 'GREETING_SENT',
    botResumeMode: null
  });
});

test('si una HV fue descartada antes de autorizar se solicita reenviarla solo en PDF o DOCX', () => {
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
  assert.match(reply, /PDF o DOCX/i);
  assert.doesNotMatch(reply, /PDF, DOC o DOCX/i);
});

test('la captura admite varios prefijos naturales antes de autorizar', async () => {
  const candidate = { id: 'candidate-1', dataConsentStatus: 'ACCEPTED', documentType: null, documentNumber: null };
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
