import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildDispatchServiceDateWhere,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from './dispatchDate.js';

const execFileAsync = promisify(execFile);
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const COMPLETE_REQUEST_STATUS = 'ASSIGNMENT_COMPLETE';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeProgrammingDate(value) {
  return normalizeDispatchDateParam(value);
}

export function normalizeProgrammingIncludePending(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'si', 'sí', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function formatBogotaDateTime(value = new Date()) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function activeAssignments(request) {
  return (request.assignments || []).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status));
}

function workerDocumentLabel(worker) {
  const documentType = normalizeString(worker?.documentType);
  const documentNumber = normalizeString(worker?.documentNumber);
  if (documentType && documentNumber) return `${documentType} ${documentNumber}`;
  if (documentNumber) return documentNumber;
  return 'Sin documento registrado';
}

function cleanServiceName(value) {
  return String(value || 'Sin servicio').replace(/\s*·\s*Grupo\s+GRP-[A-Z0-9-]+/i, '').trim() || 'Sin servicio';
}

function buildScheduleLabel(request) {
  if (request.endTime) return `${request.startTime || '-'} - ${request.endTime}`;
  return request.startTime || '-';
}

function requestStatusLabel(value) {
  return ({
    PENDING_ASSIGNMENT: 'Pendiente de asignación',
    ASSIGNMENT_PARTIAL: 'Asignación parcial',
    PENDING_CONFIRMATION: 'Pendiente de confirmación',
    ASSIGNMENT_COMPLETE: 'Asignación completa',
    CANCELLED: 'Cancelada'
  }[value] || value || 'Pendiente');
}

function assignmentStatusLabel(value) {
  return ({
    ASSIGNED: 'Asignado',
    CONFIRMATION_PENDING: 'Pendiente de confirmación',
    CONFIRMED: 'Confirmado'
  }[value] || value || 'Pendiente');
}

function requestStatusClass(value) {
  if (value === COMPLETE_REQUEST_STATUS) return 'complete';
  if (value === 'PENDING_CONFIRMATION') return 'confirmation';
  return 'pending';
}

function groupByClient(requests) {
  const map = new Map();
  for (const request of requests) {
    const key = request.clientName || 'Sin cliente';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(request);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'es'));
}

