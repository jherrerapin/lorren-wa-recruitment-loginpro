import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import {
  approvedOutreachActionsRouter,
  approvedOutreachWindowState
} from '../src/routes/approvedOutreachActions.js';
import { ensureApprovedOutreachWindowUi } from '../src/services/approvedOutreachWindowUi.js';
import { MANUAL_OUTBOUND_TRANSPORT } from '../src/services/manualOutboundDeliveryService.js';
import { createMockPrisma } from './helpers/mockPrisma.js';

const FIXED_NOW = new Date('2026-08-27T15:00:00.000Z');

async function createServer(prisma, {
  session = {
    userRole: 'admin',
    userId: 'user-test',
    username: 'user-test',
    userAccessScope: 'ALL',
    userSource: 'db'
  },
  deliver = async () => ({ ok: true })
} = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { ...session };
    req.userRole = session.userRole || null;
    req.userId = session.userId || null;
    req.username = session.username || null;
    req.userAccessScope = session.userAccessScope || 'ALL';
    req.userAccessCity = session.userAccessCity || null;
    req.userAccessVacancyId = session.userAccessVacancyId || null;
    next();
  });
  app.use('/admin/outreach/approved', approvedOutreachActionsRouter(prisma, {
    now: () => new Date(FIXED_NOW),
    deliver,
    sendText: async () => ({ messages: [{ id: 'wamid-test' }] })
  }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return server;
}

function candidate(id, status = 'APROBADO', vacancyId = 'vac-1') {
  return {
    id,
    phone: '573001110000',
    status,
    vacancyId,
    vacancy: { id: vacancyId, city: 'Ciudad Prueba' }
  };
}

function inbound(candidateId, createdAt) {
  return {
    id: `msg-${candidateId}`,
    candidateId,
    direction: 'INBOUND',
    messageType: 'TEXT',
    body: 'Mensaje de prueba',
    createdAt
  };
}

test('estado de aprobados reutiliza la autoridad canónica para ventana abierta y cerrada', async () => {
  const prisma = createMockPrisma({
    candidates: [candidate('cand-open'), candidate('cand-closed')],
    messages: [
      inbound('cand-open', new Date(FIXED_NOW.getTime() - 60 * 60 * 1000)),
      inbound('cand-closed', new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000))
    ]
  });
  const server = await createServer(prisma);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/admin/outreach/approved/window-status?candidateIds=cand-open,cand-closed`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const states = new Map(payload.candidates.map((item) => [item.candidateId, item]));

    assert.equal(states.get('cand-open').windowOpen, true);
    assert.equal(states.get('cand-open').transport, MANUAL_OUTBOUND_TRANSPORT.FREE_TEXT);
    assert.equal(states.get('cand-closed').windowOpen, false);
    assert.equal(states.get('cand-closed').transport, MANUAL_OUTBOUND_TRANSPORT.TEMPLATE);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mensaje libre de aprobado conserva el texto exacto y delega la entrega canónica', async () => {
  const exactBody = '  Mensaje libre con espacios intencionales.  ';
  const deliveries = [];
  const prisma = createMockPrisma({
    candidates: [candidate('cand-open')],
    messages: [inbound('cand-open', new Date(FIXED_NOW.getTime() - 2 * 60 * 60 * 1000))]
  });
  const server = await createServer(prisma, {
    deliver: async (...args) => {
      deliveries.push(args);
      return { ok: true };
    }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const form = new URLSearchParams({ customBody: exactBody });
    const response = await fetch(`${baseUrl}/admin/outreach/approved/cand-open/free-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    assert.equal(response.status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0][1].candidateId, 'cand-open');
    assert.equal(deliveries[0][1].body, exactBody);
    assert.equal(deliveries[0][1].expectedCandidateStatus, 'APROBADO');
    assert.equal(deliveries[0][1].rawPayload.preserveExactBody, true);
    assert.equal(deliveries[0][1].rawPayload.source, 'admin_outreach_approved_free_text');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mensaje libre se bloquea si la ventana se cerró antes de enviar', async () => {
  let deliveryCount = 0;
  const prisma = createMockPrisma({
    candidates: [candidate('cand-closed')],
    messages: [inbound('cand-closed', new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000))]
  });
  const server = await createServer(prisma, {
    deliver: async () => { deliveryCount += 1; }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/admin/outreach/approved/cand-closed/free-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customBody: 'Mensaje de prueba' })
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'whatsapp_window_closed');
    assert.equal(deliveryCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mensaje libre se bloquea si el candidato ya no está aprobado', async () => {
  let deliveryCount = 0;
  const prisma = createMockPrisma({
    candidates: [candidate('cand-contacted', 'CONTACTADO')],
    messages: [inbound('cand-contacted', new Date(FIXED_NOW.getTime() - 60 * 60 * 1000))]
  });
  const server = await createServer(prisma, {
    deliver: async () => { deliveryCount += 1; }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/admin/outreach/approved/cand-contacted/free-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customBody: 'Mensaje de prueba' })
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'candidate_not_approved');
    assert.equal(deliveryCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('mensaje libre respeta el alcance del usuario aunque fuerce el candidateId', async () => {
  let deliveryCount = 0;
  const prisma = createMockPrisma({
    candidates: [candidate('cand-other', 'APROBADO', 'vac-other')],
    messages: [inbound('cand-other', new Date(FIXED_NOW.getTime() - 60 * 60 * 1000))]
  });
  const server = await createServer(prisma, {
    session: {
      userRole: 'admin',
      userId: 'user-limited',
      username: 'user-limited',
      userAccessScope: 'VACANCY',
      userAccessVacancyId: 'vac-allowed',
      userSource: 'db'
    },
    deliver: async () => { deliveryCount += 1; }
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/admin/outreach/approved/cand-other/free-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customBody: 'Mensaje de prueba' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'forbidden');
    assert.equal(deliveryCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('helper de UI carga el script solo en la pantalla de aprobados y una sola vez', () => {
  const html = '<html><body><form action="/admin/outreach/approved/prepare"></form></body></html>';
  const enhanced = ensureApprovedOutreachWindowUi(html);
  assert.match(enhanced, /<script src="\/public\/approved-outreach-window\.js"><\/script>/);
  assert.equal((ensureApprovedOutreachWindowUi(enhanced).match(/approved-outreach-window\.js/g) || []).length, 1);
  assert.equal(ensureApprovedOutreachWindowUi('<html><body>Otra página</body></html>'), '<html><body>Otra página</body></html>');
});

test('cliente muestra estado debajo del nombre sin calcular localmente la ventana de 24 h', () => {
  const source = fs.readFileSync(new URL('../src/public/approved-outreach-window.js', import.meta.url), 'utf8');
  assert.match(source, /Ventana 24 h abierta · se enviará mensaje libre/);
  assert.match(source, /Ventana 24 h cerrada · se usará plantilla/);
  assert.match(source, /Enviar mensaje libre/);
  assert.match(source, /\/admin\/outreach\/approved\/window-status/);
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /24\s*\*\s*60\s*\*\s*60/);
});

test('bootstrap registra el adaptador de aprobados sin tocar webhook ni server monolítico', () => {
  const bootstrap = fs.readFileSync(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
  const registrar = fs.readFileSync(new URL('../src/registerApprovedOutreachActions.js', import.meta.url), 'utf8');
  assert.match(bootstrap, /registerApprovedOutreachActions\.js/);
  assert.match(registrar, /\/admin\/outreach\/approved/);
  assert.match(registrar, /approvedOutreachActionsRouter\(prisma\)/);
  assert.match(registrar, /routePaths\.has\('\/outreach\/approved'\)/);
  assert.match(registrar, /routePaths\.has\('\/outreach\/approved\/prepare'\)/);
});

test('estado puro conserva frontera exacta de 24 horas de la autoridad canónica', () => {
  const exactly24h = new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000);
  const justInside = new Date(exactly24h.getTime() + 1);
  assert.equal(approvedOutreachWindowState(exactly24h, FIXED_NOW).windowOpen, false);
  assert.equal(approvedOutreachWindowState(justInside, FIXED_NOW).windowOpen, true);
});
