import express from 'express';
import {
  buildCandidateAccessWhere,
  buildVacancyAccessWhere,
  getAccessContext
} from '../services/appUsers.js';
import { INTERVIEW_COORDINATION_HANDOFF_MODE } from './admin.js';
import {
  buildInterviewManagementSnapshot,
  createInterviewComplementaryField,
  isInterviewedCandidateReview,
  normalizeInterviewInvitationStatus,
  saveInterviewComplementaryValues,
  saveInterviewEvaluation,
  setInterviewAttendanceStatus,
  setInterviewContinuationStatus,
  setInterviewInvitationStatus,
  sortInterviewedCandidateEntries
} from '../services/interviewOutreachManagement.js';
import {
  cancelCandidateBookings,
  formatInterviewDate
} from '../services/interviewScheduler.js';
import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  createScheduledInterviewBooking
} from '../services/interviewBookingStateService.js';

const INTERVIEW_OUTREACH_SOURCE = 'admin_interview_template';
const MANAGEMENT_SCRIPT = '<script src="/public/interview-outreach-management.js" defer data-interview-outreach-management></script>';
const MANAGEMENT_LOADING_SHELL = `<script data-interview-outreach-loading-shell>
(() => {
  for (const panel of document.querySelectorAll('[data-vacancy-panel]')) {
    if (panel.querySelector('[data-interview-coordination-board]')) continue;
    const vacancyId = String(panel.dataset.vacancyPanel || '').trim();
    if (!vacancyId) continue;

    const board = document.createElement('section');
    board.className = 'ic-board';
    board.dataset.interviewCoordinationBoard = vacancyId;

    const head = document.createElement('div');
    head.className = 'ic-head';
    const title = document.createElement('h3');
    title.className = 'ic-title';
    title.textContent = 'Gestión de entrevistas';
    head.appendChild(title);

    const loading = document.createElement('div');
    loading.className = 'ic-empty';
    loading.textContent = 'Cargando…';
    board.append(head, loading);

    const header = panel.querySelector('.vacancy-header');
    if (header) header.insertAdjacentElement('afterend', board);
    else panel.prepend(board);
  }
})();
</script>`;
const INTERVIEW_INVITATION_AUDIT_LABELS = Object.freeze({
  PENDING: 'Pendiente de respuesta',
  CONFIRMED: 'Confirmó entrevista',
  DECLINED: 'No interesado'
});
const INTERVIEW_ATTENDANCE_AUDIT_LABELS = Object.freeze({
  PENDING: 'Pendiente',
  ATTENDED: 'Asistió',
  NO_SHOW: 'No asistió'
});
const INTERVIEW_CONTINUATION_AUDIT_LABELS = Object.freeze({
  CONTINUES: 'Continúa en proceso',
  WITHDREW: 'Desistió del proceso'
});

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function timeValue(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? Number.POSITIVE_INFINITY : date.getTime();
}

export function sortInterviewCoordinationEntries(entries = []) {
  const priority = { PENDING: 0, CONFIRMED: 1, DECLINED: 2 };
  return [...entries].sort((left, right) => {
    const leftStatus = left?.invitation?.status || 'PENDING';
    const rightStatus = right?.invitation?.status || 'PENDING';
    const statusDifference = (priority[leftStatus] ?? 3) - (priority[rightStatus] ?? 3);
    if (statusDifference !== 0) return statusDifference;

    if (leftStatus === 'CONFIRMED') {
      const bookingDifference = timeValue(left?.booking?.scheduledAt) - timeValue(right?.booking?.scheduledAt);
      if (bookingDifference !== 0) return bookingDifference;
    }

    const contactedDifference = timeValue(right?.contactedAt) - timeValue(left?.contactedAt);
    if (Number.isFinite(contactedDifference) && contactedDifference !== 0) return contactedDifference;
    return String(left?.candidateId || '').localeCompare(String(right?.candidateId || ''));
  });
}

function apiSessionAuth(req, res, next) {
  if (!req.session?.userRole && !req.userRole) {
    return res.status(401).json({ ok: false, error: 'authentication_required' });
  }
  return next();
}

