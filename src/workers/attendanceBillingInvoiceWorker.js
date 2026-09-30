import { prisma } from '../lib/prisma.js';
import {
  ensureAttendanceBillingInvoice
} from '../modules/dispatch-attendance/application/attendanceBillingCounter.js';
import { getOperationalAccessForUser } from '../services/operationalAccess.js';
import { normalizeDispatchWhatsappPhone } from '../services/dispatchWhatsappCloudConfig.js';
import { sendDispatchWhatsappTextMessage } from '../services/dispatchWhatsappCloudClient.js';

export const ATTENDANCE_BILLING_INVOICE_DELIVERY_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BILLING_INVOICE_DELIVERY';
export const ATTENDANCE_BILLING_INVOICE_DELIVERY_ACTION = 'ATTENDANCE_BILLING_INVOICE_WHATSAPP_SENT';
const DEFAULT_POLL_MS = 60 * 60 * 1000;

function normalizeString(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function pollMs(env = process.env) {
  const raw = Number(env.ATTENDANCE_BILLING_WORKER_POLL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : DEFAULT_POLL_MS;
}

function money(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(Math.max(0, Number(value) || 0));
}

function dateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return 'fecha pendiente';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date(`${value}T12:00:00.000Z`));
}

export function buildAttendanceBillingInvoiceWhatsappText(invoice = {}) {
  return [
    `🧾 Factura ${invoice.invoiceNumber || 'Asistencia'}`,
    `Periodo: ${dateLabel(invoice.cycleStart)} al ${dateLabel(invoice.cycleEnd)}`,
    `Auxiliares facturables: ${Number(invoice.count || 0)}`,
    `Valor unitario: ${money(invoice.unitPrice)}`,
    `Total: ${money(invoice.total)}`,
    `Fecha de pago: ${dateLabel(invoice.paymentDate)}`,
    '',
    'La factura quedó disponible en el módulo de Asistencia y Gestión de Tiempo.'
  ].join('\n');
}

export async function attendanceBillingInvoiceRecipients(prismaClient = prisma) {
  if (!prismaClient?.appUser?.findMany) throw new Error('attendance_billing_recipient_prisma_contract_invalid');
  const users = await prismaClient.appUser.findMany({
    where: { isActive: true },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isActive: true,
      dispatchAlertPhone: true,
      recoveryPhone: true
    },
    orderBy: { username: 'asc' }
  });

  const recipients = [];
  for (const user of users) {
    const appRole = String(user.role || '').toUpperCase();
    let targetRole = null;
    if (appRole === 'DEV') {
      targetRole = 'DEV';
    } else if (appRole === 'ADMIN') {
      const access = await getOperationalAccessForUser(prismaClient, user.id);
      if (access?.role === 'SUPERVISOR') targetRole = 'SUPERVISOR';
    }
    if (!targetRole) continue;
    const phone = normalizeDispatchWhatsappPhone(user.dispatchAlertPhone || user.recoveryPhone);
    if (!phone) continue;
    recipients.push({
      userId: user.id,
      username: user.username,
      displayName: normalizeString(user.displayName) || user.username,
      role: targetRole,
      phone
    });
  }
  const byPhone = new Map();
  for (const recipient of recipients) {
    if (!byPhone.has(recipient.phone)) byPhone.set(recipient.phone, recipient);
  }
  return [...byPhone.values()];
}

async function deliveryAlreadySent(prismaClient, invoice, recipient) {
  const event = await prismaClient.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BILLING_INVOICE_DELIVERY_ENTITY_TYPE,
      entityId: `${invoice.invoiceNumber}:${recipient.userId}`,
      action: ATTENDANCE_BILLING_INVOICE_DELIVERY_ACTION
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  return Boolean(event);
}

async function recordDelivery(prismaClient, invoice, recipient, providerMessageId) {
  return prismaClient.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BILLING_INVOICE_DELIVERY_ENTITY_TYPE,
      entityId: `${invoice.invoiceNumber}:${recipient.userId}`,
      entityLabel: `${invoice.invoiceNumber} → ${recipient.displayName}`,
      action: ATTENDANCE_BILLING_INVOICE_DELIVERY_ACTION,
      actorSource: 'attendance-billing-worker',
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        cycleStart: invoice.cycleStart,
        recipientUserId: recipient.userId,
        recipientUsername: recipient.username,
        recipientRole: recipient.role,
        phone: recipient.phone,
        providerMessageId: providerMessageId || null
      }
    }
  });
}

export async function deliverAttendanceBillingInvoice(prismaClient, invoice, options = {}) {
  if (!invoice) return { attempted: 0, sent: 0, skipped: 0, failed: 0, results: [] };
  const recipients = options.recipients || await attendanceBillingInvoiceRecipients(prismaClient);
  const sendText = options.sendText || sendDispatchWhatsappTextMessage;
  const results = [];
  for (const recipient of recipients) {
    if (await deliveryAlreadySent(prismaClient, invoice, recipient)) {
      results.push({ userId: recipient.userId, sent: false, skipped: true, reason: 'already_sent' });
      continue;
    }
    try {
      const providerMessageId = await sendText({
        scope: 'operational',
        phone: recipient.phone,
        text: buildAttendanceBillingInvoiceWhatsappText(invoice)
      });
      await recordDelivery(prismaClient, invoice, recipient, providerMessageId);
      results.push({ userId: recipient.userId, sent: true, skipped: false, providerMessageId });
    } catch (error) {
      results.push({
        userId: recipient.userId,
        sent: false,
        skipped: false,
        reason: 'provider_error',
        error: String(error?.message || error).slice(0, 240)
      });
    }
  }
  return {
    attempted: results.filter((item) => !item.skipped).length,
    sent: results.filter((item) => item.sent).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.sent && !item.skipped).length,
    results
  };
}

export async function runAttendanceBillingInvoiceSweep(options = {}) {
  const prismaClient = options.prismaClient || prisma;
  const invoiceResult = await ensureAttendanceBillingInvoice(prismaClient, { now: options.now || new Date() });
  if (!invoiceResult.invoice) return { invoice: invoiceResult, delivery: null };
  const delivery = await deliverAttendanceBillingInvoice(prismaClient, invoiceResult.invoice, options);
  return { invoice: invoiceResult, delivery };
}

export function startAttendanceBillingInvoiceWorker(options = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runAttendanceBillingInvoiceSweep(options);
      if (result.invoice?.created || result.delivery?.sent || result.delivery?.failed) {
        console.log('[ATTENDANCE_BILLING_INVOICE_SWEEP]', {
          created: result.invoice?.created === true,
          invoiceNumber: result.invoice?.invoice?.invoiceNumber || null,
          sent: result.delivery?.sent || 0,
          failed: result.delivery?.failed || 0
        });
      }
    } catch (error) {
      console.error('[ATTENDANCE_BILLING_INVOICE_SWEEP_FAILED]', { code: error?.message || 'unknown' });
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, pollMs(options.env || process.env));
  console.log('[ATTENDANCE_BILLING_INVOICE_WORKER_STARTED]', { pollMs: pollMs(options.env || process.env) });
  return timer;
}

if (process.argv[1] && process.argv[1].endsWith('attendanceBillingInvoiceWorker.js')) {
  startAttendanceBillingInvoiceWorker();
}
