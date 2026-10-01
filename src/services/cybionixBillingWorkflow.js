import { loadAttendanceBillingInvoices } from '../modules/dispatch-attendance/application/attendanceBillingCounter.js';
import { loadCybionixBillingConfig } from './cybionixBillingConfig.js';
import { buildAccountChargePdfBuffer, buildAttendanceInvoicePdfBuffer } from './cybionixBillingPdf.js';
import {
  getCybionixWhatsappConfig,
  sendCybionixAccountCharge,
  sendCybionixAttendanceApproval,
  sendCybionixDevAlert
} from './cybionixWhatsappClient.js';

export const CYBIONIX_APPROVAL_ENTITY_TYPE = 'CYBIONIX_ATTENDANCE_INVOICE_APPROVAL';
export const CYBIONIX_APPROVAL_ACTION = 'CYBIONIX_ATTENDANCE_APPROVAL_STATE';
export const CYBIONIX_ACCOUNT_ENTITY_TYPE = 'CYBIONIX_ACCOUNT_CHARGE';
export const CYBIONIX_ACCOUNT_ACTION = 'CYBIONIX_ACCOUNT_CHARGE_CREATED';
export const CYBIONIX_DELIVERY_ENTITY_TYPE = 'CYBIONIX_BILLING_DELIVERY';
export const CYBIONIX_DELIVERY_ACTION = 'CYBIONIX_BILLING_DELIVERY_SENT';

