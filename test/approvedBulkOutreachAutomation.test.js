import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';
import {
  MANUAL_OUTBOUND_TRANSPORT,
  resolveManualOutboundTransport
} from '../src/services/manualOutboundDeliveryService.js';
import {
  installAutomaticApprovedOutreach,
  shouldTriggerApprovedOutreach
} from '../src/registerApprovedOutreachActions.js';

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

async function createApprovalHookServer({ prepareSucceeds = true } = {}) {
  const statuses = new Map([['candidate-test-1', 'REGISTRADO']]);
  const prismaMock = {
    candidate: {
      async findUnique({ where }) {
        const status = statuses.get(where.id);
        return status ? { status } : null;
      }
    }
  };
  const router = express.Router();
  router.post('/outreach/approved', (_req, res) => res.status(204).end());
  router.post('/outreach/approved/prepare', express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = Array.isArray(req.body.candidateIds)
      ? req.body.candidateIds[0]
      : req.body.candidateIds;
    if (prepareSucceeds) {
      statuses.set(candidateId, 'CONTACTADO');
      return res.render('outreachApproved', { preparedRecipients: [{ id: candidateId }], preparedError: null });
    }
    return res.render('outreachApproved', {
      preparedRecipients: [],
      preparedError: 'Meta rechazó la citación de prueba.'
    });
  });
  const statusHandler = async (req, res) => {
    statuses.set(req.params.id, String(req.body.status || '').trim().toUpperCase());
    return res.redirect(`/admin/candidates/${req.params.id}`);
  };
  router.post('/candidates/:id/status', express.urlencoded({ extended: true }), statusHandler);
  router.post('/candidates/:id/edit', express.urlencoded({ extended: true }), statusHandler);
  installAutomaticApprovedOutreach(router, prismaMock);

  const app = express();
  app.use('/admin', router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return { server, statuses };
}

async function postApproved(baseUrl, routePath) {
  return fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status: 'APROBADO' })
  });
}

test('solo una transición real hacia APROBADO requiere citación automática', () => {
  assert.equal(shouldTriggerApprovedOutreach('REGISTRADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('RECHAZADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('CONTACTADO', 'APROBADO'), true);
  assert.equal(shouldTriggerApprovedOutreach('APROBADO', 'APROBADO'), false);
  assert.equal(shouldTriggerApprovedOutreach('REGISTRADO', 'CONTACTADO'), false);
});

test('status y edit ejecutan en backend APROBADO -> prepare -> CONTACTADO', async () => {
  for (const routePath of [
    '/admin/candidates/candidate-test-1/status',
    '/admin/candidates/candidate-test-1/edit'
  ]) {
    const { server, statuses } = await createApprovalHookServer();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await postApproved(baseUrl, routePath);
      assert.equal(response.status, 302);
      assert.equal(statuses.get('candidate-test-1'), 'CONTACTADO');
      const location = response.headers.get('location') || '';
      assert.match(location, /^\/admin\/candidates\/candidate-test-1\?/);
      assert.match(decodeURIComponent(location), /citación aceptada por Meta y movido a Contactado/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('si prepare falla el candidato queda APROBADO y el redirect reporta error', async () => {
  const { server, statuses } = await createApprovalHookServer({ prepareSucceeds: false });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await postApproved(baseUrl, '/admin/candidates/candidate-test-1/status');
    assert.equal(response.status, 302);
    assert.equal(statuses.get('candidate-test-1'), 'APROBADO');
    const location = response.headers.get('location') || '';
    assert.match(decodeURIComponent(location), /Meta rechazó la citación de prueba/);
    assert.match(decodeURIComponent(location), /Revisa Aprobados antes de reintentar/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('el adaptador backend reutiliza el handler canónico de prepare sin endpoint paralelo', () => {
  const source = readSource('src/registerApprovedOutreachActions.js');

  assert.match(source, /'\/candidates\/:id\/status'/);
  assert.match(source, /'\/candidates\/:id\/edit'/);
  assert.match(source, /requestedStatus !== 'APROBADO'/);
  assert.match(source, /shouldTriggerApprovedOutreach\(previousStatus, persistedStatus\)/);
  assert.match(source, /findFinalRouteHandler\(adminRouter, '\/outreach\/approved\/prepare'\)/);
  assert.match(source, /prepareLayer\.handle\(outreachReq, outreachRes/);
  assert.match(source, /finalStatus === 'CONTACTADO'/);
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
