import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  buildProgrammingCompletionSummary,
  buildProgrammingReportHtml,
  formatProgrammingWorkerPhone,
  programmingWorkerWhatsappUrl
} from '../src/services/dispatchProgrammingPdfService.js';
import { buildProgrammingExcelBuffer } from '../src/routes/dispatchProgrammingNotifications.js';

const DATE_KEY = '2026-09-30';

function worker(id, phone) {
  return {
    id,
    fullName: `Auxiliar ${id}`,
    documentType: 'CC',
    documentNumber: `1000${id}`,
    phone
  };
}

function request(assignments) {
  return {
    id: 'request-phone-report',
    serviceDate: new Date(`${DATE_KEY}T00:00:00.000Z`),
    clientName: 'Cliente prueba',
    operationPointName: 'Operación prueba',
    cityName: 'Bogotá',
    address: 'Dirección prueba',
    serviceName: 'Servicio prueba',
    startTime: '08:00',
    endTime: '17:00',
    requiredWorkers: assignments.length,
    status: 'ASSIGNMENT_COMPLETE',
    assignments
  };
}

function confirmedAssignment(id, phone) {
  return {
    id: `assignment-${id}`,
    status: 'CONFIRMED',
    createdAt: new Date(`${DATE_KEY}T00:00:00.000Z`),
    worker: worker(id, phone)
  };
}

function prismaFor(requests) {
  return {
    dispatchServiceRequest: { findMany: async () => requests },
    devAuditEvent: { findMany: async () => [] }
  };
}

test('formatea teléfono colombiano sin indicativo y conserva destino canónico de WhatsApp', () => {
  assert.equal(formatProgrammingWorkerPhone('+57 300 123 4567'), '3001234567');
  assert.equal(programmingWorkerWhatsappUrl('+57 300 123 4567'), 'https://wa.me/573001234567');
  assert.equal(formatProgrammingWorkerPhone('300 123 4567'), '3001234567');
  assert.equal(programmingWorkerWhatsappUrl('300 123 4567'), 'https://wa.me/573001234567');
});

test('PDF diario añade teléfono clickeable y alinea nombre, documento, teléfono y estado por columnas', () => {
  const reportRequest = request([confirmedAssignment('1', '+57 300 123 4567')]);
  const html = buildProgrammingReportHtml({
    selectedDate: DATE_KEY,
    requests: [reportRequest],
    managedBy: 'LoginPro Operaciones',
    includePending: true,
    overallSummary: buildProgrammingCompletionSummary([reportRequest]),
    includeWorkerAbsences: false
  });

  assert.match(html, /class="worker-row"/);
  assert.match(html, /grid-template-columns: minmax\(0, 2\.2fr\) 112px 130px 128px/);
  assert.match(html, /<strong class="worker-name">Auxiliar 1<\/strong>/);
  assert.match(html, /<span class="worker-document">CC 10001<\/span>/);
  assert.match(html, /Tel: <a class="worker-phone" href="https:\/\/wa\.me\/573001234567">3001234567<\/a>/);
  assert.match(html, /Confirmado/);
});

test('Excel diario mantiene sus 10 columnas y enlaza a WhatsApp cuando hay un único auxiliar', async () => {
  const reportRequest = request([confirmedAssignment('1', '+57 300 123 4567')]);
  const result = await buildProgrammingExcelBuffer(prismaFor([reportRequest]), {
    selectedDate: DATE_KEY,
    managedBy: 'LoginPro Operaciones',
    includePending: true
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  const sheet = workbook.getWorksheet('Programación');
  assert.equal(sheet.columnCount, 10);
  assert.equal(sheet.getCell('J3').value, 'Auxiliares asignados');
  const cell = sheet.getCell('J4');
  assert.match(cell.text, /Auxiliar 1 · CC 10001 · Tel: 3001234567 · Confirmado/);
  assert.equal(cell.hyperlink || cell.value?.hyperlink, 'https://wa.me/573001234567');
});

test('Excel con varios auxiliares conserva todos los teléfonos sin asignar un enlace ambiguo a la celda', async () => {
  const reportRequest = request([
    confirmedAssignment('1', '+57 300 123 4567'),
    confirmedAssignment('2', '301 765 4321')
  ]);
  const result = await buildProgrammingExcelBuffer(prismaFor([reportRequest]), {
    selectedDate: DATE_KEY,
    managedBy: 'LoginPro Operaciones',
    includePending: true
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  const cell = workbook.getWorksheet('Programación').getCell('J4');
  assert.match(cell.text, /Tel: 3001234567/);
  assert.match(cell.text, /Tel: 3017654321/);
  assert.equal(cell.hyperlink || cell.value?.hyperlink || null, null);
});
