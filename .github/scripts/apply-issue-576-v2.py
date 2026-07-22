from pathlib import Path

recipe_path = Path('.github/scripts/apply-issue-576.py')
recipe = recipe_path.read_text(encoding='utf-8')
prefix, separator, _test_section = recipe.partition("test_path = 'test/dispatchWhatsappRuntimeContracts.test.js'")
if not separator:
    raise SystemExit('No se encontró el inicio de la sección de contratos en la receta #576.')

# Ejecuta únicamente las transformaciones verificadas de vista, ruta y servicios.
exec(compile(prefix, str(recipe_path), 'exec'), {})

test_path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
content = test_path.read_text(encoding='utf-8')

line_replacements = [
    (
        "  assert.match(source, /killStaleChromiumProcesses\\(status\\.authDataPath \\|\\| resolveAuthDataPath\\(\\)\\)/);",
        "  assert.match(watchdog, /await restartDispatchWhatsappClient\\(`watchdog:\\$\\{reason\\}`\\)/);"
    ),
    (
        "  assert.match(source, /scheduleStalledRecoveryProbe\\(\\)/);",
        "  assert.doesNotMatch(source, /scheduleStalledRecoveryProbe/);"
    ),
    (
        "  assert.doesNotMatch(source, /closeRuntimeSession\\(\\)\\.catch/);",
        "  assert.doesNotMatch(watchdog, /closeDispatchWhatsappSession|closeRuntimeSession/);"
    )
]
for old, new in line_replacements:
    if new in content and old not in content:
        continue
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'Contrato watchdog: se esperaba una coincidencia para {old!r} y se encontraron {count}')
    content = content.replace(old, new, 1)

start_marker = "test('WhatsApp storage diagnostics remain restricted to DEV'"
end_marker = "test('stale cleanup includes uncertain delivery and pending automatic replies'"
start = content.find(start_marker)
end = content.find(end_marker, start + len(start_marker))
new_tests = """test('WhatsApp status view omits storage implementation details and surfaces polling failures', () => {
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
if start < 0 or end < 0:
    if "test('WhatsApp status view omits storage implementation details" not in content:
        raise SystemExit(f'No se encontraron los límites del contrato visual: start={start} end={end}')
else:
    content = content[:start] + new_tests + content[end:]

test_path.write_text(content, encoding='utf-8')
