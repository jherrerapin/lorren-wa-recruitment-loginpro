import express from 'express';
import {
  buildCandidateAccessWhere,
  getAccessContext
} from '../services/appUsers.js';
import { INTERVIEW_COORDINATION_HANDOFF_MODE } from './admin.js';
import {
  buildInterviewManagementSnapshot,
  createInterviewComplementaryField,
  normalizeInterviewInvitationStatus,
  saveInterviewComplementaryValues,
  saveInterviewEvaluation,
  setInterviewAttendanceStatus,
  setInterviewInvitationStatus
} from '../services/interviewOutreachManagement.js';
import {
  cancelCandidateBookings,
  createBooking,
  formatInterviewDate,
  listOfferableSlots
} from '../services/interviewScheduler.js';
import { ACTIVE_INTERVIEW_BOOKING_STATUSES } from '../services/interviewBookingStateService.js';

const INTERVIEW_OUTREACH_SOURCE = 'admin_interview_template';
const MANAGEMENT_SCRIPT = '<script src="/public/interview-outreach-management.js" defer data-interview-outreach-management></script>';

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
        return originalSend(body.replace('</body>', `${MANAGEMENT_SCRIPT}\n</body>`));
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
      lastInboundAt: true,
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
      where: { vacancyId: candidate.vacancyId },
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

function serializeOffer(option = {}) {
  return {
    slotId: option.slot?.id || null,
    scheduledAt: option.date || null,
    label: option.formattedDate || (option.date ? formatInterviewDate(option.date) : null)
  };
}

async function loadVacancyCoordinationEntries(prisma, req, vacancyId) {
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
      botPausedAt: true,
      botResumeMode: true,
      interviewCandidateReviews: {
        where: { vacancyId },
        take: 1
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

  return sortInterviewCoordinationEntries(candidates.map((candidate) => {
    const review = candidate.interviewCandidateReviews?.[0] || null;
    const snapshot = buildInterviewManagementSnapshot({ review });
    return {
      candidateId: candidate.id,
      fullName: candidate.fullName,
      phone: candidate.phone,
      contactedAt: candidate.botPausedAt || null,
      invitation: snapshot.invitation,
      attendance: snapshot.attendance,
      evaluation: snapshot.evaluation,
      booking: serializeBooking(candidate.interviewBookings?.[0] || null)
    };
  }));
}

async function runCoordinationTransaction(prisma, callback) {
  if (typeof prisma.$transaction !== 'function') return callback(prisma);
  return prisma.$transaction((tx) => callback(tx));
}

function sameBooking(booking, slotId, scheduledAt) {
  if (!booking || !slotId || !scheduledAt) return false;
  return booking.slotId === slotId
    && new Date(booking.scheduledAt).getTime() === new Date(scheduledAt).getTime();
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

    const entries = await loadVacancyCoordinationEntries(prisma, req, vacancyId);
    const offers = await listOfferableSlots(prisma, vacancyId, null, new Date(), 0);

    return res.json({
      ok: true,
      vacancyId,
      entries,
      availableSlots: offers.map(serializeOffer)
    });
  });

  router.post('/interview-management/candidates/:candidateId/coordination', apiSessionAuth, async (req, res) => {
    const data = await requireCandidateManagementData(prisma, req, res);
    if (!data) return;

    try {
      const status = normalizeInterviewInvitationStatus(req.body?.status);
      const actor = await resolveCurrentActor(prisma, req);

      if (status === 'CONFIRMED') {
        const slotId = normalizeString(req.body?.slotId);
        const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
        if (!slotId || !scheduledAt || Number.isNaN(scheduledAt.getTime())) {
          return res.status(400).json({ ok: false, error: 'interview_management_slot_required' });
        }

        const bookingAlreadyMatches = sameBooking(data.booking, slotId, scheduledAt);
        let chosenOffer = null;
        if (!bookingAlreadyMatches) {
          const offers = await listOfferableSlots(
            prisma,
            data.candidate.vacancyId,
            data.candidate.lastInboundAt ? new Date(data.candidate.lastInboundAt) : null,
            new Date(),
            0
          );
          chosenOffer = offers.find((option) => (
            option.slot?.id === slotId
            && option.date?.getTime?.() === scheduledAt.getTime()
          )) || null;
          if (!chosenOffer?.slot) {
            return res.status(409).json({ ok: false, error: 'interview_management_slot_unavailable' });
          }
        }

        await runCoordinationTransaction(prisma, async (tx) => {
          if (!bookingAlreadyMatches) {
            await createBooking(
              tx,
              data.candidate.id,
              data.candidate.vacancyId,
              chosenOffer.slot.id,
              chosenOffer.date,
              !chosenOffer.windowOk
            );
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
        vacancyId: data.candidate.vacancyId,
        label: req.body?.label,
        actor
      });
      const updated = await loadCandidateManagementData(prisma, req, data.candidate.id);
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
