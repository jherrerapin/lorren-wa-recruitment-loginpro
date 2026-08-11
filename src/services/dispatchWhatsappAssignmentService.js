import axios from 'axios';
import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  ACTIVE_LINK_STATUSES,
  INBOUND_LINK_STATUSES,
  buildDispatchWhatsappError,
  dispatchWhatsappScopeDefinition,
  ensureDispatchWhatsappConfigured,
  normalizeDispatchWhatsappPhone,
  setDispatchWhatsappRuntimeState
} from './dispatchWhatsappCloudConfig.js';
import { dispatchWhatsappProviderErrorMessage, sendCloudAssignmentTemplate } from './dispatchWhatsappCloudClient.js';

function confirmationExpiresAt(serviceDate) {
  const minimum = Date.now() + (36 * 60 * 60 * 1000);
  const key = dispatchServiceDateKey(serviceDate);
  if (!key) return new Date(minimum);
  const serviceExpiry = new Date(`${key}T23:59:59.999-05:00`).getTime() + (12 * 60 * 60 * 1000);
  return new Date(Math.max(minimum, serviceExpiry));
}

export async function validateDispatchAssignmentContext({
  context = {}, phone = '', scope = 'operational', prismaClient = prisma
} = {}) {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const assignmentId = String(context?.assignmentId || '').trim();
  const serviceRequestId = String(context?.serviceRequestId || '').trim();
  const workerId = String(context?.workerId || '').trim();
  if (!assignmentId || !serviceRequestId || !workerId) {
    throw buildDispatchWhatsappError('No se puede enviar WhatsApp porque falta el contexto completo de la asignación.', 400, 'dispatch_whatsapp_context_incomplete');
  }

  const assignment = await prismaClient.dispatchAssignment.findFirst({
    where: { id: assignmentId, serviceRequestId, workerId, status: { in: definition.pendingAssignmentStatuses } },
    include: { worker: true, serviceRequest: { include: { operationPoint: true } } }
  });
  if (!assignment) {
    throw buildDispatchWhatsappError('La asignación ya no está pendiente o no corresponde al auxiliar indicado.', 409, 'dispatch_whatsapp_assignment_not_sendable');
  }
  if (definition.requestSource && assignment.serviceRequest?.source !== definition.requestSource) {
    throw buildDispatchWhatsappError('La asignación no pertenece al entorno de pruebas de despacho.', 409, 'dispatch_whatsapp_scope_mismatch');
  }
  if (scope === 'operational' && assignment.serviceRequest?.source === 'DEV_TEST') {
    throw buildDispatchWhatsappError('Una asignación DEV no puede enviarse desde la línea operativa.', 409, 'dispatch_whatsapp_scope_mismatch');
  }

  const recipientPhone = normalizeDispatchWhatsappPhone(phone);
  const assignmentPhone = normalizeDispatchWhatsappPhone(assignment.worker?.phone);
  if (!recipientPhone || !assignmentPhone || recipientPhone !== assignmentPhone) {
    throw buildDispatchWhatsappError('El número indicado no corresponde al auxiliar de esta asignación.', 409, 'dispatch_whatsapp_recipient_mismatch');
  }

  const serviceDate = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
  if (!serviceDate || serviceDate < todayIsoDateCO()) {
    throw buildDispatchWhatsappError('No se puede solicitar confirmación para una asignación de una fecha anterior.', 409, 'dispatch_whatsapp_service_date_past');
  }
  return { assignment, phone: recipientPhone, context: { ...context, assignmentId, serviceRequestId, workerId } };
}

