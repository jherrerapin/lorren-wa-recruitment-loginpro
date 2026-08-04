from pathlib import Path


def replace_once(pathname: str, old: str, new: str) -> None:
    path = Path(pathname)
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{pathname}: expected one match, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/public/worker-biometric-mobile.js',
    """  const DETECTION_INTERVAL_MS = 90;
  const SAMPLE_COMPLETION_GRACE_MS = 12_000;
""",
    """  const DETECTION_INTERVAL_MS = 90;
  const DETECTION_TIMEOUT_MS = 8_000;
  const SAMPLE_COMPLETION_GRACE_MS = 12_000;
"""
)

replace_once(
    'src/public/worker-biometric-mobile.js',
    """    try {
      result = await human.detect(video);
      runtimeLastUsedAt = Date.now();
    } catch (cause) {
      invalidateRuntime('detect-failed');
      const error = new Error('biometric_runtime_unavailable');
      error.cause = cause;
      throw error;
""",
    """    try {
      onStatus?.('Analizando tu rostro. Mantén la posición dentro del marco.');
      result = await withTimeout(
        human.detect(video),
        DETECTION_TIMEOUT_MS,
        'biometric_detection_timeout'
      );
      runtimeLastUsedAt = Date.now();
    } catch (cause) {
      const code = cause?.message === 'biometric_detection_timeout'
        ? 'biometric_detection_timeout'
        : 'biometric_runtime_unavailable';
      invalidateRuntime(code === 'biometric_detection_timeout' ? 'detect-timeout' : 'detect-failed');
      const error = new Error(code);
      error.cause = cause;
      throw error;
"""
)

replace_once(
    'src/public/worker-portal-biometric-flow.js',
    """  const FLOW_RELEASE = '20260804-biometric-marking-reliability-v3';
""",
    """  const FLOW_RELEASE = '20260804-biometric-detection-watchdog-v4';
"""
)

replace_once(
    'src/public/worker-portal-biometric-flow.js',
    """    'biometric_runtime_unavailable',
    'biometric_capture_timeout',
""",
    """    'biometric_runtime_unavailable',
    'biometric_detection_timeout',
    'biometric_capture_timeout',
"""
)

replace_once(
    'src/public/worker-portal-biometric-flow.js',
    """  const BACKEND_RECOVERY_ERRORS = new Set([
    'biometric_runtime_unavailable',
    'biometric_baseline_timeout',
""",
    """  const BACKEND_RECOVERY_ERRORS = new Set([
    'biometric_runtime_unavailable',
    'biometric_detection_timeout',
    'biometric_baseline_timeout',
"""
)

replace_once(
    'src/public/worker-portal-biometric-flow.js',
    """      biometric_runtime_unavailable: 'El reconocimiento facial se reinició, pero no pudo quedar listo.',
      biometric_enrollment_timeout: 'No se obtuvieron tres capturas válidas para registrar el rostro.',
""",
    """      biometric_runtime_unavailable: 'El reconocimiento facial se reinició, pero no pudo quedar listo.',
      biometric_detection_timeout: 'El análisis facial se demoró demasiado y fue reiniciado.',
      biometric_enrollment_timeout: 'No se obtuvieron tres capturas válidas para registrar el rostro.',
"""
)

replace_once(
    'src/public/worker-portal-biometric-flow.js',
    """    setInstruction('Mira de frente. La validación comenzará automáticamente.');
""",
    """    setInstruction('Abriendo cámara y preparando el análisis facial…');
"""
)

replace_once(
    'src/views/workerPortal.ejs',
    """    .mark-status { margin: 0; min-height: 62px; display: flex; align-items: center; font-size: clamp(18px, 4.8vw, 23px); line-height: 1.3; font-weight: 800; border: 2px solid #cbd6de; }
    #biometric-instruction { margin-top: 0; font-size: clamp(18px, 4.8vw, 23px); line-height: 1.3; font-weight: 800; color: #102a1b; }
""",
    """    .mark-status { margin: 0; min-height: 110px; display: flex; align-items: center; padding: 16px 18px; font-size: clamp(18px, 4.8vw, 23px); line-height: 1.3; font-weight: 800; border: 2px solid #cbd6de; }
    #biometric-instruction { display: none; }
"""
)

replace_once(
    'src/views/workerPortal.ejs',
    """      .mark-status, #biometric-instruction { font-size: 19px; }
""",
    """      .mark-status { font-size: 19px; }
"""
)

