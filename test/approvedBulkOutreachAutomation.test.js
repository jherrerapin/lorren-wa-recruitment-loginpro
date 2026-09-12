import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';
import {
  MANUAL_OUTBOUND_TRANSPORT,
  resolveManualOutboundTransport
} from '../src/services/manualOutboundDeliveryService.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function approvedClientScriptBody(html = '') {
  const match = String(html).match(/<script\s+data-approved-recruitment-ux>([\s\S]*?)<\/script>/i);
  return match?.[1] || '';
}

function renderBulkHtml() {
  return [
    '<html><body>',
    '<a href="/admin/outreach/approved" class="export-btn">Mensajes a aprobados</a>',
    '<table id="legacy-candidates-table"><tbody>',
    '<tr><td>fecha</td><td>Persona Prueba</td><td></td><td></td><td></td><td></td><td></td><td></td><td><span class="badge badge-registrado">Registrado</span></td><td></td><td><a class="link-detail" href="/admin/candidates/candidate-test-1">Ver</a></td></tr>',
    '</tbody></table>',
    '</body></html>'
  ].join('');
}

function renderDetailHtml() {
  return [
    '<html><body>',
    '<form method="post" action="/admin/candidates/candidate-test-1/status" class="status-form">',
    '<input type="hidden" name="returnTo" value="/admin?status=registered" />',
    '<select name="status"><option value="REGISTRADO" selected>Registrado</option><option value="APROBADO">Aprobado</option></select>',
    '<button type="submit">Guardar</button>',
    '</form>',
    '</body></html>'
  ].join('');
}

test('cualquier cambio masivo a APROBADO encadena el outreach configurado existente', () => {
  const script = approvedClientScriptBody(enhanceApprovedRecruitmentUx(renderBulkHtml()));

  assert.match(script, /const autoOutreachOnApproval = status === 'APROBADO'/);
  assert.match(script, /postCandidateStatus\(candidateId, status, returnTo\)/);
  assert.match(script, /triggerConfiguredApprovedOutreach\(candidateId, vacancyId\)/);
  assert.match(script, /\/admin\/outreach\/approved\/prepare/);
  assert.match(script, /body\.append\('candidateIds', candidateId\)/);
  assert.match(script, /if \(vacancyId\) body\.set\('vacancyId', vacancyId\)/);
  assert.doesNotMatch(script, /\['registered', 'missing_cv_complete'\]\.includes\(activeStatus\)/);
  assert.doesNotMatch(script, /citacion_entrevista_loginpro|templateLanguage|bodyParameters/);
  assert.doesNotThrow(() => new Function(script));
});

test('la aprobación individual usa el mismo cambio de estado y el mismo outreach que el batch', () => {
  const enhanced = enhanceApprovedRecruitmentUx(renderDetailHtml());
  const script = approvedClientScriptBody(enhanced);

  assert.match(script, /function candidateIdFromStatusForm\(form\)/);
  assert.match(script, /function installSingleCandidateApprovalAutomation\(\)/);
  assert.match(script, /statusSelect\.value !== 'APROBADO'/);
  assert.match(script, /postCandidateStatus\(candidateId, 'APROBADO', returnTo\)/);
  assert.match(script, /triggerConfiguredApprovedOutreach\(candidateId\)/);
  assert.equal((script.match(/async function postCandidateStatus/g) || []).length, 1);
  assert.equal((script.match(/async function triggerConfiguredApprovedOutreach/g) || []).length, 1);
  assert.doesNotMatch(script, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotThrow(() => new Function(script));
});

test('la UI elimina los accesos manuales a Mensajes a aprobados', () => {
  const html = [
    '<html><body>',
    '<a href="/admin/outreach/approved" class="export-btn">Mensajes a aprobados</a>',
    '<section data-vacancy-panel="vacancy-test"><div class="vacancy-header"></div>',
    '<a href="/admin/outreach/approved" class="export-btn">Mensajes a aprobados</a></section>',
    '</body></html>'
  ].join('');
  const enhanced = enhanceApprovedRecruitmentUx(html);

  assert.doesNotMatch(enhanced, /href=["']\/admin\/outreach\/approved["']/);
  assert.doesNotMatch(enhanced, />Mensajes a aprobados<\/a>/);
});

test('solo la aprobación automática continúa el lote ante fallo individual', () => {
  const script = approvedClientScriptBody(enhanceApprovedRecruitmentUx(renderBulkHtml()));

  assert.match(script, /\/admin\/outreach\/approved\/window-status/);
  assert.match(script, /!payload\.candidates\.some\(\(candidate\) => candidate\?\.candidateId === candidateId\)/);
  assert.match(script, /for \(let index = 0; index < selectedIds\.length; index \+= 1\)/);
  assert.match(script, /approvedPendingOutreach \+= 1/);
  assert.match(script, /failed \+= 1/);
  assert.match(script, /if \(!autoOutreachOnApproval\) break;/);
  assert.match(script, /if \(autoOutreachOnApproval\)[\s\S]*continue;/);
  assert.doesNotMatch(script, /bulk_status_request_failed/);
});

test('la autoridad existente conserva ventana abierta como texto y cerrada como plantilla', () => {
  const now = new Date('2026-09-11T18:00:00.000Z');
  const open = resolveManualOutboundTransport({
    source: 'admin_interview_template',
    lastInboundAt: new Date('2026-09-11T17:30:00.000Z'),
    now
  });
  const closed = resolveManualOutboundTransport({
    source: 'admin_interview_template',
    lastInboundAt: new Date('2026-09-10T16:00:00.000Z'),
    now
  });

  assert.equal(open.transport, MANUAL_OUTBOUND_TRANSPORT.FREE_TEXT);
  assert.equal(open.whatsappWindowOpen, true);
  assert.equal(closed.transport, MANUAL_OUTBOUND_TRANSPORT.TEMPLATE);
  assert.equal(closed.whatsappWindowOpen, false);
});

test('el envío configurado mantiene APROBADO como precondición y CONTACTADO como finalización canónica', () => {
  const adminSource = readSource('src/routes/admin.js');

  assert.match(adminSource, /expectedCandidateStatus:\s*'APROBADO'/);
  assert.match(adminSource, /source:\s*'admin_interview_template'/);
  assert.match(adminSource, /sendTemplateMessage\(phone/);
  assert.match(adminSource, /afterFinalize:\s*\(tx, context\) => finalizeApprovedInterviewOutreachHandoff/);
  assert.match(adminSource, /status:\s*'CONTACTADO'/);
  assert.match(adminSource, /where:\s*\{[\s\S]*status:\s*'APROBADO'/);
});

test('la automatización no introduce una autoridad nueva de entrega ni modifica webhook', () => {
  const uxSource = readSource('src/services/approvedRecruitmentUx.js');
  const webhookSource = readSource('src/routes/webhook.js');

  assert.match(uxSource, /\/admin\/candidates\/' \+ encodeURIComponent\(candidateId\) \+ '\/status'/);
  assert.match(uxSource, /\/admin\/outreach\/approved\/prepare/);
  assert.doesNotMatch(uxSource, /graph\.facebook\.com|META_ACCESS_TOKEN|sendTemplateMessage/);
  assert.doesNotMatch(webhookSource, /approvedBulkOutreachAutomation|autoOutreachOnApproval|approvalOutreachReady/);
});
