from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'No se encontró el bloque requerido: {label}')
    if text.count(old) != 1:
        raise SystemExit(f'El bloque {label} aparece {text.count(old)} veces')
    return text.replace(old, new, 1)


# 1) Recuperación real de inicialización atascada en la fachada canónica.
path = Path('src/services/dispatchWhatsappWebService.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "const STALLED_INITIALIZATION_TIMEOUT_MS = Math.max(60000, Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000));\nconst HEALTH_PROBE_TIMEOUT_MS",
    "const STALLED_INITIALIZATION_TIMEOUT_MS = Math.max(15000, Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000));\nconst STALLED_INITIALIZATION_ERROR = 'La inicialización de WhatsApp de despacho superó el tiempo máximo. El sistema reinició la conexión automáticamente.';\nconst HEALTH_PROBE_TIMEOUT_MS",
    'constante de recuperación de inicialización'
)
text = replace_once(
    text,
    "let initializingSeenAtMs = null;\nlet runtimeEnvironmentPrepared = false;",
    "let initializingSeenAtMs = null;\nlet stalledInitializationError = null;\nlet runtimeEnvironmentPrepared = false;",
    'estado de error de inicialización'
)
marker = "async function runDispatchWhatsappWatchdog(reason = 'interval') {"
helper = """function hasInitializationProgress(status = {}) {
  return Boolean(status.ready || status.lastQr || status.lastError || status.manualLogoutRequested);
}

async function recoverStalledInitialization(status = getRuntimeStatus(), reason = 'status') {
  if (!status.initializing || hasInitializationProgress(status)) {
    initializingSeenAtMs = null;
    if (status.ready || status.lastQr) stalledInitializationError = null;
    return false;
  }

  const now = Date.now();
  if (!initializingSeenAtMs) {
    initializingSeenAtMs = now;
    return false;
  }
  if (now - initializingSeenAtMs < STALLED_INITIALIZATION_TIMEOUT_MS) return false;

  initializingSeenAtMs = null;
  stalledInitializationError = STALLED_INITIALIZATION_ERROR;
  console.warn(`[dispatch-wa] ${STALLED_INITIALIZATION_ERROR} reason=${reason}`);
  await restartDispatchWhatsappClient(`stalled:${reason}`);
  return true;
}

"""
text = replace_once(text, marker, helper + marker, 'helper de recuperación compartido')
old_watchdog = """    if (status.initializing && !status.ready && !status.lastQr && !status.lastError) {
      const now = Date.now();
      if (!initializingSeenAtMs) {
        initializingSeenAtMs = now;
      } else if (now - initializingSeenAtMs >= STALLED_INITIALIZATION_TIMEOUT_MS) {
        console.warn('[dispatch-wa] Watchdog detectó una inicialización atascada. Reiniciando el cliente sin cerrar la sesión persistida.');
        initializingSeenAtMs = null;
        await restartDispatchWhatsappClient(`watchdog:${reason}`);
        return;
      }
    } else {
      initializingSeenAtMs = null;
    }

    initDispatchWhatsappClient();"""
new_watchdog = """    if (await recoverStalledInitialization(status, `watchdog:${reason}`)) return;

    initDispatchWhatsappClient();"""
text = replace_once(text, old_watchdog, new_watchdog, 'recuperación del watchdog')
text = replace_once(
    text,
    """export function initDispatchWhatsappClient() {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  return initRuntimeClient();
}

export function getDispatchWhatsappStatus() {
  return getRuntimeStatus();
}

export async function getDispatchWhatsappStatusView(options = {}) {
  return getRuntimeStatusView(options);
}""",
    """export function initDispatchWhatsappClient() {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  if (!status.ready && !status.initializing && !status.lastQr && !status.lastError) {
    initializingSeenAtMs = Date.now();
  }
  return initRuntimeClient();
}

export function getDispatchWhatsappStatus() {
  const status = getRuntimeStatus();
  if (status.ready || status.lastQr) stalledInitializationError = null;
  return { ...status, lastError: status.lastError || stalledInitializationError };
}

export async function getDispatchWhatsappStatusView(options = {}) {
  let status = await getRuntimeStatusView(options);
  if (await recoverStalledInitialization(status, 'status-view')) {
    status = await getRuntimeStatusView({ autoStart: false });
  }
  if (status.ready || status.lastQr) stalledInitializationError = null;
  return { ...status, lastError: status.lastError || stalledInitializationError };
}""",
    'API canónica de estado e inicio'
)
text = replace_once(
    text,
    """export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  killStaleChromiumProcesses(status.authDataPath || resolveAuthDataPath());
  return restartRuntimeClient(reason);
}""",
    """export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  killStaleChromiumProcesses(status.authDataPath || resolveAuthDataPath());
  const restarted = await restartRuntimeClient(reason);
  initializingSeenAtMs = Date.now();
  return restarted;
}""",
    'reinicio con seguimiento temporal'
)
text = replace_once(
    text,
    """export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
  runtimeEnvironmentPrepared = false;
  readyHealthFailures = 0;
  return closeRuntimeSession();
}""",
    """export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
  runtimeEnvironmentPrepared = false;
  readyHealthFailures = 0;
  initializingSeenAtMs = null;
  stalledInitializationError = null;
  return closeRuntimeSession();
}""",
    'limpieza de seguimiento al cerrar sesión'
)
path.write_text(text, encoding='utf-8')