function getRequestAccessContext(req = {}) {
  return getAccessContext({
    userRole: req.userRole || req.session?.userRole,
    userId: req.userId || req.session?.userId,
    username: req.username || req.session?.username,
    userAccessScope: req.userAccessScope || req.session?.userAccessScope,
    userAccessCity: req.userAccessCity || req.session?.userAccessCity,
    userAccessVacancyId: req.userAccessVacancyId || req.session?.userAccessVacancyId
  });
}

async function loadAuthorizedVacancy(prisma, req, vacancyId) {
  return prisma.vacancy.findFirst({
    where: {
      AND: [
        buildVacancyAccessWhere(getRequestAccessContext(req)),
        { id: vacancyId }
      ]
    },
    select: { id: true }
  });
}

function installManagementScriptInjection(router) {
  router.use((req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/') return next();

    const originalSend = res.send.bind(res);
    res.send = (body) => {
      if (
        typeof body === 'string'
        && body.includes('data-vacancy-panel')
        && body.includes('</body>')
        && !body.includes('data-interview-outreach-management')
      ) {
        return originalSend(body.replace(
          '</body>',
          `${MANAGEMENT_LOADING_SHELL}\n${MANAGEMENT_SCRIPT}\n</body>`
        ));
      }
      return originalSend(body);
    };
    return next();
  });
}

async function resolveCurrentActor(prisma, req) {
  const userId = normalizeString(req.userId || req.session?.userId);
  const sessionUsername = normalizeString(req.username || req.session?.username);
  if (userId && typeof prisma?.appUser?.findUnique === 'function') {
    const user = await prisma.appUser.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true }
    });
    if (user) {
      return {
        userId: user.id,
        label: normalizeString(user.displayName) || normalizeString(user.username) || sessionUsername || 'usuario'
      };
    }
  }

  return {
    userId: userId || null,
    label: sessionUsername || normalizeString(req.userRole || req.session?.userRole) || 'usuario'
  };
}

function activeBookingSelect() {
  return {
    id: true,
    slotId: true,
    scheduledAt: true,
    status: true
  };
}

function serializeBooking(booking = null) {
  if (!booking) return null;
  return {
    id: booking.id,
    slotId: booking.slotId,
    scheduledAt: booking.scheduledAt,
    status: booking.status,
    label: booking.scheduledAt ? formatInterviewDate(new Date(booking.scheduledAt)) : null
  };
}

function auditBookingLabel(booking = null) {
  if (!booking?.scheduledAt) return null;
  return formatInterviewDate(new Date(booking.scheduledAt));
}

function auditRatingLabel(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 'Sin calificación';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Sin calificación';
  return numeric.toFixed(2).replace('.', ',');
}

