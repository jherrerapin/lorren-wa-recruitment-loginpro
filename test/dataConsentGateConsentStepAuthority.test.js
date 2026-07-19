import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/services/dataConsentGate.js', 'utf8');

function extractFunctionSource(functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró ${functionName}`);
  const openingBrace = source.indexOf('{', source.indexOf(')', match.index) + 1);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

test('recordConsent entrega el snapshot de currentStep a ConsentStateService', () => {
  const recordConsent = extractFunctionSource('recordConsent');
  assert.match(recordConsent, /expected\s*:\s*\{\s*currentStep\s*:\s*candidate\.currentStep\s*\}/);
  assert.match(recordConsent, /return\s+result\s*;/);
});

test('la revocatoria no responde cuando la transición de paso entra en conflicto', () => {
  const handler = extractFunctionSource('handleConsentDecision');
  const revokedIndex = handler.indexOf("'REVOKED'");
  assert.notEqual(revokedIndex, -1);

  const conflictIndex = handler.indexOf('consentResult.conflict', revokedIndex);
  const replyIndex = handler.indexOf('CONSENT_REVOKED_REPLY', revokedIndex);

  assert.notEqual(conflictIndex, -1);
  assert.notEqual(replyIndex, -1);
  assert.ok(conflictIndex < replyIndex, 'El conflicto debe evaluarse antes de enviar la respuesta de revocatoria');
});

test('la aceptación no captura perfil ni responde cuando currentStep quedó obsoleto', () => {
  const handler = extractFunctionSource('handleConsentDecision');
  const acceptedIndex = handler.indexOf("'ACCEPTED'");
  assert.notEqual(acceptedIndex, -1);

  const conflictIndex = handler.indexOf('consentResult.conflict', acceptedIndex);
  const captureIndex = handler.indexOf('captureConsentedProfileData', acceptedIndex);
  const replyIndex = handler.indexOf('buildConsentAcceptedReply', acceptedIndex);

  assert.notEqual(conflictIndex, -1);
  assert.notEqual(captureIndex, -1);
  assert.notEqual(replyIndex, -1);
  assert.ok(conflictIndex < captureIndex, 'El conflicto debe impedir captura de perfil');
  assert.ok(conflictIndex < replyIndex, 'El conflicto debe impedir respuesta de aceptación');
});

test('el gate conserva la evidencia inbound antes del intento transaccional', () => {
  const handler = extractFunctionSource('handleConsentDecision');
  const saveAcceptance = handler.indexOf("saveInboundConsentEvidence(prisma, candidate.id, message, body, 'ACCEPTED')");
  const recordAcceptance = handler.indexOf("recordConsent(prisma, req, candidate, 'ACCEPTED'");
  const saveRevocation = handler.indexOf("saveInboundConsentEvidence(prisma, candidate.id, message, body, 'REVOKED')");
  const recordRevocation = handler.indexOf("recordConsent(prisma, req, candidate, 'REVOKED'");

  assert.ok(saveAcceptance !== -1 && saveAcceptance < recordAcceptance);
  assert.ok(saveRevocation !== -1 && saveRevocation < recordRevocation);
});
