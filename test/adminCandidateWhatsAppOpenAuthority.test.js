import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/adminLegacy.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

const route = between(
  source,
  "router.get('/candidates/:id/open-whatsapp'",
  "router.post('/candidates/:id/send-vacancy-info'"
);

test('admin importa la autoridad estrecha para apertura de WhatsApp', () => {
  assert.match(
    source,
    /import \{[\s\S]*recordManualWhatsAppOpen[\s\S]*\} from '\.\.\/services\/candidateStateService\.js';/
  );
});

test('la ruta carga el snapshot completo antes de delegar', () => {
  for (const field of [
    'botPaused',
    'botPausedAt',
    'botPausedBy',
    'botPauseReason',
    'botResumeMode',
    'devLastSeenAt',
    'status'
  ]) {
    assert.match(route, new RegExp(`${field}: true`), `Falta seleccionar ${field}.`);
  }

  assert.match(route, /recordManualWhatsAppOpen\(prisma,\s*\{/);
  assert.match(route, /candidateId:\s*candidate\.id/);
  assert.match(route, /role:\s*req\.userRole/);
  assert.match(route, /actor:\s*req\.username \|\| req\.userRole \|\| 'dashboard'/);
  assert.match(route, /devLastSeenAt:\s*candidate\.devLastSeenAt \?\? null/);
  assert.match(route, /status:\s*candidate\.status/);
});

test('valida enlace antes de persistir y no escribe Candidate directamente', () => {
  const linkIndex = route.indexOf('buildWhatsAppLink(candidate.phone)');
  const authorityIndex = route.indexOf('recordManualWhatsAppOpen');
  assert.ok(linkIndex >= 0);
  assert.ok(authorityIndex >= 0);
  assert.ok(authorityIndex > linkIndex);
  assert.doesNotMatch(route, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(route, /buildManualWhatsAppOpenCandidateUpdate/);
});

test('un conflicto termina antes de auditoría y apertura externa', () => {
  const authorityIndex = route.indexOf('recordManualWhatsAppOpen');
  const countIndex = route.indexOf('transition.count !== 1');
  const eventIndex = route.indexOf('logCandidateAdminEvent');
  const whatsappUrlIndex = route.indexOf('const whatsappUrl');
  const redirectIndex = route.lastIndexOf('return res.redirect(whatsappUrl)');

  assert.ok(authorityIndex >= 0);
  assert.ok(countIndex >= 0);
  assert.ok(eventIndex >= 0);
  assert.ok(whatsappUrlIndex >= 0);
  assert.ok(redirectIndex >= 0);
  assert.ok(countIndex > authorityIndex);
  assert.ok(eventIndex > countIndex);
  assert.ok(whatsappUrlIndex > countIndex);
  assert.ok(redirectIndex > whatsappUrlIndex);
  assert.match(route, /El estado del candidato cambió mientras se abría WhatsApp\. Actualiza la página e intenta de nuevo\./);
});

test('solo registra CONTACTADO después de una transición persistida', () => {
  const countIndex = route.indexOf('transition.count !== 1');
  const roleGuardIndex = route.indexOf("req.userRole !== 'dev'");
  const eventIndex = route.indexOf("eventType: 'WHATSAPP_OPENED'");

  assert.ok(countIndex >= 0);
  assert.ok(roleGuardIndex >= 0);
  assert.ok(eventIndex >= 0);
  assert.ok(roleGuardIndex > countIndex);
  assert.ok(eventIndex > roleGuardIndex);
  assert.match(route, /candidate\.status !== 'CONTACTADO'/);
  assert.match(route, /toValue:\s*'Contactado'/);
});