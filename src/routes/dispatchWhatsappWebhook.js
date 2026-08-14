import crypto from 'node:crypto';
import express from 'express';
import {
  dispatchWhatsappAppSecret,
  dispatchWhatsappVerifyTokens,
  normalizeDispatchWhatsappPhone,
  processDispatchWhatsappWebhook,
  resolveDispatchWhatsappScopeByPhoneNumberId
} from '../services/dispatchWhatsappCloudService.js';
import { addDispatchIsoDays, todayIsoDateCO } from '../services/dispatchDate.js';
import { confirmedOperationalAssignments, deriveDispatchRequestOperationalState } from '../services/dispatchOperationalCoverage.js';
import { buildProgrammingCompletionSummary, loadProgrammingRequests } from '../services/dispatchProgrammingPdfService.js';
import {
  sendDispatchWhatsappProgrammingDateMenu,
  sendDispatchWhatsappProgrammingFormatMenu,
  sendDispatchWhatsappReportMenu,
  sendDispatchWhatsappSummaryDateMenu,
  sendDispatchWhatsappTextMessage
} from '../services/dispatchWhatsappCloudClient.js';
import { recordDispatchWhatsappMessageAudit } from '../services/dispatchWhatsappMonitor.js';
import { loadProgrammingWhatsappRecipients, sendProgrammingContactDocuments } from './dispatchProgrammingNotifications.js';
import { logWhatsappWebhookDiagnostics } from '../services/whatsappWebhookDiagnostics.js';

const PENDING_PROGRAMMING_STATUSES = new Set(['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION']);
const DISPATCH_WHATSAPP_MESSAGE_ENTITY = 'DISPATCH_WHATSAPP_MESSAGE';
const PROGRAMMING_CONTACT_CLAIM_ENTITY = 'DISPATCH_PROGRAMMING_CONTACT_INBOUND';
const PROGRAMMING_CONTACT_CLAIM_ACTION = 'CLAIM_DISPATCH_PROGRAMMING_CONTACT_INBOUND';
const PROGRAMMING_REPORT_ACTIONS = new Map([
  ['dispatch_report:programming_today_pdf', { dateChoice: 'today', formats: ['pdf'] }],
  ['dispatch_report:programming_today_excel', { dateChoice: 'today', formats: ['excel'] }],
  ['dispatch_report:programming_today_both', { dateChoice: 'today', formats: ['pdf', 'excel'] }],
  ['dispatch_report:programming_tomorrow_pdf', { dateChoice: 'tomorrow', formats: ['pdf'] }],
  ['dispatch_report:programming_tomorrow_excel', { dateChoice: 'tomorrow', formats: ['excel'] }],
  ['dispatch_report:programming_tomorrow_both', { dateChoice: 'tomorrow', formats: ['pdf', 'excel'] }],
  ['dispatch_report:programming_pdf', { dateChoice: 'today', formats: ['pdf'] }],
  ['dispatch_report:programming_excel', { dateChoice: 'today', formats: ['excel'] }],
  ['dispatch_report:programming_both', { dateChoice: 'today', formats: ['pdf', 'excel'] }]
]);

function parsePayload(rawBody) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch (_error) { return null; }
}

function payloadPhoneNumberIds(payload = {}) {
  const ids = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const phoneNumberId = String(change?.value?.metadata?.phone_number_id || '').trim();
      if (phoneNumberId) ids.push(phoneNumberId);
    }
  }
  return [...new Set(ids)];
}

function webhookMessageValues(payload = {}) {
  const values = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field === 'messages' && Array.isArray(change?.value?.messages) && change.value.messages.length) values.push(change.value);
    }
  }
  return values;
}

function inboundAuditEntityId(messageId) {
  const id = String(messageId || '').trim();
  return id ? `dispatch-wa:inbound:${id}` : '';
}

