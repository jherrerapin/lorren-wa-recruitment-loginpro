import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOutboundReply } from '../src/services/replySafety.js';

const baseVacancy = {
  title: 'Auxiliar logístico',
  city: 'Bogotá',
  requirements: 'Experiencia en bodega',
  conditions: '',
  requiredDocuments: 'CC o PPT',
  operationAddress: 'Zona industrial',
  interviewAddress: 'Calle 80 # 10-20'
};

test('bloquea prestaciones de ley no registradas', () => {
  const result = sanitizeOutboundReply({ reply: 'La vacante tiene todas las prestaciones de ley.', vacancy: baseVacancy });
  assert.equal(result.blocked, true);
  assert.ok(result.blockedClaims.includes('prestaciones_de_ley'));
});

test('permite prestaciones si están registradas en conditions', () => {
  const result = sanitizeOutboundReply({ reply: 'La vacante tiene prestaciones de ley.', vacancy: { ...baseVacancy, conditions: 'Prestaciones de ley' } });
  assert.equal(result.blocked, false);
});

test('bloquea pagos quincenales y contrato directo no soportados', () => {
  const result = sanitizeOutboundReply({ reply: 'Es contrato directo y pagos quincenales.', vacancy: baseVacancy });
  assert.equal(result.blocked, true);
  assert.ok(result.blockedClaims.includes('contrato_directo'));
  assert.ok(result.blockedClaims.includes('pagos_quincenales'));
});


test('permite documentos de entrevista sensibles si están configurados en la vacante', () => {
  const vacancy = { ...baseVacancy, requiredDocuments: 'Hoja de vida Minerva 1003 o impresa y cédula original' };
  const result = sanitizeOutboundReply({
    reply: 'Para la entrevista recuerda traer Hoja de vida Minerva 1003 o impresa y cédula original.',
    vacancy
  });
  assert.equal(result.blocked, false);
});

test('bloquea dirección de entrevista no registrada', () => {
  const result = sanitizeOutboundReply({ reply: 'Preséntate en Calle 100 # 20-30 mañana.', vacancy: baseVacancy });
  assert.equal(result.blocked, true);
  assert.ok(result.blockedClaims.some((claim) => claim.startsWith('unregistered_interview_address')));
});

test('bloquea horario especifico no registrado', () => {
  const result = sanitizeOutboundReply({ reply: 'El horario es de 8 a 5 de lunes a viernes.', vacancy: baseVacancy });
  assert.equal(result.blocked, true);
  assert.ok(result.blockedClaims.includes('horario_especifico'));
});


test('no reescribe mensaje manual autorizado con restricciones de bot automático', () => {
  const manual = 'La vacante tiene prestaciones de ley y pagos quincenales.';
  const result = sanitizeOutboundReply({ reply: manual, vacancy: baseVacancy, source: 'admin_outbound' });
  assert.equal(result.blocked, false);
  assert.equal(result.reply, manual);
});