function evaluationAuditState(snapshot = null) {
  const evaluation = snapshot?.evaluation || {};
  const complementaryFields = Array.isArray(snapshot?.complementaryFields)
    ? snapshot.complementaryFields
    : [];
  return JSON.stringify({
    rating: evaluation.rating ?? null,
    observationEnabled: Boolean(evaluation.observationEnabled),
    observation: evaluation.observation || null,
    complementaryFields: complementaryFields
      .map((field) => ({
        id: String(field?.id || ''),
        label: String(field?.label || ''),
        value: String(field?.value || '')
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });
}

export function buildInterviewAdminAuditEvents({
  action,
  beforeSnapshot = null,
  afterSnapshot = null,
  beforeBooking = null,
  afterBooking = null,
  complementaryField = null
} = {}) {
  const events = [];

  if (action === 'coordination' || action === 'invitation') {
    const beforeStatus = beforeSnapshot?.invitation?.status || 'PENDING';
    const afterStatus = afterSnapshot?.invitation?.status || 'PENDING';
    if (beforeStatus !== afterStatus) {
      events.push({
        eventType: 'INTERVIEW_INVITATION_STATUS_CHANGED',
        eventLabel: 'Actualizó gestión de entrevista',
        fromValue: INTERVIEW_INVITATION_AUDIT_LABELS[beforeStatus] || beforeStatus,
        toValue: INTERVIEW_INVITATION_AUDIT_LABELS[afterStatus] || afterStatus,
        note: afterStatus === 'CONFIRMED' && auditBookingLabel(afterBooking)
          ? `Horario: ${auditBookingLabel(afterBooking)}`
          : null
      });
    } else if (
      action === 'coordination'
      && afterStatus === 'CONFIRMED'
      && auditBookingLabel(beforeBooking) !== auditBookingLabel(afterBooking)
    ) {
      events.push({
        eventType: 'INTERVIEW_SCHEDULE_CHANGED',
        eventLabel: 'Actualizó fecha de entrevista',
        fromValue: auditBookingLabel(beforeBooking),
        toValue: auditBookingLabel(afterBooking),
        note: null
      });
    }
  }

  if (action === 'attendance') {
    const beforeStatus = beforeSnapshot?.attendance?.status || 'PENDING';
    const afterStatus = afterSnapshot?.attendance?.status || 'PENDING';
    if (beforeStatus !== afterStatus) {
      events.push({
        eventType: 'INTERVIEW_ATTENDANCE_STATUS_CHANGED',
        eventLabel: 'Actualizó asistencia de entrevista',
        fromValue: INTERVIEW_ATTENDANCE_AUDIT_LABELS[beforeStatus] || beforeStatus,
        toValue: INTERVIEW_ATTENDANCE_AUDIT_LABELS[afterStatus] || afterStatus,
        note: null
      });
    }
  }

  if (action === 'continuation' || action === 'attendance') {
    const beforeStatus = beforeSnapshot?.continuation?.status || 'CONTINUES';
    const afterStatus = afterSnapshot?.continuation?.status || 'CONTINUES';
    if (beforeStatus !== afterStatus) {
      events.push({
        eventType: 'INTERVIEW_CONTINUATION_STATUS_CHANGED',
        eventLabel: 'Actualizó continuidad después de entrevista',
        fromValue: INTERVIEW_CONTINUATION_AUDIT_LABELS[beforeStatus] || beforeStatus,
        toValue: INTERVIEW_CONTINUATION_AUDIT_LABELS[afterStatus] || afterStatus,
        note: action === 'attendance' ? 'Ajuste automático por corrección de asistencia.' : null
      });
    }
  }

  if (action === 'evaluation' && evaluationAuditState(beforeSnapshot) !== evaluationAuditState(afterSnapshot)) {
    const beforeRating = auditRatingLabel(beforeSnapshot?.evaluation?.rating);
    const afterRating = auditRatingLabel(afterSnapshot?.evaluation?.rating);
    const ratingChanged = beforeRating !== afterRating;
    events.push({
      eventType: 'INTERVIEW_EVALUATION_UPDATED',
      eventLabel: 'Actualizó evaluación de entrevista',
      fromValue: ratingChanged ? beforeRating : null,
      toValue: ratingChanged ? afterRating : null,
      note: ratingChanged ? null : 'Actualizó observación o información complementaria.'
    });
  }

  if (action === 'complementary-field' && complementaryField?.created) {
    events.push({
      eventType: 'INTERVIEW_COMPLEMENTARY_FIELD_CREATED',
      eventLabel: 'Creó campo complementario de entrevista',
      fromValue: null,
      toValue: normalizeString(complementaryField.label),
      note: null
    });
  }

  return events;
}

async function persistInterviewAdminAuditEvents(prisma, req, candidateId, actor, events = []) {
  if (!candidateId || typeof prisma?.candidateAdminEvent?.create !== 'function' || !events.length) return;
  const actorRole = normalizeString(req.userRole || req.session?.userRole) || 'admin';
  for (const event of events) {
    try {
      await prisma.candidateAdminEvent.create({
        data: {
          candidateId,
          actorUserId: normalizeString(actor?.userId),
          actorRole,
          eventType: event.eventType,
          eventLabel: event.eventLabel,
          fromValue: normalizeString(event.fromValue),
          toValue: normalizeString(event.toValue),
          note: normalizeString(event.note)
        }
      });
    } catch (error) {
      console.error('[interview-management][audit]', error?.message || error);
    }
  }
}

async function loadAuthorizedCandidate(prisma, req, candidateId) {
  const id = normalizeString(candidateId);
  if (!id) return null;
  return prisma.candidate.findFirst({
    where: {
      AND: [
        { id },
        buildCandidateAccessWhere(getRequestAccessContext(req))
      ]
    },
    select: {
      id: true,
      fullName: true,
      phone: true,
      vacancyId: true,
      status: true,
      botResumeMode: true,
      botPausedAt: true,
      vacancy: { select: { id: true, title: true, role: true, city: true } },
      interviewBookings: {
        where: { status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES } },
        orderBy: { scheduledAt: 'asc' },
        take: 1,
        select: activeBookingSelect()
      }
    }
  });
}

async function loadLatestCitation(prisma, candidateId) {
  return prisma.message.findFirst({
    where: {
      candidateId,
      direction: 'OUTBOUND',
      rawPayload: {
        path: ['source'],
        equals: INTERVIEW_OUTREACH_SOURCE
      }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, body: true, rawPayload: true }
  });
}

async function loadCandidateManagementData(prisma, req, candidateId) {
  const candidate = await loadAuthorizedCandidate(prisma, req, candidateId);
  if (!candidate?.vacancyId) return null;

  const [review, citation, fields, values] = await Promise.all([
    prisma.interviewCandidateReview.findUnique({
      where: {
        candidateId_vacancyId: {
          candidateId: candidate.id,
          vacancyId: candidate.vacancyId
        }
      }
    }),
    loadLatestCitation(prisma, candidate.id),
    prisma.interviewComplementaryField.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }]
    }),
    prisma.interviewComplementaryValue.findMany({
      where: { candidateId: candidate.id }
    })
  ]);

  const isCited = Boolean(citation)
    || candidate.botResumeMode === INTERVIEW_COORDINATION_HANDOFF_MODE
    || Boolean(review);
  if (!isCited) return null;

  return {
    candidate,
    citedAt: citation?.createdAt || candidate.botPausedAt || null,
    review,
    booking: candidate.interviewBookings?.[0] || null,
    snapshot: buildInterviewManagementSnapshot({
      review,
      fields,
      values
    })
  };
}

