import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const operationalPhoneId = 'programming-global-test-phone-id';

function programmingRequest({ cityName, clientName, operationPointName, startTime = '08:00' }) {
  return {
    id: `${cityName}-${clientName}-${operationPointName}`,
    cityName,
    clientName,
    operationPointName,
    serviceName: 'Cargue y descargue',
    address: 'Dirección de prueba',
    startTime,
    endTime: null,
    requiredWorkers: 1,
    status: 'ASSIGNMENT_COMPLETE',
    assignments: [{
      status: 'CONFIRMED',
      worker: { fullName: 'Auxiliar Prueba', documentType: 'CC', documentNumber: '1000000000' }
    }]
  };
}

test('menú de programación concentra día y formato en una sola lista de seis opciones', async () => {
  const { buildDispatchReportMenuPayload } = await import('../src/services/dispatchWhatsappCloudClient.js');
  const payload = buildDispatchReportMenuPayload({ phone: '3001234567', name: 'Jefe Operativo' });
  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'list');
  const rows = payload.interactive.action.sections.flatMap((section) => section.rows);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.id), [
    'dispatch_report:programming_today_pdf',
    'dispatch_report:programming_today_excel',
    'dispatch_report:programming_today_both',
    'dispatch_report:programming_tomorrow_pdf',
    'dispatch_report:programming_tomorrow_excel',
    'dispatch_report:programming_tomorrow_both'
  ]);
  assert.deepEqual(rows.map((row) => row.title), [
    'Hoy · PDF',
    'Hoy · Excel',
    'Hoy · Ambos',
    'Mañana · PDF',
    'Mañana · Excel',
    'Mañana · Ambos'
  ]);
  assert.equal(rows.every((row) => !Object.hasOwn(row, 'description')), true);
  assert.doesNotMatch(payload.interactive.body.text, /resumen operativo/i);
  const webhookSource = fs.readFileSync('src/routes/dispatchWhatsappWebhook.js', 'utf8');
  assert.doesNotMatch(webhookSource, /El resumen operativo se envía automáticamente/i);
});

test('seleccionar programación envía documentos y después resumen para la misma fecha', async () => {
  const previousPhoneId = process.env.DISPATCH_META_PHONE_NUMBER_ID;
  process.env.DISPATCH_META_PHONE_NUMBER_ID = operationalPhoneId;
  const { processProgrammingContacts } = await import('../src/routes/dispatchWhatsappWebhook.js');
  const calls = [];
  const prisma = {
    devAuditEvent: {
      findFirst: async () => ({
        metadata: { contacts: [{ name: 'Jefe Operativo', phone: '573001234567' }] }
      }),
      create: async ({ data }) => data
    }
  };
  const payload = {
    entry: [{ changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: operationalPhoneId },
        messages: [{
          id: 'wamid-global-programming-1',
          from: '573001234567',
          type: 'interactive',
          interactive: { list_reply: { id: 'dispatch_report:programming_tomorrow_both', title: 'Mañana · Ambos' } }
        }]
      }
    }] }]
  };
  try {
    const result = await processProgrammingContacts(prisma, payload, {
      handlers: {
        sendProgrammingContactDocuments: async (_prisma, _contact, formats, selectedDate) => {
          calls.push({ type: 'documents', formats, selectedDate });
        },
        sendProgrammingSummary: async (_prisma, _contact, selectedDate) => {
          calls.push({ type: 'summary', selectedDate });
        }
      }
    });
    assert.equal(result.handled, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, 'documents');
    assert.deepEqual(calls[0].formats, ['pdf', 'excel']);
    assert.equal(calls[1].type, 'summary');
    assert.equal(calls[1].selectedDate, calls[0].selectedDate);
  } finally {
    if (previousPhoneId === undefined) delete process.env.DISPATCH_META_PHONE_NUMBER_ID;
    else process.env.DISPATCH_META_PHONE_NUMBER_ID = previousPhoneId;
  }
});

test('PDF organiza la programación global por ciudad y luego por cliente sin dejar encabezados huérfanos', async () => {
  const { buildProgrammingReportHtml } = await import('../src/services/dispatchProgrammingPdfService.js');
  const requests = [
    programmingRequest({ cityName: 'Medellín', clientName: 'Cliente B', operationPointName: 'La Estrella' }),
    programmingRequest({ cityName: 'Bogotá', clientName: 'Cliente A', operationPointName: 'Montevideo' }),
    programmingRequest({ cityName: 'Bogotá', clientName: 'Cliente C', operationPointName: 'Zona Franca', startTime: '10:00' })
  ];
  const html = buildProgrammingReportHtml({
    selectedDate: '2026-10-01',
    requests,
    managedBy: 'LoginPro Operaciones',
    includePending: true,
    overallSummary: { totalRequests: 3, completedRequests: 3, requiredWorkers: 3, assignedWorkers: 3 },
    workerAbsences: [],
    includeWorkerAbsences: true
  });
  const bogota = html.indexOf('<h2>Bogotá</h2>');
  const clienteA = html.indexOf('<h3>Cliente A</h3>');
  const clienteC = html.indexOf('<h3>Cliente C</h3>');
  const medellin = html.indexOf('<h2>Medellín</h2>');
  const clienteB = html.indexOf('<h3>Cliente B</h3>');
  assert.ok(bogota >= 0 && medellin > bogota);
  assert.ok(clienteA > bogota && clienteC > clienteA && clienteC < medellin);
  assert.ok(clienteB > medellin);
  assert.match(html, /\.city-section \+ \.city-section \{ break-before: page; page-break-before: always; \}/);
  assert.match(html, /\.city-head \{ break-inside: avoid; break-after: avoid; page-break-inside: avoid; page-break-after: avoid;/);
  assert.match(html, /\.client-head \{ break-after: avoid; page-break-after: avoid;/);
  assert.match(html, /\.block-card \{[^}]*break-inside: avoid; page-break-inside: avoid;/);
  assert.match(html, /\.client-section \{ margin: 0 0 16px 8px; \}/);
  assert.doesNotMatch(html, /\.client-section \{ break-inside: avoid;/);
});

test('Excel mantiene una hoja global y crea hojas por ciudad ordenadas por cliente', () => {
  const source = fs.readFileSync('src/routes/dispatchProgrammingNotifications.js', 'utf8');
  assert.match(source, /header\.values = \['Ciudad', 'Cliente'/);
  assert.match(source, /for \(const \[cityName, cityRequests\] of groupByCity\(report\.requests\)\)/);
  assert.match(source, /workbook\.addWorksheet\(cleanSheetName\(cityName, 'Ciudad'\)\)/);
  assert.match(source, /String\(left\.clientName \|\| ''\)\.localeCompare/);
});
