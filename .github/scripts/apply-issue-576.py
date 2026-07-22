from pathlib import Path


def replace_exact(path, old, new):
    file_path = Path(path)
    content = file_path.read_text(encoding='utf-8')
    if new in content and old not in content:
        return
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'{path}: se esperaba una coincidencia y se encontraron {count}')
    file_path.write_text(content.replace(old, new, 1), encoding='utf-8')


view_path = 'src/views/operacionesWhatsappEstado.ejs'
replace_exact(
    view_path,
    """    .storage-box { border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; border-radius: 14px; padding: 11px 13px; display: grid; gap: 3px; font-size: 12px; }
    .storage-box.persistent { border-color: #86efac; background: #f0fdf4; color: #166534; }
    .storage-box.ephemeral { border-color: #fdba74; background: #fff7ed; color: #9a3412; }
""",
    ''
)
replace_exact(
    view_path,
    """        <% if (role === 'dev') { %><div class=\"storage-box <%= authStoragePersistent ? 'persistent' : 'ephemeral' %>\" id=\"storageBox\"><strong id=\"storageLabel\"><%= authStoragePersistent ? 'Sesión persistente' : 'Sesión en almacenamiento efímero' %></strong><span id=\"storageText\"><%= authStoragePersistent ? 'LocalAuth está dentro de almacenamiento persistente.' : (authStorageWarning || 'La sesión puede perderse al reiniciar o desplegar.') %></span></div><% } %>
""",
    ''
)
replace_exact(
    view_path,
    """    const storageBox = document.getElementById('storageBox');
    const storageLabel = document.getElementById('storageLabel');
    const storageText = document.getElementById('storageText');
""",
    ''
)
replace_exact(
    view_path,
    """    function renderStorageStatus(data) {
      const persistent = Boolean(data.authStoragePersistent);
      if (storageBox) storageBox.className = 'storage-box ' + (persistent ? 'persistent' : 'ephemeral');
      if (storageLabel) storageLabel.textContent = persistent ? 'Sesión persistente' : 'Sesión en almacenamiento efímero';
      if (storageText) storageText.textContent = persistent ? 'LocalAuth está dentro de almacenamiento persistente.' : (data.authStorageWarning || 'La sesión puede perderse al reiniciar o desplegar.');
    }
""",
    ''
)
replace_exact(view_path, "      renderStorageStatus(data);\n", '')
replace_exact(
    view_path,
    """    async function refreshStatus() {
      const response = await fetch('/admin/operaciones/whatsapp/estado', { cache: 'no-store' });
      if (!response.ok) return;
      renderStatus(await response.json());
    }
    document.getElementById('refreshStatus')?.addEventListener('click', refreshStatus);
    renderReadyAt(readyAtText?.dataset.rawReadyAt || readyAtText?.textContent || '');
    window.setInterval(refreshStatus, 3000);
""",
    """    function renderStatusError() {
      renderStatus({
        ready: false,
        initializing: false,
        reconnecting: false,
        qrImage: null,
        lastError: fallbackOperationalError,
        technicalLastError: null,
        lastReadyAt: null
      });
    }
    async function refreshStatus() {
      try {
        const response = await fetch('/admin/operaciones/whatsapp/estado', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`Estado HTTP ${response.status}`);
        renderStatus(await response.json());
      } catch (error) {
        console.error('No fue posible consultar el estado de WhatsApp despacho.', error);
        renderStatusError();
      }
    }
    document.getElementById('refreshStatus')?.addEventListener('click', refreshStatus);
    renderReadyAt(readyAtText?.dataset.rawReadyAt || readyAtText?.textContent || '');
    refreshStatus();
    window.setInterval(refreshStatus, 3000);
"""
)

runtime_path = 'src/services/dispatchWhatsappWebServiceV6.js'
replace_exact(
    runtime_path,
    "const CATCHUP_MIN_INTERVAL_MS = Number(process.env.DISPATCH_WA_CATCHUP_MIN_INTERVAL_MS || 60000);\n",
    "const CATCHUP_MIN_INTERVAL_MS = Number(process.env.DISPATCH_WA_CATCHUP_MIN_INTERVAL_MS || 60000);\nconst CLIENT_DESTROY_TIMEOUT_MS = Math.max(1000, Number(process.env.DISPATCH_WWEB_DESTROY_TIMEOUT_MS || 5000));\n"
)
replace_exact(
    runtime_path,
    """function resetClientReference() {
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  if (oldClient) oldClient.destroy().catch((error) => console.warn('No fue posible cerrar completamente el cliente anterior de WhatsApp despacho.', error));
}

async function getReadyClient() {
""",
    """function resetClientReference() {
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  if (oldClient) oldClient.destroy().catch((error) => console.warn('No fue posible cerrar completamente el cliente anterior de WhatsApp despacho.', error));
}

async function destroyClientWithoutLogout(activeClient) {
  if (!activeClient) return;
  let timeoutId = null;
  try {
    await Promise.race([
      Promise.resolve(activeClient.destroy()),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, CLIENT_DESTROY_TIMEOUT_MS);
        timeoutId.unref?.();
      })
    ]);
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible destruir completamente el cliente durante la recuperación.', error?.message || error);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (manualLogoutRequested) return getDispatchWhatsappStatus();
  clearReconnectTimer();
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  lastError = null;
  await destroyClientWithoutLogout(oldClient);
  const dataPath = ensureAuthDataPath();
  cleanupChromiumProfileLocks(dataPath);
  console.warn(`[dispatch-wa] Reiniciando cliente sin cerrar la sesión persistida. reason=${reason}`);
  initDispatchWhatsappClient();
  return getDispatchWhatsappStatus();
}

async function getReadyClient() {
"""
)

