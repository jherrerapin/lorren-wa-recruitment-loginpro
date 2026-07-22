import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPortalActivationAbuseGuard } from '../src/services/workerPortalActivationAbuseGuard.js';

test('permite el umbral y bloquea intentos posteriores dentro de la ventana', () => {
  let now = 1_000;
  const guard = createWorkerPortalActivationAbuseGuard({
    windowMs: 60_000,
    maxAttempts: 2,
    maxEntries: 10,
    nowFn: () => now
  });

  assert.equal(guard.consume('10.0.0.1').allowed, true);
  assert.equal(guard.consume('10.0.0.1').allowed, true);
  const blocked = guard.consume('10.0.0.1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 60);

  now += 60_001;
  assert.equal(guard.consume('10.0.0.1').allowed, true);
});

test('mantiene el mapa acotado y expulsa la entrada menos reciente', () => {
  let now = 10_000;
  const guard = createWorkerPortalActivationAbuseGuard({
    windowMs: 600_000,
    maxAttempts: 5,
    maxEntries: 2,
    nowFn: () => now
  });

  guard.consume('ip-a');
  now += 1;
  guard.consume('ip-b');
  now += 1;
  guard.consume('ip-c');

  assert.equal(guard.getSize(), 2);
  assert.equal(guard.hasKey('ip-a'), false);
  assert.equal(guard.hasKey('ip-b'), true);
  assert.equal(guard.hasKey('ip-c'), true);
});

test('elimina entradas vencidas antes de admitir nuevas claves', () => {
  let now = 20_000;
  const guard = createWorkerPortalActivationAbuseGuard({
    windowMs: 100,
    maxAttempts: 2,
    maxEntries: 2,
    nowFn: () => now
  });

  guard.consume('ip-a');
  guard.consume('ip-b');
  now += 101;
  guard.consume('ip-c');

  assert.equal(guard.getSize(), 1);
  assert.equal(guard.hasKey('ip-a'), false);
  assert.equal(guard.hasKey('ip-b'), false);
  assert.equal(guard.hasKey('ip-c'), true);
});

test('normaliza claves vacías y limita claves excesivamente largas', () => {
  const guard = createWorkerPortalActivationAbuseGuard({
    maxAttempts: 1,
    maxEntries: 5,
    nowFn: () => 30_000
  });

  assert.equal(guard.consume('').allowed, true);
  assert.equal(guard.consume(null).allowed, false);

  const longKey = 'x'.repeat(500);
  assert.equal(guard.consume(longKey).allowed, true);
  assert.equal(guard.hasKey('x'.repeat(200)), true);
});

test('rechaza configuración permisiva o reloj inválido', () => {
  assert.throws(
    () => createWorkerPortalActivationAbuseGuard({ windowMs: 0 }),
    /worker_portal_activation_guard_window_ms_invalid/
  );
  assert.throws(
    () => createWorkerPortalActivationAbuseGuard({ maxAttempts: -1 }),
    /worker_portal_activation_guard_max_attempts_invalid/
  );
  assert.throws(
    () => createWorkerPortalActivationAbuseGuard({ maxEntries: 0 }),
    /worker_portal_activation_guard_max_entries_invalid/
  );
  assert.throws(
    () => createWorkerPortalActivationAbuseGuard({ nowFn: null }),
    /worker_portal_activation_guard_now_fn_required/
  );

  const guard = createWorkerPortalActivationAbuseGuard({ nowFn: () => Number.NaN });
  assert.throws(() => guard.consume('ip'), /worker_portal_activation_guard_now_invalid/);
});
