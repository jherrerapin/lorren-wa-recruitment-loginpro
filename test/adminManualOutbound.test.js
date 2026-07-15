import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import axios from 'axios';
import { adminRouter } from '../src/routes/admin.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';

async function createServer(prisma) {
  const app = express();
  const sessions = new Map();

  app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/sid=([^;]+)/);
    const sid = cookieMatch?.[1];
    req.session = sid && sessions.has(sid) ? sessions.get(sid) : {};
    next();
  });

  app.get('/test-login/:role', (req, res) => {
    const sid = `sid-${Math.random().toString(16).slice(2)}`;
    sessions.set(sid, { userRole: req.params.role });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    res.status(204).end();
  });
  app.use('/admin', adminRouter(prisma));

  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });

  return { server };
}

async function loginAndGetCookie(baseUrl, role = 'dev') {
  const response = await fetch(`${baseUrl}/test-login/${role}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('mensaje libre manual se envía y se guarda exactamente sin filtro de IA/seguridad', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';

  const manualBody = '  La vacante tiene prestaciones de ley. Insulto de prueba: bruto.  ';
  const prisma = createMockPrisma({
    candidates: [
      {
        id: 'cand-manual-1',
        phone: '573001112233',
        fullName: 'Candidato Manual',
        status: 'REGISTRADO',
        vacancy: { id: 'vac-1', city: 'Bogotá' }
      }
    ],
    messages: [
      {
        id: 'inbound-1',
        candidateId: 'cand-manual-1',
        direction: 'INBOUND',
        messageType: 'TEXT',
        body: 'Hola',
        createdAt: new Date()
      }
    ]
  });
  const whatsappMock = createWhatsappMock();
  const originalPost = axios.post.bind(axios);
  axios.post = async (url, payload, config) => {
    if (String(url).includes('graph.facebook.com')) {
      return { data: whatsappMock.handleSend(url, payload, config) };
    }
    return originalPost(url, payload, config);
  };

  const { server } = await createServer(prisma);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'dev');
    const form = new URLSearchParams({
      action: 'free_text',
      customBody: manualBody
    });

    const response = await fetch(`${baseUrl}/admin/candidates/cand-manual-1/outbound`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form,
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /outboundSuccess=/);
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.equal(whatsappMock.sentMessages[0].body, manualBody);

    const outbound = prisma.state.messages.find((message) => message.direction === 'OUTBOUND');
    assert.ok(outbound);
    assert.equal(outbound.body, manualBody);
    assert.equal(outbound.rawPayload.preserveExactBody, true);
    assert.equal(outbound.rawPayload.replySafety, undefined);
    assert.equal(prisma.state.candidates[0].botPaused, true);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});

test('la eliminación administrativa delega mensajes y reservas conservando el orden transaccional', () => {
  const source = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("router.post('/candidates/:id/delete'");
  const routeEnd = source.indexOf("router.post('/candidates/:id/edit'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'No se encontró la ruta de eliminación del candidato');

  const route = source.slice(routeStart, routeEnd);
  assert.doesNotMatch(route, /tx\.message\.deleteMany\s*\(/);
  assert.doesNotMatch(route, /tx\.interviewBooking\.deleteMany\s*\(/);
  assert.match(route, /deleteConversationMessagesForCandidate\(tx,\s*\{\s*candidateId:\s*candidate\.id\s*\}\)/s);
  assert.match(route, /deleteCandidateInterviewBookings\(tx,\s*\{\s*candidateId:\s*candidate\.id\s*\}\)/s);

  const messageIndex = route.indexOf('deleteConversationMessagesForCandidate(tx,');
  const bookingIndex = route.indexOf('deleteCandidateInterviewBookings(tx,');
  const candidateIndex = route.indexOf('tx.candidate.delete(');
  const transactionEnd = route.indexOf('    });', candidateIndex);
  const cvCleanupIndex = route.indexOf('clearCandidateCvStorage(candidate)');

  assert.ok(messageIndex >= 0, 'No se encontró la eliminación delegada de mensajes');
  assert.ok(bookingIndex >= 0, 'No se encontró la eliminación delegada de reservas');
  assert.ok(candidateIndex >= 0, 'No se encontró la eliminación del candidato');
  assert.ok(transactionEnd >= 0, 'No se encontró el cierre de la transacción');
  assert.ok(cvCleanupIndex >= 0, 'No se encontró la limpieza del CV');
  assert.ok(messageIndex < bookingIndex, 'Los mensajes deben eliminarse antes de las reservas');
  assert.ok(bookingIndex < candidateIndex, 'Las reservas deben eliminarse antes del candidato');
  assert.ok(candidateIndex < transactionEnd, 'El candidato debe eliminarse dentro de la transacción');
  assert.ok(transactionEnd < cvCleanupIndex, 'La limpieza del CV debe permanecer fuera de la transacción');
});
