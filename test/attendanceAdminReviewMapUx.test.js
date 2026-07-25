import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveAttendanceReviewReason } from '../src/routes/dispatchAttendanceAdmin.js';
import { enrichAttendanceBoardWithWorkday } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

const viewSource = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

test('la tarjeta solo ofrece las fotografías explícitas de entrada y salida', () => {
  assert.equal(occurrences(viewSource, 'Ver fotografía de entrada'), 1);
  assert.equal(occurrences(viewSource, 'Ver fotografía de salida'), 1);
  assert.doesNotMatch(viewSource, />Ver fotografía<\/a>/);
  assert.doesNotMatch(viewSource, /row\.evidenceAvailable&&row\.markId/);
});

test('un solo mapa cambia entre entrada, salida y ambas marcaciones', () => {
  assert.match(viewSource, /data-arrival-lat=/);
  assert.match(viewSource, /data-departure-lat=/);
  assert.match(viewSource, /data-map-mode="arrival"/);
  assert.match(viewSource, /data-map-mode="departure"/);
  assert.match(viewSource, /data-map-mode="both"/);
  assert.match(viewSource, /L\.layerGroup\(\)/);
  assert.match(viewSource, /markLayers\.clearLayers\(\)/);
  assert.equal(occurrences(viewSource, 'class="attendance-map"'), 1);
});

test('la revisión hace opcional el motivo a tiempo y autocompleta el retraso', () => {
  assert.match(viewSource, /class="review-form attendance-validation-form"/);
  assert.match(viewSource, /reason\.required = late/);
  assert.match(viewSource, /Observación opcional/);
  assert.match(viewSource, /Llegada tarde por \$\{minutes\} minutos/);
});

test('el servidor genera un motivo auditable para una validación a tiempo sin texto', async () => {
  let reads = 0;
  const reason = await resolveAttendanceReviewReason({
    dispatchAttendanceSession: {
      async findUnique() {
        reads += 1;
        return null;
      }
    }
  }, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'ON_TIME',
    reason: ''
  });

  assert.equal(reason, 'Validación de llegada a tiempo.');
  assert.equal(reads, 0);
});

test('el servidor calcula el retraso con las horas persistidas y no con el navegador', async () => {
  const reason = await resolveAttendanceReviewReason({
    dispatchAttendanceSession: {
      async findUnique(input) {
        assert.deepEqual(input, {
          where: { id: 'session-2' },
          select: { arrivalReportedAt: true, expectedStartAt: true }
        });
        return {
          expectedStartAt: new Date('2026-07-25T13:00:00.000Z'),
          arrivalReportedAt: new Date('2026-07-25T13:17:45.000Z')
        };
      }
    }
  }, {
    sessionId: 'session-2',
    action: 'VALIDATE',
    attendanceStatus: 'LATE',
    reason: ''
  });

  assert.equal(reason, 'Llegada tarde por 17 minutos frente a la hora programada.');
});

test('el enriquecimiento separa coordenadas y minutos de retraso de entrada y salida', async () => {
  const board = {
    rows: [{
      assignmentId: 'assignment-1',
      markId: 'legacy-mark',
      expectedStartAt: '2026-07-25T13:00:00.000Z'
    }]
  };
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [{
          id: 'assignment-1',
          serviceRequestId: 'request-1',
          attendanceSession: {
            arrivalReportedAt: new Date('2026-07-25T13:12:30.000Z'),
            departureReportedAt: new Date('2026-07-25T21:00:00.000Z'),
            workedMinutes: 408,
            marks: [
              {
                id: 'departure-mark',
                markType: 'DEPARTURE',
                serverReceivedAt: new Date('2026-07-25T21:00:00.000Z'),
                latitude: '4.7002',
                longitude: '-74.1002',
                evidenceStorageKey: 'attendance/worker/assignment/departure/file.jpg'
              },
              {
                id: 'arrival-mark',
                markType: 'ARRIVAL',
                serverReceivedAt: new Date('2026-07-25T13:12:30.000Z'),
                latitude: '4.7001',
                longitude: '-74.1001',
                evidenceStorageKey: 'attendance/worker/assignment/arrival/file.jpg'
              }
            ]
          }
        }];
      }
    },
    async $queryRaw() {
      return [];
    },
    async $executeRaw() {
      return 0;
    }
  };

  const result = await enrichAttendanceBoardWithWorkday(prisma, board);
  const row = result.rows[0];
  assert.equal(row.arrivalLatitude, 4.7001);
  assert.equal(row.arrivalLongitude, -74.1001);
  assert.equal(row.departureLatitude, 4.7002);
  assert.equal(row.departureLongitude, -74.1002);
  assert.equal(row.lateMinutes, 12);
  assert.equal(row.arrivalEvidenceAvailable, true);
  assert.equal(row.departureEvidenceAvailable, true);
});
