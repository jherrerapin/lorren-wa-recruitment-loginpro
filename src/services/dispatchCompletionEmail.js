import { buildGroupedWhereClauseForRequest, countAssignments, extractRequestGroupCode, resolveRequestServiceName } from './dispatchRequestGrouping.js';

const EMAIL_PROVIDER_RESEND = 'resend';
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];

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

function formatShift(request) {
  return request.startTime || '-';
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

function getGroupRecipient(requests) {
  const firstWithEmail = requests.find((request) => normalizeString(request.requestedByEmail));
  return normalizeString(firstWithEmail?.requestedByEmail);
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

function getEmailConfig() {
  return {
    provider: normalizeString(process.env.EMAIL_PROVIDER) || EMAIL_PROVIDER_RESEND,
    resendApiKey: normalizeString(process.env.RESEND_API_KEY),
    from: normalizeString(process.env.DISPATCH_EMAIL_FROM) || normalizeString(process.env.EMAIL_FROM),
    defaultReplyTo: normalizeString(process.env.DISPATCH_EMAIL_REPLY_TO) || normalizeString(process.env.EMAIL_REPLY_TO)
  };
}

async function sendWithResend({ apiKey, from, to, subject, html, text, replyTo }) {
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

/**
 * @param {object} prisma
 * @param {string} serviceRequestId
 * @param {{ replyTo?: string|null, managedByUsername?: string|null }} [options]
 */
export async function sendDispatchCompletionEmail(prisma, serviceRequestId, options = {}) {
  const requestGroup = await loadRequestGroup(prisma, serviceRequestId);
  if (!requestGroup.length) return { skipped: true, reason: 'service_request_not_found' };
  if (!groupIsComplete(requestGroup)) return { skipped: true, reason: 'service_request_not_complete' };
  if (requestGroup.every((request) => request.completionEmailSentAt)) return { skipped: true, reason: 'already_sent' };

  const recipient = getGroupRecipient(requestGroup);
  if (!recipient) return { skipped: true, reason: 'missing_requested_by_email' };

  const config = getEmailConfig();
  const firstRequest = sortRequestsByTime(requestGroup)[0];
  if (config.provider !== EMAIL_PROVIDER_RESEND) return { skipped: true, reason: 'unsupported_provider' };
  if (!config.resendApiKey || !config.from) {
    const errorMessage = 'Faltan RESEND_API_KEY y/o DISPATCH_EMAIL_FROM para enviar correo de cierre.';
    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: requestGroup.map((request) => request.id) } },
      data: { completionEmailLastError: errorMessage }
    });
    return { skipped: true, reason: 'missing_email_config' };
  }

  const replyTo = normalizeString(options.replyTo) || config.defaultReplyTo;
  const managedByUsername = normalizeString(options.managedByUsername);
  const subject = `Solicitud confirmada - ${firstRequest.clientName} - ${firstRequest.operationPointName || firstRequest.cityName || ''}`.trim();
  const html = buildHtmlForRequests(requestGroup, managedByUsername);
  const text = buildTextForRequests(requestGroup, managedByUsername);

  try {
    const providerId = await sendWithResend({
      apiKey: config.resendApiKey,
      from: config.from,
      to: recipient,
      subject,
      html,
      text,
      replyTo
    });

    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: requestGroup.map((request) => request.id) } },
      data: {
        completionEmailSentAt: new Date(),
        completionEmailTo: recipient,
        completionEmailProviderId: providerId,
        completionEmailLastError: null
      }
    });

    return { sent: true, to: recipient, providerId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido enviando correo.';
    await prisma.dispatchServiceRequest.updateMany({
      where: { id: { in: requestGroup.map((request) => request.id) } },
      data: { completionEmailLastError: message }
    });
    return { sent: false, error: message };
  }
}