replace_once(
    'src/views/workerPortal.ejs',
    """            <p id=\"biometric-instruction\" class=\"step-copy\" role=\"status\" aria-live=\"assertive\" aria-atomic=\"true\">Mira de frente.</p>
""",
    """            <p id=\"biometric-instruction\" class=\"step-copy\" hidden aria-hidden=\"true\">Mira de frente.</p>
"""
)

replace_once(
    'src/views/workerPortal.ejs',
    """      <script src=\"/public/worker-biometric.js?v=20260803-worker-portal-runtime-v5\"></script>
""",
    """      <script src=\"/public/worker-biometric.js?v=20260804-worker-portal-biometric-v7\"></script>
"""
)

replace_once(
    'src/public/worker-biometric.js',
    """const BIOMETRIC_ASSET_RELEASE = '20260804-worker-portal-biometric-v6';
""",
    """const BIOMETRIC_ASSET_RELEASE = '20260804-worker-portal-biometric-v7';
"""
)

replace_once(
    'src/public/worker-portal-sw.js',
    """const CACHE_NAME = 'lorren-worker-portal-shell-v12';
""",
    """const CACHE_NAME = 'lorren-worker-portal-shell-v13';
"""
)

for test_path in Path('test').glob('*.test.js'):
    source = test_path.read_text(encoding='utf-8')
    updated = source.replace(
        '20260804-worker-portal-biometric-v6',
        '20260804-worker-portal-biometric-v7'
    ).replace(
        'lorren-worker-portal-shell-v12',
        'lorren-worker-portal-shell-v13'
    )
    if updated != source:
        test_path.write_text(updated, encoding='utf-8')

accessibility = Path('test/workerBiometricAccessibilityContracts.test.js')
accessibility_source = accessibility.read_text(encoding='utf-8')
anchor = """  assert.match(view, /aria-live=\"assertive\"/);
});
"""
replacement = """  assert.match(view, /aria-live=\"assertive\"/);
  assert.match(view, /id=\"biometric-instruction\"[^>]*hidden[^>]*aria-hidden=\"true\"/);
  assert.match(view, /#biometric-instruction\\s*\\{\\s*display:\\s*none/);
});
"""
if accessibility_source.count(anchor) != 1:
    raise SystemExit('accessibility contract anchor mismatch')
accessibility.write_text(accessibility_source.replace(anchor, replacement, 1), encoding='utf-8')

Path('test/workerBiometricDetectionWatchdogContracts.test.js').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mobile = read('src/public/worker-biometric-mobile.js');
const flow = read('src/public/worker-portal-biometric-flow.js');
const view = read('src/views/workerPortal.ejs');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');

test('cada inferencia facial tiene watchdog y no puede bloquear la marcación indefinidamente', () => {
  assert.match(mobile, /const DETECTION_TIMEOUT_MS = 8_000/);
  assert.match(mobile, /withTimeout\\([\\s\\S]*human\\.detect\\(video\\)[\\s\\S]*DETECTION_TIMEOUT_MS[\\s\\S]*biometric_detection_timeout/);
  assert.match(mobile, /invalidateRuntime\\(code === 'biometric_detection_timeout' \\? 'detect-timeout' : 'detect-failed'\\)/);
  assert.match(flow, /'biometric_detection_timeout'/);
  assert.match(flow, /El análisis facial se demoró demasiado y fue reiniciado/);
});

test('la interfaz muestra una sola instrucción amplia y mantiene el progreso accesible', () => {
  assert.match(view, /\\.mark-status \\{[^}]*min-height:\\s*110px/);
  assert.match(view, /#biometric-instruction \\{ display: none; \\}/);
  assert.match(view, /id=\"biometric-instruction\"[^>]*hidden[^>]*aria-hidden=\"true\"/);
  assert.match(view, /id=\"mark-result\"[^>]*aria-live=\"assertive\"/);
  assert.match(flow, /setInstruction\\('Abriendo cámara y preparando el análisis facial…'\\)/);
  assert.match(mobile, /Analizando tu rostro\. Mantén la posición dentro del marco\./);
});

test('la aplicación instalada recibe el motor y la caché corregidos', () => {
  assert.match(loader, /20260804-worker-portal-biometric-v7/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v13/);
  assert.match(view, /worker-biometric\.js\\?v=20260804-worker-portal-biometric-v7/);
});
""", encoding='utf-8')
