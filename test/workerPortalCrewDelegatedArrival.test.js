import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignmentForMark,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';

const NOW = new Date('2026-08-21T13:30:00.000Z');
const WORKER_ID = 'TEST-WORKER-AUX';
const ASSIGNMENT_ID = 'TEST-ASSIGNMENT-CREW';

function assignmentFixture(overrides = {}) {
  return {
    id: ASSIGNMENT_ID,
    workerId: WORKER_ID,
    serviceRequestId: 'TEST-SERVICE-CREW',
    status: 'CONFIRMED',
    attendanceSession: null,
    serviceRequest: {
      id: 'TEST-SERVICE-CREW',
      clientName: 'Cliente Prueba',
      operationPointName: 'Operación Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      serviceDate: new Date('2026-08-21T00:00:00.000Z'),
      startTime: '08:30',
      endTime: '17:00',
      operationPoint: {
        id: 'TEST-OPERATION-CREW',
        name: 'Operación Prueba',
        cityName: 'Bogotá',
        address: 'Dirección de prueba',
        attendanceEnabled: true,
        attendancePhotoPolicy: 'RISK_ONLY'
      }
    },
    ...overrides
  };
}

function prismaFor(record = assignmentFixture()) {
  return {
    dispatchAssignment: {
      async findMany() { return [record]; },
      async findFirst() { return record; }
    },
    dispatchWorker: {
      async findUnique() {
        return { fullName: 'Persona Prueba Auxiliar', documentNumber: 'TEST-DOC-CREW' };
      }
    }
  };
}

function crewContext(overrides = {}) {
  return {
    assignmentId: ASSIGNMENT_ID,
    serviceRequestId: 'TEST-SERVICE-CREW',
    mode: 'CREW',
    crewAvailable: true,
    isCrewLeader: false,
    ...overrides
  };
}

const contexts = (...items) => async () => items;

test('auxiliar de cuadrilla disponible delega todas sus marcaciones al encargado', async () => {
  const [assignment] = await loadWorkerPortalAssignments(prismaFor(), {
    workerId: WORKER_ID,
    now: NOW,
    loadCrewContextsFn: contexts(crewContext())
  });

  assert.equal(assignment.arrivalDelegatedToCrewLeader, true);
  assert.equal(assignment.markDelegatedToCrewLeader, true);
  assert.equal(assignment.canRegisterArrival, false);
  assert.equal(assignment.canStartBreak, false);
  assert.equal(assignment.canEndBreak, false);
  assert.equal(assignment.canRegisterDeparture, false);
  assert.equal(assignment.breakActionType, null);
  assert.equal(assignment.actionType, 'BLOCKED');
  assert.equal(assignment.actionLabel, 'Las marcaciones las registra el encargado de cuadrilla');
  assert.doesNotMatch(assignment.actionLabel, /registrar llegada|marcar entrada/i);
});

test('encargado conserva la llegada de cuadrilla y un crew no disponible conserva fallback individual', async () => {
  const [leader] = await loadWorkerPortalAssignments(prismaFor(), {
    workerId: WORKER_ID,
    now: NOW,
    loadCrewContextsFn: contexts(crewContext({ isCrewLeader: true }))
  });
  const [unavailable] = await loadWorkerPortalAssignments(prismaFor(), {
    workerId: WORKER_ID,
    now: NOW,
    loadCrewContextsFn: contexts(crewContext({ crewAvailable: false }))
  });

  assert.equal(leader.arrivalDelegatedToCrewLeader, false);
  assert.equal(leader.markDelegatedToCrewLeader, false);
  assert.equal(leader.canRegisterArrival, true);
  assert.equal(leader.actionLabel, 'Registrar llegada');
  assert.equal(unavailable.arrivalDelegatedToCrewLeader, false);
  assert.equal(unavailable.markDelegatedToCrewLeader, false);
  assert.equal(unavailable.canRegisterArrival, true);
  assert.equal(unavailable.actionLabel, 'Registrar llegada');
});

test('consulta puntual bloquea cualquier marcación individual del auxiliar crew disponible', async () => {
  const prisma = prismaFor();
  const input = {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    now: NOW,
    loadCrewContextsFn: contexts(crewContext())
  };

  const arrival = await loadWorkerPortalAssignmentForArrival(prisma, input);
  const genericMark = await loadWorkerPortalAssignmentForMark(prisma, input);

  assert.equal(arrival, null);
  assert.equal(genericMark, null);
});

test('la vista consume la proyección server-side y no inventa otra regla de cuadrilla', async () => {
  const view = await readFile(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
  const arrivalBranch = view.match(/<% if \(!assignment\.arrivalReported && !assignment\.departureReported\) \{ %>[\s\S]*?<% \} else if \(!assignment\.departureReported\) \{ %>/)?.[0] || '';

  assert.match(arrivalBranch, /assignment\.canRegisterArrival \? '' : 'disabled'/);
  assert.match(arrivalBranch, /<%= assignment\.actionLabel %>/);
  assert.doesNotMatch(arrivalBranch, />Registrar llegada<\/button>/);
});
