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

function renderBulkScript() {
  const html = [
    '<html><body>',
    '<table id="legacy-candidates-table"><tbody>',
    '<tr><td>fecha</td><td>Persona Prueba</td><td></td><td></td><td></td><td></td><td></td><td></td><td><span class="badge badge-registrado">Registrado</span></td><td></td><td><a class="link-detail" href="/admin/candidates/candidate-test-1">Ver</a></td></tr>',
    '</tbody></table>',
    '</body></html>'
  ].join('');
  return approvedClientScriptBody(enhanceApprovedRecruitmentUx(html));
}

test('aprobar desde Registrados o Pendientes HV encadena el outreach configurado existente', () => {
  const script = renderBulkScript();

  assert.match(script, /status === 'APROBADO'/);
  assert.match(script, /\['registered', 'missing_cv_complete'\]\.includes\(activeStatus\)/);
  assert.match(script, /applyCandidateStatus\(candidateId, status, returnTo\)/);
  assert.match(script, /triggerConfiguredApprovedOutreach\(candidateId\)/);
  assert.match(script, /\/admin\/outreach\/approved\/prepare/);
  assert.match(script, /body\.append\('candidateIds', candidateId\)/);
  assert.match(script, /body\.set\('vacancyId', vacancyId\)/);
  assert.doesNotMatch(script, /citacion_entrevista_loginpro|templateLanguage|bodyParameters/);
  assert.doesNotThrow(() => new Function(script));
});

test('el batch verifica el estado backend y continúa procesando aunque una citación falle', () => {
  const script = renderBulkScript();

  assert.match(script, /\/admin\/outreach\/approved\/window-status/);
  assert.match(script, /!payload\.candidates\.some\(\(candidate\) => candidate\?\.candidateId === candidateId\)/);
  assert.match(script, /for \(let index = 0; index < selectedIds\.length; index \+= 1\)/);
  assert.match(script, /approvedPendingOutreach \+= 1/);
  assert.match(script, /failed \+= 1/);
  assert.match(script, /continue;/);
  assert.doesNotMatch(script, /bulk_status_request_failed/);
  assert.doesNotMatch(script, /\b(?:alert|confirm|prompt)\s*\(/);
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
  assert.doesNotMatch(webhookSource, /approvedBulkOutreachAutomation|autoOutreachOnApproval/);
});
