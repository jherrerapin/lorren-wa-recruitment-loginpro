import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sendDispatchCompletionEmail } from '../src/services/dispatchCompletionEmail.js';

function confirmedAssignment(index = 1) {
  return {
    id: `assignment-test-${index}`,
    status: 'CONFIRMED',
    createdAt: new Date(`2026-08-20T1${index}:00:00.000Z`),
    worker: {
      id: `worker-test-${index}`,
      fullName: `Auxiliar TEST ${index}`,
      phone: `TEST-PHONE-${index}`,
      documentType: 'CC',
      documentNumber: `TEST-DOC-${index}`
    }
  };
}

function serviceRequest(overrides = {}) {
  return {
    id: 'request-test-1',
    clientName: 'Cliente TEST',
    operationPointName: 'Operación TEST',
    cityName: 'Ciudad TEST',
    address: 'Dirección TEST',
    serviceDate: new Date('2026-08-21T00:00:00.000Z'),
    startTime: '08:00',
    endTime: '17:00',
    requiredWorkers: 1,
    status: 'ASSIGNMENT_COMPLETE',
    notes: null,
    serviceName: 'Servicio TEST',
    service: { id: 'service-test-1', name: 'Servicio TEST' },
    requestedByName: 'Solicitante TEST',
    requestedByPhone: 'TEST-PHONE-CLIENT',
    requestedByEmail: 'solicitante@example.test',
    completionEmailSentAt: null,
    assignments: [confirmedAssignment()],
    ...overrides
  };
}

function prismaFor(requests) {
  const updates = [];
  return {
    updates,
    dispatchServiceRequest: {
      findUnique: async () => requests[0] || null,
      findMany: async () => requests,
      updateMany: async (args) => {
        updates.push(args);
        return { count: requests.length };
      }
    }
  };
}

function snapshotEnvironment() {
  const keys = ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'DISPATCH_EMAIL_FROM', 'EMAIL_FROM', 'DISPATCH_EMAIL_REPLY_TO', 'EMAIL_REPLY_TO'];
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureTestEmail() {
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 'TEST-RESEND-KEY';
  process.env.DISPATCH_EMAIL_FROM = 'operaciones@example.test';
  delete process.env.EMAIL_FROM;
}

test('la confirmación automática no envía correo ni genera PDF sin acción manual explícita', async () => {
  const env = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  const prisma = prismaFor([serviceRequest()]);
  let providerCalls = 0;
  let pdfBuilds = 0;

  configureTestEmail();
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('El proveedor no debe invocarse en un disparo automático.');
  };

  try {
    const result = await sendDispatchCompletionEmail(prisma, 'request-test-1', {
      pdfBuilder: async () => {
        pdfBuilds += 1;
        throw new Error('El PDF no debe generarse en un disparo automático.');
      }
    });

    assert.equal(result.reason, 'manual_send_required');
    assert.equal(providerCalls, 0);
    assert.equal(pdfBuilds, 0);
    assert.equal(prisma.updates.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(env);
  }
});

test('el sender canónico conserva envío manual explícito con PDF adjunto e idempotencia persistida', async () => {
  const env = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  const prisma = prismaFor([serviceRequest()]);
  let providerRequest = null;
  let pdfBuilds = 0;

  configureTestEmail();
  globalThis.fetch = async (url, options) => {
    providerRequest = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'email-provider-test-1' })
    };
  };

  try {
    const result = await sendDispatchCompletionEmail(prisma, 'request-test-1', {
      manual: true,
      managedBy: 'Coordinación TEST',
      pdfBuilder: async (_prisma, options) => {
        pdfBuilds += 1;
        assert.equal(options.fecha, '2026-08-21');
        assert.deepEqual(options.requestIds, ['request-test-1']);
        assert.equal(options.includePending, false);
        return { selectedDate: '2026-08-21', buffer: Buffer.from('%PDF-TEST-CONTENT') };
      }
    });

    assert.equal(result.sent, true);
    assert.equal(result.to, 'solicitante@example.test');
    assert.equal(pdfBuilds, 1);
    assert.equal(providerRequest?.url, 'https://api.resend.com/emails');

    const payload = JSON.parse(providerRequest.options.body);
    assert.deepEqual(payload.to, ['solicitante@example.test']);
    assert.equal(payload.attachments.length, 1);
    assert.match(payload.attachments[0].filename, /^programacion-operativa-auxiliares-confirmados-/);
    assert.equal(payload.attachments[0].content, Buffer.from('%PDF-TEST-CONTENT').toString('base64'));

    assert.equal(prisma.updates.length, 1);
    assert.deepEqual(prisma.updates[0].where.id.in, ['request-test-1']);
    assert.equal(prisma.updates[0].data.completionEmailTo, 'solicitante@example.test');
    assert.equal(prisma.updates[0].data.completionEmailProviderId, 'email-provider-test-1');
    assert.ok(prisma.updates[0].data.completionEmailSentAt instanceof Date);
    assert.equal(prisma.updates[0].data.completionEmailLastError, null);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(env);
  }
});