export async function loadPreviouslyAuditedProgrammingMessageIds(prisma, payload) {
  if (!prisma?.devAuditEvent?.findMany) return new Set();
  const messageIds = [];
  for (const value of webhookMessageValues(payload)) {
    if (resolveDispatchWhatsappScopeByPhoneNumberId(value?.metadata?.phone_number_id) !== 'operational') continue;
    for (const message of value.messages) {
      const messageId = String(message?.id || '').trim();
      if (messageId) messageIds.push(messageId);
    }
  }
  const uniqueMessageIds = [...new Set(messageIds)];
  if (!uniqueMessageIds.length) return new Set();
  const rows = await prisma.devAuditEvent.findMany({
    where: {
      entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY,
      entityId: { in: uniqueMessageIds.map(inboundAuditEntityId) }
    },
    select: { entityId: true }
  });
  const prefix = 'dispatch-wa:inbound:';
  return new Set(rows
    .map((row) => String(row?.entityId || ''))
    .filter((entityId) => entityId.startsWith(prefix))
    .map((entityId) => entityId.slice(prefix.length))
    .filter(Boolean));
}

function programmingClaimId(messageId) {
  return `dispatch-programming-inbound:${messageId}`;
}

export async function claimProgrammingContactInbound(prisma, message, actionType = 'GENERIC_MENU') {
  const messageId = String(message?.id || '').trim();
  if (!messageId || !prisma?.devAuditEvent?.create) return { claimed: false, reason: 'missing_message_id' };
  try {
    await prisma.devAuditEvent.create({
      data: {
        id: programmingClaimId(messageId),
        entityType: PROGRAMMING_CONTACT_CLAIM_ENTITY,
        entityId: messageId,
        action: PROGRAMMING_CONTACT_CLAIM_ACTION,
        actorSource: 'dispatch-whatsapp-webhook',
        metadata: {
          messageType: String(message?.type || 'UNKNOWN').trim().toUpperCase(),
          actionType: String(actionType || 'GENERIC_MENU').trim().toUpperCase()
        }
      }
    });
    return { claimed: true, messageId };
  } catch (error) {
    if (error?.code === 'P2002') return { claimed: false, duplicate: true, messageId };
    throw error;
  }
}

function inboundPayload(message = {}) {
  return [message.button?.payload, message.interactive?.button_reply?.id, message.interactive?.list_reply?.id]
    .find((value) => typeof value === 'string' && value.trim()) || '';
}

function programmingContactAction(message = {}) {
  const payload = inboundPayload(message).trim();
  if (payload === 'dispatch_report:programming_today') return { type: 'PROGRAMMING_DATE' };
  if (payload === 'dispatch_report:programming_date_today') return { type: 'PROGRAMMING_FORMAT', dateChoice: 'today' };
  if (payload === 'dispatch_report:programming_date_tomorrow') return { type: 'PROGRAMMING_FORMAT', dateChoice: 'tomorrow' };
  if (payload === 'dispatch_report:summary') return { type: 'SUMMARY_DATE' };
  if (payload === 'dispatch_report:summary_date_today') return { type: 'SUMMARY', dateChoice: 'today' };
  if (payload === 'dispatch_report:summary_date_tomorrow') return { type: 'SUMMARY', dateChoice: 'tomorrow' };
  if (payload === 'dispatch_report:summary_today') return { type: 'SUMMARY', dateChoice: 'today' };
  const reportAction = PROGRAMMING_REPORT_ACTIONS.get(payload);
  if (reportAction) return { type: 'PROGRAMMING_DOCUMENTS', ...reportAction };
  return null;
}

function programmingDateForChoice(dateChoice) {
  const today = todayIsoDateCO();
  return dateChoice === 'tomorrow' ? addDispatchIsoDays(today, 1) : today;
}

