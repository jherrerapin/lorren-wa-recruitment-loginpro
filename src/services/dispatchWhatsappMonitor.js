import { dispatchServiceDateKey } from './dispatchDate.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `57${digits}` : digits;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatServiceDate(value) {
  const key = dispatchServiceDateKey(value);
  if (!key) return 'fecha por confirmar';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function hourLabel(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '').trim() || 'Por confirmar';
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function assignmentMessage(assignment = {}) {
  const worker = assignment.worker || {};
  const request = assignment.serviceRequest || {};
  const name = text(worker.fullName) || 'Auxiliar';
  const operation = text(request.operationPointName) || text(request.serviceName) || 'Operación LoginPro';
  const address = text(request.address) || text(request.operationPoint?.address) || 'Por confirmar';
  return `Hola *${name}*,\n\nMañana: *${formatServiceDate(request.serviceDate)}*\nLlegar a: *${operation}  - ${address}*\nHora : *${hourLabel(request.startTime)} por favor.*\n\n\n*Confirmado?*`;
}

function eventBase({ id, occurredAt, direction, phone, contactName, kind, content, status, evidence, messageId = null }) {
  return {
    id,
    occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
    direction,
    phone: normalizePhone(phone),
    contactName: text(contactName) || null,
    kind,
    content,
    status: text(status) || 'UNKNOWN',
    evidence,
    messageId: text(messageId) || null
  };
}

function assignmentEvents(link) {
  const assignment = link.assignment || {};
  const worker = assignment.worker || {};
  const events = [eventBase({
    id: `assignment-out-${link.id}`,
    occurredAt: link.createdAt,
    direction: 'OUTBOUND',
    phone: link.phone || worker.phone,
    contactName: worker.fullName,
    kind: 'ASIGNACION',
    content: assignmentMessage(assignment),
    status: link.status,
    evidence: 'PERSISTIDO',
    messageId: link.providerMessageId
  })];

  const replyAt = link.confirmationReceivedAt;
  if (replyAt && link.confirmationMessageId && ['CONFIRMED', 'CONFIRMED_REPLY_PENDING'].includes(link.status)) {
    events.push(eventBase({
      id: `assignment-confirm-${link.id}`,
      occurredAt: replyAt,
      direction: 'INBOUND',
      phone: link.phone || worker.phone,
      contactName: worker.fullName,
      kind: 'CONFIRMACION',
      content: 'CONFIRMADO',
      status: 'RECIBIDO',
      evidence: 'PERSISTIDO',
      messageId: link.confirmationMessageId
    }));
  }

  if (replyAt && link.confirmationMessageId && link.status === 'DECLINED') {
    events.push(eventBase({
      id: `assignment-decline-${link.id}`,
      occurredAt: replyAt,
      direction: 'INBOUND',
      phone: link.phone || worker.phone,
      contactName: worker.fullName,
      kind: 'RESPUESTA_LEGACY',
      content: 'NO PUEDO',
      status: 'RECIBIDO',
      evidence: 'PERSISTIDO',
      messageId: link.confirmationMessageId
    }));
  }

  if (replyAt && link.status === 'CONFIRMED') {
    events.push(eventBase({
      id: `assignment-thanks-${link.id}`,
      occurredAt: new Date(new Date(replyAt).getTime() + 1),
      direction: 'OUTBOUND',
      phone: link.phone || worker.phone,
      contactName: worker.fullName,
      kind: 'RESPUESTA_AUTOMATICA',
      content: 'Gracias.',
      status: 'ENVIADO',
      evidence: 'RECONSTRUIDO'
    }));
  }

  return events;
}

function noveltyEvent(incident) {
  const assignment = incident.assignment || {};
  const worker = incident.worker || assignment.worker || {};
  return eventBase({
    id: `novelty-${incident.id}`,
    occurredAt: incident.createdAt,
    direction: 'INBOUND',
    phone: worker.phone,
    contactName: worker.fullName,
    kind: 'NOVEDAD',
    content: 'REPORTAR NOVEDAD',
    status: incident.status || 'OPEN',
    evidence: 'PERSISTIDO'
  });
}

function reminderText(reminder, link) {
  const worker = link?.assignment?.worker;
  if (!worker) return 'Recordatorio de vencimiento de la ventana de 24 horas.';
  return `⏰ La ventana de 24 horas con ${text(worker.fullName) || 'el auxiliar'} (${normalizePhone(worker.phone) || 'sin número'}) vence en aproximadamente 25 minutos. Si necesitas enviarle información sin plantilla, hazlo antes del vencimiento.`;
}