async function requireCandidateManagementData(prisma, req, res) {
  const data = await loadCandidateManagementData(prisma, req, req.params.candidateId);
  if (!data) {
    res.status(404).json({ ok: false, error: 'interview_management_candidate_not_found' });
    return null;
  }
  return data;
}

function sendManagementError(res, error) {
  if (error instanceof TypeError) {
    return res.status(400).json({ ok: false, error: error.message || 'interview_management_invalid_input' });
  }
  throw error;
}

async function runEvaluationTransaction(prisma, input) {
  if (typeof prisma.$transaction !== 'function') {
    const evaluation = await saveInterviewEvaluation(prisma, input);
    await saveInterviewComplementaryValues(prisma, input);
    return evaluation;
  }

  return prisma.$transaction(async (tx) => {
    const evaluation = await saveInterviewEvaluation(tx, input);
    await saveInterviewComplementaryValues(tx, input);
    return evaluation;
  });
}

function serializeComplementaryValues(values = []) {
  return [...values]
    .filter((item) => String(item?.value || '').trim())
    .sort((left, right) => {
      const sortDifference = Number(left?.field?.sortOrder || 0) - Number(right?.field?.sortOrder || 0);
      if (sortDifference !== 0) return sortDifference;
      return String(left?.field?.label || '').localeCompare(String(right?.field?.label || ''));
    })
    .map((item) => ({
      fieldId: item.fieldId,
      label: item.field?.label || '',
      value: item.value || ''
    }));
}

