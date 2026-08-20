import { buildGroupedWhereClauseForRequest, countAssignments, extractRequestGroupCode, resolveRequestServiceName } from './dispatchRequestGrouping.js';

const EMAIL_PROVIDER_RESEND = 'resend';
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const PDF_PAGE_WIDTH = 595;
const PDF_PAGE_HEIGHT = 842;
const PDF_MARGIN = 48;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function formatDateKey(value) {
  if (!value) return 'sin-fecha';
  return new Date(value).toISOString().slice(0, 10);
}

function formatShift(request) {
  const start = normalizeString(request.startTime) || '-';
  const end = normalizeString(request.endTime);
  return end ? `${start} - ${end}` : start;
}

function sortRequestsByTime(requests) {
  return [...requests].sort((a, b) => {
    const dateA = new Date(a.serviceDate || 0).getTime();
    const dateB = new Date(b.serviceDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''), 'es');
  });
}

function confirmedAssignments(request) {
  return (request.assignments || []).filter((assignment) => assignment.status === 'CONFIRMED');
}

function requestIsComplete(request) {
  return countAssignments(request, ACTIVE_ASSIGNMENT_STATUSES).confirmedCount >= (Number(request.requiredWorkers) || 0);
}

function groupIsComplete(requests) {
  return requests.length > 0 && requests.every(requestIsComplete);
}

function firstPersistedValue(requests, fieldName) {
  const row = requests.find((request) => normalizeString(request[fieldName]));
  return normalizeString(row?.[fieldName]);
}

function getGroupRecipient(requests) {
  return firstPersistedValue(requests, 'requestedByEmail');
}

function getGroupPhone(requests) {
  return firstPersistedValue(requests, 'requestedByPhone');
}

function getGroupRequesterName(requests) {
  return firstPersistedValue(requests, 'requestedByName');
}

function buildTextForRequests(requests, managedByUsername) {
  const sortedRequests = sortRequestsByTime(requests);
  const primary = sortedRequests[0] || {};
  const serviceName = resolveRequestServiceName(primary) || '-';
  const shiftBlocks = sortedRequests.map((request, shiftIndex) => {
    const workersText = confirmedAssignments(request)
      .map((assignment, index) => {
        const worker = assignment.worker;
        return `${index + 1}. ${worker.fullName || 'Auxiliar'} | Tel: ${worker.phone || '-'} | Doc: ${[worker.documentType, worker.documentNumber].filter(Boolean).join(' ') || '-'}`;
      })
      .join('\n');

    return [
      `Horario ${shiftIndex + 1}: ${formatShift(request)}`,
      `Auxiliares requeridos: ${request.requiredWorkers || 0}`,
      workersText || 'Sin auxiliares confirmados.'
    ].join('\n');
  }).join('\n\n');

  return [
    'Confirmación de solicitud de servicio',
    '',
    `Cliente: ${primary.clientName || '-'}`,
    `Operación: ${primary.operationPointName || '-'}`,
    `Servicio: ${serviceName}`,
    `Ciudad: ${primary.cityName || '-'}`,
    `Dirección: ${primary.address || '-'}`,
    `Fecha: ${formatDate(primary.serviceDate)}`,
    `Total auxiliares requeridos: ${sortedRequests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0)}`,
    '',
    'Asignación por horario:',
    shiftBlocks,
    '',
    primary.notes ? `Notas: ${primary.notes}` : null,
    '',
    managedByUsername ? `Gestionado por: ${managedByUsername}` : null
  ].filter(Boolean).join('\n');
}

