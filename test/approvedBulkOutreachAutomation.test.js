import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';
import {
  MANUAL_OUTBOUND_TRANSPORT,
  resolveManualOutboundTransport
} from '../src/services/manualOutboundDeliveryService.js';
import { shouldSendApprovedOutreachForStatusChange } from '../src/routes/admin.js';

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
  assert.equal(shouldSendApprovedOutreachForStatusChange('REGISTRADO', 'APROBADO'), true);
  assert.equal(shouldSendApprovedOutreachForStatusChange('RECHAZADO', 'APROBADO'), true);
  assert.equal(shouldSendApprovedOutreachForStatusChange('CONTACTADO', 'APROBADO'), true);
  assert.equal(shouldSendApprovedOutreachForStatusChange('APROBADO', 'APROBADO'), false);
  assert.equal(shouldSendApprovedOutreachForStatusChange('REGISTRADO', 'CONTACTADO'), false);
});

test('la autoridad backend de cambio de estado dispara la citación al aprobar', () => {
  const source = readSource('src/routes/admin.js');
  const statusStart = source.indexOf("router.post('/candidates/:id/status'");
  const nextRoute = source.indexOf("router.get('/candidates/:id/open-whatsapp'", statusStart);
  assert.ok(statusStart >= 0 && nextRoute > statusStart);
  const statusRoute = source.slice(statusStart, nextRoute);

  assert.match(statusRoute, /shouldSendApprovedOutreachForStatusChange\(existingCandidate\.status, status\)/);
  assert.match(statusRoute, /deliverApprovedInterviewOutreach\(prisma, req, existingCandidate\)/);
  assert.match(statusRoute, /Candidato aprobado, citación aceptada por Meta y movido a Contactado/);
  assert.match(statusRoute, /El candidato quedó Aprobado/);
});

test('la edición individual también usa la misma autoridad backend al pasar a APROBADO', () => {
  const source = readSource('src/routes/admin.js');
  const editStart = source.indexOf("router.post('/candidates/:id/edit'");
  const nextRoute = source.indexOf("router.post('/candidates/:id/bot-pause'", editStart);
  assert.ok(editStart >= 0 && nextRoute > editStart);
  const editRoute = source.slice(editStart, nextRoute);

  assert.match(editRoute, /shouldSendApprovedOutreachForStatusChange\(existingCandidate\.status, data\.status\)/);
  assert.match(editRoute, /deliverApprovedInterviewOutreach\(prisma, req, approvedCandidate\)/);
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

test('el helper backend reutiliza entrega, plantilla y finalización CONTACTADO existentes', () => {
  const source = readSource('src/routes/admin.js');
  const helperStart = source.indexOf('export async function deliverApprovedInterviewOutreach');
  const helperEnd = source.indexOf('function ensureDevRole', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /deliverManualOutboundText\(prisma/);
  assert.match(helper, /expectedCandidateStatus:\s*'APROBADO'/);
  assert.match(helper, /source:\s*'admin_interview_template'/);
  assert.match(helper, /sendTemplateMessage\(phone/);
  assert.match(helper, /finalizeApprovedInterviewOutreachHandoff/);

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
