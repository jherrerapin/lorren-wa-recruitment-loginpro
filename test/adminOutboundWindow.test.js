import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import axios from 'axios';
import { MessageDirection } from '@prisma/client';
import { adminRouter } from '../src/routes/admin.js';

function createPrismaMock({ candidate, messages = [] }) {
  const state = {
    candidate: { ...candidate },
    messages: [...messages],
    outboundCreates: []
  };

  return {
    state,
    candidate: {
      async findUnique({ where }) {
        if (where.id !== state.candidate.id) return null;
        return { ...state.candidate };
      },
      async update({ where, data }) {
        if (where.id !== state.candidate.id) throw new Error('Candidate not found');
        state.candidate = { ...state.candidate, ...data };
        return { ...state.candidate };
      }
    },
    message: {
      async findFirst({ where }) {
        const filtered = state.messages
          .filter(m => m.candidateId === where.candidateId && m.direction === where.direction)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const first = filtered[0];
        if (!first) return null;
        return { createdAt: first.createdAt };
      },
      async create({ data }) {
        state.outboundCreates.push(data);
        return { id: `msg-${state.outboundCreates.length}`, ...data };
      },
      async findMany() {
        return [];
      }
    }
  };
}

async function createServer(initialState) {
  const prisma = createPrismaMock(initialState);
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

  return { prisma, server };
}

async function loginAndGetCookie(baseUrl, role = 'dev') {
  const response = await fetch(`${baseUrl}/test-login/${role}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

function minusHours(hours) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000));
}

function getOutboundError(location = '') {
  const parsed = new URL(location, 'http://localhost');
  return parsed.searchParams.get('outboundError');
}

test('inbound dentro de 24h => permite envío', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { ok: true } });

  const { prisma, server } = await createServer({
    candidate: { id: 'cand-1', phone: '573001112233', createdAt: minusHours(2) },
    messages: [
      { candidateId: 'cand-1', direction: MessageDirection.INBOUND, createdAt: minusHours(1) }
    ]
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin/candidates/cand-1/outbound`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=reminder',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /outboundSuccess=/);
    assert.equal(prisma.state.outboundCreates.length, 1);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});

test('inbound fuera de 24h => bloquea envío', async () => {
  const originalPost = axios.post;
  let sendCalled = false;
  axios.post = async () => {
    sendCalled = true;
    return { data: { ok: true } };
  };

  const { prisma, server } = await createServer({
    candidate: { id: 'cand-2', phone: '573001112244', createdAt: minusHours(2) },
    messages: [
      { candidateId: 'cand-2', direction: MessageDirection.INBOUND, createdAt: minusHours(30) }
    ]
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin/candidates/cand-2/outbound`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=request_hv',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    const errorText = getOutboundError(response.headers.get('location') || '');
    assert.match(errorText || '', /Estado de ventana: vencida/i);
    assert.equal(prisma.state.outboundCreates.length, 0);
    assert.equal(sendCalled, false);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});

test('solo outbound => bloquea envío', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { ok: true } });

  const { prisma, server } = await createServer({
    candidate: { id: 'cand-3', phone: '573001112255', createdAt: minusHours(2) },
    messages: [
      { candidateId: 'cand-3', direction: MessageDirection.OUTBOUND, createdAt: minusHours(1) }
    ]
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin/candidates/cand-3/outbound`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=request_missing_data',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    const errorText = getOutboundError(response.headers.get('location') || '');
    assert.match(errorText || '', /Sin mensajes inbound/i);
    assert.equal(prisma.state.outboundCreates.length, 0);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});

test('candidate.createdAt reciente pero inbound viejo => bloquea', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { ok: true } });

  const { prisma, server } = await createServer({
    candidate: { id: 'cand-4', phone: '573001112266', createdAt: minusHours(1) },
    messages: [
      { candidateId: 'cand-4', direction: MessageDirection.INBOUND, createdAt: minusHours(48) }
    ]
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin/candidates/cand-4/outbound`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=reminder',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.ok(getOutboundError(response.headers.get('location') || ''));
    assert.equal(prisma.state.outboundCreates.length, 0);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});

test('candidate.createdAt viejo pero inbound reciente => permite', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { ok: true } });

  const { prisma, server } = await createServer({
    candidate: { id: 'cand-5', phone: '573001112277', createdAt: minusHours(24 * 90) },
    messages: [
      { candidateId: 'cand-5', direction: MessageDirection.INBOUND, createdAt: minusHours(2) }
    ]
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl);
    const response = await fetch(`${baseUrl}/admin/candidates/cand-5/outbound`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=reminder',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /outboundSuccess=/);
    assert.equal(prisma.state.outboundCreates.length, 1);
  } finally {
    axios.post = originalPost;
    await new Promise(resolve => server.close(resolve));
  }
});
