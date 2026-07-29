import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('la cuenta WhatsApp de prueba usa LocalAuth y almacenamiento distintos', async () => {
  const source = await read('src/services/dispatchTestWhatsappWebService.js');
  assert.match(source, /new WhatsappLocalAuth\(\{ clientId: 'dispatch-test', dataPath \}\)/);
  assert.match(source, /dispatch-wweb-auth-test/);
  assert.match(source, /DISPATCH_TEST_WWEB_AUTH_PATH/);
  assert.doesNotMatch(source, /clientId: 'dispatch'/);
});

test('los envíos y confirmaciones de prueba exigen solicitud y sujeto DEV_TEST', async () => {
  const source = await read('src/services/dispatchTestWhatsappWebService.js');
  assert.match(source, /serviceRequest: \{ source: DEV_TEST_REQUEST_SOURCE \}/);
  assert.match(source, /worker: \{ isTestProfile: true \}/);
  assert.match(source, /DEV_TEST_ASSIGNED/);
  assert.match(source, /DEV_TEST_CONFIRMED/);
  assert.match(source, /isAutomaticConfirmationReply/);
  assert.match(source, /resolveDispatchWhatsappChatAliases/);
});

test('la sesión operativa no consulta estados de confirmación DEV_TEST', async () => {
  const operational = await read('src/services/dispatchWhatsappWebServiceV6.js');
  assert.doesNotMatch(operational, /DEV_TEST_PENDING/);
  assert.doesNotMatch(operational, /DEV_TEST_DELIVERY_UNKNOWN/);
  assert.doesNotMatch(operational, /DEV_TEST_CONFIRMED/);
});

test('las rutas WhatsApp de prueba permanecen detrás del router exclusivo de DEV', async () => {
  const route = await read('src/routes/dispatchDevPayrollTest.js');
  assert.match(route, /router\.use\(requireDev\)/);
  assert.match(route, /router\.get\('\/whatsapp'/);
  assert.match(route, /router\.get\('\/whatsapp\/estado'/);
  assert.match(route, /router\.post\('\/whatsapp\/cerrar-sesion'/);
  assert.match(route, /router\.post\('\/whatsapp\/enviar'/);
});

test('Nómina conserva explícitamente el modo de prueba al recalcular', async () => {
  const view = await read('src/views/operacionesNomina.ejs');
  assert.match(view, /name="includeTest" value="true"/);
  assert.match(view, /report\.filters\.includeTest \? 'checked'/);
  assert.match(view, /Modo de prueba activo/);
});
