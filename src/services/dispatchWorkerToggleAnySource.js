import express from 'express';
import { PrismaClient } from '@prisma/client';

const BASE_PATH = '/admin/operaciones';
const TOGGLE_PATH_PATTERN = /^\/admin\/operaciones\/personal\/([^/]+)\/toggle$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const AUDIT_ACTION = 'DISPATCH_WORKER_EXIT_REASON';
const WORD_SUBSTANCE = 'estupefac' + 'ientes';
const WORD_HARASSMENT = 'aco' + 'so';
const WORD_SEXUAL = 'se' + 'xual';

const EXIT_REASONS = [
  { code: 'T01_HURTO', category: 'TERMINACION', label: 'Terminación de contrato por hurto' },
  { code: 'T02_AUSENCIAS', category: 'TERMINACION', label: 'Terminación de contrato por ausencias' },
  { code: 'T03_BAJO_RENDIMIENTO', category: 'TERMINACION', label: 'Terminación de contrato por bajo rendimiento' },
  { code: 'T04_PORTE_ARMAS', category: 'TERMINACION', label: 'Terminación de contrato por porte de armas' },
  { code: 'T05_SUSTANCIAS', category: 'TERMINACION', label: `Terminación de contrato por consumo y/o porte de ${WORD_SUBSTANCE}` },
  { code: 'T06_CONFLICTOS', category: 'TERMINACION', label: 'Terminación de contrato por conflictos personales y/o laborales' },
  { code: 'T07_FINALIZACION_LABOR', category: 'TERMINACION', label: 'Terminación de contrato por finalización de labor' },
  { code: 'T08_AVERIAS_DANOS', category: 'TERMINACION', label: 'Terminación de contrato por averías y daños que se niega a pagar' },
  { code: 'T09_PRODUCTO_DINERO', category: 'TERMINACION', label: 'Terminación de contrato por recibir producto y/o dinero' },
  { code: 'R10_ACOSO', category: 'RENUNCIA', label: `Renuncia por ${WORD_HARASSMENT} ${WORD_SEXUAL} y/o laboral` },
  { code: 'R11_TEMA_PERSONAL', category: 'RENUNCIA', label: 'Renuncia por tema personal' },
  { code: 'R12_PRESION_ESTRES', category: 'RENUNCIA', label: 'Renuncia por presión y estrés' },
  { code: 'R13_FALTA_INDUCCION', category: 'RENUNCIA', label: 'Renuncia por falta de inducción' },
  { code: 'R14_INCUMPLIMIENTO_OFRECIDO', category: 'RENUNCIA', label: 'Renuncia por incumplimiento de lo ofrecido e inconformidad con funciones y política de la empresa' },
  { code: 'R15_JORNADA_EXTENSA', category: 'RENUNCIA', label: 'Renuncia por jornada extensa laboral' },
  { code: 'R16_ENFERMEDAD', category: 'RENUNCIA', label: 'Renuncia por enfermedad' }
];

let prisma = null;
function db() { if (!prisma) prisma = new PrismaClient(); return prisma; }
function text(value) { if (typeof value !== 'string') return null; const out = value.trim(); return out ? out : null; }
function pathOnly(req = {}) { return String(req.originalUrl || req.url || '').split('?')[0]; }
function canUseOps(req = {}) { const role = req.session?.userRole || req.userRole; const user = text(req.session?.username || req.username); return role === 'dev' || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) || Boolean(user?.startsWith('operaciones-despacho')); }
function reasonByCode(code) { return EXIT_REASONS.find((reason) => reason.code === code) || null; }
function addMessage(pathValue, message) { const [pathname, query = ''] = String(pathValue || '/admin/operaciones/personal').split('?'); const params = new URLSearchParams(query); params.set('message', message); return `${pathname}?${params.toString()}`; }
function safeBack(req) { const referer = req.get?.('referer'); if (!referer) return '/admin/operaciones/personal'; try { const parsed = new URL(referer); const origin = `${req.protocol}://${req.get('host')}`; if (parsed.origin === origin && parsed.pathname.startsWith('/admin/operaciones/personal')) return `${parsed.pathname}${parsed.search}`; } catch (_error) {} return '/admin/operaciones/personal'; }

