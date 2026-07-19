import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_TOKEN_BYTES,
  generateActivationToken,
  hashActivationToken,
  hashInstallationId,
  normalizeActivationTtlMinutes
} from '../src/modules/dispatch-attendance/domain/deviceActivationPolicy.js';
import {
  activatePrimaryDevice,
  issuePrimaryDeviceActivation
} from '../src/modules/dispatch-attendance/application/primaryDeviceActivation.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const PEPPER = 'attendance-installation-pepper-32-chars-minimum';
const INSTALLATION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function deterministicBytes(length) {
  assert.equal(length, ACTIVATION_TOKEN_BYTES);
  return Buffer.alloc(length, 7);
}

function createRepository() {
  const activations = new Map();
  const devices = new Map();
  const revoked = [];
  let activationSequence = 0;
  let deviceSequence = 0;

  return {
    activations,
    devices,
    revoked,
    async findActiveWorker(workerId) {
      return workerId === 'worker-1' ? { id: workerId, operationalStatus: 'CONTRATADO' } : null;
    },
    async replacePendingActivation(input) {
      for (const activation of activations.values()) {
        if (activation.workerId === input.workerId && activation.status === 'PENDING') {
          activation.status = 'REVOKED';
          activation.revokedAt = input.createdAt;
        }
      }
      const row = { id: `activation-${++activationSequence}`, status: 'PENDING', ...input };
      activations.set(row.tokenHash, row);
      return row;
    },
    async claimActivationAndAuthorizePrimaryDevice(input) {
      const activation = activations.get(input.tokenHash);
      if (!activation || activation.purpose !== input.purpose || activation.status !== 'PENDING') return null;
      if (activation.expiresAt <= input.now) return null;

      activation.status = 'CONSUMED';
      activation.consumedAt = input.now;

      for (const device of devices.values()) {
        if (device.workerId === activation.workerId && device.authorizationType === 'PRIMARY' && device.status === 'ACTIVE') {
          device.status = 'REVOKED';
          device.revokedAt = input.now;
          revoked.push(device.id);
        }
      }

      const device = {
        id: `device-${++deviceSequence}`,
        workerId: activation.workerId,
        installationIdHash: input.installationIdHash,
        authorizationType: 'PRIMARY',
        status: 'ACTIVE',
        activatedAt: input.now,
        userAgent: input.userAgent,
        platform: input.platform
      };
      devices.set(device.id, device);
      return { workerId: device.workerId, deviceId: device.id, activatedAt: device.activatedAt };
    }
  };
}

test('genera un token base64url de 256 bits y persiste solo su hash', async () => {
  const repository = createRepository();
  const result = await issuePrimaryDeviceActivation({
    repository,
    workerId: 'worker-1',
    now: NOW,
    ttlMinutes: 30,
    randomBytesFn: deterministicBytes
  });

  assert.equal(result.rawToken.length, 43);
  assert.equal(result.expiresAt.toISOString(), '2026-07-19T12:30:00.000Z');
  const persisted = repository.activations.get(hashActivationToken(result.rawToken));
  assert.ok(persisted);
  assert.equal(Object.hasOwn(persisted, 'rawToken'), false);
});

test('una nueva emisión revoca la activación pendiente anterior', async () => {
  const repository = createRepository();
  const first = await issuePrimaryDeviceActivation({ repository, workerId: 'worker-1', now: NOW, randomBytesFn: deterministicBytes });
  const secondBytes = () => Buffer.alloc(ACTIVATION_TOKEN_BYTES, 8);
  const second = await issuePrimaryDeviceActivation({ repository, workerId: 'worker-1', now: new Date(NOW.getTime() + 1000), randomBytesFn: secondBytes });

  assert.equal(repository.activations.get(hashActivationToken(first.rawToken)).status, 'REVOKED');
  assert.equal(repository.activations.get(hashActivationToken(second.rawToken)).status, 'PENDING');
});

