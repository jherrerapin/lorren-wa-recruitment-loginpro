import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { adminRouter } from '../src/routes/admin.js';

function createPrismaMock(initialCandidate) {
  const state = { candidate: { ...initialCandidate } };

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
      async findMany() {
        return [];
      }
    }
  };
}

async function createServer(initialCandidate) {
  const prisma = createPrismaMock(initialCandidate);
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

async function loginAndGetCookie(baseUrl, role = 'admin') {
  const response = await fetch(`${baseUrl}/test-login/${role}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('sube PDF válido y descarga posterior funciona', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-1',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const form = new FormData();
    form.append('cvFile', new Blob([Buffer.from('%PDF test')], { type: 'application/pdf' }), 'cv.pdf');

    const uploadResponse = await fetch(`${baseUrl}/admin/candidates/cand-1/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });
    assert.equal(uploadResponse.status, 302);
    assert.match(uploadResponse.headers.get('location') || '', /cvSuccess=/);

    assert.equal(prisma.state.candidate.cvOriginalName, 'cv.pdf');
    assert.equal(prisma.state.candidate.cvMimeType, 'application/pdf');
    assert.equal(Buffer.isBuffer(prisma.state.candidate.cvData), true);

    const downloadResponse = await fetch(`${baseUrl}/admin/candidates/cand-1/cv`, {
      headers: { Cookie: cookie }
    });
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get('content-type'), 'application/pdf');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sube DOCX válido, reemplaza existente y luego permite eliminar', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-2',
    cvData: Buffer.from('anterior'),
    cvOriginalName: 'old.pdf',
    cvMimeType: 'application/pdf'
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'dev');
    const form = new FormData();
    form.append(
      'cvFile',
      new Blob([Buffer.from('docx')], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }),
      'nuevo.docx'
    );

    const replaceResponse = await fetch(`${baseUrl}/admin/candidates/cand-2/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });
    assert.equal(replaceResponse.status, 302);
    assert.match(replaceResponse.headers.get('location') || '', /cvSuccess=/);
    assert.equal(prisma.state.candidate.cvOriginalName, 'nuevo.docx');

    const deleteResponse = await fetch(`${baseUrl}/admin/candidates/cand-2/cv/delete`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual'
    });
    assert.equal(deleteResponse.status, 302);
    assert.equal(prisma.state.candidate.cvData, null);
    assert.equal(prisma.state.candidate.cvOriginalName, null);
    assert.equal(prisma.state.candidate.cvMimeType, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('rechaza archivo inválido por MIME/extensión', async () => {
  const { prisma, server } = await createServer({
    id: 'cand-3',
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cookie = await loginAndGetCookie(baseUrl, 'admin');
    const form = new FormData();
    form.append('cvFile', new Blob([Buffer.from('txt')], { type: 'text/plain' }), 'notas.txt');

    const invalidResponse = await fetch(`${baseUrl}/admin/candidates/cand-3/cv/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      redirect: 'manual'
    });

    assert.equal(invalidResponse.status, 302);
    assert.match(invalidResponse.headers.get('location') || '', /cvError=/);
    assert.equal(prisma.state.candidate.cvData, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
