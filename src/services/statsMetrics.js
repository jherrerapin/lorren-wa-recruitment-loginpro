const APPROVED_STATUSES = new Set(['APROBADO', 'CONTRATADO']);
const CANCELLED_BOOKING_STATUSES = new Set(['CANCELLED']);
const CONFIRMED_BOOKING_STATUSES = new Set(['CONFIRMED', 'ATTENDED']);

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasCandidateData(candidate = {}) {
  return Boolean(
    candidate.fullName ||
    candidate.documentNumber ||
    candidate.age ||
    candidate.neighborhood ||
    candidate.locality ||
    candidate.transportMode
  );
}

export function hasCompleteCoreData(candidate = {}) {
  return Boolean(candidate.fullName && candidate.documentNumber && candidate.phone);
}

export function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

export function activeBookings(candidate = {}) {
  return (candidate.interviewBookings || []).filter((booking) => !CANCELLED_BOOKING_STATUSES.has(booking.status));
}

export function hasBooking(candidate = {}) {
  return activeBookings(candidate).length > 0;
}

export function hasConfirmedBooking(candidate = {}) {
  return activeBookings(candidate).some((booking) => CONFIRMED_BOOKING_STATUSES.has(booking.status));
}

export function hasAttendedBooking(candidate = {}) {
  return activeBookings(candidate).some((booking) => booking.status === 'ATTENDED');
}

export function hasNoShowBooking(candidate = {}) {
  return activeBookings(candidate).some((booking) => booking.status === 'NO_SHOW');
}

export function requiresHumanReview(candidate = {}) {
  return Boolean(candidate.potentialDuplicate || candidate.botPaused || candidate.rejectionDetails);
}

export function costPerResult(budget, count) {
  const amount = toNumber(budget);
  if (!amount || !count) return null;
  return Math.round(amount / count);
}

export function buildCampaignMetric(campaign = {}, options = {}) {
  const schedulingEnabled = Boolean(options.schedulingEnabled ?? campaign.vacancy?.schedulingEnabled);
  const candidates = campaign.attributedCandidates || campaign.candidates || [];
  const budget = toNumber(campaign.budgetCOP);

  const conversationsStarted = candidates.length;
  const startedProcess = candidates.filter(hasCandidateData).length;
  const dataCompleted = candidates.filter(hasCompleteCoreData).length;
  const cvReceived = candidates.filter(hasCv).length;
  const apt = candidates.filter((candidate) => APPROVED_STATUSES.has(candidate.status)).length;
  const rejected = candidates.filter((candidate) => candidate.status === 'RECHAZADO').length;
  const hired = candidates.filter((candidate) => candidate.status === 'CONTRATADO').length;
  const abandoned = candidates.filter((candidate) => candidate.status === 'NUEVO' && !hasCandidateData(candidate) && !hasCv(candidate)).length;
  const pendingCv = candidates.filter((candidate) => hasCompleteCoreData(candidate) && !hasCv(candidate)).length;
  const humanReview = candidates.filter(requiresHumanReview).length;

  const qualityScore = conversationsStarted >= 3
    ? Math.min(100, Math.round(
      (cvReceived / conversationsStarted) * 35 +
      (apt / (cvReceived || 1)) * 40 +
      (hired / conversationsStarted) * 25
    ))
    : null;

  const metric = {
    conversationsStarted,
    startedProcess,
    dataCompleted,
    cvReceived,
    apt,
    rejected,
    hired,
    abandoned,
    pendingCv,
    humanReview,
    exactAttributions: campaign.exactAttributions || 0,
    inferredAttributions: campaign.inferredAttributions || 0,
    directAttributions: campaign.directAttributions || 0,
    qualityScore,
    cplConversation: costPerResult(budget, conversationsStarted),
    cplDataCompleted: costPerResult(budget, dataCompleted),
    cplCvReceived: costPerResult(budget, cvReceived),
    cplApt: costPerResult(budget, apt),
    cplHired: costPerResult(budget, hired)
  };

  if (schedulingEnabled) {
    const scheduled = candidates.filter(hasBooking).length;
    const confirmed = candidates.filter(hasConfirmedBooking).length;
    const attended = candidates.filter(hasAttendedBooking).length;
    const noShow = candidates.filter(hasNoShowBooking).length;

    metric.scheduled = scheduled;
    metric.confirmed = confirmed;
    metric.attended = attended;
    metric.noShow = noShow;
    metric.attendanceRate = confirmed ? Math.round((attended / confirmed) * 100) : null;
    metric.cplScheduled = costPerResult(budget, scheduled);
    metric.cplAttended = costPerResult(budget, attended);
  }

  return metric;
}

export function buildAggregateCampaignMetric(campaigns = []) {
  return campaigns.reduce((total, campaign) => {
    const metric = buildCampaignMetric(campaign);
    for (const [key, value] of Object.entries(metric)) {
      if (typeof value === 'number') total[key] = (total[key] || 0) + value;
    }
    return total;
  }, {});
}
