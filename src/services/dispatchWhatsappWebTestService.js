import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  closeDispatchWhatsappSession as closeTestRuntimeSession,
  getDispatchWhatsappStatus as getTestRuntimeStatus,
  getDispatchWhatsappStatusView as getTestRuntimeStatusView,
  initDispatchWhatsappClient as initTestRuntimeClient,
  sendDispatchWhatsappMessage as sendTestRuntimeTextMessage
} from './dispatchWhatsappWebServiceV6.js?scope=dev-test';

const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
const DEV_TEST_ASSIGNMENT_STATUS = 'DEV_TEST_ASSIGNED';
const DEV_TEST_CONFIRMED_STATUS = 'DEV_TEST_CONFIRMED';
const RESTARTABLE_TEST_STATUSES = [DEV_TEST_ASSIGNMENT_STATUS, DEV_TEST_CONFIRMED_STATUS];

function buildOperationalError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

function hourLabel(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '');
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function labelHours(value) {
  return String(value || '').replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g, (_text, hour, minute) => hourLabel(`${hour}:${minute}`));
}

async function validateTestAssignmentContext(context = {}, phone = '') {
  const assignmentId = String(context?.assignmentId || '').trim();
  const serviceRequestId = String(context?.serviceRequestId || '').trim();
  const workerId = String(context?.workerId || '').trim();
  if (!assignmentId || !serviceRequestId || !workerId) {
    throw buildOperationalError('No se puede ejecutar la prueba porque falta el contexto completo de la asignación.', 400);
  }

  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: assignmentId,
      serviceRequestId,
      workerId,
      status: { in: RESTARTABLE_TEST_STATUSES }
    },
    select: {
      id: true,
      status: true,
      workerId: true,
      worker: { select: { phone: true, isTestProfile: true } },
      serviceRequest: { select: { id: true, source: true, serviceDate: true } }
    }
  });

  if (!assignment
    || assignment.serviceRequest?.source !== DEV_TEST_REQUEST_SOURCE
    || assignment.worker?.isTestProfile !== true) {
    throw buildOperationalError('La asignación no pertenece al entorno aislado de pruebas DEV.', 409);
  }

  const recipientPhone = normalizePhone(phone);
  const assignmentPhone = normalizePhone(assignment.worker?.phone);
  if (!recipientPhone || !assignmentPhone || recipientPhone !== assignmentPhone) {
    throw buildOperationalError('El número indicado no corresponde al sujeto de prueba de esta asignación.', 409);
  }

  const serviceDate = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
  const today = todayIsoDateCO();
  if (!serviceDate || serviceDate < today) {
    throw buildOperationalError('Para probar confirmaciones por WhatsApp usa una solicitud de hoy o de una fecha futura.', 409);
  }

  return {
    assignment,
    context: { ...context, assignmentId, serviceRequestId, workerId }
  };
}

async function prepareAssignmentForNewTest(assignment) {
  await prisma.$transaction([
    prisma.dispatchWhatsappConfirmation.updateMany({
      where: {
        assignmentId: assignment.id,
        status: { in: ['PENDING', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'] }
      },
      data: { status: 'EXPIRED' }
    }),
    prisma.dispatchAssignment.update({
      where: { id: assignment.id },
      data: { status: DEV_TEST_ASSIGNMENT_STATUS }
    })
  ]);
}

export function initDispatchTestWhatsappClient() {
  return initTestRuntimeClient();
}

export function getDispatchTestWhatsappStatus() {
  return getTestRuntimeStatus();
}

export async function getDispatchTestWhatsappStatusView(options = {}) {
  return getTestRuntimeStatusView(options);
}

export async function closeDispatchTestWhatsappSession() {
  return closeTestRuntimeSession();
}

export async function sendDispatchTestWhatsappMessage(args = {}) {
  const validated = await validateTestAssignmentContext(args.context, args.phone);
  await prepareAssignmentForNewTest(validated.assignment);
  return sendTestRuntimeTextMessage({
    ...args,
    context: validated.context,
    message: labelHours(args.message)
  });
}
