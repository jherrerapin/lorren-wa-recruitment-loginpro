import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const monitorView = fs.readFileSync(
  new URL('../src/views/operacionesWhatsappMonitor.ejs', import.meta.url),
  'utf8'
);

test('monitor DEV muestra conversaciones recientes aparte de asignados sin exigir búsqueda manual', () => {
  assert.match(monitorView, /<h2>Conversaciones de Despacho<\/h2>/);
  assert.match(monitorView, /data-conversation-phone/);
  assert.match(monitorView, /bindConversationButtons/);
  assert.match(monitorView, /currentPhoneQuery = phone/);
  assert.match(monitorView, /Contacto → Lórren/);
  assert.match(monitorView, /Lórren → contacto/);
  assert.match(monitorView, /id="phoneSearchCard" hidden aria-hidden="true"/);
  assert.match(monitorView, /no necesitas copiar ni buscar el número/);
});

test('conversación abierta conserva posición durante el refresh vivo', () => {
  assert.match(monitorView, /lookupTop: lookupPanel\?\.scrollTop/);
  assert.match(monitorView, /lookupPanel\.scrollTop = state\.lookupTop/);
  assert.match(monitorView, /window\.scrollTo\(state\.pageX, state\.pageY\)/);
  assert.match(monitorView, /window\.setInterval\(\(\) => refreshMonitor\(\{ preservePosition: true \}\), 5000\)/);
});

test('lista de conversaciones no habilita envío libre a números no asignados', () => {
  assert.doesNotMatch(monitorView, /data-conversation-phone[^>]+manual-message-button/);
  assert.match(monitorView, /manual-message-button/);
});
