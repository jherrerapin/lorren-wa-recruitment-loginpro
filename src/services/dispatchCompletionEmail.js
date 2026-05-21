const EMAIL_PROVIDER_RESEND = 'resend';

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

function buildText(serviceRequest) {
  const assignments = serviceRequest.assignments || [];
  const workersText = assignments
    .map((assignment, index) => {
      const worker = assignment.worker;
      return `${index + 1}. ${worker.fullName || 'Auxiliar'} | Tel: ${worker.phone || '-'} | Doc: ${[worker.documentType, worker.documentNumber].filter(Boolean).join(' ') || '-'}`;
    })
    .join('\n');

  return [
    'Confirmación de solicitud de servicio',
    '',
    `Cliente: ${serviceRequest.clientName || '-'}`,
    `Operación: ${serviceRequest.operationPointName || '-'}`,
    `Servicio: ${serviceRequest.serviceName || '-'}`,
    `Ciudad: ${serviceRequest.cityName || '-'}`,
    `Dirección: ${serviceRequest.address || '-'}`,
    `Fecha: ${formatDate(serviceRequest.serviceDate)}`,
    `Horario: ${serviceRequest.startTime || '-'} - ${serviceRequest.endTime || '-'}`,
    `Auxiliares requeridos: ${serviceRequest.requiredWorkers || 0}`,
    '',
    'Auxiliares confirmados:',
    workersText || 'Sin auxiliares confirmados.',
    '',
    serviceRequest.notes ? `Notas: ${serviceRequest.notes}` : null
  ].filter(Boolean).join('\n');
}

function buildHtml(serviceRequest) {
  const assignments = serviceRequest.assignments || [];
  const workersRows = assignments.map((assignment, index) => {
    const worker = assignment.worker;
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${index + 1}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;"><strong>${escapeHtml(worker.fullName || 'Auxiliar')}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(worker.phone || '-')}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml([worker.documentType, worker.documentNumber].filter(Boolean).join(' ') || '-')}</td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:Arial,sans-serif;color:#172033;line-height:1.5;max-width:760px;margin:0 auto;">
    <div style="background:#1e2d3d;color:#ffffff;padding:20px 24px;border-radius:14px 14px 0 0;">
      <h1 style="margin:0;font-size:22px;">Solicitud de servicio confirmada</h1>
      <p style="margin:6px 0 0;color:#cbd5e1;">La asignación de auxiliares fue completada y confirmada.</p>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:0;padding:22px 24px;border-radius:0 0 14px 14px;">
      <h2 style="font-size:16px;margin:0 0 12px;color:#1e2d3d;">Información de la solicitud</h2>
      <table style="border-collapse:collapse;width:100%;margin-bottom:22px;">
        <tbody>
          <tr><td style="padding:6px 0;color:#64748b;width:180px;">Cliente</td><td style="padding:6px 0;"><strong>${escapeHtml(serviceRequest.clientName || '-')}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Operación</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.operationPointName || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Servicio</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.serviceName || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Ciudad</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.cityName || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Dirección</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.address || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Fecha</td><td style="padding:6px 0;">${escapeHtml(formatDate(serviceRequest.serviceDate))}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Horario</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.startTime || '-')} - ${escapeHtml(serviceRequest.endTime || '-')}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;">Auxiliares requeridos</td><td style="padding:6px 0;">${escapeHtml(serviceRequest.requiredWorkers || 0)}</td></tr>
        </tbody>
      </table>

      <h2 style="font-size:16px;margin:0 0 12px;color:#1e2d3d;">Auxiliares confirmados</h2>
      <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">#</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Nombre</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Teléfono</th>
            <th style="padding:8px;text-align:left;border-bottom:1px solid #e5e7eb;">Documento</th>
          </tr>
        </thead>
        <tbody>${workersRows || '<tr><td colspan="4" style="padding:10px;">Sin auxiliares confirmados.</td></tr>'}</tbody>
      </table>

      ${serviceRequest.notes ? `<p style="margin-top:18px;"><strong>Notas:</strong> ${escapeHtml(serviceRequest.notes)}</p>` : ''}
      <p style="margin-top:22px;color:#64748b;font-size:12px;">Mensaje generado automáticamente por el sistema LoginPro IA / Operaciones.</p>
    </div>
  </div>`;
}

function getEmailConfig() {
  return {
    provider: normalizeString(process.env.EMAIL_PROVIDER) || EMAIL_PROVIDER_RESEND,
    resendApiKey: normalizeString(process.env.RESEND_API_KEY),
    from: normalizeString(process.env.DISPATCH_EMAIL_FROM) || normalizeString(process.env.EMAIL_FROM),
    replyTo: normalizeString(process.env.DISPATCH_EMAIL_REPLY_TO) || normalizeString(process.env.EMAIL_REPLY_TO)
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

export async function sendDispatchCompletionEmail(prisma, serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    include: {
      assignments: {
        where: { status: 'CONFIRMED' },
        include: { worker: true },
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  if (!serviceRequest) return { skipped: true, reason: 'service_request_not_found' };
  if (serviceRequest.status !== 'ASSIGNMENT_COMPLETE') return { skipped: true, reason: 'service_request_not_complete' };
  if (serviceRequest.completionEmailSentAt) return { skipped: true, reason: 'already_sent' };

  const recipient = normalizeString(serviceRequest.requestedByEmail);
  if (!recipient) return { skipped: true, reason: 'missing_requested_by_email' };

  const config = getEmailConfig();
  if (config.provider !== EMAIL_PROVIDER_RESEND) return { skipped: true, reason: 'unsupported_provider' };
  if (!config.resendApiKey || !config.from) {
    const errorMessage = 'Faltan RESEND_API_KEY y/o DISPATCH_EMAIL_FROM para enviar correo de cierre.';
    await prisma.dispatchServiceRequest.update({
      where: { id: serviceRequest.id },
      data: { completionEmailLastError: errorMessage }
    });
    return { skipped: true, reason: 'missing_email_config' };
  }

  const subject = `Solicitud confirmada - ${serviceRequest.clientName} - ${serviceRequest.operationPointName || serviceRequest.cityName || ''}`.trim();
  const html = buildHtml(serviceRequest);
  const text = buildText(serviceRequest);

  try {
    const providerId = await sendWithResend({
      apiKey: config.resendApiKey,
      from: config.from,
      to: recipient,
      subject,
      html,
      text,
      replyTo: config.replyTo
    });

    await prisma.dispatchServiceRequest.update({
      where: { id: serviceRequest.id },
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
    await prisma.dispatchServiceRequest.update({
      where: { id: serviceRequest.id },
      data: { completionEmailLastError: message }
    });
    return { sent: false, error: message };
  }
}
