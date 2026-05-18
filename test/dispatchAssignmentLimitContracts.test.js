import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const view = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');

test('dispatch assignment backend limits assignments to required workers', () => {
  assert.match(route, /post\('\/asignaciones\/assign'/);
  assert.match(route, /select:\s*\{\s*id:\s*true,\s*requiredWorkers:\s*true\s*\}/);
  assert.match(route, /dispatchAssignment\.count\(\{\s*where:\s*\{\s*serviceRequestId\s*\}\s*\}\)/);
  assert.match(route, /assignedCount\s*>=\s*serviceRequest\.requiredWorkers/);
  assert.match(route, /La solicitud ya tiene el numero de auxiliares requerido\./);
  assert.match(route, /dispatchAssignment\.findUnique\(\{\s*where:\s*\{\s*serviceRequestId_workerId:/);
  assert.match(route, /El auxiliar ya estaba asignado\./);
  assert.match(route, /assignedCount\s*>=\s*serviceRequest\.requiredWorkers[\s\S]*dispatchAssignment\.findUnique[\s\S]*dispatchAssignment\.create/);
});

test('dispatch assignment frontend blocks completed requests and displays remaining capacity', () => {
  assert.match(view, /remainingWorkers\s*=\s*Math\.max\(selectedServiceRequest\.requiredWorkers - selectedAssignedCount, 0\)/);
  assert.match(view, /selectedRequestComplete\s*=\s*remainingWorkers\s*===\s*0/);
  assert.match(view, /Faltan \$\{remainingWorkers\} auxiliares/);
  assert.match(view, /Solicitud completa\. No se pueden asignar más auxiliares\./);
  assert.match(view, /data-disabled="<%= selectedRequestComplete \? 'true' : 'false' %>"/);
  assert.match(view, /isDropZoneDisabled/);
  assert.match(view, /if \(isDropZoneDisabled\) return;[\s\S]*drag-over/);
  assert.match(view, /if \(isDropZoneDisabled\) \{[\s\S]*Solicitud completa\. No se pueden asignar más auxiliares\./);
});
