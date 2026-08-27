import express from 'express';
import { MessageDirection } from '@prisma/client';
import {
  deliverManualOutboundText,
  getManualOutboundUserMessage,
  MANUAL_OUTBOUND_TRANSPORT,
  resolveManualOutboundTransport
} from '../services/manualOutboundDeliveryService.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { canAccessCandidate, getAccessContext } from '../services/appUsers.js';

const INTERVIEW_OUTREACH_SOURCE = 'admin_interview_template';
const APPROVED_FREE_TEXT_SOURCE = 'admin_outreach_approved_free_text';
const MAX_STATUS_CANDIDATES = 100;
const MAX_FREE_TEXT_LENGTH = 4000;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function requestAccessContext(req = {}) {
  return getAccessContext({
    userRole: req.userRole || req.session?.userRole || null,
    userId: req.userId || req.session?.userId || null,
    username: req.username || req.session?.username || null,
    userAccessScope: req.userAccessScope || req.session?.userAccessScope || 'ALL',
    userAccessCity: req.userAccessCity || req.session?.userAccessCity || null,
    userAccessVacancyId: req.userAccessVacancyId || req.session?.userAccessVacancyId || null
  });
}

function requirePanelSession(req, res, next) {
  if (!(req.userRole || req.session?.userRole)) {
    return res.status(401).json({ ok: false, error: 'authentication_required' });
  }
  return next();
}

function normalizeCandidateIds(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  return [...new Set(rawValues
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean))]
    .slice(0, MAX_STATUS_CANDIDATES);
}

async function loadLatestInboundAt(prisma, candidateId) {
  const rows = await prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { createdAt: true }
  });
  return rows[0]?.createdAt || null;
}

export function approvedOutreachWindowState(lastInboundAt, now = new Date()) {
  const delivery = resolveManualOutboundTransport({
    source: INTERVIEW_OUTREACH_SOURCE,
    lastInboundAt,
    now
  });
  return {
    windowOpen: delivery.whatsappWindowOpen === true,
    transport: delivery.transport,
    expiresAt: delivery.whatsappWindowExpiresAt
  };
}

function statusResponse(candidate, lastInboundAt, now) {
  return {
    candidateId: candidate.id,
    ...approvedOutreachWindowState(lastInboundAt, now)
  };
}

function userMessage(error, fallback) {
  return getManualOutboundUserMessage(error, fallback);
}

export function approvedOutreachActionsRouter(prisma, options = {}) {
  const router = express.Router();
  const sendText = options.sendText || sendTextMessage;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  router.use(requirePanelSession);

  router.get('/window-status', async (req, res) => {
    const candidateIds = normalizeCandidateIds(req.query.candidateIds);
    if (!candidateIds.length) return res.json({ ok: true, candidates: [] });

    const accessContext = requestAccessContext(req);
    const candidates = await prisma.candidate.findMany({
      where: {
        id: { in: candidateIds },
        status: 'APROBADO'
      },
      select: {
        id: true,
        vacancyId: true,
        vacancy: { select: { id: true, city: true } }
      }
    });
    const visibleCandidates = candidates.filter((candidate) => canAccessCandidate(accessContext, candidate));
    const observedAt = now();
    const states = await Promise.all(visibleCandidates.map(async (candidate) => (
      statusResponse(candidate, await loadLatestInboundAt(prisma, candidate.id), observedAt)
    )));

    return res.json({ ok: true, candidates: states });
  });

  router.post('/:candidateId/free-text', express.urlencoded({ extended: true }), async (req, res) => {
    const candidateId = normalizeString(req.params.candidateId);
    const customBody = typeof req.body?.customBody === 'string' ? req.body.customBody : '';
    if (!candidateId) return res.status(400).json({ ok: false, error: 'candidate_required' });
    if (!customBody.trim()) {
      return res.status(400).json({ ok: false, error: 'message_required', message: 'Escribe el mensaje que deseas enviar.' });
    }
    if (customBody.length > MAX_FREE_TEXT_LENGTH) {
      return res.status(400).json({ ok: false, error: 'message_too_long', message: 'El mensaje es demasiado largo.' });
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        phone: true,
        status: true,
        vacancyId: true,
        vacancy: { select: { id: true, city: true } }
      }
    });
    if (!candidate) return res.status(404).json({ ok: false, error: 'candidate_not_found' });

    const accessContext = requestAccessContext(req);
    if (!canAccessCandidate(accessContext, candidate)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (candidate.status !== 'APROBADO') {
      return res.status(409).json({ ok: false, error: 'candidate_not_approved', message: 'El candidato ya no está en Aprobados. Actualiza la lista.' });
    }

    const lastInboundAt = await loadLatestInboundAt(prisma, candidate.id);
    const windowState = approvedOutreachWindowState(lastInboundAt, now());
    if (!windowState.windowOpen || windowState.transport !== MANUAL_OUTBOUND_TRANSPORT.FREE_TEXT) {
      return res.status(409).json({ ok: false, error: 'whatsapp_window_closed', message: 'La ventana de 24 h ya está cerrada. Actualiza la lista antes de continuar.' });
    }

    try {
      await deliverManualOutboundText(prisma, {
        candidateId: candidate.id,
        phone: candidate.phone,
        body: customBody,
        actor: req.username || req.session?.username || req.userRole || 'dashboard',
        reason: 'Mensaje libre enviado desde la lista de aprobados',
        expectedCandidateStatus: 'APROBADO',
        rawPayload: {
          source: APPROVED_FREE_TEXT_SOURCE,
          action: 'free_text',
          actor: 'RECRUITER',
          sourceCategory: 'MANUAL_AUTHORIZED',
          manualIntervention: true,
          preserveExactBody: true,
          vacancyId: candidate.vacancyId || null
        }
      }, { sendText });
      return res.json({ ok: true, message: 'Mensaje enviado correctamente.' });
    } catch (error) {
      console.error('[approved_outreach_free_text]', {
        candidateId: candidate.id,
        code: error?.code || null,
        message: error?.message || String(error)
      });
      const conflict = String(error?.code || '').includes('conflict') || error?.persistencePending;
      return res.status(conflict ? 409 : 502).json({
        ok: false,
        error: error?.code || 'send_failed',
        message: userMessage(error, 'No fue posible enviar el mensaje en este momento.')
      });
    }
  });

  return router;
}