async function loadVacancyManagementEntries(prisma, req, vacancyId) {
  const candidates = await prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(getRequestAccessContext(req)),
        { vacancyId },
        {
          OR: [
            { botResumeMode: INTERVIEW_COORDINATION_HANDOFF_MODE },
            { interviewCandidateReviews: { some: { vacancyId } } }
          ]
        }
      ]
    },
    select: {
      id: true,
      fullName: true,
      phone: true,
      status: true,
      botPausedAt: true,
      botResumeMode: true,
      interviewCandidateReviews: {
        where: { vacancyId },
        take: 1
      },
      interviewComplementaryValues: {
        select: {
          fieldId: true,
          value: true,
          field: { select: { label: true, sortOrder: true } }
        }
      },
      interviewBookings: {
        where: {
          vacancyId,
          status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
        },
        orderBy: { scheduledAt: 'asc' },
        take: 1,
        select: activeBookingSelect()
      }
    }
  });

  const classified = candidates.map((candidate) => {
    const review = candidate.interviewCandidateReviews?.[0] || null;
    const snapshot = buildInterviewManagementSnapshot({ review });
    const entry = {
      candidateId: candidate.id,
      fullName: candidate.fullName,
      phone: candidate.phone,
      candidateStatus: candidate.status,
      contactedAt: candidate.botPausedAt || null,
      invitation: snapshot.invitation,
      attendance: snapshot.attendance,
      continuation: snapshot.continuation,
      evaluation: snapshot.evaluation,
      complementary: serializeComplementaryValues(candidate.interviewComplementaryValues),
      booking: serializeBooking(candidate.interviewBookings?.[0] || null)
    };
    return { entry, interviewed: isInterviewedCandidateReview(review) };
  });

  return {
    entries: sortInterviewCoordinationEntries(
      classified.filter(({ interviewed }) => !interviewed).map(({ entry }) => entry)
    ),
    interviewed: sortInterviewedCandidateEntries(
      classified.filter(({ interviewed }) => interviewed).map(({ entry }) => entry)
    )
  };
}

async function runCoordinationTransaction(prisma, callback) {
  if (typeof prisma.$transaction !== 'function') return callback(prisma);
  return prisma.$transaction((tx) => callback(tx));
}

function sameBookingTime(booking, scheduledAt) {
  if (!booking || !scheduledAt) return false;
  return new Date(booking.scheduledAt).getTime() === new Date(scheduledAt).getTime();
}