async function ensureNoRecentConfirmationSend(prismaClient, assignmentId, duplicateSendWindowMs) {
  if (!duplicateSendWindowMs) return;
  const recent = await prismaClient.dispatchWhatsappConfirmation.findFirst({
    where: {
      assignmentId,
      status: { in: ACTIVE_LINK_STATUSES },
      createdAt: { gte: new Date(Date.now() - duplicateSendWindowMs) }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!recent) return;
  const age = Date.now() - new Date(recent.createdAt).getTime();
  const remaining = Math.max(1, Math.ceil((duplicateSendWindowMs - age) / 1000));
  throw buildDispatchWhatsappError(
    `Ya se envió una solicitud de confirmación recientemente. Espera ${remaining} segundos antes de repetirla.`,
    429,
    'dispatch_whatsapp_duplicate_send'
  );
}

export async function sendDispatchWhatsappMessage({
  phone, context, scope = 'operational', axiosClient = axios, prismaClient = prisma
} = {}) {
  const config = ensureDispatchWhatsappConfigured(scope);
  const validated = await validateDispatchAssignmentContext({ context, phone, scope, prismaClient });
  await ensureNoRecentConfirmationSend(prismaClient, validated.assignment.id, config.duplicateSendWindowMs);
  await prismaClient.dispatchWhatsappConfirmation.updateMany({
    where: { assignmentId: validated.assignment.id, status: { in: ACTIVE_LINK_STATUSES } },
    data: { status: 'EXPIRED' }
  });

  const link = await prismaClient.dispatchWhatsappConfirmation.create({
    data: {
      assignmentId: validated.assignment.id,
      serviceRequestId: validated.assignment.serviceRequestId,
      phone: validated.phone,
      chatId: null,
      providerMessageId: null,
      status: 'PENDING',
      expiresAt: confirmationExpiresAt(validated.assignment.serviceRequest?.serviceDate)
    }
  });

  try {
    const { providerMessageId } = await sendCloudAssignmentTemplate({
      scope, assignment: validated.assignment, phone: validated.phone, axiosClient
    });
    const transaction = [prismaClient.dispatchWhatsappConfirmation.update({
      where: { id: link.id }, data: { providerMessageId, status: 'SENT' }
    })];
    if (scope === 'operational') {
      transaction.push(prismaClient.dispatchAssignment.updateMany({
        where: { id: validated.assignment.id, status: 'ASSIGNED' }, data: { status: 'CONFIRMATION_PENDING' }
      }));
    }
    await prismaClient.$transaction(transaction);
    const now = new Date().toISOString();
    setDispatchWhatsappRuntimeState(scope, { lastOutboundAt: now, lastError: null, lastProviderStatus: 'SENT', lastProviderStatusAt: now });
    console.info(`[dispatch-wa-cloud] Plantilla enviada. scope=${scope} assignment=${validated.assignment.id} providerMessage=yes.`);
    return { phone: validated.phone, providerMessageId, templateName: config.assignmentTemplateName, provider: 'META_CLOUD_API' };
  } catch (error) {
    await prismaClient.dispatchWhatsappConfirmation.updateMany({
      where: { id: link.id, status: 'PENDING' }, data: { status: 'FAILED' }
    }).catch(() => {});
    const message = error?.code?.startsWith?.('dispatch_') ? error.message : dispatchWhatsappProviderErrorMessage(error);
    setDispatchWhatsappRuntimeState(scope, { lastError: message });
    if (error?.statusCode) throw error;
    throw buildDispatchWhatsappError(message, 502, 'dispatch_whatsapp_provider_error');
  }
}

export async function claimDispatchAssignmentConfirmation({
  scope = 'operational', assignment, confirmationMessageId = '', confirmationReceivedAt = null, prismaClient = prisma
} = {}) {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const evidenceMessageId = String(confirmationMessageId || '').trim();
  const evidenceReceivedAt = confirmationReceivedAt instanceof Date
    ? confirmationReceivedAt
    : new Date(confirmationReceivedAt || Number.NaN);
  if (!assignment?.id || !evidenceMessageId || Number.isNaN(evidenceReceivedAt.getTime())) {
    return { assignmentConfirmed: false, shouldReply: false, duplicate: false };
  }

  return prismaClient.$transaction(async (tx) => {
    const duplicate = await tx.dispatchWhatsappConfirmation.findFirst({
      where: { confirmationMessageId: evidenceMessageId }, select: { id: true }
    });
    if (duplicate) return { assignmentConfirmed: false, shouldReply: false, duplicate: true };

    const updated = await tx.dispatchAssignment.updateMany({
      where: { id: assignment.id, status: { in: definition.pendingAssignmentStatuses } },
      data: { status: definition.confirmedAssignmentStatus }
    });
    const current = updated.count
      ? { status: definition.confirmedAssignmentStatus }
      : await tx.dispatchAssignment.findUnique({ where: { id: assignment.id }, select: { status: true } });
    if (current?.status !== definition.confirmedAssignmentStatus) {
      return { assignmentConfirmed: false, shouldReply: false, duplicate: false };
    }

    const evidence = await tx.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: INBOUND_LINK_STATUSES } },
      data: {
        status: 'CONFIRMED_REPLY_PENDING',
        confirmationMessageId: evidenceMessageId,
        confirmationReceivedAt: evidenceReceivedAt
      }
    });
    return {
      assignmentConfirmed: Boolean(updated.count),
      shouldReply: evidence.count > 0,
      duplicate: false
    };
  });
}