facade_path = 'src/services/dispatchWhatsappWebService.js'
replace_exact(
    facade_path,
    """  initDispatchWhatsappClient as initRuntimeClient,
  sendDispatchWhatsappMediaMessage,
""",
    """  initDispatchWhatsappClient as initRuntimeClient,
  restartDispatchWhatsappClient as restartRuntimeClient,
  sendDispatchWhatsappMediaMessage,
"""
)
replace_exact(
    facade_path,
    "const STALLED_RECOVERY_PROBE_MS = Math.max(1000, Number(process.env.DISPATCH_WWEB_STALLED_RECOVERY_PROBE_MS || 3000));\n",
    ''
)
replace_exact(
    facade_path,
    """function scheduleStalledRecoveryProbe() {
  const timer = setTimeout(() => {
    runDispatchWhatsappWatchdog('stalled_recovery').catch(() => {});
  }, STALLED_RECOVERY_PROBE_MS);
  timer.unref?.();
}

""",
    ''
)
replace_exact(
    facade_path,
    """        console.warn('[dispatch-wa] Watchdog detectó una inicialización atascada. Limpiando Chromium para permitir la recuperación.');
        killStaleChromiumProcesses(status.authDataPath || resolveAuthDataPath());
        initializingSeenAtMs = now;
        scheduleStalledRecoveryProbe();
        return;
""",
    """        console.warn('[dispatch-wa] Watchdog detectó una inicialización atascada. Reiniciando el cliente sin cerrar la sesión persistida.');
        initializingSeenAtMs = null;
        await restartDispatchWhatsappClient(`watchdog:${reason}`);
        return;
"""
)
replace_exact(
    facade_path,
    """export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
""",
    """export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  killStaleChromiumProcesses(status.authDataPath || resolveAuthDataPath());
  return restartRuntimeClient(reason);
}

export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
"""
)

route_path = 'src/routes/dispatchWaRouterV2.js'
replace_exact(
    route_path,
    "import { closeDispatchWhatsappSession, getDispatchWhatsappStatusView, initDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebService.js';\n",
    "import { closeDispatchWhatsappSession, getDispatchWhatsappStatusView, initDispatchWhatsappClient, restartDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebService.js';\n"
)
replace_exact(
    route_path,
    """  closeDispatchWhatsappSession()
    .catch((error) => console.warn('[dispatch-wa] No fue posible cerrar completamente el cliente atascado.', error?.message || error))
    .finally(() => {
      recoveryInProgress = false;
      initDispatchWhatsappClient();
    });
""",
    """  restartDispatchWhatsappClient('estado atascado detectado desde el panel')
    .catch((error) => console.warn('[dispatch-wa] No fue posible reiniciar el cliente atascado.', error?.message || error))
    .finally(() => {
      recoveryInProgress = false;
    });
"""
)

test_path = 'test/dispatchWhatsappRuntimeContracts.test.js'
replace_exact(
    test_path,
    """  assert.match(watchdog, /killStaleChromiumProcesses\(status\.authDataPath \|\| resolveAuthDataPath\(\)\)/);
  assert.match(source, /scheduleStalledRecoveryProbe\(\)/);
  assert.doesNotMatch(source, /closeRuntimeSession\(\)\.catch/);
""",
    """  assert.match(watchdog, /await restartDispatchWhatsappClient\(`watchdog:\$\{reason\}`\)/);
  assert.doesNotMatch(source, /scheduleStalledRecoveryProbe/);
  assert.doesNotMatch(watchdog, /closeDispatchWhatsappSession|closeRuntimeSession/);
"""
)
replace_exact(
    test_path,
    """test('WhatsApp storage diagnostics remain restricted to DEV', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.match(view, /<% if \(role === 'dev'\) \{ %><div class=\"storage-box/);
  assert.match(view, /id=\"storageBox\"/);
  assert.match(view, /Sesión persistente/);
  assert.match(view, /Sesión en almacenamiento efímero/);
  assert.match(view, /renderStorageStatus\(data\)/);
});
""",
    """test('WhatsApp status view omits storage implementation details and surfaces polling failures', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.doesNotMatch(view, /storage-box|storageBox|storageLabel|storageText/);
  assert.doesNotMatch(view, /Sesión persistente|Sesión en almacenamiento efímero|LocalAuth|renderStorageStatus/);
  assert.match(view, /function renderStatusError\(\)/);
  assert.match(view, /catch \(error\)/);
  assert.match(view, /renderStatusError\(\)/);
  assert.match(view, /refreshStatus\(\);\s*window\.setInterval\(refreshStatus, 3000\)/);
});

test('stalled recovery releases the client without deleting LocalAuth session data', () => {
  const runtime = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const restart = between(runtime, 'export async function restartDispatchWhatsappClient', 'async function getReadyClient');
  assert.match(restart, /client = null/);
  assert.match(restart, /initializing = false/);
  assert.match(restart, /destroyClientWithoutLogout\(oldClient\)/);
  assert.match(restart, /cleanupChromiumProfileLocks\(dataPath\)/);
  assert.match(restart, /initDispatchWhatsappClient\(\)/);
  assert.doesNotMatch(restart, /logout\(/);
});

test('panel stalled recovery uses non-destructive restart instead of manual logout', () => {
  const route = readSource('src/routes/dispatchWaRouterV2.js');
  const recovery = between(route, 'function recoverStalledInitialization()', 'async function getStatusForViewer');
  assert.match(route, /restartDispatchWhatsappClient/);
  assert.match(recovery, /restartDispatchWhatsappClient\('estado atascado detectado desde el panel'\)/);
  assert.doesNotMatch(recovery, /closeDispatchWhatsappSession\(/);
});
"""
)
