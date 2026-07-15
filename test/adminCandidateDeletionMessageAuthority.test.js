import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const adminSource = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
const repositorySource = readFileSync(new URL('../src/services/conversationMessageRepository.js', import.meta.url), 'utf8');

function candidateDeletionRouteSource() {
  const start = adminSource.indexOf("router.post('/candidates/:id/delete'");
  const end = adminSource.indexOf("router.post('/candidates/:id/edit'", start);
  assert.ok(start >= 0, 'No se encontró la ruta administrativa de eliminación de candidatos');
  assert.ok(end > start, 'No se pudo delimitar la ruta administrativa de eliminación');
  return adminSource.slice(start, end);
}

test('la eliminación administrativa delega mensajes en la autoridad canónica', () => {
  assert.match(
    repositorySource,
    /export async function deleteConversationMessagesByCandidate\s*\(/,
    'ConversationMessageRepository debe exponer el contrato de eliminación por candidato'
  );
  assert.match(
    adminSource,
    /deleteConversationMessagesByCandidate/,
    'admin.js debe importar y usar el contrato de ciclo de vida de Message'
  );
  assert.doesNotMatch(
    adminSource,
    /\b[A-Za-z_$][\w$]*\s*\.\s*message\s*\.\s*deleteMany\s*\(/,
    'admin.js no debe eliminar Message directamente'
  );
});

test('conserva la eliminación de mensajes dentro de la transacción y antes del candidato', () => {
  const route = candidateDeletionRouteSource();
  const transactionIndex = route.indexOf('prisma.$transaction');
  const messageDeleteIndex = route.indexOf('deleteConversationMessagesByCandidate(tx');
  const bookingDeleteIndex = route.indexOf('tx.interviewBooking.deleteMany');
  const candidateDeleteIndex = route.indexOf('tx.candidate.delete');

  assert.ok(transactionIndex >= 0, 'La eliminación debe seguir siendo transaccional');
  assert.ok(messageDeleteIndex > transactionIndex, 'La autoridad de Message debe recibir el cliente tx');
  assert.ok(bookingDeleteIndex > messageDeleteIndex, 'Los mensajes deben eliminarse antes de las reservas');
  assert.ok(candidateDeleteIndex > bookingDeleteIndex, 'El candidato debe eliminarse al final de la transacción');
  assert.match(route, /candidateId:\s*candidate\.id/);
});