function resolveBrowserExecutablePath() {
  const candidates = [
    process.env.DISPATCH_BROWSER_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function loadProgrammingRequests(prisma, selectedDate, options = {}) {
  const normalizedDate = normalizeProgrammingDate(selectedDate);
  const requestId = normalizeString(options.requestId);
  const requests = await prisma.dispatchServiceRequest.findMany({
    where: requestId ? { id: requestId } : buildDispatchServiceDateWhere(normalizedDate),
    include: {
      service: true,
      assignments: {
        include: { worker: true },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
      }
    },
    orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });
  return {
    selectedDate: normalizedDate,
    requests: requestId ? requests : filterDispatchServiceRequestsByDate(requests, normalizedDate)
  };
}

export function buildProgrammingCompletionSummary(requests) {
  const totalRequests = requests.length;
  const completedRequests = requests.filter((request) => request.status === COMPLETE_REQUEST_STATUS).length;
  const requiredWorkers = requests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
  const assignedWorkers = requests.reduce((sum, request) => sum + activeAssignments(request).length, 0);
  return {
    totalRequests,
    completedRequests,
    requiredWorkers,
    assignedWorkers,
    isComplete: totalRequests > 0 && completedRequests >= totalRequests
  };
}

export function selectProgrammingRequests(requests = [], options = {}) {
  const includePending = normalizeProgrammingIncludePending(options.includePending, true);
  if (options.requestId || includePending) return [...requests];
  return requests.filter((request) => request.status === COMPLETE_REQUEST_STATUS);
}

function buildWorkersHtml(request) {
  const assignments = activeAssignments(request);
  if (!assignments.length) return '<p class="empty-workers">Sin auxiliares asignados.</p>';
  return `<ol class="workers-list">${assignments.map((assignment) => {
    const worker = assignment.worker || {};
    return `<li><strong>${escapeHtml(worker.fullName || 'Auxiliar')}</strong><span>${escapeHtml(workerDocumentLabel(worker))}</span><em>${escapeHtml(assignmentStatusLabel(assignment.status))}</em></li>`;
  }).join('')}</ol>`;
}

function buildHtml({ selectedDate, requests, managedBy, includePending, overallSummary }) {
  const requestsByClient = groupByClient(requests);
  const includedSummary = buildProgrammingCompletionSummary(requests);
  const generatedAt = formatBogotaDateTime();
  const manager = normalizeString(managedBy) || 'Julián Herrera';
  const documentTitle = includePending ? 'Programación operativa del día' : 'Programación confirmada del día';
  const scopeLabel = includePending
    ? 'Incluye solicitudes pendientes, parciales o por confirmar.'
    : 'Incluye únicamente solicitudes con asignación completa.';

  const clientSections = requestsByClient.length ? requestsByClient.map(([clientName, clientRequests]) => {
    const clientRequired = clientRequests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
    const clientAssigned = clientRequests.reduce((sum, request) => sum + activeAssignments(request).length, 0);
    const rows = clientRequests.map((request, index) => `
      <section class="block-card">
        <div class="block-title">
          <div><span>Bloque ${index + 1}</span><strong>${escapeHtml(buildScheduleLabel(request))}</strong></div>
          <div class="block-status">
            <span class="request-status ${requestStatusClass(request.status)}">${escapeHtml(requestStatusLabel(request.status))}</span>
            <div class="coverage">${activeAssignments(request).length}/${Number(request.requiredWorkers || 0)} auxiliares</div>
          </div>
        </div>
        <div class="block-meta">
          <div><b>Operación:</b> ${escapeHtml(request.operationPointName || 'Sin operación')}</div>
          <div><b>Servicio:</b> ${escapeHtml(cleanServiceName(request.serviceName || request.service?.name))}</div>
          <div><b>Ciudad:</b> ${escapeHtml(request.cityName || '-')}</div>
          <div><b>Dirección:</b> ${escapeHtml(request.address || '-')}</div>
        </div>
        ${buildWorkersHtml(request)}
      </section>
    `).join('');
    return `
      <section class="client-section">
        <div class="client-head">
          <h2>${escapeHtml(clientName)}</h2>
          <span>${clientRequests.length} solicitud(es) · ${clientAssigned}/${clientRequired} auxiliares</span>
        </div>
        ${rows}
      </section>
    `;
  }).join('') : `<section class="client-section"><h2>Sin solicitudes para este alcance</h2><p>${includePending ? 'No hay solicitudes programadas para esta fecha.' : 'No hay solicitudes con asignación completa para esta fecha.'}</p></section>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Programación operativa ${escapeHtml(selectedDate)}</title>
<style>
  @page { size: A4; margin: 22mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #172033; background: #ffffff; font-size: 12px; }
  .header { background: linear-gradient(135deg, #172033, #0d7a6b); color: #fff; border-radius: 18px; padding: 22px 24px; margin-bottom: 18px; }
  .eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 800; color: #bff8ef; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 25px; line-height: 1.15; }
  .subtitle { margin: 8px 0 0; color: #e6fffb; font-size: 12px; }
  .scope { margin: 8px 0 0; color: #fff; font-size: 11px; font-weight: 700; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
  .summary-card { border: 1px solid #d8e0ea; border-radius: 12px; padding: 10px; background: #f8fafc; }
  .summary-card span { display: block; color: #60708a; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
  .summary-card strong { display: block; color: #0d7a6b; font-size: 18px; margin-top: 4px; }
  .client-section { break-inside: avoid; margin-bottom: 16px; }
  .client-head { border-left: 6px solid #0d7a6b; background: #eefcf8; border-radius: 12px; padding: 10px 12px; display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 10px; }
  .client-head h2 { margin: 0; font-size: 17px; color: #0f2537; }
  .client-head span { font-weight: 800; color: #0d7a6b; font-size: 11px; }
  .block-card { border: 1px solid #d8e0ea; border-radius: 14px; margin-bottom: 10px; overflow: hidden; break-inside: avoid; }
  .block-title { background: #f8fafc; border-bottom: 1px solid #d8e0ea; padding: 9px 11px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .block-title span { display: block; color: #60708a; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
  .block-title strong { display: block; color: #172033; font-size: 15px; }
  .block-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
  .request-status { border-radius: 999px; padding: 5px 9px; font-size: 10px !important; font-weight: 800; white-space: nowrap; }
  .request-status.complete { background: #dcfce7; color: #166534; }
  .request-status.confirmation { background: #dbeafe; color: #1d4ed8; }
  .request-status.pending { background: #fef3c7; color: #92400e; }
  .coverage { background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 5px 9px; font-size: 11px; font-weight: 800; white-space: nowrap; }
  .block-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; padding: 10px 11px 0; color: #334155; }
  .workers-list { margin: 8px 0 0; padding: 0 11px 11px 32px; }
  .workers-list li { margin: 5px 0; line-height: 1.35; }
  .workers-list strong { color: #172033; }
  .workers-list span { color: #475569; margin-left: 6px; }
  .workers-list em { display: inline-block; margin-left: 6px; color: #1d4ed8; font-size: 10px; font-style: normal; font-weight: 800; }
  .empty-workers { padding: 0 11px 11px; color: #991b1b; font-weight: 800; }
  .footer { margin-top: 18px; border-top: 1px solid #d8e0ea; padding-top: 10px; display: flex; justify-content: space-between; color: #60708a; font-size: 10px; }
</style>
</head>
<body>
  <header class="header">
    <div class="eyebrow">LoginPro · Operaciones / Despacho</div>
    <h1>${escapeHtml(documentTitle)}</h1>
    <p class="subtitle">Fecha de servicio: ${escapeHtml(selectedDate)} · Generado: ${escapeHtml(generatedAt)} · Gestionado por: ${escapeHtml(manager)}</p>
    <p class="scope">${escapeHtml(scopeLabel)}</p>
  </header>
  <section class="summary">
    <div class="summary-card"><span>Solicitudes incluidas</span><strong>${includedSummary.totalRequests}</strong></div>
    <div class="summary-card"><span>Completas del día</span><strong>${overallSummary.completedRequests}/${overallSummary.totalRequests}</strong></div>
    <div class="summary-card"><span>Aux. requeridos</span><strong>${includedSummary.requiredWorkers}</strong></div>
    <div class="summary-card"><span>Aux. asignados</span><strong>${includedSummary.assignedWorkers}</strong></div>
  </section>
  ${clientSections}
  <footer class="footer"><span>Documento generado por LoginPro Operaciones.</span><span>Solo incluye nombre completo, documento y estado del auxiliar.</span></footer>
</body>
</html>`;
}

async function htmlToPdfBuffer(html) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    const error = new Error('No hay navegador disponible para generar el PDF de programación.');
    error.statusCode = 503;
    throw error;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-programming-'));
  const htmlPath = path.join(tempDir, 'programacion.html');
  const pdfPath = path.join(tempDir, 'programacion.pdf');
  await fs.writeFile(htmlPath, html, 'utf8');

  try {
    await execFileAsync(executablePath, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`
    ], { timeout: 45000 });
    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildProgrammingPdfBuffer(prisma, options = {}) {
  const loaded = await loadProgrammingRequests(prisma, options.fecha || options.date, { requestId: options.requestId });
  const includePending = normalizeProgrammingIncludePending(options.includePending, true);
  const requests = selectProgrammingRequests(loaded.requests, { includePending, requestId: options.requestId });
  const overallSummary = buildProgrammingCompletionSummary(loaded.requests);
  const includedSummary = buildProgrammingCompletionSummary(requests);
  const html = buildHtml({
    selectedDate: loaded.selectedDate,
    requests,
    managedBy: options.managedBy,
    includePending,
    overallSummary
  });
  return {
    selectedDate: loaded.selectedDate,
    summary: overallSummary,
    includedSummary,
    includePending,
    buffer: await htmlToPdfBuffer(html)
  };
}

export function buildProgrammingFilename(selectedDate, suffix = 'completa') {
  return `programacion-operativa-${suffix}-${selectedDate}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}