# 2) La UI deja de mostrar un cargador indefinido cuando ya existe error.
path = Path('src/views/operacionesWhatsappEstado.ejs')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """        <div id="waitingQr" <%= !ready && !qrImage && (!lastError || initializing || reconnecting) ? '' : 'hidden' %>>""",
    """        <div id="waitingQr" <%= !ready && !qrImage && !lastError ? '' : 'hidden' %>>""",
    'estado inicial de preparación'
)
text = replace_once(
    text,
    """        <div class="info-box" id="unavailableBox" <%= !ready && !qrImage && lastError && !initializing && !reconnecting ? '' : 'hidden' %>>""",
    """        <div class="info-box" id="unavailableBox" <%= !ready && !qrImage && lastError ? '' : 'hidden' %>>""",
    'estado inicial no disponible'
)
text = replace_once(
    text,
    """      setHidden(waitingQr, data.ready || Boolean(data.qrImage) || (hasError && !isPreparingConnection));
      setHidden(unavailableBox, data.ready || Boolean(data.qrImage) || !hasError || isPreparingConnection);""",
    """      setHidden(waitingQr, data.ready || Boolean(data.qrImage) || hasError);
      setHidden(unavailableBox, data.ready || Boolean(data.qrImage) || !hasError);""",
    'render dinámico sin carga infinita'
)
path.write_text(text, encoding='utf-8')


# 3) El formulario de cliente de prueba solo existe para dev.
path = Path('src/views/operacionesClientes.ejs')
text = path.read_text(encoding='utf-8')
old_field = """            <div class="field"><label for="isTestClient">Tipo de cliente</label><select id="isTestClient" name="isTestClient"><option value="false" <%= formClient.isTestClient !== true ? 'selected' : '' %>>Cliente real</option><option value="true" <%= formClient.isTestClient === true ? 'selected' : '' %>>Cliente de prueba</option></select><small class="muted">Las solicitudes de un cliente de prueba pueden eliminarse en cualquier momento. La edición conserva el límite de dos horas.</small></div>"""
new_field = """            <% if (role === 'dev') { %>
              <div class="field"><label for="isTestClient">Tipo de cliente</label><select id="isTestClient" name="isTestClient"><option value="false" <%= formClient.isTestClient !== true ? 'selected' : '' %>>Cliente real</option><option value="true" <%= formClient.isTestClient === true ? 'selected' : '' %>>Cliente de prueba</option></select><small class="muted">Configuración exclusiva de DEV. Las solicitudes de un cliente de prueba pueden eliminarse en cualquier momento; la edición conserva el límite de dos horas.</small></div>
            <% } %>"""
text = replace_once(text, old_field, new_field, 'selector exclusivo de dev')
path.write_text(text, encoding='utf-8')


# 4) Protección server-side en la ruta realmente usada por el formulario.
path = Path('src/routes/publicDispatchClient.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {""",
    """function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function isDev(req) {
  return (req.session?.userRole || req.userRole) === 'dev';
}

function canUseOps(req) {""",
    'helper isDev en ruta pública/administrativa'
)
old_build = """function buildClientData(body) {
  return {
    name: normalizeString(body.name),
    nit: normalizeString(body.nit),
    cityName: normalizeString(body.cityName),
    contactName: normalizeString(body.contactName),
    contactPhone: normalizeString(body.contactPhone),
    contactEmail: normalizeString(body.contactEmail),
    notes: normalizeString(body.notes),
    isActive: normalizeString(body.isActive) !== 'false',
    isTestClient: normalizeString(body.isTestClient) === 'true'
  };
}"""
new_build = """function buildClientData(body, { canManageTestClient = false } = {}) {
  return {
    name: normalizeString(body.name),
    nit: normalizeString(body.nit),
    cityName: normalizeString(body.cityName),
    contactName: normalizeString(body.contactName),
    contactPhone: normalizeString(body.contactPhone),
    contactEmail: normalizeString(body.contactEmail),
    notes: normalizeString(body.notes),
    isActive: normalizeString(body.isActive) !== 'false',
    ...(canManageTestClient ? { isTestClient: normalizeString(body.isTestClient) === 'true' } : {})
  };
}"""
text = replace_once(text, old_build, new_build, 'datos de cliente condicionados por rol')
if text.count('const data = buildClientData(req.body);') != 2:
    raise SystemExit('Se esperaban dos usos administrativos de buildClientData')