function reminderEvent(reminder, user, link) {
  return eventBase({
    id: `window-reminder-${reminder.id}`,
    occurredAt: reminder.sentAt || reminder.createdAt,
    direction: 'OUTBOUND',
    phone: user?.dispatchAlertPhone,
    contactName: user?.username,
    kind: 'RECORDATORIO_24H',
    content: reminderText(reminder, link),
    status: reminder.status,
    evidence: 'PERSISTIDO'
  });
}

function matches(event, filters) {
  if (filters.direction && event.direction !== filters.direction) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  if (filters.status && event.status !== filters.status) return false;
  if (filters.phone && !event.phone.includes(filters.phone)) return false;
  if (filters.q) {
    const haystack = [event.contactName, event.phone, event.kind, event.content, event.status, event.messageId]
      .filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filters.q)) return false;
  }
  return true;
}

function closestLinkBefore(links, workerPhone, occurredAt) {
  const phone = normalizePhone(workerPhone);
  const time = new Date(occurredAt).getTime();
  return links.find((link) => normalizePhone(link.phone || link.assignment?.worker?.phone) === phone
    && new Date(link.createdAt).getTime() <= time) || null;
}

export function normalizeDispatchWhatsappMonitorFilters(query = {}) {
  const page = positiveInteger(query.page, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE));
  return {
    page,
    pageSize,
    direction: ['INBOUND', 'OUTBOUND'].includes(text(query.direction).toUpperCase()) ? text(query.direction).toUpperCase() : '',
    kind: text(query.kind).toUpperCase(),
    status: text(query.status).toUpperCase(),
    phone: normalizePhone(query.phone),
    q: text(query.q).toLowerCase()
  };
}

export async function loadDispatchWhatsappMonitorHistory({ prismaClient, query = {} } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const filters = normalizeDispatchWhatsappMonitorFilters(query);
  const [links, incidents, reminders] = await Promise.all([
    prismaClient.dispatchWhatsappConfirmation.findMany({
      include: {
        assignment: {
          include: {
            worker: true,
            serviceRequest: { include: { operationPoint: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    }),
    prismaClient.dispatchIncident.findMany({
      where: { type: 'WHATSAPP_NOVELTY' },
      include: { worker: true, assignment: { include: { worker: true } } },
      orderBy: { createdAt: 'desc' }
    }),
    prismaClient.dispatchWhatsappWindowReminder.findMany({ orderBy: { createdAt: 'desc' } })
  ]);

  const appUserIds = [...new Set(reminders.map((item) => item.appUserId).filter(Boolean))];
  const users = appUserIds.length
    ? await prismaClient.appUser.findMany({
        where: { id: { in: appUserIds } },
        select: { id: true, username: true, dispatchAlertPhone: true }
      })
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const linksByNewest = [...links].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const events = links.flatMap(assignmentEvents);
  events.push(...incidents.map(noveltyEvent));
  events.push(...reminders.map((reminder) => {
    const link = closestLinkBefore(linksByNewest, reminder.phone, reminder.sentAt || reminder.createdAt);
    return reminderEvent(reminder, usersById.get(reminder.appUserId), link);
  }));

  const filtered = events
    .filter((event) => event.occurredAt && matches(event, filters))
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const start = (page - 1) * filters.pageSize;
  const items = filtered.slice(start, start + filters.pageSize);
  const oldest = filtered.length ? filtered[filtered.length - 1].occurredAt : null;
  const reconstructedCount = filtered.filter((event) => event.evidence === 'RECONSTRUIDO').length;

  return {
    items,
    filters: { ...filters, page },
    pagination: { page, pageSize: filters.pageSize, total, totalPages },
    summary: {
      total,
      inbound: filtered.filter((event) => event.direction === 'INBOUND').length,
      outbound: filtered.filter((event) => event.direction === 'OUTBOUND').length,
      reconstructed: reconstructedCount,
      oldestAvailableAt: oldest
    },
    limitations: [
      'Meta Cloud API no ofrece un listado retroactivo de conversaciones completas.',
      'Los eventos anteriores se muestran únicamente cuando existe evidencia persistida en Lórren.',
      '“Reconstruido” significa que el contenido se dedujo de un estado persistido; no equivale a conservar el payload original.'
    ]
  };
}