function text(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function eventMetadata(event) {
  return event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata : {};
}

function billingSnapshot(config = {}) {
  return {
    modules: Array.isArray(config.modules) ? config.modules.map((item) => ({ ...item })) : [],
    recipients: Array.isArray(config.recipients) ? config.recipients.map((item) => ({ ...item })) : [],
    supervisor: config.supervisor ? { ...config.supervisor } : null,
    devAlertPhone: text(config.devAlertPhone, 32),
    accountHeading: text(config.accountHeading, 160)
  };
}

async function invoiceByNumber(prisma, invoiceNumber) {
  const target = text(invoiceNumber, 80);
  if (!target) return null;
  const invoices = await loadAttendanceBillingInvoices(prisma, { take: 24 });
  return invoices.find((invoice) => invoice.invoiceNumber === target) || null;
}

export async function loadCybionixApprovalState(prisma, invoiceNumber) {
  const event = await prisma.devAuditEvent.findFirst({
    where: { entityType: CYBIONIX_APPROVAL_ENTITY_TYPE, entityId: invoiceNumber, action: CYBIONIX_APPROVAL_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  const metadata = eventMetadata(event);
  return {
    status: text(metadata.status, 32) || 'UNSENT',
    invoiceNumber,
    supervisorName: text(metadata.supervisorName, 160),
    supervisorPhone: text(metadata.supervisorPhone, 32),
    reason: text(metadata.reason, 500),
    providerMessageId: text(metadata.providerMessageId, 240),
    billingSnapshot: metadata.billingSnapshot && typeof metadata.billingSnapshot === 'object'
      ? metadata.billingSnapshot
      : null,
    updatedAt: event?.createdAt || null
  };
}

async function recordPendingApproval(prisma, invoice, input = {}) {
  return prisma.devAuditEvent.create({
    data: {
      entityType: CYBIONIX_APPROVAL_ENTITY_TYPE,
      entityId: invoice.invoiceNumber,
      entityLabel: `Aprobación ${invoice.invoiceNumber}`,
      action: CYBIONIX_APPROVAL_ACTION,
      actorSource: 'cybionix-billing-worker',
      metadata: {
        status: 'PENDING',
        invoiceNumber: invoice.invoiceNumber,
        cycleStart: invoice.cycleStart,
        supervisorName: text(input.supervisorName, 160),
        supervisorPhone: text(input.supervisorPhone, 32),
        providerMessageId: text(input.providerMessageId, 240)
      }
    }
  });
}

async function claimTerminalDecision(prisma, invoice, status, config, input = {}) {
  const id = `cybionix-billing-decision:${invoice.invoiceNumber}`;
  try {
    const event = await prisma.devAuditEvent.create({
      data: {
        id,
        entityType: CYBIONIX_APPROVAL_ENTITY_TYPE,
        entityId: invoice.invoiceNumber,
        entityLabel: `Aprobación ${invoice.invoiceNumber}`,
        action: CYBIONIX_APPROVAL_ACTION,
        actorSource: 'cybionix-whatsapp-webhook',
        metadata: {
          status,
          invoiceNumber: invoice.invoiceNumber,
          cycleStart: invoice.cycleStart,
          supervisorName: text(input.supervisorName, 160),
          supervisorPhone: text(input.supervisorPhone, 32),
          reason: text(input.reason, 500),
          billingSnapshot: billingSnapshot(config)
        }
      }
    });
    return { claimed: true, state: { ...eventMetadata(event), updatedAt: event.createdAt || null } };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    return { claimed: false, state: await loadCybionixApprovalState(prisma, invoice.invoiceNumber) };
  }
}

function accountFromEvent(event) {
  const metadata = eventMetadata(event);
  if (!metadata.accountNumber) return null;
  return { id: event.id, createdAt: event.createdAt || null, ...metadata };
}

export async function loadCybionixAccountForInvoice(prisma, invoiceNumber) {
  const event = await prisma.devAuditEvent.findFirst({
    where: { entityType: CYBIONIX_ACCOUNT_ENTITY_TYPE, entityId: invoiceNumber, action: CYBIONIX_ACCOUNT_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  return event ? accountFromEvent(event) : null;
}

export async function ensureCybionixAccountCharge(prisma, invoice, config, input = {}) {
  const existing = await loadCybionixAccountForInvoice(prisma, invoice.invoiceNumber);
  if (existing) return { created: false, account: existing, reason: 'already_created' };
  const fixedItems = (config.modules || [])
    .filter((item) => item?.active !== false && Number(item?.value) >= 0)
    .map((item) => ({ name: text(item.name, 160) || 'Módulo', value: Math.max(0, Number(item.value) || 0), source: 'FIXED' }));
  const items = [
    ...fixedItems,
    { name: 'Módulo de Asistencia y Gestión de Tiempo', value: Math.max(0, Number(invoice.total) || 0), source: 'ATTENDANCE', invoiceNumber: invoice.invoiceNumber }
  ];
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const generatedAt = new Date().toISOString();
  const account = {
    accountNumber: `COBRO-${String(invoice.cycleStart || '').slice(0, 7).replace('-', '')}`,
    generatedAt,
    attendanceInvoiceNumber: invoice.invoiceNumber,
    cycleStart: invoice.cycleStart,
    cycleEnd: invoice.cycleEnd,
    items,
    total,
    currency: 'COP',
    recipients: (config.recipients || []).filter((item) => item?.active !== false).map((item) => ({ ...item })),
    accountHeading: config.accountHeading || config.recipients?.[0]?.name || null,
    approvedBy: {
      name: text(input.supervisorName, 160) || config.supervisor?.name || null,
      phone: text(input.supervisorPhone, 32) || config.supervisor?.phone || null,
      approvedAt: generatedAt
    }
  };
  try {
    const event = await prisma.devAuditEvent.create({
      data: {
        id: `cybionix-billing-account:${invoice.invoiceNumber}`,
        entityType: CYBIONIX_ACCOUNT_ENTITY_TYPE,
        entityId: invoice.invoiceNumber,
        entityLabel: `Cuenta de cobro ${account.accountNumber}`,
        action: CYBIONIX_ACCOUNT_ACTION,
        actorSource: 'cybionix-billing-approval',
        metadata: account
      }
    });
    return { created: true, account: accountFromEvent(event), reason: 'created' };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    return { created: false, account: await loadCybionixAccountForInvoice(prisma, invoice.invoiceNumber), reason: 'already_created' };
  }
}

async function deliveryAlreadySent(prisma, key) {
  const event = await prisma.devAuditEvent.findFirst({
    where: { entityType: CYBIONIX_DELIVERY_ENTITY_TYPE, entityId: key, action: CYBIONIX_DELIVERY_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  return Boolean(event);
}

async function recordDelivery(prisma, key, metadata) {
  try {
    await prisma.devAuditEvent.create({
      data: {
        id: `cybionix-billing-delivery:${key}`,
        entityType: CYBIONIX_DELIVERY_ENTITY_TYPE,
        entityId: key,
        entityLabel: key,
        action: CYBIONIX_DELIVERY_ACTION,
        actorSource: 'cybionix-billing-whatsapp',
        metadata
      }
    });
    return true;
  } catch (error) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}

export async function deliverCybionixAttendanceApproval(prisma, invoice, options = {}) {
  const config = options.config || await loadCybionixBillingConfig(prisma);
  const channel = getCybionixWhatsappConfig(options.env || process.env);
  if (!config.enabled) return { sent: false, skipped: true, reason: 'billing_disabled' };
  if (!config.supervisor?.phone) return { sent: false, skipped: true, reason: 'supervisor_missing' };
  if (!channel.accessToken || !channel.phoneNumberId || !channel.verifyToken || !channel.appSecret || !channel.approvalTemplateName) {
    return { sent: false, skipped: true, reason: 'cybionix_channel_unconfigured' };
  }
  const state = await loadCybionixApprovalState(prisma, invoice.invoiceNumber);
  if (['PENDING', 'APPROVED', 'REJECTED'].includes(state.status)) return { sent: false, skipped: true, reason: `already_${state.status.toLowerCase()}` };
  const pdfBuffer = await buildAttendanceInvoicePdfBuffer(invoice);
  const providerMessageId = await (options.sendApproval || sendCybionixAttendanceApproval)({
    phone: config.supervisor.phone,
    supervisorName: config.supervisor.name,
    invoice,
    pdfBuffer,
    env: options.env || process.env
  });
  await recordPendingApproval(prisma, invoice, {
    supervisorName: config.supervisor.name,
    supervisorPhone: config.supervisor.phone,
    providerMessageId
  });
  return { sent: true, skipped: false, providerMessageId };
}

export async function deliverCybionixAccountCharge(prisma, account, options = {}) {
  if (!account) return { attempted: 0, sent: 0, skipped: 0, failed: 0, results: [] };
  const channel = getCybionixWhatsappConfig(options.env || process.env);
  if (!channel.accessToken || !channel.phoneNumberId || !channel.accountTemplateName) {
    return { attempted: 0, sent: 0, skipped: 1, failed: 0, results: [{ skipped: true, reason: 'cybionix_channel_unconfigured' }] };
  }
  const pdfBuffer = await buildAccountChargePdfBuffer(account);
  const results = [];
  for (const recipient of account.recipients || []) {
    const key = `${account.accountNumber}:${recipient.phone}`;
    if (await deliveryAlreadySent(prisma, key)) {
      results.push({ phone: recipient.phone, sent: false, skipped: true, reason: 'already_sent' });
      continue;
    }
    try {
      const providerMessageId = await (options.sendAccount || sendCybionixAccountCharge)({
        phone: recipient.phone,
        recipientName: recipient.name,
        account,
        pdfBuffer,
        env: options.env || process.env
      });
      await recordDelivery(prisma, key, {
        type: 'ACCOUNT_CHARGE', accountNumber: account.accountNumber, invoiceNumber: account.attendanceInvoiceNumber,
        recipientName: recipient.name, phone: recipient.phone, providerMessageId
      });
      results.push({ phone: recipient.phone, sent: true, skipped: false, providerMessageId });
    } catch (error) {
      results.push({ phone: recipient.phone, sent: false, skipped: false, reason: String(error?.message || error).slice(0, 240) });
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

export async function resolveCybionixAttendanceApproval(prisma, input = {}, options = {}) {
  const invoice = await invoiceByNumber(prisma, input.invoiceNumber);
  if (!invoice) return { ok: false, reason: 'invoice_not_found' };
  const config = await loadCybionixBillingConfig(prisma);
  const current = await loadCybionixApprovalState(prisma, invoice.invoiceNumber);
  if (['APPROVED', 'REJECTED'].includes(current.status)) {
    return { ok: true, idempotent: true, status: current.status, invoice, account: await loadCybionixAccountForInvoice(prisma, invoice.invoiceNumber) };
  }
  const supervisorPhone = text(input.supervisorPhone, 32) || config.supervisor?.phone || null;
  if (config.supervisor?.phone && supervisorPhone !== config.supervisor.phone) {
    return { ok: false, reason: 'supervisor_phone_mismatch' };
  }
  const decision = String(input.decision || '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) return { ok: false, reason: 'decision_invalid' };
  const terminalStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const claimed = await claimTerminalDecision(prisma, invoice, terminalStatus, config, {
    supervisorName: config.supervisor?.name,
    supervisorPhone,
    reason: decision === 'REJECT' ? (text(input.reason, 500) || 'No aprobada por el supervisor') : null
  });
  if (!claimed.claimed) {
    return {
      ok: true,
      idempotent: true,
      status: claimed.state.status,
      invoice,
      account: await loadCybionixAccountForInvoice(prisma, invoice.invoiceNumber)
    };
  }

  if (decision === 'APPROVE') {
    const snapshot = claimed.state.billingSnapshot || billingSnapshot(config);
    const accountResult = await ensureCybionixAccountCharge(prisma, invoice, snapshot, {
      supervisorName: config.supervisor?.name,
      supervisorPhone
    });
    const delivery = accountResult.created
      ? await deliverCybionixAccountCharge(prisma, accountResult.account, options)
      : { attempted: 0, sent: 0, skipped: 1, failed: 0, results: [{ skipped: true, reason: 'account_already_created' }] };
    return { ok: true, idempotent: false, status: 'APPROVED', invoice, account: accountResult.account, delivery };
  }

  let alert = { skipped: true, reason: 'dev_alert_phone_missing' };
  if (config.devAlertPhone) {
    try {
      alert = await (options.sendAlert || sendCybionixDevAlert)({
        phone: config.devAlertPhone,
        invoiceNumber: invoice.invoiceNumber,
        reason: 'No aprobada por el supervisor',
        env: options.env || process.env
      });
    } catch (error) {
      alert = { skipped: false, failed: true, reason: String(error?.message || error).slice(0, 240) };
    }
  }
  return { ok: true, idempotent: false, status: 'REJECTED', invoice, account: null, alert };
}

export async function loadCybionixBillingDashboard(prisma) {
  const config = await loadCybionixBillingConfig(prisma);
  const invoices = await loadAttendanceBillingInvoices(prisma, { take: 12 });
  const rows = [];
  for (const invoice of invoices) {
    rows.push({
      invoice,
      approval: await loadCybionixApprovalState(prisma, invoice.invoiceNumber),
      account: await loadCybionixAccountForInvoice(prisma, invoice.invoiceNumber)
    });
  }
  return { config, rows };
}