function buildHtmlForRequests(requests, managedByUsername) {
  const sortedRequests = sortRequestsByTime(requests);
  const primary = sortedRequests[0] || {};
  const serviceName = resolveRequestServiceName(primary) || '-';
  const totalRequired = sortedRequests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0);
  const shiftSections = sortedRequests.map((request, shiftIndex) => {
    const workersRows = confirmedAssignments(request).map((assignment, index) => {
      const worker = assignment.worker;
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${index + 1}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;"><strong>${escapeHtml(worker.fullName || 'Auxiliar')}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(worker.phone || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml([worker.documentType, worker.documentNumber].filter(Boolean).join(' ') || '-')}</td>
      </tr>`;
    }).join('');

    return `
      <h3 style="font-size:15px;margin:22px 0 8px;color:#1e2d3d;">Horario ${shiftIndex + 1}: ${escapeHtml(formatShift(request))}</h3>
      <p style="margin:0 0 8px;color:#64748b;">Auxiliares requeridos: ${escapeHtml(request.requiredWorkers || 0)}</p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:12px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">#</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Nombre</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Teléfono</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Documento</th>
          </tr>
        </thead>
        <tbody>${workersRows || '<tr><td colspan="4" style="padding:10px;">Sin auxiliares confirmados.</td></tr>'}</tbody>
      </table>`;
  }).join('');

  const managedByRow = managedByUsername
    ? `<tr><td style="padding:6px 0;color:#64748b;">Gestionado por</td><td style="padding:6px 0;">${escapeHtml(managedByUsername)}</td></tr>`
    : '';

  return `
  <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.5;max-width:760px;margin:0 auto;">
    <div style="background:#1e2d3d;color:#ffffff;padding:20px 24px;border-radius:14px 14px 0 0;">
      <h1 style="margin:0;font-size:22px;">Solicitud de servicio confirmada</h1>
      <p style="margin:6px 0 0;color:#cbd5e1;">La asignación fue completada y confirmada para todos los horarios solicitados.</p>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:0;padding:22px 24px;border-radius:0 0 14px 14px;">
      <p style="margin:0 0 18px;color:#334155;">Adjuntamos el PDF con el detalle de los auxiliares confirmados para esta solicitud.</p>
      <h2 style="font-size:16px;margin:0 0 12px;color:#1e2d3d;">Información de la solicitud</h2>
      <table style="border-collapse:collapse;width:100%;margin-bottom:22px;">
        <tbody>
          <tr><td style="padding:6px 0;color:#64748b;width:180px;">Cliente</td><td style="padding:6px 0;"><strong>${escapeHtml(primary.clientName || '-')}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Operación</td><td style="padding:6px 0;">${escapeHtml(primary.operationPointName || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Servicio</td><td style="padding:6px 0;">${escapeHtml(serviceName)}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Ciudad</td><td style="padding:6px 0;">${escapeHtml(primary.cityName || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Dirección</td><td style="padding:6px 0;">${escapeHtml(primary.address || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Fecha</td><td style="padding:6px 0;">${escapeHtml(formatDate(primary.serviceDate))}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Horarios</td><td style="padding:6px 0;">${escapeHtml(sortedRequests.map(formatShift).join(' / '))}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Total requeridos</td><td style="padding:6px 0;">${escapeHtml(totalRequired)}</td></tr>
          ${managedByRow}
        </tbody>
      </table>
      <h2 style="font-size:16px;margin:0 0 12px;color:#1e2d3d;">Auxiliares confirmados por horario</h2>
      ${shiftSections}
      ${primary.notes ? `<p style="margin-top:18px;"><strong>Notas:</strong> ${escapeHtml(primary.notes)}</p>` : ''}
      <p style="margin-top:22px;color:#64748b;font-size:12px;">Mensaje generado automáticamente por el sistema LoginPro IA / Operaciones.</p>
    </div>
  </div>`;
}

function pdfSafe(value) {
  return String(value ?? '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pdfText(command, text, x, y, size = 10, bold = false, color = '0.10 0.15 0.22') {
  command.push(`${color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfSafe(text)}) Tj ET\n`);
}

function truncatePdfText(value, maxLength) {
  const text = String(value ?? '-');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function buildPdfPages(requests, managedByUsername) {
  const sortedRequests = sortRequestsByTime(requests);
  const primary = sortedRequests[0] || {};
  const serviceName = resolveRequestServiceName(primary) || '-';
  const pages = [];
  let command = [];
  let y = 742;

  function startPage() {
    command = [];
    command.push('0.12 0.18 0.24 rg 0 782 595 60 re f\n');
    pdfText(command, 'LoginPro IA / Operaciones', PDF_MARGIN, 810, 11, true, '1 1 1');
    pdfText(command, 'Auxiliares confirmados', PDF_MARGIN, 790, 18, true, '1 1 1');
    y = 748;
  }

  function finishPage() {
    const pageNumber = pages.length + 1;
    pdfText(command, `Página ${pageNumber}`, 500, 28, 8, false, '0.45 0.50 0.58');
    pdfText(command, 'Documento generado por LoginPro IA / Operaciones', PDF_MARGIN, 28, 8, false, '0.45 0.50 0.58');
    pages.push(command.join(''));
  }

  function ensureSpace(height) {
    if (y - height >= 64) return;
    finishPage();
    startPage();
  }

  startPage();
  pdfText(command, truncatePdfText(primary.clientName || '-', 78), PDF_MARGIN, y, 15, true);
  y -= 24;
  const summaryRows = [
    ['Operación', primary.operationPointName || '-'],
    ['Servicio', serviceName],
    ['Ciudad', primary.cityName || '-'],
    ['Dirección', primary.address || '-'],
    ['Fecha', formatDate(primary.serviceDate)],
    ['Horarios', sortedRequests.map(formatShift).join(' / ') || '-'],
    ['Total requeridos', sortedRequests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0)],
    ...(managedByUsername ? [['Gestionado por', managedByUsername]] : [])
  ];

  command.push(`0.96 0.97 0.98 rg ${PDF_MARGIN} ${y - (summaryRows.length * 20) - 8} 499 ${(summaryRows.length * 20) + 18} re f\n`);
  summaryRows.forEach(([label, value]) => {
    pdfText(command, label, PDF_MARGIN + 12, y, 9, true, '0.38 0.45 0.55');
    pdfText(command, truncatePdfText(value, 70), PDF_MARGIN + 120, y, 9, false);
    y -= 20;
  });
  y -= 16;

  sortedRequests.forEach((request, shiftIndex) => {
    const workers = confirmedAssignments(request);
    ensureSpace(64 + workers.length * 28);
    pdfText(command, `Horario ${shiftIndex + 1}: ${formatShift(request)}`, PDF_MARGIN, y, 12, true, '0.05 0.48 0.42');
    y -= 18;
    pdfText(command, `Auxiliares requeridos: ${request.requiredWorkers || 0}`, PDF_MARGIN, y, 9, false, '0.38 0.45 0.55');
    y -= 18;

    command.push(`0.93 0.95 0.97 rg ${PDF_MARGIN} ${y - 18} 499 24 re f\n`);
    pdfText(command, '#', PDF_MARGIN + 8, y - 3, 8, true);
    pdfText(command, 'Nombre', PDF_MARGIN + 34, y - 3, 8, true);
    pdfText(command, 'Teléfono', PDF_MARGIN + 260, y - 3, 8, true);
    pdfText(command, 'Documento', PDF_MARGIN + 365, y - 3, 8, true);
    y -= 26;

    if (!workers.length) {
      pdfText(command, 'Sin auxiliares confirmados.', PDF_MARGIN + 8, y, 9, false, '0.38 0.45 0.55');
      y -= 24;
    } else {
      workers.forEach((assignment, index) => {
        ensureSpace(34);
        const worker = assignment.worker || {};
        command.push(`0.88 0.90 0.93 RG ${PDF_MARGIN} ${y - 18} 499 24 re S\n`);
        pdfText(command, String(index + 1), PDF_MARGIN + 8, y - 3, 8);
        pdfText(command, truncatePdfText(worker.fullName || 'Auxiliar', 34), PDF_MARGIN + 34, y - 3, 8, true);
        pdfText(command, truncatePdfText(worker.phone || '-', 17), PDF_MARGIN + 260, y - 3, 8);
        pdfText(command, truncatePdfText([worker.documentType, worker.documentNumber].filter(Boolean).join(' ') || '-', 22), PDF_MARGIN + 365, y - 3, 8);
        y -= 26;
      });
    }
    y -= 12;
  });

  if (primary.notes) {
    ensureSpace(54);
    pdfText(command, 'Notas', PDF_MARGIN, y, 10, true);
    y -= 16;
    pdfText(command, truncatePdfText(primary.notes, 92), PDF_MARGIN, y, 9, false, '0.25 0.31 0.40');
  }

  finishPage();
  return pages;
}

function buildPdfBuffer(pageStreams) {
  const pageCount = pageStreams.length;
  const objects = new Map();
  const pageObjectIds = [];
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pageStreams.forEach((stream, index) => {
    const contentId = 5 + index * 2;
    const pageId = contentId + 1;
    pageObjectIds.push(pageId);
    const streamLength = Buffer.byteLength(stream, 'latin1');
    objects.set(contentId, `<< /Length ${streamLength} >>\nstream\n${stream}endstream`);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
  });

  objects.set(2, `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  const maxObjectId = Math.max(...objects.keys());
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [0];

  for (let id = 1; id <= maxObjectId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxObjectId + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id <= maxObjectId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function slugPart(value) {
  const normalized = String(value || 'cliente')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'cliente';
}

export function buildDispatchCompletionPdf(requests, options = {}) {
  const sortedRequests = sortRequestsByTime(requests);
  const primary = sortedRequests[0] || {};
  const managedByUsername = normalizeString(options.managedByUsername);
  const pageStreams = buildPdfPages(sortedRequests, managedByUsername);
  const buffer = buildPdfBuffer(pageStreams);
  const filename = `auxiliares-confirmados-${slugPart(primary.clientName)}-${formatDateKey(primary.serviceDate)}.pdf`;
  return { buffer, filename };
}

function buildWhatsappText(requests, requesterName) {
  const sortedRequests = sortRequestsByTime(requests);
  const primary = sortedRequests[0] || {};
  const greeting = requesterName ? `Hola ${requesterName},` : 'Hola,';
  return [
    greeting,
    '',
    `Te compartimos el PDF con los auxiliares confirmados para ${primary.clientName || 'la solicitud'}, ${primary.operationPointName || primary.cityName || ''}.`,
    `Fecha: ${formatDate(primary.serviceDate)}.`,
    '',
    'Quedamos atentos.'
  ].join('\n');
}

function getEmailConfig() {
  return {
    provider: normalizeString(process.env.EMAIL_PROVIDER) || EMAIL_PROVIDER_RESEND,
    resendApiKey: normalizeString(process.env.RESEND_API_KEY),
    from: normalizeString(process.env.DISPATCH_EMAIL_FROM) || normalizeString(process.env.EMAIL_FROM),
    defaultReplyTo: normalizeString(process.env.DISPATCH_EMAIL_REPLY_TO) || normalizeString(process.env.EMAIL_REPLY_TO)
  };
}

async function sendWithResend({ apiKey, from, to, subject, html, text, replyTo, attachment }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
      attachments: [{
        filename: attachment.filename,
        content: attachment.buffer.toString('base64')
      }],
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || `Error HTTP ${response.status}`;
    throw new Error(`No fue posible enviar correo: ${message}`);
  }

  return data?.id || null;
}

async function loadRequestGroup(prisma, serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    include: {
      assignments: {
        include: { worker: true },
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  if (!serviceRequest) return [];
  const groupCode = extractRequestGroupCode(serviceRequest);
  if (!groupCode) return [serviceRequest];

  return prisma.dispatchServiceRequest.findMany({
    where: buildGroupedWhereClauseForRequest(serviceRequest),
    include: {
      assignments: {
        include: { worker: true },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: [{ serviceDate: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });
}

export async function getDispatchCompletionPackage(prisma, serviceRequestId, options = {}) {
  const requestGroup = await loadRequestGroup(prisma, serviceRequestId);
  if (!requestGroup.length) return { ready: false, reason: 'service_request_not_found' };
  if (!groupIsComplete(requestGroup)) return { ready: false, reason: 'service_request_not_complete' };

  const sortedRequests = sortRequestsByTime(requestGroup);
  const firstRequest = sortedRequests[0];
  const managedByUsername = normalizeString(options.managedByUsername);
  const requesterName = getGroupRequesterName(requestGroup);
  const pdf = buildDispatchCompletionPdf(requestGroup, { managedByUsername });

  return {
    ready: true,
    requestIds: requestGroup.map((request) => request.id),
    recipientEmail: getGroupRecipient(requestGroup),
    recipientPhone: getGroupPhone(requestGroup),
    recipientName: requesterName,
    emailAlreadySent: requestGroup.every((request) => request.completionEmailSentAt),
    subject: `Solicitud confirmada - ${firstRequest.clientName} - ${firstRequest.operationPointName || firstRequest.cityName || ''}`.trim(),
    html: buildHtmlForRequests(requestGroup, managedByUsername),
    text: buildTextForRequests(requestGroup, managedByUsername),
    whatsappText: buildWhatsappText(requestGroup, requesterName),
    pdfBuffer: pdf.buffer,
    pdfFilename: pdf.filename
  };
}

/**
 * Envío manual de cierre. Las llamadas automáticas históricas permanecen inocuas
 * porque deben optar explícitamente por `manual: true`.
 *
 * @param {object} prisma
 * @param {string} serviceRequestId
 * @param {{ manual?: boolean, replyTo?: string|null, managedByUsername?: string|null }} [options]
 */
export async function sendDispatchCompletionEmail(prisma, serviceRequestId, options = {}) {
  const completionPackage = await getDispatchCompletionPackage(prisma, serviceRequestId, options);
  if (!completionPackage.ready) return { skipped: true, reason: completionPackage.reason };
  if (options.manual !== true) return { skipped: true, reason: 'manual_send_required' };
  if (completionPackage.emailAlreadySent) return { skipped: true, reason: 'already_sent' };

  const recipient = completionPackage.recipientEmail;
  if (!recipient) return { skipped: true, reason: 'missing_requested_by_email' };

  const config = getEmailConfig();
  if (config.provider !== EMAIL_PROVIDER_RESEND) return { skipped: true, reason: 'unsupported_provider' };
  if (!config.resendApiKey || !config.from) {
    const errorMessage = 'Faltan RESEND_API_KEY y/o DISPATCH_EMAIL_FROM para enviar correo de cierre.';
    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: completionPackage.requestIds } },
      data: { completionEmailLastError: errorMessage }
    });
    return { skipped: true, reason: 'missing_email_config' };
  }

  const replyTo = normalizeString(options.replyTo) || config.defaultReplyTo;

  try {
    const providerId = await sendWithResend({
      apiKey: config.resendApiKey,
      from: config.from,
      to: recipient,
      subject: completionPackage.subject,
      html: completionPackage.html,
      text: completionPackage.text,
      replyTo,
      attachment: {
        filename: completionPackage.pdfFilename,
        buffer: completionPackage.pdfBuffer
      }
    });

    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: completionPackage.requestIds } },
      data: {
        completionEmailSentAt: new Date(),
        completionEmailTo: recipient,
        completionEmailProviderId: providerId,
        completionEmailLastError: null
      }
    });

    return {
      sent: true,
      to: recipient,
      providerId,
      pdfFilename: completionPackage.pdfFilename
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido enviando correo.';
    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: completionPackage.requestIds } },
      data: { completionEmailLastError: message }
    });
    return { sent: false, error: message };
  }
}
