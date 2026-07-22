// Regresión del contrato de auxiliar y de la selección automática por historial operativo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  rankHistoricalWorkers,
  selectAutoAssignmentCandidates,
  timeRangesOverlap
} from '../src/services/dispatchAutoAssignment.js';

test('prioriza frecuencia confirmada, recencia y nombre de forma determinista', () => {
  const worker = (id, fullName) => ({ id, fullName, operationalStatus: 'CONTRATADO', cities: [] });
  const history = [
    { workerId: 'w2', worker: worker('w2', 'Beatriz'), updatedAt: '2026-07-10T10:00:00Z' },
    { workerId: 'w1', worker: worker('w1', 'Andrés'), updatedAt: '2026-07-01T10:00:00Z' },
    { workerId: 'w1', worker: worker('w1', 'Andrés'), updatedAt: '2026-07-02T10:00:00Z' },
    { workerId: 'w3', worker: worker('w3', 'Camilo'), updatedAt: '2026-07-11T10:00:00Z' }
  ];

  assert.deepEqual(
    rankHistoricalWorkers(history).map((item) => item.workerId),
    ['w1', 'w3', 'w2']
  );
});

test('detecta cruces reales y permite turnos consecutivos', () => {
  assert.equal(
    timeRangesOverlap(
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '11:00', endTime: '14:00' }
    ),
    true
  );
  assert.equal(
    timeRangesOverlap(
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '16:00' }
    ),
    false
  );
  assert.equal(
    timeRangesOverlap(
      { startTime: '08:00', endTime: null },
      { startTime: '08:00', endTime: '12:00' }
    ),
    true
  );
});

test('selecciona por ciudad y excluye auxiliares con horario cruzado', () => {
  const rankedWorkers = [
    {
      workerId: 'cruce',
      confirmedCount: 8,
      worker: {
        fullName: 'Cruce',
        operationalStatus: 'CONTRATADO',
        residenceCity: 'Bogotá',
        cities: []
      }
    },
    {
      workerId: 'elegible',
      confirmedCount: 5,
      worker: {
        fullName: 'Elegible',
        operationalStatus: 'CONTRATADO',
        residenceCity: 'Siberia',
        cities: []
      }
    },
    {
      workerId: 'otra-ciudad',
      confirmedCount: 12,
      worker: {
        fullName: 'Otra ciudad',
        operationalStatus: 'CONTRATADO',
        residenceCity: 'Neiva',
        cities: []
      }
    }
  ];

  const selected = selectAutoAssignmentCandidates({
    rankedWorkers,
    activeAssignments: [{
      workerId: 'cruce',
      serviceRequest: { startTime: '09:00', endTime: '13:00' }
    }],
    request: { cityName: 'Bogotá D.C.', startTime: '10:00', endTime: '12:00' },
    limit: 2
  });

  assert.deepEqual(selected.map((item) => item.workerId), ['elegible']);
});

test('contrato y autoasignación quedan conectados al flujo real', async () => {
  const [
    schema,
    migration,
    form,
    board,
    opsRoute,
    publicRoute,
    multiShiftRoute,
    service
  ] = await Promise.all([
    readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8'),
    readFile(new URL('../prisma/migrations/20260722010000_add_dispatch_worker_contract_type/migration.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesPersonalNuevo.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/dispatchOpsExtras.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/publicDispatchClient.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/dispatchMultiShiftRequests.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/dispatchAutoAssignment.js', import.meta.url), 'utf8')
  ]);

  assert.match(schema, /enum DispatchContractType\s*\{[\s\S]*DIRECTO[\s\S]*CONTRATISTA[\s\S]*\}/);
  assert.match(schema, /contractType\s+DispatchContractType\s+@default\(DIRECTO\)/);
  assert.match(migration, /ADD COLUMN "contractType"/);
  assert.match(form, /name="contractType"/);
  assert.match(form, />Directo</);
  assert.match(form, />Contratista</);
  assert.match(board, /contractLabel\(worker\.contractType\)/);
  assert.match(board, /contractLabel\(assignment\.worker\.contractType\)/);
  assert.match(opsRoute, /contractType:\s*normalizeDispatchContractType\(body\.contractType\)/);
  assert.match(publicRoute, /contractType:\s*normalizeDispatchContractType\(body\.contractType\)/);
  assert.match(multiShiftRoute, /autoAssignServiceRequests\(prisma, createdRequests/);
  assert.match(service, /status:\s*'CONFIRMATION_PENDING'/);
  assert.doesNotMatch(service, /status:\s*'CONFIRMED'\s*,\s*notes:\s*AUTO_ASSIGNMENT_NOTE/);
});
