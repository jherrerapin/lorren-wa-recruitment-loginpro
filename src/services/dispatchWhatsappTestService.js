import { prisma } from '../lib/prisma.js';
import {
  getDispatchWhatsappStatus,
  getDispatchWhatsappStatusView,
  normalizeDispatchWhatsappPhone,
  sendDispatchWhatsappMessage
} from './dispatchWhatsappCloudService.js';

const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
const DEV_TEST_ASSIGNMENT_STATUS = 'DEV_TEST_ASSIGNED';
const DEV_TEST_CONFIRMED_STATUS = 'DEV_TEST_CONFIRMED';
const RESTARTABLE_TEST_STATUSES = [DEV_TEST_ASSIGNMENT_STATUS, DEV_TEST_CONFIRMED_STATUS];
const ACTIVE_LINK_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'CONFIRMED_REPLY_PENDING'];

function buildOperationalError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
    include: {
      worker: true,
      serviceRequest: true
    }
  });

  if (!assignment || assignment.serviceRequest?.source !== DEV_TEST_REQUEST_SOURCE) {
    throw buildOperationalError('La asignación no pertenece al entorno aislado de pruebas DEV.', 409);
  }

  const recipientPhone = normalizeDispatchWhatsappPhone(phone);
  const assignmentPhone = normalizeDispatchWhatsappPhone(assignment.worker?.phone);
  if (!recipientPhone || !assignmentPhone || recipientPhone !== assignmentPhone) {
    throw buildOperationalError('El número indicado no corresponde al sujeto de prueba de esta asignación.', 409);
  }

  return {
    assignment,
    context: { ...context, assignmentId, serviceRequestId, workerId }
  };
}

async function prepareAssignmentForNewTest(assignment) {
  await prisma.$transaction([
    prisma.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: ACTIVE_LINK_STATUSES } },
      data: { status: 'EXPIRED' }
    }),
    prisma.dispatchAssignment.update({
      where: { id: assignment.id },
      data: { status: DEV_TEST_ASSIGNMENT_STATUS }
    })
  ]);
}

export function getDispatchTestWhatsappStatus() {
  return getDispatchWhatsappStatus('dev-test');
}

export async function getDispatchTestWhatsappStatusView() {
  return getDispatchWhatsappStatusView({ scope: 'dev-test' });
}

export async function sendDispatchTestWhatsappMessage(args = {}) {
  const validated = await validateTestAssignmentContext(args.context, args.phone);
  await prepareAssignmentForNewTest(validated.assignment);
  return sendDispatchWhatsappMessage({
    phone: args.phone,
    context: validated.context,
    scope: 'dev-test'
  });
}
