import { getCandidateReadiness } from './readinessGuard.js';

const DEFAULT_TIME_ZONE = 'America/Bogota';

function asNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asInteger(value) {
  return Math.round(asNumber(value));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasCandidateData(candidate = {}) {
  return Boolean(
    candidate.fullName
    || candidate.documentNumber
    || candidate.age
    || candidate.neighborhood
    || candidate.locality
    || candidate.transportMode
    || candidate.experienceTime
    || candidate.experienceSummary
  );
}

function hasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey || candidate.cvData || candidate.cvOriginalName);
}

function isApt(candidate = {}) {
  return ['APROBADO', 'CONTRATADO'].includes(String(candidate.status || ''));
}

function isHired(candidate = {}) {
  return String(candidate.status || '') === 'CONTRATADO';
}

function hasBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => booking.status !== 'CANCELLED');
}

function hasConfirmedBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => ['CONFIRMED', 'ATTENDED'].includes(booking.status));
}

function hasAttendedBooking(candidate = {}) {
  return (candidate.interviewBookings || []).some((booking) => booking.status === 'ATTENDED');
}

export function dateKeyInTimeZone(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function extractMessagingConversations(rawActions = []) {
  if (!Array.isArray(rawActions)) return 0;
  return rawActions.reduce((total, action) => {
    const type = String(action?.action_type || '').toLowerCase();
    if (!type.includes('messaging_conversation_started')) return total;
    return total + asInteger(action?.value);
  }, 0);
}

export function candidateMatchesAdExactly(candidate = {}, campaign = {}) {
  if (!candidate || !campaign) return false;
  if (candidate.campaignId && campaign.id) return candidate.campaignId === campaign.id;
  const candidateAdId = String(candidate.metaAdId || '').trim();
  const campaignAdId = String(campaign.code || '').trim();
  return Boolean(candidateAdId && campaignAdId && candidateAdId === campaignAdId);
}

export function buildCandidateRegistrationState(candidate = {}, campaign = {}) {
  const vacancy = candidate.vacancy || campaign.vacancy || null;
  const vacancyId = candidate.vacancyId || campaign.vacancyId || vacancy?.id || null;
  const candidateForReadiness = { ...candidate, vacancyId };
  const readiness = getCandidateReadiness(candidateForReadiness, vacancy, { requireCv: true });
  const consent = String(candidate.dataConsentStatus || 'PENDING');
  const consentAccepted = consent === 'ACCEPTED';
  const complete = Boolean(consentAccepted && vacancyId && readiness.readyForDone);

  let stage = 'Registro completo';
  let stageCode = 'COMPLETE';
  if (!vacancyId) {
    stage = 'Vacante sin confirmar';
    stageCode = 'VACANCY_PENDING';
  } else if (consent === 'REVOKED') {
    stage = 'No autorizó datos';
    stageCode = 'CONSENT_REVOKED';
  } else if (!consentAccepted) {
    stage = 'Autorización pendiente';
    stageCode = 'CONSENT_PENDING';
  } else if (readiness.eligibilityFailures?.length) {
    stage = readiness.eligibilityFailures[0].label || 'No cumple un requisito excluyente';
    stageCode = 'INELIGIBLE';
  } else if (readiness.missingFields?.length) {
    stage = `Falta ${readiness.missingFieldLabels?.[0] || readiness.missingFields[0]}`;
    stageCode = 'DATA_INCOMPLETE';
  } else if (!readiness.hasValidCv) {
    stage = 'Falta hoja de vida válida';
    stageCode = 'CV_PENDING';
  }

  return {
    complete,
    stage,
    stageCode,
    consentAccepted,
    startedProcess: consentAccepted || hasCandidateData(candidate),
    hasCv: hasCv(candidate),
    readiness
  };
}

function createEmptyAdMetric(campaign = {}) {
  return {
    campaign,
    metaAdId: String(campaign.code || ''),
    metaAdName: campaign.name || null,
    metaCampaignId: null,
    metaCampaignName: null,
    metaAdsetId: null,
    metaAdsetName: null,
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    inlineLinkClicks: 0,
    metaConversationsStarted: 0,
    candidates: [],
    candidatesCount: 0,
    startedProcess: 0,
    completedRegistrations: 0,
    incompleteRegistrations: 0,
    cvReceived: 0,
    apt: 0,
    hired: 0,
    scheduled: 0,
    confirmed: 0,
    attended: 0,
    noShow: 0,
    completionRate: null,
    costPerCandidate: null,
    costPerCompletedRegistration: null,
    costPerIncompleteRegistration: null,
    costPerCv: null,
    costPerApt: null,
    costPerHired: null,
    costPerLinkClick: null,
    estimatedIncompleteSpend: 0,
    unattributedSpend: 0,
    dailySpend: new Map(),
    candidatesPerDay: new Map()
  };
}

function safeCost(spend, count) {
  return spend > 0 && count > 0 ? Math.round(spend / count) : null;
}

function snapshotDateKey(snapshot = {}) {
  if (!snapshot.date) return null;
  const date = snapshot.date instanceof Date ? snapshot.date : new Date(snapshot.date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function candidateDateKey(candidate = {}, timeZone) {
  return dateKeyInTimeZone(candidate.createdAt, timeZone);
}

export function buildMetaAdStatistics({
  campaigns = [],
  candidates = [],
  snapshots = [],
  timeZone = DEFAULT_TIME_ZONE
} = {}) {
  const metricsByCampaignId = new Map();
  const metricsByAdId = new Map();

  for (const campaign of campaigns) {
    const metric = createEmptyAdMetric(campaign);
    metricsByCampaignId.set(campaign.id, metric);
    if (metric.metaAdId) metricsByAdId.set(metric.metaAdId, metric);
  }

  for (const snapshot of snapshots) {
    const adId = String(snapshot.metaAdId || '').trim();
    const metric = metricsByAdId.get(adId);
    if (!metric) continue;
    metric.metaAdName = snapshot.metaAdName || metric.metaAdName;
    metric.metaCampaignId = snapshot.metaCampaignId || metric.metaCampaignId;
    metric.metaCampaignName = snapshot.metaCampaignName || metric.metaCampaignName;
    metric.metaAdsetId = snapshot.metaAdsetId || metric.metaAdsetId;
    metric.metaAdsetName = snapshot.metaAdsetName || metric.metaAdsetName;
    metric.spend += asNumber(snapshot.spend);
    metric.impressions += asInteger(snapshot.impressions);
    metric.reach += asInteger(snapshot.reach);
    metric.clicks += asInteger(snapshot.clicks);
    metric.inlineLinkClicks += asInteger(snapshot.inlineLinkClicks);
    metric.metaConversationsStarted += extractMessagingConversations(snapshot.rawActions);
    const dateKey = snapshotDateKey(snapshot);
    if (dateKey) metric.dailySpend.set(dateKey, (metric.dailySpend.get(dateKey) || 0) + asNumber(snapshot.spend));
  }

  for (const candidate of candidates) {
    let metric = candidate.campaignId ? metricsByCampaignId.get(candidate.campaignId) : null;
    if (!metric && candidate.metaAdId) metric = metricsByAdId.get(String(candidate.metaAdId));
    if (!metric || !candidateMatchesAdExactly(candidate, metric.campaign)) continue;

    const state = buildCandidateRegistrationState(candidate, metric.campaign);
    const enrichedCandidate = { ...candidate, registrationState: state, estimatedCost: null };
    metric.candidates.push(enrichedCandidate);
    metric.candidatesCount += 1;
    if (state.startedProcess) metric.startedProcess += 1;
    if (state.complete) metric.completedRegistrations += 1;
    else metric.incompleteRegistrations += 1;
    if (state.hasCv) metric.cvReceived += 1;
    if (isApt(candidate)) metric.apt += 1;
    if (isHired(candidate)) metric.hired += 1;
    if (hasBooking(candidate)) metric.scheduled += 1;
    if (hasConfirmedBooking(candidate)) metric.confirmed += 1;
    if (hasAttendedBooking(candidate)) metric.attended += 1;

    const dateKey = candidateDateKey(candidate, timeZone);
    if (dateKey) metric.candidatesPerDay.set(dateKey, (metric.candidatesPerDay.get(dateKey) || 0) + 1);
  }

  for (const metric of metricsByCampaignId.values()) {
    metric.noShow = Math.max(0, metric.confirmed - metric.attended);
    metric.completionRate = metric.candidatesCount
      ? Math.round((metric.completedRegistrations / metric.candidatesCount) * 100)
      : null;
    metric.costPerCandidate = safeCost(metric.spend, metric.candidatesCount);
    metric.costPerCompletedRegistration = safeCost(metric.spend, metric.completedRegistrations);
    metric.costPerIncompleteRegistration = safeCost(metric.spend, metric.incompleteRegistrations);
    metric.costPerCv = safeCost(metric.spend, metric.cvReceived);
    metric.costPerApt = safeCost(metric.spend, metric.apt);
    metric.costPerHired = safeCost(metric.spend, metric.hired);
    metric.costPerLinkClick = safeCost(metric.spend, metric.inlineLinkClicks || metric.clicks);

    let allocatedSpend = 0;
    for (const candidate of metric.candidates) {
      const dateKey = candidateDateKey(candidate, timeZone);
      const dailySpend = dateKey ? metric.dailySpend.get(dateKey) || 0 : 0;
      const dailyCandidates = dateKey ? metric.candidatesPerDay.get(dateKey) || 0 : 0;
      candidate.estimatedCost = safeCost(dailySpend, dailyCandidates);
      if (candidate.estimatedCost !== null) {
        allocatedSpend += candidate.estimatedCost;
        if (!candidate.registrationState.complete) metric.estimatedIncompleteSpend += candidate.estimatedCost;
      }
    }
    metric.unattributedSpend = Math.max(0, Math.round(metric.spend - allocatedSpend));
    metric.dailySpend = undefined;
    metric.candidatesPerDay = undefined;
  }

  return [...metricsByCampaignId.values()];
}

export function aggregateMetaAdStatistics(metrics = []) {
  const total = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    inlineLinkClicks: 0,
    metaConversationsStarted: 0,
    candidatesCount: 0,
    startedProcess: 0,
    completedRegistrations: 0,
    incompleteRegistrations: 0,
    cvReceived: 0,
    apt: 0,
    hired: 0,
    scheduled: 0,
    confirmed: 0,
    attended: 0,
    noShow: 0,
    estimatedIncompleteSpend: 0,
    unattributedSpend: 0
  };

  for (const metric of metrics) {
    for (const key of Object.keys(total)) total[key] += asNumber(metric[key]);
  }

  total.completionRate = total.candidatesCount
    ? Math.round((total.completedRegistrations / total.candidatesCount) * 100)
    : null;
  total.costPerCandidate = safeCost(total.spend, total.candidatesCount);
  total.costPerCompletedRegistration = safeCost(total.spend, total.completedRegistrations);
  total.costPerIncompleteRegistration = safeCost(total.spend, total.incompleteRegistrations);
  total.costPerCv = safeCost(total.spend, total.cvReceived);
  total.costPerApt = safeCost(total.spend, total.apt);
  total.costPerHired = safeCost(total.spend, total.hired);
  total.costPerLinkClick = safeCost(total.spend, total.inlineLinkClicks || total.clicks);
  return total;
}

export function campaignMetaStatus(campaign = {}) {
  const notes = String(campaign.notes || '');
  const match = notes.match(/estado_meta:\s*([A-Z_]+)/i);
  if (campaign.endsAt && campaign.createdByUsername === 'meta-ads-sync') return 'NO_DISPONIBLE';
  return match ? match[1].toUpperCase() : (campaign.isActive ? 'ACTIVE' : 'PAUSED');
}

export function missingVacancyCount(metrics = []) {
  return metrics.filter((metric) => !hasValue(metric.campaign?.vacancyId)).length;
}