text = text.replace(
    'const data = buildClientData(req.body);',
    'const data = buildClientData(req.body, { canManageTestClient: isDev(req) });'
)
path.write_text(text, encoding='utf-8')


# 5) Protección equivalente en las rutas administrativas canónicas históricas.
path = Path('src/routes/dispatchBridgeCore.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "function isOpsUser(req) { const username = normalizeString(req.session?.username || req.username); return Boolean(username?.startsWith('operaciones-despacho')); }\nfunction canUseOps(req)",
    "function isOpsUser(req) { const username = normalizeString(req.session?.username || req.username); return Boolean(username?.startsWith('operaciones-despacho')); }\nfunction isDev(req) { return (req.session?.userRole || req.userRole) === 'dev'; }\nfunction canUseOps(req)",
    'helper isDev en core'
)
text = replace_once(
    text,
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', isTestClient: normalizeString(req.body.isTestClient) === 'true', createdByUsername:",
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', ...(isDev(req) ? { isTestClient: normalizeString(req.body.isTestClient) === 'true' } : {}), createdByUsername:",
    'creación de cliente condicionada en core'
)
text = replace_once(
    text,
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', isTestClient: normalizeString(req.body.isTestClient) === 'true' } }); return res.redirect",
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', ...(isDev(req) ? { isTestClient: normalizeString(req.body.isTestClient) === 'true' } : {}) } }); return res.redirect",
    'edición de cliente condicionada en core'
)
path.write_text(text, encoding='utf-8')


# 6) Regresión focalizada.
Path('test/dispatchWhatsappLoadingAndTestClientAccess.test.js').write_text("""import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('el estado de WhatsApp recupera una inicialización atascada y no mantiene el cargador cuando existe error', () => {
  const service = read('src/services/dispatchWhatsappWebService.js');
  const view = read('src/views/operacionesWhatsappEstado.ejs');

  assert.match(service, /STALLED_INITIALIZATION_ERROR/);
  assert.match(service, /async function recoverStalledInitialization/);
  assert.match(service, /await recoverStalledInitialization\(status, 'status-view'\)/);
  assert.match(service, /await restartDispatchWhatsappClient\(`stalled:\$\{reason\}`\)/);
  assert.match(service, /lastError: status\.lastError \|\| stalledInitializationError/);
  assert.match(view, /setHidden\(waitingQr, data\.ready \|\| Boolean\(data\.qrImage\) \|\| hasError\)/);
  assert.match(view, /setHidden\(unavailableBox, data\.ready \|\| Boolean\(data\.qrImage\) \|\| !hasError\)/);
});

test('solo dev puede ver y persistir la marca de cliente de prueba', () => {
  const view = read('src/views/operacionesClientes.ejs');
  const publicRoute = read('src/routes/publicDispatchClient.js');
  const coreRoute = read('src/routes/dispatchBridgeCore.js');

  const devGate = view.indexOf("<% if (role === 'dev') { %>");
  const testField = view.indexOf('name="isTestClient"');
  const gateClose = view.indexOf('<% } %>', testField);
  assert.ok(devGate >= 0 && testField > devGate && gateClose > testField);

  assert.match(publicRoute, /function isDev\(req\)/);
  assert.match(publicRoute, /buildClientData\(body, \{ canManageTestClient = false \} = \{\}\)/);
  assert.match(publicRoute, /\.\.\.\(canManageTestClient \? \{ isTestClient:/);
  assert.equal((publicRoute.match(/canManageTestClient: isDev\(req\)/g) || []).length, 2);

  assert.match(coreRoute, /function isDev\(req\)/);
  assert.equal((coreRoute.match(/\.\.\.\(isDev\(req\) \? \{ isTestClient:/g) || []).length, 2);
  assert.doesNotMatch(coreRoute, /isActive:[^\n]+isTestClient: normalizeString\(req\.body\.isTestClient\)/);
});
""", encoding='utf-8')
