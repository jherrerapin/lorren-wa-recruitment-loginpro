from pathlib import Path

path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
text = path.read_text(encoding='utf-8')
old = """  assert.match(source, /let initializingSeenAtMs = null/);
  assert.match(source, /DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS/);
  assert.match(source, /status\.initializing && !status\.ready && !status\.lastQr && !status\.lastError/);
  assert.match(watchdog, /await restartDispatchWhatsappClient\(`watchdog:\$\{reason\}`\)/);
  assert.doesNotMatch(source, /scheduleStalledRecoveryProbe/);
  assert.doesNotMatch(watchdog, /closeDispatchWhatsappSession|closeRuntimeSession/);"""
new = """  assert.match(source, /let initializingSeenAtMs = null/);
  assert.match(source, /DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS/);
  assert.match(source, /async function recoverStalledInitialization/);
  assert.match(source, /status\.initializing/);
  assert.match(source, /await restartDispatchWhatsappClient\(`stalled:\$\{reason\}`\)/);
  assert.match(watchdog, /await recoverStalledInitialization\(status, `watchdog:\$\{reason\}`\)/);
  assert.match(source, /await recoverStalledInitialization\(status, 'status-view'\)/);
  assert.doesNotMatch(source, /scheduleStalledRecoveryProbe/);
  assert.doesNotMatch(watchdog, /closeDispatchWhatsappSession|closeRuntimeSession/);"""
if old not in text:
    raise SystemExit('No se encontró el contrato histórico de recuperación del watchdog')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
