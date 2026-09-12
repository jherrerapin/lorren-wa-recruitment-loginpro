import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';
import {
  MANUAL_OUTBOUND_TRANSPORT,
  resolveManualOutboundTransport
} from '../src/services/manualOutboundDeliveryService.js';
import { shouldTriggerApprovedOutreach } from '../src/registerApprovedOutreachActions.js';

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

test('solo una transición real hacia APROBADO requiere citación automática', () => {
  assert.equal(shouldTriggerApprovedOutreach('REGISTRADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('RECHAZADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('CONTACTADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('APROBADO', 'APROBADO'), false);
  assert.equal(shouldTriggerApprovedOutreach('REGISTRADO', 'CONTACTADO'), false);
});

test('el adaptador backend cubre los dos caminos administrativos que pueden aprobar', () => {
  const source = readSource('src/registerApprovedOutreachActions.js');

  assert.match(source, /'\/candidates\/:id\/status'/);
  assert.match(source, /'\/candidates\/:id\/edit'/);
  assert.match(source, /requestedStatus !== 'APROBADO'/);
  assert.match(source, /shouldTriggerApprovedOutreach\(previousStatus, persistedStatus\)/);
  assert.match(source, /invokeApprovedOutreachPrepare\(adminRouter, req, candidateId\)/);
  assert.match(source, /finalStatus === 'CONTACTADO'/);
  assert.match(source, /Candidato aprobado, citación aceptada por Meta y movido a Contactado/);
  assert.match(source, /El candidato quedó Aprobado/);
});

test('el backend reutiliza directamente el handler canónico de prepare sin endpoint paralelo', () => {
  const source = readSource('src/registerApprovedOutreachActions.js');

  assert.match(source, /findFinalRouteHandler\(adminRouter, '\/outreach\/approved\/prepare'\)/);
  assert.match(source, /prepareLayer\.handle\(outreachReq, outreachRes/);
  assert.doesNotMatch(source, /sendTemplateMessage|deliverManualOutboundText|graph\.facebook\.com|META_ACCESS_TOKEN/);
  assert.doesNotMatch(source, /router\.(?:post|get)\('\/approve/);
});

test('el batch solo solicita el cambio de estado y no duplica el envío de WhatsApp', () => {
  const script = approvedClientScriptBody(enhanceApprovedRecruitmentUx(renderBulkHtml()));

  assert.match(script, /postCandidateStatus\(candidateId, status, returnTo\)/);
  assert.match(script, /const approvalBatch = status === 'APROBADO'/);
  assert.match(script, /statusResult\.error/);
  assert.match(script, /statusResult\.success/);
  assert.doesNotMatch(script, /\/admin\/outreach\/approved\/prepare/);
  assert.doesNotMatch(script, /triggerConfiguredApprovedOutreach/);
  assert.doesNotMatch(script, /installSingleCandidateApprovalAutomation/);
  assert.doesNotMatch(script, /citacion_entrevista_loginpro|templateLanguage|bodyParameters/);
  assert.doesNotThrow(() => new Function(script));
});

test('la autoridad canónica de outreach decide ventana abierta texto y cerrada plantilla', () => {
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

test('prepare conserva precondición APROBADO y finalización CONTACTADO', () => {
  const source = readSource('src/routes/admin.js');
  const prepareStart = source.indexOf("router.post('/outreach/approved/prepare'");
  const prepareEnd = source.indexOf("router.get('/bot-knowledge'", prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.match(prepare, /expectedCandidateStatus:\s*'APROBADO'/);
  assert.match(prepare, /source:\s*'admin_interview_template'/);
  assert.match(prepare, /sendTemplateMessage\(phone/);
  assert.match(prepare, /finalizeApprovedInterviewOutreachHandoff/);

  const finalizerStart = source.indexOf('export async function finalizeApprovedInterviewOutreachHandoff');
  const finalizerEnd = source.indexOf('function parseVacancyBody', finalizerStart);
  const finalizer = source.slice(finalizerStart, finalizerEnd);
  assert.match(finalizer, /status:\s*'CONTACTADO'/);
  assert.match(finalizer, /status:\s*'APROBADO'/);
});

test('la UI elimina Mensajes a aprobados y no introduce transporte Meta paralelo', () => {
  const html = enhanceApprovedRecruitmentUx(renderBulkHtml());
  const uxSource = readSource('src/services/approvedRecruitmentUx.js');
  const webhookSource = readSource('src/routes/webhook.js');

  assert.doesNotMatch(html, /href=["']\/admin\/outreach\/approved["']/);
  assert.doesNotMatch(html, />Mensajes a aprobados<\/a>/);
  assert.doesNotMatch(uxSource, /graph\.facebook\.com|META_ACCESS_TOKEN|sendTemplateMessage/);
  assert.doesNotMatch(uxSource, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(webhookSource, /approvedBulkOutreachAutomation|autoOutreachOnApproval|approvalOutreachReady/);
});