test('rechaza trabajador inexistente o inactivo', async () => {
  await assert.rejects(
    issuePrimaryDeviceActivation({ repository: createRepository(), workerId: 'worker-x', now: NOW }),
    /activation_worker_not_active/
  );
});

test('limita el TTL a valores enteros entre 5 minutos y 24 horas', () => {
  assert.equal(normalizeActivationTtlMinutes(5), 5);
  assert.equal(normalizeActivationTtlMinutes(1440), 1440);
  [0, 4, 1441, 10.5, 'abc'].forEach((value) => assert.throws(() => normalizeActivationTtlMinutes(value), /activation_ttl_invalid/));
});

test('activa el dispositivo principal y consume el token una sola vez', async () => {
  const repository = createRepository();
  const issued = await issuePrimaryDeviceActivation({ repository, workerId: 'worker-1', now: NOW, randomBytesFn: deterministicBytes });

  const activated = await activatePrimaryDevice({
    repository,
    rawToken: issued.rawToken,
    installationId: INSTALLATION_ID,
    installationPepper: PEPPER,
    userAgent: 'Browser test',
    platform: 'Android',
    now: new Date(NOW.getTime() + 60_000)
  });

  assert.equal(activated.workerId, 'worker-1');
  assert.equal(activated.authorizationType, 'PRIMARY');
  assert.equal(repository.activations.get(hashActivationToken(issued.rawToken)).status, 'CONSUMED');
  await assert.rejects(
    activatePrimaryDevice({ repository, rawToken: issued.rawToken, installationId: INSTALLATION_ID, installationPepper: PEPPER, now: new Date(NOW.getTime() + 120_000) }),
    /activation_token_unavailable/
  );
});

test('rechaza token vencido', async () => {
  const repository = createRepository();
  const issued = await issuePrimaryDeviceActivation({ repository, workerId: 'worker-1', now: NOW, ttlMinutes: 5, randomBytesFn: deterministicBytes });
  await assert.rejects(
    activatePrimaryDevice({ repository, rawToken: issued.rawToken, installationId: INSTALLATION_ID, installationPepper: PEPPER, now: new Date(NOW.getTime() + 5 * 60_000 + 1) }),
    /activation_token_unavailable/
  );
});

test('rechaza token e identificador de instalación con formatos inválidos', async () => {
  await assert.rejects(
    activatePrimaryDevice({ repository: createRepository(), rawToken: 'short', installationId: INSTALLATION_ID, installationPepper: PEPPER, now: NOW }),
    /activation_token_invalid/
  );
  await assert.rejects(
    activatePrimaryDevice({ repository: createRepository(), rawToken: generateActivationToken(deterministicBytes), installationId: 'not-a-uuid', installationPepper: PEPPER, now: NOW }),
    /installation_id_invalid/
  );
});

test('requiere un pepper de servidor robusto para hash de instalación', () => {
  assert.throws(() => hashInstallationId(INSTALLATION_ID, 'short'), /installation_pepper_too_short/);
  assert.equal(hashInstallationId(INSTALLATION_ID, PEPPER).length, 64);
});

test('el mismo UUID produce hashes distintos con peppers diferentes', () => {
  const first = hashInstallationId(INSTALLATION_ID, PEPPER);
  const second = hashInstallationId(INSTALLATION_ID, `${PEPPER}-different`);
  assert.notEqual(first, second);
});

test('exige puertos transaccionales explícitos del repositorio', async () => {
  await assert.rejects(
    issuePrimaryDeviceActivation({ repository: {}, workerId: 'worker-1', now: NOW }),
    /activation_repository_findActiveWorker_required/
  );
  await assert.rejects(
    activatePrimaryDevice({ repository: {}, rawToken: generateActivationToken(deterministicBytes), installationId: INSTALLATION_ID, installationPepper: PEPPER, now: NOW }),
    /activation_repository_claimActivationAndAuthorizePrimaryDevice_required/
  );
});
