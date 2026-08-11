import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('el lockfile no conserva el runtime retirado de WhatsApp Web', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const rootDependencies = lock.packages?.['']?.dependencies || {};

  for (const packageName of ['whatsapp-web.js', 'qrcode', 'qrcode-terminal']) {
    assert.equal(rootDependencies[packageName], undefined, `${packageName} no debe seguir declarado en el lockfile raíz`);
    assert.equal(lock.packages?.[`node_modules/${packageName}`], undefined, `${packageName} no debe seguir instalado en el lockfile`);
  }

  for (const packagePath of [
    'node_modules/puppeteer',
    'node_modules/puppeteer-core',
    'node_modules/@puppeteer/browsers'
  ]) {
    assert.equal(lock.packages?.[packagePath], undefined, `${packagePath} pertenece al runtime retirado`);
  }
});

test('el tablero de asignaciones usa la plantilla oficial y no mensajes libres', () => {
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(view, /WhatsApp oficial de despacho/);
  assert.match(view, /Enviar plantilla a todos/);
  assert.match(view, /JSON\.stringify\(\{phone,context\}\)/);

  for (const legacyPattern of [
    /Mensaje base para WhatsApp/,
    /assignment-message/,
    /globalTemplate/,
    /waMessage/,
    /JSON\.stringify\(\{phone,message,context\}\)/
  ]) {
    assert.doesNotMatch(view, legacyPattern);
  }
});

test('CI no conserva banderas del runtime de WhatsApp Web ni Puppeteer', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.doesNotMatch(workflow, /DISPATCH_WWEB_/);
  assert.doesNotMatch(workflow, /PUPPETEER_SKIP_DOWNLOAD/);
});

test('los destinatarios de programación se configuran por entorno y no por código', () => {
  const route = read('src/routes/dispatchProgrammingNotifications.js');
  const envExample = read('.env.example');

  assert.match(route, /DISPATCH_PROGRAMMING_WHATSAPP_RECIPIENTS/);
  assert.match(envExample, /DISPATCH_PROGRAMMING_WHATSAPP_RECIPIENTS=/);

  for (const legacyPattern of [
    /DEFAULT_PROGRAMMING_WHATSAPP_RECIPIENTS/,
    /CODE_TEST_PROGRAMMING_WHATSAPP_RECIPIENTS/,
    /testRecipients/
  ]) {
    assert.doesNotMatch(route, legacyPattern);
  }
});


test('la confirmación operativa queda bajo autoridad del webhook oficial', () => {
  const opsRoutes = read('src/routes/dispatchOpsExtras.js');
  const audit = read('src/services/dispatchAuditMiddleware.js');
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.doesNotMatch(opsRoutes, /DISPATCH_ASSIGNMENT_WHATSAPP|DEFAULT_ASSIGNMENT_TEMPLATE|dispatchMessageTemplate/);
  assert.doesNotMatch(opsRoutes, /\/asignaciones\/confirmar|\/api\/asignacion-template|\/asignaciones\/template/);
  assert.doesNotMatch(audit, /\/asignaciones\/confirmar|DISPATCH_ASSIGNMENT_CONFIRM/);
  assert.doesNotMatch(view, /data-async-assignment-action="confirmar"|\/asignaciones\/confirmar/);
  assert.match(webhook, /recalculateDispatchServiceRequestStatus/);
  assert.match(webhook, /sendDispatchCompletionEmail/);
  assert.match(view, /data-async-assignment-action="no-confirmado"/);
});
