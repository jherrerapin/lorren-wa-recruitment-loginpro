import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDevShareableUserContact } from '../src/routes/admin.js';

const adminSource = fs.readFileSync('src/routes/admin.js', 'utf8');
const detailView = fs.readFileSync('src/views/detail.ejs', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.ok(startIndex >= 0, `No se encontró ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `No se encontró ${end}`);
  return content.slice(startIndex, endIndex);
}

test('DEV comparte solo usuarios no-DEV activos con teléfono persistido válido', () => {
  assert.deepEqual(buildDevShareableUserContact({
    id: 'user-coordinator-1', role: 'ADMIN', isActive: true,
    displayName: 'Coordinación Prueba', dispatchAlertPhone: '3001112233'
  }), {
    id: 'user-coordinator-1', label: 'Coordinación Prueba', displayPhone: '+57 300 111 2233'
  });
  assert.equal(buildDevShareableUserContact({
    id: 'user-dev-1', role: 'DEV', isActive: true,
    displayName: 'DEV Prueba', dispatchAlertPhone: '3001112233'
  }), null);
  assert.equal(buildDevShareableUserContact({
    id: 'user-inactive-1', role: 'ADMIN', isActive: false,
    displayName: 'Usuario Inactivo', dispatchAlertPhone: '3001112233'
  }), null);
  assert.equal(buildDevShareableUserContact({
    id: 'user-no-phone-1', role: 'ADMIN', isActive: true,
    displayName: 'Sin Teléfono', dispatchAlertPhone: '123'
  }), null);
  assert.equal(buildDevShareableUserContact({
    id: 'user-fallback-1', role: 'ADMIN', isActive: true,
    displayName: 'Coordinación Respaldo', recoveryPhone: '3004445566'
  })?.displayPhone, '+57 300 444 5566');
});

test('detalle DEV carga contactos por ID desde AppUser y nunca expone usuarios DEV', () => {
  const route = between(adminSource, "router.get('/candidates/:id'", "router.post('/candidates/:id/bot-pause'");
  assert.match(route, /prisma\.appUser\.findMany\(/);
  assert.match(route, /where:\s*\{\s*isActive:\s*true,\s*role:\s*\{\s*not:\s*'DEV'\s*\}\s*\}/);
  assert.match(route, /shareableUserContacts/);
});

test('envío de contacto resuelve AppUser en servidor y usa la entrega manual canónica', () => {
  const route = between(adminSource, "router.post('/candidates/:id/outbound'", "router.post('/candidates/:id/request-hv'");
  assert.match(route, /action === 'share_user_contact'/);
  assert.match(route, /normalizeString\(req\.body\.contactUserId\)/);
  assert.match(route, /prisma\.appUser\.findFirst\(/);
  assert.match(route, /role:\s*\{\s*not:\s*'DEV'\s*\}/);
  assert.doesNotMatch(route, /req\.body\.(?:phone|displayPhone|dispatchAlertPhone|recoveryPhone|contactName)/);
  assert.match(route, /sendAdminOutboundMessage\(prisma, candidate, body/);
  assert.match(route, /source:\s*action === 'share_user_contact' \? 'admin_share_user_contact'/);
  assert.match(route, /preserveExactBody:\s*action === 'free_text' \|\| action === 'share_user_contact'/);
});

test('DEV muestra un botón por contacto y el historial identifica citaciones y contactos enviados', () => {
  assert.match(detailView, /name="action" value="share_user_contact"/);
  assert.match(detailView, /name="contactUserId" value="<%= contact\.id %>"/);
  assert.match(detailView, /Enviar <%= contact\.label %> · <%= contact\.displayPhone %>/);
  assert.match(detailView, /admin_interview_template/);
  assert.match(detailView, /Citación de entrevista/);
  assert.match(detailView, /admin_share_user_contact/);
  assert.match(detailView, /Contacto enviado por DEV/);
  assert.doesNotMatch(detailView, /name="(?:phone|displayPhone|dispatchAlertPhone|recoveryPhone|contactName)"/);
});
