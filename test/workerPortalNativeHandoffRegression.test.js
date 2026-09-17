import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const loaderSource = fs.readFileSync(
  new URL('../src/public/worker-biometric.js', import.meta.url),
  'utf8'
);
const installSource = fs.readFileSync(
  new URL('../src/public/worker-portal-install.js', import.meta.url),
  'utf8'
);
const handoffSource = fs.readFileSync(
  new URL('../src/public/worker-portal-session-handoff.js', import.meta.url),
  'utf8'
);

function executeHandoff({
  userAgent,
  platform = '',
  userAgentDataPlatform = '',
  maxTouchPoints = 0,
  nativeBridge = false
}) {
  let clickListeners = 0;
  let observerStarts = 0;

  class FakeElement {}
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {
      observerStarts += 1;
    }
  }

  const navigatorStub = {
    userAgent,
    platform,
    maxTouchPoints,
    ...(userAgentDataPlatform
      ? { userAgentData: { platform: userAgentDataPlatform } }
      : {})
  };
  const windowStub = {
    navigator: navigatorStub,
    location: {
      href: 'https://portal.example/operaciones/portal',
      origin: 'https://portal.example'
    },
    setTimeout() {},
    ...(nativeBridge ? { LorrenAndroidPresence: {} } : {})
  };
  const documentStub = {
    documentElement: {},
    addEventListener(type) {
      if (type === 'click') clickListeners += 1;
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    createElement() {
      throw new Error('unexpected_element_creation');
    }
  };

  vm.runInNewContext(handoffSource, {
    window: windowStub,
    navigator: navigatorStub,
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    Element: FakeElement,
    URL,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    encodeURIComponent,
    console
  });

  return { clickListeners, observerStarts };
}

test('el instalador recupera la autoridad de handoff si el cargador antiguo la omite', () => {
  assert.match(loaderSource, /LOAD_WORKER_PORTAL_HANDOFF = \/Android/);
  assert.match(installSource, /HANDOFF_SCRIPT_PATH = '\/public\/worker-portal-session-handoff\.js'/);
  assert.match(installSource, /script\[src\^=/);
  assert.match(installSource, /document\.head\.append\(script\)/);
  assert.match(installSource, /LorrenBiometricAssetRelease/);
  assert.doesNotMatch(installSource, /sesion-transferencia\/crear/);
  assert.doesNotMatch(installSource, /lorren:\/\/portal\/transferencia/);
});

test('Android móvil conserva el handoff existente', () => {
  const state = executeHandoff({
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
    platform: 'Linux armv8l',
    maxTouchPoints: 5
  });

  assert.equal(state.clickListeners, 1);
  assert.equal(state.observerStarts, 1);
});

test('Chrome Android en modo escritorio conserva el handoff mediante la plataforma del navegador', () => {
  const state = executeHandoff({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    userAgentDataPlatform: 'Android',
    maxTouchPoints: 10
  });

  assert.equal(state.clickListeners, 1);
  assert.equal(state.observerStarts, 1);
});

test('el fallback táctil cubre Chromium Android de escritorio aunque no exponga UA-CH', () => {
  const state = executeHandoff({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    maxTouchPoints: 10
  });

  assert.equal(state.clickListeners, 1);
  assert.equal(state.observerStarts, 1);
});

test('el bridge nativo sigue identificando la APK sin depender del User-Agent', () => {
  const state = executeHandoff({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    nativeBridge: true
  });

  assert.equal(state.clickListeners, 1);
  assert.equal(state.observerStarts, 1);
});

test('iPhone y escritorio no táctil no activan el handoff Android', () => {
  const iphone = executeHandoff({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5
  });
  const desktop = executeHandoff({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    maxTouchPoints: 0
  });

  assert.deepEqual(iphone, { clickListeners: 0, observerStarts: 0 });
  assert.deepEqual(desktop, { clickListeners: 0, observerStarts: 0 });
});

test('la transferencia sigue teniendo una sola autoridad cliente', () => {
  assert.match(handoffSource, /sesion-transferencia\/crear/);
  assert.match(handoffSource, /lorren:\/\/portal\/transferencia\?transferencia=/);
  assert.match(handoffSource, /Ya instalé Lórren · abrir app/);
  assert.doesNotMatch(installSource, /session-handoff-native/);
  assert.doesNotMatch(installSource, /handoffToken/);
});
