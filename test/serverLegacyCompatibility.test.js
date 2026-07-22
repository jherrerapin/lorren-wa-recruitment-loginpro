import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/server.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('el middleware HTML no conserva el no-op de Meta Ads', () => {
  assert.doesNotMatch(source, /injectMetaAdsSyncButton/);

  const sendWrapper = between(
    "app.use('/public', express.static(path.join(__dirname, 'public')));",
    "app.use((req, res, next) => {\n  const originalRender"
  );

  assert.match(sendWrapper, /const originalSend = res\.send\.bind\(res\)/);
  assert.match(sendWrapper, /shouldReplaceLorenV2UiLabel\(output, res\)/);
  assert.match(sendWrapper, /output = replaceLorenV2UiLabel\(output\)/);
  assert.match(sendWrapper, /return originalSend\(output\)/);
  assert.doesNotMatch(sendWrapper, /MetaAds|metaAds|SyncButton/);
});

test('la transformación de render y el enlace de estadísticas permanecen caracterizados', () => {
  const renderWrapper = between(
    "app.use((req, res, next) => {\n  const originalRender",
    "app.use(morgan('combined'));"
  );

  assert.match(renderWrapper, /const originalRender = res\.render\.bind\(res\)/);
  assert.match(renderWrapper, /assignment-confirm-dialog\.js/);
  assert.match(renderWrapper, /assignment-template-sync\.js/);
  assert.match(renderWrapper, /injectLorenV2NavbarLink\(htmlWithDispatchScripts, req\)/);

  const navbar = between(
    'function injectLorenV2NavbarLink',
    'function mapDbRoleToSessionRole'
  );
  assert.match(navbar, /canSeeLorenV2\(req\)/);
  assert.match(navbar, /LOREN_STATS_BASE_PATH/);
  assert.match(navbar, /LOREN_STATS_UI_LABEL/);
});

test('las rutas GET legacy conservan status y destino', () => {
  const expectedRoutes = [
    "app.get(LOREN_STATS_LEGACY_BASE_PATH, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));",
    "app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/campaigns`));",
    "app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/reports`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));",
    "app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/daily-summary`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));",
    "app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/data-consents`, (_req, res) => res.redirect(301, LOREN_STATS_BASE_PATH));",
    "app.get(`${LOREN_STATS_LEGACY_BASE_PATH}/cv-analysis`, (_req, res) => res.redirect(301, `${LOREN_STATS_BASE_PATH}/cv-analysis`));"
  ];

  for (const route of expectedRoutes) assert.ok(source.includes(route), `Ruta legacy modificada: ${route}`);
});

test('las rutas POST legacy conservan redirects 308', () => {
  const expectedRoutes = [
    "app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns`));",
    "app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns/associate`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns/associate`));",
    "app.post(`${LOREN_STATS_LEGACY_BASE_PATH}/campaigns/:id/edit`, (req, res) => res.redirect(308, `${LOREN_STATS_BASE_PATH}/campaigns/${encodeURIComponent(req.params.id)}/edit`));"
  ];

  for (const route of expectedRoutes) assert.ok(source.includes(route), `Ruta POST legacy modificada: ${route}`);
});
