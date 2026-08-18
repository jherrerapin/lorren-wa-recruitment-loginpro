import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  filterAttendanceAdminHtml,
  filterAttendanceFeatureHtml
} from '../src/routes/dispatchBridge.js';
import { loadAttendanceAdminBoard } from '../src/modules/dispatch-attendance/application/adminAttendance.js';

const runtimeSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-runtime-core.js', import.meta.url),
  'utf8'
);
const compactSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-compact.js', import.meta.url),
  'utf8'
);

const leafletHtml = `<!doctype html><html><body><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-invalid" crossorigin=""></script></body></html>`;

function attendanceBoardPrisma(assignment) {
  const prisma = {
    dispatchAssignment: {
      async findMany() { return [assignment]; },
      async findUnique() { return assignment; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return assignment.attendanceSession; },
      async create({ data }) { return { id: 'session-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) { return { id: 'mark-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) { return { id: 'review-created', ...data }; }
    }
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return prisma;
}

test('el runtime correctivo se carga solamente en el panel administrativo de asistencia', () => {
  const adminHtml = filterAttendanceAdminHtml(leafletHtml);
  assert.match(adminHtml, /\/public\/attendance-admin-runtime\.js/);
  assert.equal((adminHtml.match(/attendance-admin-runtime\.js/g) || []).length, 1);

  const pointConfigHtml = filterAttendanceFeatureHtml(leafletHtml, { allowed: true });
  assert.doesNotMatch(pointConfigHtml, /attendance-admin-runtime\.js/);
});

test('el runtime administrativo deja de generar puntajes y señales técnicas visibles', () => {
  assert.doesNotMatch(runtimeSource, /Puntaje de revisión:/);
  assert.doesNotMatch(runtimeSource, /riskTranslations|riskPresentation|translateRiskSignals|riskLevel/);
  assert.doesNotMatch(runtimeSource, /\.risk-score|\.risk-flag/);
  assert.match(compactSource, /removeAll\('\.attendance-risk-explanation, \.risk-score, \.risk-flag'\)/);
  assert.doesNotMatch(compactSource, /gridTemplateColumns/);
});

test('el tablero conserva las señales de riesgo como datos de auditoría aunque la tarjeta no las muestre', async () => {
  const offlineFlags = ['OFFLINE_WEB_CAPTURE', 'CLIENT_CLOCK_UNTRUSTED'];
  const assignment = {
    id: 'assignment-risk-origin',
    status: 'CONFIRMED',
    workerId: 'worker-risk-origin',
    worker: {
      id: 'worker-risk-origin',
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-1051',
      phone: 'TEST-PHONE'
    },
    serviceRequest: {
      id: 'request-risk-origin',
      serviceDate: new Date('2026-08-12T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      clientName: 'Cliente Prueba',
      operationPointName: 'Punto Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.6,
        attendanceLongitude: -74.1,
        geofenceRadiusMeters: 100,
        absenceGraceMinutes: 15,
        manualAttendanceAllowed: true
      }
    },
    attendanceSession: {
      id: 'session-risk-origin',
      attendanceStatus: 'ARRIVAL_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      punctualityStatus: 'ON_TIME',
      riskScore: 40,
      riskFlags: offlineFlags,
      arrivalReportedAt: new Date('2026-08-12T13:00:00.000Z'),
      marks: [
        {
          id: 'mark-arrival-offline',
          markType: 'ARRIVAL',
          serverReceivedAt: new Date('2026-08-12T13:10:00.000Z'),
          clientCapturedAt: new Date('2026-08-12T13:00:00.000Z'),
          riskScore: 40,
          riskFlags: offlineFlags,
          latitude: 4.6,
          longitude: -74.1,
          accuracyMeters: 12,
          distanceToPointMeters: 0,
          insideGeofence: true
        },
        {
          id: 'mark-break-legacy',
          markType: 'BREAK_START',
          serverReceivedAt: new Date('2026-08-12T17:00:00.000Z'),
          clientCapturedAt: new Date('2026-08-12T17:00:00.000Z'),
          riskScore: 40,
          riskFlags: offlineFlags,
          latitude: 4.6,
          longitude: -74.1,
          accuracyMeters: 12,
          distanceToPointMeters: 0,
          insideGeofence: true
        }
      ],
      reviews: []
    }
  };

  const board = await loadAttendanceAdminBoard(attendanceBoardPrisma(assignment), {
    from: '2026-08-12',
    to: '2026-08-12',
    now: new Date('2026-08-12T18:00:00.000Z')
  });

  assert.equal(board.rows.length, 1);
  assert.deepEqual(board.rows[0].riskGroups, [{
    markType: 'ARRIVAL',
    label: 'Llegada',
    riskFlags: offlineFlags,
    riskScore: 40,
    occurredAtLabel: board.rows[0].riskGroups[0].occurredAtLabel
  }]);
  assert.match(board.rows[0].riskGroups[0].occurredAtLabel, /12.*ago.*2026/i);
  assert.deepEqual(board.rows[0].riskFlags, [
    'ARRIVAL::OFFLINE_WEB_CAPTURE',
    'ARRIVAL::CLIENT_CLOCK_UNTRUSTED'
  ]);
});

test('el mapa administrativo usa OSM primero y conserva IDECA como respaldo', () => {
  const osmIndex = runtimeSource.indexOf("label: 'OpenStreetMap'");
  const idecaIndex = runtimeSource.indexOf("label: 'Mapa oficial IDECA · UAECD'");
  assert.ok(osmIndex >= 0);
  assert.ok(idecaIndex > osmIndex);
  assert.match(runtimeSource, /TILE_TIMEOUT_MS = 5_000/);
  assert.match(runtimeSource, /tileerror/);
  assert.match(runtimeSource, /activateProvider\(map, state, index \+ 1\)/);
});

test('el mapa recalcula tamaño, centro y zoom al abrir tarjetas y geocerca', () => {
  assert.match(runtimeSource, /map\.invalidateSize/);
  assert.match(runtimeSource, /map\.setView/);
  assert.match(runtimeSource, /\[data-map-details\], \[data-attendance-card\]/);
  assert.match(runtimeSource, /\[0, 80, 260, 700\]/);
});
