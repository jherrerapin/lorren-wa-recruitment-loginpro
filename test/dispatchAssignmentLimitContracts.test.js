import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const view = fs.readFileSync('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8');

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
  assert.match(view, /remainingWorkers=Math\.max\(selectedServiceRequest\.requiredWorkers-selectedActiveCount,0\)/);
  assert.match(view, /coverageComplete=selectedActiveCount>=selectedServiceRequest\.requiredWorkers/);
  assert.match(view, /selectedRequestComplete=selectedConfirmedCount>=selectedServiceRequest\.requiredWorkers/);
  assert.match(view, /Faltan \$\{remainingWorkers\} auxiliares/);
  assert.match(view, /Cobertura completa\. Espera confirmación o marca no confirmado para liberar cupo\./);
  assert.match(view, /data-disabled="<%= coverageComplete\?'true':'false' %>"/);
  assert.match(view, /drop\?\.dataset\.disabled==='true'/);
  assert.match(view, /dragover[^\n]*drop\.dataset\.disabled==='true'/);
  assert.match(view, /drop[^\n]*dataset\.disabled==='true'[\s\S]*No puedes asignar aquí en este momento\./);
});
