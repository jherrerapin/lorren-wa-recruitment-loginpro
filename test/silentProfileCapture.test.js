import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSilentProfileCaptureReply,
  buildSilentProfileCaptureUpdate,
  getBotResumeModeKey,
  hasMaterialProfileData,
  isSilentProfileCaptureMode,
  shouldSilentCaptureProfileData
} from '../src/services/silentProfileCapture.js';

function candidate(overrides = {}) {
  return {
    id: 'cand-silent-profile',
    fullName: null,
    vacancyId: null,
    botResumeMode: 'alternative_vacancy_offer:vac-cargue-bogota',
    currentStep: 'GREETING_SENT',
    ...overrides
  };
}

test('detecta la llave base de botResumeMode aunque tenga vacancyId sugerido', () => {
  assert.equal(getBotResumeModeKey('alternative_vacancy_offer:vac-123'), 'alternative_vacancy_offer');
});

test('reconoce modos donde los datos se pueden guardar sin asignar vacante', () => {
  assert.equal(isSilentProfileCaptureMode('alternative_vacancy_offer:vac-123'), true);
  assert.equal(isSilentProfileCaptureMode('alternative_vacancy_prequalification:vac-456'), true);
  assert.equal(isSilentProfileCaptureMode('future_profile_offer'), true);
  assert.equal(isSilentProfileCaptureMode('paused_vacancy'), true);
});

test('detecta datos materiales del candidato', () => {
  assert.equal(hasMaterialProfileData({}), false);
  assert.equal(hasMaterialProfileData({ fullName: 'Andreina Zabaleta' }), true);
  assert.equal(hasMaterialProfileData({ documentNumber: '1143354546', age: 36 }), true);
});

test('permite guardar datos enviados durante oferta de alternativa sin vacancyId', () => {
  const decision = shouldSilentCaptureProfileData({
    candidate: candidate(),
    hasDataIntent: true,
    normalizedData: {
      fullName: 'Andreina Zabaleta Aviles',
      documentNumber: '1143354546',
      age: 36,
      locality: 'Engativa',
      medicalRestrictions: 'ninguna'
    }
  });

  assert.equal(decision, true);
});

test('no permite captura silenciosa si ya hay vacante asignada', () => {
  const decision = shouldSilentCaptureProfileData({
    candidate: candidate({ vacancyId: 'vac-cargue-bogota' }),
    hasDataIntent: true,
    normalizedData: { fullName: 'Andreina Zabaleta Aviles' }
  });

  assert.equal(decision, false);
});

test('actualizacion silenciosa nunca asigna vacancyId y conserva alternativa pendiente', () => {
  const update = buildSilentProfileCaptureUpdate({
    candidate: candidate(),
    normalizedData: {
      fullName: 'Andreina Zabaleta Aviles',
      documentNumber: '1143354546',
      age: 36
    }
  });

  assert.equal(update.fullName, 'Andreina Zabaleta Aviles');
  assert.equal(update.documentNumber, '1143354546');
  assert.equal(update.age, 36);
  assert.equal(update.vacancyId, undefined);
  assert.equal(update.botResumeMode, 'alternative_vacancy_offer:vac-cargue-bogota');
  assert.equal(update.currentStep, 'GREETING_SENT');
  assert.equal(update.reminderState, 'SKIPPED');
});

test('respuesta de alternativa deja claro que aun no hay vacante asignada', () => {
  const reply = buildSilentProfileCaptureReply({
    candidate: candidate({ fullName: 'Andreina Zabaleta Aviles' }),
    city: 'Bogota',
    requestedRoleText: 'servicio general'
  });

  assert.match(reply, /Gracias, Andreina/i);
  assert.match(reply, /datos registrados/i);
  assert.match(reply, /Aún no te asigno|Aun no te asigno/i);
  assert.doesNotMatch(reply, /quedaste postulad/i);
  assert.doesNotMatch(reply, /entrevista/i);
});

test('respuesta de perfil futuro no promete entrevista ni postulacion activa', () => {
  const reply = buildSilentProfileCaptureReply({
    candidate: candidate({ botResumeMode: 'future_profile_offer', fullName: 'Andreina Zabaleta Aviles' }),
    city: 'Bogota',
    requestedRoleText: 'servicios generales'
  });

  assert.match(reply, /futuras aperturas compatibles/i);
  assert.match(reply, /no hay una vacante activa asociada/i);
  assert.doesNotMatch(reply, /quedaste postulad/i);
  assert.doesNotMatch(reply, /agendada/i);
});
