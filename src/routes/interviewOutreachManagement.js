import express from 'express';
import {
  buildCandidateAccessWhere,
  getAccessContext
} from '../services/appUsers.js';
import {
  INTERVIEW_COORDINATION_HANDOFF_MODE,
  deriveInterviewOutreachAttendance
} from '../services/vacancyDashboardSearchExpansion.js';
import {
  buildInterviewManagementSnapshot,
  createInterviewComplementaryField,
  saveInterviewComplementaryValues,
  saveInterviewEvaluation,
  setInterviewAttendanceStatus,
  setInterviewInvitationStatus
} from '../services/interviewOutreachManagement.js';

const INTERVIEW_OUTREACH_SOURCE = 'admin_interview_template';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
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
      vacancy: { select: { id: true, title: true, role: true, city: true } }
    }
  });
}

async function loadLatestCitationEvidence(prisma, candidateId) {
  const citation = await prisma.message.findFirst({
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

  if (!citation) {
    return {
      citation: null,
      evidence: { status: 'PENDIENTE', respondedAt: null, source: null }
    };
  }

  const messages = await prisma.message.findMany({
    where: {
      candidateId,
      direction: 'INBOUND',
      createdAt: { gte: citation.createdAt }
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { body: true, rawPayload: true, createdAt: true }
  });

  return {
    citation,
    evidence: deriveInterviewOutreachAttendance({
      botResumeMode: INTERVIEW_COORDINATION_HANDOFF_MODE,
      botPausedAt: citation.createdAt,
      messages
    })
  };
}

async function loadCandidateManagementData(prisma, req, candidateId) {
  const candidate = await loadAuthorizedCandidate(prisma, req, candidateId);
  if (!candidate?.vacancyId) return null;

  const [review, citationEvidence, fields, values] = await Promise.all([
    prisma.interviewCandidateReview.findUnique({
      where: {
        candidateId_vacancyId: {
          candidateId: candidate.id,
          vacancyId: candidate.vacancyId
        }
      }
    }),
    loadLatestCitationEvidence(prisma, candidate.id),
    prisma.interviewComplementaryField.findMany({
      where: { vacancyId: candidate.vacancyId },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }]
    }),
    prisma.interviewComplementaryValue.findMany({
      where: { candidateId: candidate.id }
    })
  ]);

  const isCited = Boolean(citationEvidence.citation)
    || candidate.botResumeMode === INTERVIEW_COORDINATION_HANDOFF_MODE
    || Boolean(review);
  if (!isCited) return null;

  return {
    candidate,
    citedAt: citationEvidence.citation?.createdAt || candidate.botPausedAt || null,
    review,
    evidence: citationEvidence.evidence,
    snapshot: buildInterviewManagementSnapshot({
      review,
      evidence: citationEvidence.evidence,
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

export function interviewOutreachManagementRouter(prisma) {
  const router = express.Router();

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
      management: data.snapshot
    });
  });

  router.get('/interview-management/vacancies/:vacancyId', apiSessionAuth, async (req, res) => {
    const vacancyId = normalizeString(req.params.vacancyId);
    if (!vacancyId) return res.status(400).json({ ok: false, error: 'vacancy_id_required' });

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
        botPausedAt: true,
        botResumeMode: true,
        messages: {
          where: { direction: 'INBOUND' },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { body: true, rawPayload: true, createdAt: true }
        },
        interviewCandidateReviews: {
          where: { vacancyId },
          take: 1
        }
      }
    });

    const entries = candidates.map((candidate) => {
      const evidence = deriveInterviewOutreachAttendance(candidate);
      const review = candidate.interviewCandidateReviews?.[0] || null;
      const snapshot = buildInterviewManagementSnapshot({ review, evidence });
      return {
        candidateId: candidate.id,
        invitation: snapshot.invitation,
        attendance: snapshot.attendance,
        evaluation: snapshot.evaluation
      };
    });

    return res.json({ ok: true, vacancyId, entries });
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