export function interviewOutreachManagementRouter(prisma) {
  const router = express.Router();
  installManagementScriptInjection(router);

  router.get('/interview-management/candidates/:candidateId', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    return res.json({
      ok: true,
      candidate: {
        id: data.candidate.id,
        fullName: data.candidate.fullName,
        phone: data.candidate.phone,
        vacancyId: data.candidate.vacancyId,
        status: data.candidate.status,
        vacancy: data.candidate.vacancy,
        citedAt: data.citedAt
      },
      booking: serializeBooking(data.booking),
      management: data.snapshot
    });
  });

  router.get('/interview-management/vacancies/:vacancyId', apiSessionAuth, async (req, res) => {
    const vacancyId = normalizeString(req.params.vacancyId);
    if (!vacancyId) return res.status(400).json({ ok: false, error: 'vacancy_id_required' });

    const allowedVacancy = await loadAuthorizedVacancy(prisma, req, vacancyId);
    if (!allowedVacancy) {
      return res.status(404).json({ ok: false, error: 'interview_management_vacancy_not_found' });
    }

    const { entries, interviewed } = await loadVacancyManagementEntries(prisma, req, vacancyId);
    return res.json({ ok: true, vacancyId, entries, interviewed });
  });

  router.post('/interview-management/candidates/:candidateId/coordination', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;

    try {
      const status = normalizeInterviewInvitationStatus(req.body?.status);
      const actor = await resolveCurrentActor(prisma, req);

      if (status === 'CONFIRMED') {
        const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
        if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
          return res.status(400).json({ ok: false, error: 'interview_management_datetime_required' });
        }

        const bookingAlreadyMatches = sameBookingTime(data.booking, scheduledAt);
        await runCoordinationTransaction(prisma, async (tx) => {
          if (!bookingAlreadyMatches) {
            await createScheduledInterviewBooking(tx, {
              candidateId: data.candidate.id,
              vacancyId: data.candidate.vacancyId,
              slotId: null,
              scheduledAt,
              manualScheduling: true
            });
          }
          await setInterviewInvitationStatus(tx, {
            candidateId: data.candidate.id,
            vacancyId: data.candidate.vacancyId,
            status,
            actor
          });
        });
      } else {
        await runCoordinationTransaction(prisma, async (tx) => {
          if (data.booking) {
            await cancelCandidateBookings(tx, data.candidate.id, 'CANCELLED');
          }
          await setInterviewInvitationStatus(tx, {
            candidateId: data.candidate.id,
            vacancyId: data.candidate.vacancyId,
            status,
            actor
          });
        });
      }

      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'coordination',
          beforeSnapshot: data.snapshot,
          afterSnapshot: updated?.snapshot,
          beforeBooking: data.booking,
          afterBooking: updated?.booking
        })
      );
      return res.json({
        ok: true,
        booking: serializeBooking(updated?.booking || null),
        management: updated?.snapshot || null
      });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  router.post('/interview-management/candidates/:candidateId/invitation', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    try {
      const actor = await resolveCurrentActor(prisma, req);
      await setInterviewInvitationStatus(prisma, {
        candidateId: data.candidate.id,
        vacancyId: data.candidate.vacancyId,
        status: req.body?.status,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'invitation',
          beforeSnapshot: data.snapshot,
          afterSnapshot: updated?.snapshot,
          beforeBooking: data.booking,
          afterBooking: updated?.booking
        })
      );
      return res.json({ ok: true, management: updated.snapshot });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  router.post('/interview-management/candidates/:candidateId/attendance', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    try {
      const actor = await resolveCurrentActor(prisma, req);
      await setInterviewAttendanceStatus(prisma, {
        candidateId: data.candidate.id,
        vacancyId: data.candidate.vacancyId,
        status: req.body?.status,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'attendance',
          beforeSnapshot: data.snapshot,
          afterSnapshot: updated?.snapshot
        })
      );
      return res.json({ ok: true, management: updated.snapshot });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  router.post('/interview-management/candidates/:candidateId/continuation', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    try {
      const actor = await resolveCurrentActor(prisma, req);
      await setInterviewContinuationStatus(prisma, {
        candidateId: data.candidate.id,
        vacancyId: data.candidate.vacancyId,
        candidateStatus: data.candidate.status,
        status: req.body?.status,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'continuation',
          beforeSnapshot: data.snapshot,
          afterSnapshot: updated?.snapshot
        })
      );
      return res.json({ ok: true, management: updated.snapshot });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  router.post('/interview-management/candidates/:candidateId/evaluation', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    try {
      const actor = await resolveCurrentActor(prisma, req);
      const values = Array.isArray(req.body?.values) ? req.body.values : [];
      await runEvaluationTransaction(prisma, {
        candidateId: data.candidate.id,
        vacancyId: data.candidate.vacancyId,
        rating: req.body?.rating,
        observationEnabled: req.body?.observationEnabled,
        observation: req.body?.observation,
        values,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'evaluation',
          beforeSnapshot: data.snapshot,
          afterSnapshot: updated?.snapshot
        })
      );
      return res.json({ ok: true, management: updated.snapshot });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  router.post('/interview-management/candidates/:candidateId/complementary-fields', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;
    try {
      const actor = await resolveCurrentActor(prisma, req);
      const result = await createInterviewComplementaryField(prisma, {
        label: req.body?.label,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
      await persistInterviewAdminAuditEvents(
        prisma,
        req,
        data.candidate.id,
        actor,
        buildInterviewAdminAuditEvents({
          action: 'complementary-field',
          complementaryField: {
            created: result.created,
            label: result.field.label
          }
        })
      );
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        created: result.created,
        field: { id: result.field.id, label: result.field.label },
        management: updated.snapshot
      });
    } catch (error) {
      return sendManagementError(res, error);
    }
  });

  return router;
}