test('un grupo pendiente tampoco se entrega mediante el sender manual', async () => {
  const env = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let pdfBuilds = 0;
  const groupName = 'Servicio TEST · Grupo GRP-TEST-1';
  const complete = serviceRequest({ id: 'request-test-1', serviceName: groupName });
  const pending = serviceRequest({
    id: 'request-test-2',
    serviceName: groupName,
    startTime: '18:00',
    endTime: '22:00',
    assignments: [{ ...confirmedAssignment(2), status: 'CONFIRMATION_PENDING' }],
    status: 'PENDING_CONFIRMATION'
  });
  const prisma = prismaFor([complete, pending]);

  configureTestEmail();
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('No debe enviarse mientras el grupo esté incompleto.');
  };

  try {
    const result = await sendDispatchCompletionEmail(prisma, 'request-test-1', {
      manual: true,
      pdfBuilder: async () => {
        pdfBuilds += 1;
        throw new Error('No debe generarse PDF mientras el grupo esté incompleto.');
      }
    });
    assert.equal(result.reason, 'service_request_not_complete');
    assert.equal(providerCalls, 0);
    assert.equal(pdfBuilds, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(env);
  }
});

test('fallo del PDF manual se registra como error de entrega sin propagar la excepción', async () => {
  const env = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const prisma = prismaFor([serviceRequest()]);

  configureTestEmail();
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('El proveedor no debe invocarse si falla el PDF.');
  };

  try {
    const result = await sendDispatchCompletionEmail(prisma, 'request-test-1', {
      manual: true,
      pdfBuilder: async () => {
        throw new Error('TEST pdf generation failed');
      }
    });
    assert.equal(result.sent, false);
    assert.match(result.error, /TEST pdf generation failed/);
    assert.equal(providerCalls, 0);
    assert.equal(prisma.updates.length, 1);
    assert.match(prisma.updates[0].data.completionEmailLastError, /TEST pdf generation failed/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(env);
  }
});

test('la UI de cierre es compacta y abre correo o WhatsApp al contacto persistido tras descargar PDF', () => {
  const service = fs.readFileSync(new URL('../src/services/dispatchCompletionEmail.js', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8');

  assert.match(service, /options\.manual !== true[\s\S]{0,120}manual_send_required/);
  assert.match(view, /if \(selectedRequestComplete\)[\s\S]{0,350}completionDeliveryActions/);
  assert.match(view, /class="completion-delivery"/);
  assert.match(view, />PDF<\/a>/);
  assert.match(view, /data-email="<%= selectedServiceRequest\.requestedByEmail %>"/);
  assert.match(view, /openCompletionEmail/);
  assert.match(view, /mailto:/);
  assert.match(view, /data-phone="<%= selectedServiceRequest\.requestedByPhone %>"/);
  assert.match(view, /openCompletionWhatsapp/);
  assert.match(view, /web\.whatsapp\.com\/send\?phone=/);
  assert.match(view, /downloadCompletionPdf\(button\)/);
  assert.doesNotMatch(view, /navigator\.share|navigator\.canShare/);
  assert.doesNotMatch(view, /class="notify-block"/);
  assert.doesNotMatch(view, /action="\/admin\/operaciones\/asignaciones\/entrega\/email"/);
  assert.doesNotMatch(view, /(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/);
});
