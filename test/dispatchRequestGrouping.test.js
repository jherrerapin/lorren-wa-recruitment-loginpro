import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupedServiceRequests,
  extractRequestGroupCode,
  resolveRequestServiceName
} from '../src/services/dispatchRequestGrouping.js';
import { buildTimeBlocks, resolveBlockServices } from '../src/routes/dispatchMultiShiftRequests.js';

test('cada fila conserva servicio y auxiliares propios aunque comparta fecha y horario', () => {
  const blocks = buildTimeBlocks({
    serviceDateBlock: ['2026-10-02', '2026-10-02'],
    requiredWorkers: ['2', '3'],
    serviceId: ['service-a', 'service-b'],
    startTime: ['08:00', '08:00'],
    endTime: ['16:00', '16:00']
  });
  const services = [{ id: 'service-a', name: 'Cargue' }, { id: 'service-b', name: 'Inventario' }];
  const resolved = resolveBlockServices(blocks, services, 'GRP-TEST');

  assert.deepEqual(resolved.map(({ serviceId, requiredWorkers }) => [serviceId, requiredWorkers]), [
    ['service-a', 2], ['service-b', 3]
  ]);
  assert.equal(resolved[0].serviceDate.getTime(), resolved[1].serviceDate.getTime());
  assert.equal(resolved[0].startTime, resolved[1].startTime);
  assert.match(resolved[0].serviceName, /Grupo GRP-TEST/);
  assert.throws(() => resolveBlockServices(blocks, services.slice(0, 1), null), /servicio válido del cliente/);
});

function assignment(status) {
  return { status, workerId: `worker-${status}`, worker: { fullName: `Auxiliar ${status}` } };
}

test('groups multi-shift dispatch requests by legacy group code', () => {
  const serviceRequests = [
    {
      id: 'morning-shift',
      clientName: 'Loginpro',
      serviceName: 'Cargue y descargue · Grupo GRP-ABC-01',
      serviceDate: '2026-06-10T00:00:00.000Z',
      startTime: '08:00',
      endTime: '12:00',
      requiredWorkers: 2,
      assignments: [assignment('CONFIRMED'), assignment('CONFIRMED')]
    },
    {
      id: 'afternoon-shift',
      clientName: 'Loginpro',
      serviceName: 'Cargue y descargue · Grupo GRP-ABC-01',
      serviceDate: '2026-06-10T00:00:00.000Z',
      startTime: '14:00',
      endTime: '18:00',
      requiredWorkers: 1,
      assignments: [assignment('CONFIRMATION_PENDING')]
    },
    {
      id: 'single-request',
      clientName: 'Otro cliente',
      serviceName: 'Inventario',
      serviceDate: '2026-06-10T00:00:00.000Z',
      startTime: '09:00',
      endTime: '11:00',
      requiredWorkers: 1,
      assignments: []
    }
  ];

  const groups = buildGroupedServiceRequests(serviceRequests);
  const grouped = groups.find((group) => group.groupCode === 'GRP-ABC-01');
  const single = groups.find((group) => group.primaryId === 'single-request');

  assert.equal(groups.length, 2);
  assert.equal(extractRequestGroupCode(serviceRequests[0]), 'GRP-ABC-01');
  assert.equal(resolveRequestServiceName(serviceRequests[0]), 'Cargue y descargue');
  assert.equal(grouped.isGrouped, true);
  assert.equal(grouped.requests.length, 2);
  assert.equal(grouped.requiredWorkers, 3);
  assert.equal(grouped.activeCount, 3);
  assert.equal(grouped.confirmedCount, 2);
  assert.equal(grouped.status, 'PENDING_CONFIRMATION');
  assert.equal(grouped.nextRequestId, 'afternoon-shift');
  assert.equal(single.isGrouped, false);
});
