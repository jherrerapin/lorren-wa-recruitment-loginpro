import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUniqueReplySegment,
  composeUniqueReplySegment,
  detectReplyFollowUpTargets
} from '../src/services/replyComposition.js';

test('no añade un segmento exacto ya presente', () => {
  const base = 'Estoy revisando tu información. Para continuar, adjunta tu hoja de vida en PDF, DOC o DOCX.';
  const segment = 'Para continuar, adjunta tu hoja de vida en PDF, DOC o DOCX.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.text, base);
  assert.equal(result.appended, false);
  assert.equal(result.reason, 'segment_already_present');
});

test('no repite una solicitud de hoja de vida expresada con otras palabras', () => {
  const base = 'Estoy validando tus datos. Envíame tu HV como archivo PDF para cerrar el registro.';
  const segment = 'Para continuar necesito que adjuntes tu hoja de vida como archivo PDF, DOC o DOCX.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.text, base);
  assert.equal(result.appended, false);
  assert.deepEqual(result.sharedTargets, ['cv_upload']);
});

test('no repite una solicitud de datos faltantes', () => {
  const base = 'Estoy revisando el proceso y necesito que me compartas tu nombre y documento.';
  const segment = 'Si deseas continuar, aún me faltan estos datos: nombre completo y documento.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.text, base);
  assert.equal(result.appended, false);
  assert.ok(result.sharedTargets.includes('candidate_data'));
});

test('no repite la confirmación de vacante', () => {
  const base = 'Estoy verificando la información. Confírmame que la vacante de líder de operación es la correcta.';
  const segment = 'Si te interesa continuar, primero confirmamos que esta sea la vacante correcta y luego te guío con los datos necesarios.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.text, base);
  assert.equal(result.appended, false);
  assert.deepEqual(result.sharedTargets, ['vacancy_confirmation']);
});

test('no repite el ofrecimiento de registro para una futura apertura', () => {
  const base = 'Puedo dejar tu perfil registrado para cuando la vacante vuelva a abrir.';
  const segment = 'Si quieres, puedo tomar tus datos y tu hoja de vida para dejar tu perfil registrado por si la vacante se vuelve a abrir.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.text, base);
  assert.equal(result.appended, false);
  assert.deepEqual(result.sharedTargets, ['future_profile']);
});

test('añade seguimiento cuando la respuesta solo informa que está revisando', () => {
  const base = 'Estoy revisando la información que me compartiste.';
  const segment = 'Para continuar, adjunta tu hoja de vida como archivo PDF, DOC o DOCX.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.appended, true);
  assert.equal(result.reason, 'segment_appended');
  assert.equal(result.text, `${base} ${segment}`);
});

test('conserva un seguimiento con objetivo distinto', () => {
  const base = 'Confírmame que la vacante de auxiliar es la correcta.';
  const segment = 'Para continuar, adjunta tu hoja de vida como archivo PDF, DOC o DOCX.';
  const result = composeUniqueReplySegment(base, segment);

  assert.equal(result.appended, true);
  assert.equal(result.text, `${base} ${segment}`);
});

test('normaliza tildes, puntuación y espacios al comparar objetivos', () => {
  const base = 'Estoy revisando.  ¡Envíame tu currículum en PDF!';
  const segment = 'Para continuar necesito que adjuntes tu hoja de vida como archivo PDF, DOC o DOCX.';

  assert.equal(appendUniqueReplySegment(base, segment), base);
  assert.ok(detectReplyFollowUpTargets(base).includes('cv_upload'));
});

test('maneja entradas vacías sin inventar contenido', () => {
  assert.deepEqual(composeUniqueReplySegment('', ''), {
    text: '',
    appended: false,
    reason: 'both_empty',
    sharedTargets: []
  });
  assert.equal(appendUniqueReplySegment('', 'Continúa con tus datos.'), 'Continúa con tus datos.');
  assert.equal(appendUniqueReplySegment('Respuesta base.', ''), 'Respuesta base.');
});