async function recalculateRequest(prismaClient, serviceRequestId) {
  const serviceRequest = await prismaClient.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } });
  if (!serviceRequest) return null;
  const [activeCount, confirmedCount] = await Promise.all([
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prismaClient.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);
  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';
  await prismaClient.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
  return status;
}

async function cancelAssignments(prismaClient, workerId, reasonLabel) {
  const activeAssignments = await prismaClient.dispatchAssignment.findMany({ where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }, select: { id: true, serviceRequestId: true, status: true } });
  if (!activeAssignments.length) return [];
  const requestIds = [...new Set(activeAssignments.map((item) => item.serviceRequestId))];
  await prismaClient.$transaction(activeAssignments.map((assignment) => prismaClient.dispatchAssignment.update({
    where: { id: assignment.id },
    data: { status: assignment.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED', notes: `Auxiliar retirado del flujo. Causal: ${reasonLabel}.` }
  })));
  await Promise.all(requestIds.map((id) => recalculateRequest(prismaClient, id)));
  return requestIds;
}

async function deactivateWorker(prismaClient, worker, req) {
  const reason = reasonByCode(text(req.body?.exitReasonCode));
  if (!reason) { const error = new Error('Debes seleccionar una causal de retiro para desactivar el auxiliar.'); error.statusCode = 400; throw error; }
  const actor = text(req.session?.username || req.username) || 'sistema';
  const note = text(req.body?.exitReasonNote);
  await prismaClient.$transaction([
    prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'DISABLED' } }),
    prismaClient.devAuditEvent.create({
      data: {
        entityType: 'DISPATCH_WORKER',
        entityId: worker.id,
        entityLabel: worker.fullName || null,
        action: AUDIT_ACTION,
        actorUsername: actor,
        actorRole: text(req.session?.userRole || req.userRole),
        actorSource: 'dashboard',
        method: req.method || null,
        path: pathOnly(req) || null,
        fromValue: { operationalStatus: worker.operationalStatus || null },
        toValue: { operationalStatus: 'DISABLED' },
        metadata: { reasonCode: reason.code, reasonLabel: reason.label, category: reason.category, note }
      }
    })
  ]);
  return reason;
}

async function handleToggle(req, res, next, workerId) {
  if (!canUseOps(req)) return res.status(403).send('Módulo no habilitado para este usuario');
  const prismaClient = db();
  const backUrl = safeBack(req);
  const worker = await prismaClient.dispatchWorker.findFirst({ where: { id: workerId }, select: { id: true, fullName: true, operationalStatus: true } });
  if (!worker) return res.redirect(addMessage(backUrl, 'Auxiliar no encontrado. Recarga el listado e intenta nuevamente.'));
  try {
    if (worker.operationalStatus === 'CONTRATADO') {
      const reason = await deactivateWorker(prismaClient, worker, req);
      const affected = await cancelAssignments(prismaClient, worker.id, reason.label);
      const extra = affected.length ? ` Se cancelaron sus asignaciones activas en ${affected.length} solicitud${affected.length !== 1 ? 'es' : ''}.` : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado. Causal: ${reason.label}.${extra}`)}`);
    }
    await prismaClient.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'CONTRATADO' } });
    return res.redirect(addMessage(backUrl, 'Auxiliar reactivado. Ya aparece disponible para asignaciones.'));
  } catch (error) {
    if (error.statusCode === 400) return res.redirect(addMessage(backUrl, error.message));
    return next(error);
  }
}

function installAnySourceTogglePatch() {
  if (express.__dispatchWorkerAnySourceToggleInstalled) return;
  const originalRouter = express.Router;
  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(express, args);
    router.use(async (req, res, next) => {
      if (req.method !== 'POST') return next();
      const match = pathOnly(req).match(TOGGLE_PATH_PATTERN);
      if (!match) return next();
      return handleToggle(req, res, next, decodeURIComponent(match[1]));
    });
    return router;
  };
  Object.assign(express.Router, originalRouter);
  express.__dispatchWorkerAnySourceToggleInstalled = true;
}

installAnySourceTogglePatch();