function formatDateLabel(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return String(dateKey || 'hoy');
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

async function auditProgrammingReply(prisma, { phone, body, messageType, providerMessageId, source }) {
  await recordDispatchWhatsappMessageAudit({ prismaClient: prisma, scope: 'operational', direction: 'OUTBOUND', phone, body, messageType, providerMessageId, source, occurredAt: new Date() });
}

async function sendProgrammingSummary(prisma, contact, selectedDate = todayIsoDateCO()) {
  const loaded = await loadProgrammingRequests(prisma, selectedDate);
  const summary = buildProgrammingCompletionSummary(loaded.requests);
  const confirmedWorkers = loaded.requests.reduce((sum, request) => sum + confirmedOperationalAssignments(request).length, 0);
  const pendingRequests = loaded.requests.filter((request) => PENDING_PROGRAMMING_STATUSES.has(deriveDispatchRequestOperationalState(request).status)).length;
  const text = [
    `📊 *Resumen operativo — ${formatDateLabel(loaded.selectedDate)}*`,
    `Solicitudes: ${summary.totalRequests}`,
    `Completas: ${summary.completedRequests}`,
    `Pendientes: ${pendingRequests}`,
    `Auxiliares requeridos: ${summary.requiredWorkers}`,
    `Asignados: ${summary.assignedWorkers}`,
    `Confirmados: ${confirmedWorkers}`
  ].join('\n');
  const providerMessageId = await sendDispatchWhatsappTextMessage({ scope: 'operational', phone: contact.phone, text });
  await auditProgrammingReply(prisma, { phone: contact.phone, body: text, messageType: 'TEXT', providerMessageId, source: 'PROGRAMMING_CONTACT_SUMMARY' });
}

async function sendProgrammingMenu(prisma, contact) {
  const result = await sendDispatchWhatsappReportMenu({ scope: 'operational', phone: contact.phone, name: contact.name });
  await auditProgrammingReply(prisma, {
    phone: contact.phone,
    body: `Hola ${contact.name}. ¿Cómo te puedo ayudar hoy? [Programación] [Resumen del día]`,
    messageType: 'INTERACTIVE',
    providerMessageId: result.providerMessageId,
    source: 'PROGRAMMING_CONTACT_MENU'
  });
}

async function sendReportDateMenu(prisma, contact, reportType) {
  const isSummary = reportType === 'summary';
  const result = isSummary
    ? await sendDispatchWhatsappSummaryDateMenu({ scope: 'operational', phone: contact.phone })
    : await sendDispatchWhatsappProgrammingDateMenu({ scope: 'operational', phone: contact.phone });
  await auditProgrammingReply(prisma, {
    phone: contact.phone,
    body: '¿Qué día deseas consultar? [Hoy] [Mañana]',
    messageType: 'INTERACTIVE',
    providerMessageId: result.providerMessageId,
    source: isSummary ? 'PROGRAMMING_CONTACT_SUMMARY_DATE_MENU' : 'PROGRAMMING_CONTACT_DATE_MENU'
  });
}

async function sendProgrammingFormatMenu(prisma, contact, dateChoice) {
  const result = await sendDispatchWhatsappProgrammingFormatMenu({ scope: 'operational', phone: contact.phone, dateChoice });
  const dayLabel = dateChoice === 'tomorrow' ? 'mañana' : 'hoy';
  await auditProgrammingReply(prisma, {
    phone: contact.phone,
    body: `¿En qué formato deseas recibir la programación de ${dayLabel}? [PDF] [Excel] [Ambos]`,
    messageType: 'INTERACTIVE',
    providerMessageId: result.providerMessageId,
    source: 'PROGRAMMING_CONTACT_FORMAT_MENU'
  });
}

export async function processProgrammingContacts(prisma, payload, {
  allowGenericMenu = false,
  skipMessageIds = [],
  handlers = {}
} = {}) {
  const messageValues = webhookMessageValues(payload);
  if (!messageValues.length) return { handled: 0, skipped: 0 };
  const recipients = await loadProgrammingWhatsappRecipients(prisma);
  if (!recipients.length) return { handled: 0, skipped: 0 };
  const byPhone = new Map(recipients.map((recipient) => [recipient.phone, recipient]));
  const skippedIds = skipMessageIds instanceof Set ? skipMessageIds : new Set(skipMessageIds || []);
  const senders = {
    menu: handlers.sendProgrammingMenu || sendProgrammingMenu,
    reportDateMenu: handlers.sendReportDateMenu || sendReportDateMenu,
    formatMenu: handlers.sendProgrammingFormatMenu || sendProgrammingFormatMenu,
    documents: handlers.sendProgrammingContactDocuments || sendProgrammingContactDocuments,
    summary: handlers.sendProgrammingSummary || sendProgrammingSummary
  };
  let handled = 0;
  let skipped = 0;

  for (const value of messageValues) {
    if (resolveDispatchWhatsappScopeByPhoneNumberId(value?.metadata?.phone_number_id) !== 'operational') continue;
    for (const message of value.messages) {
      const contact = byPhone.get(normalizeDispatchWhatsappPhone(message.from));
      if (!contact) continue;
      const action = programmingContactAction(message);
      const genericMenu = !action && allowGenericMenu && message?.type === 'text';
      if (!action && !genericMenu) continue;
      const messageId = String(message?.id || '').trim();
      if (!messageId || skippedIds.has(messageId)) {
        skipped += 1;
        continue;
      }
      const claim = await claimProgrammingContactInbound(prisma, message, action?.type || 'GENERIC_MENU');
      if (!claim.claimed) {
        skipped += 1;
        continue;
      }

      if (action?.type === 'PROGRAMMING_DATE') await senders.reportDateMenu(prisma, contact, 'programming');
      else if (action?.type === 'PROGRAMMING_FORMAT') await senders.formatMenu(prisma, contact, action.dateChoice);
      else if (action?.type === 'PROGRAMMING_DOCUMENTS') {
        const selectedDate = programmingDateForChoice(action.dateChoice);
        await senders.documents(prisma, contact, action.formats, selectedDate);
      } else if (action?.type === 'SUMMARY_DATE') await senders.reportDateMenu(prisma, contact, 'summary');
      else if (action?.type === 'SUMMARY') {
        const selectedDate = programmingDateForChoice(action.dateChoice);
        await senders.summary(prisma, contact, selectedDate);
      } else if (genericMenu) await senders.menu(prisma, contact);
      handled += 1;
    }
  }
  return { handled, skipped };
}

export function verifyDispatchWhatsappSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !appSecret) return false;
  const received = String(signatureHeader || '').trim();
  if (!/^sha256=[a-f0-9]{64}$/i.test(received)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function resolveWebhookScopes(payload) {
  return [...new Set(payloadPhoneNumberIds(payload).map((phoneNumberId) => resolveDispatchWhatsappScopeByPhoneNumberId(phoneNumberId)).filter(Boolean))];
}

export function dispatchWhatsappWebhookRouter(prisma) {
  const router = express.Router();
  router.get('/', (req, res) => {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    const acceptedTokens = new Set(dispatchWhatsappVerifyTokens());
    if (mode === 'subscribe' && token && acceptedTokens.has(token)) return res.status(200).send(challenge);
    return res.sendStatus(403);
  });

  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const payload = parsePayload(rawBody);
      if (!payload) return res.sendStatus(400);
      const scopes = resolveWebhookScopes(payload);
      if (!scopes.length) return res.sendStatus(200);
      const signature = req.get('x-hub-signature-256');
      const signatureValid = scopes.some((scope) => verifyDispatchWhatsappSignature(rawBody, signature, dispatchWhatsappAppSecret(scope)));
      if (!signatureValid) {
        console.warn(`[dispatch-wa-cloud] Firma de webhook inválida. scopes=${scopes.join(',')}.`);
        return res.sendStatus(401);
      }
      logWhatsappWebhookDiagnostics(payload, '/webhook/dispatch');
      const previouslyAuditedMessageIds = await loadPreviouslyAuditedProgrammingMessageIds(prisma, payload);
      const dispatchResult = await processDispatchWhatsappWebhook(payload, { prismaClient: prisma });
      await processProgrammingContacts(prisma, payload, {
        allowGenericMenu: Number(dispatchResult?.messagesProcessed || 0) === 0,
        skipMessageIds: previouslyAuditedMessageIds
      });
      return res.sendStatus(200);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
