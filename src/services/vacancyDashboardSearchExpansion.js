import express from 'express';
import { prisma } from '../lib/prisma.js';
import { buildCandidateAccessWhere, getAccessContext } from './appUsers.js';
import { getCandidateResidenceValue } from './candidateData.js';
import {
  applyVacancyCandidateRegistrationPolicy,
  buildVacancyRegistrationCandidateWhere,
  normalizeVacancyRegistrationDateFilters
} from './vacancyCandidateRegistrationPolicy.js';

const RENDER_PATCH_FLAG = Symbol.for('lorren.completeVacancyCandidateSearch');
const VACANCY_LIST_FIELDS = [
  'registeredNoBooking',
  'registeredComplete',
  'completeWithoutCv',
  'approvedCandidates',
  'contractedCandidates'
];
const OUTBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizePhone(value) {
  const digits = normalizeDigits(value);
  return digits.startsWith('57') && digits.length > 10 ? digits.slice(2) : digits;
}

function timeValue(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function candidateHasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey)
    || Boolean(candidate.cvData)
    || hasValue(candidate.cvOriginalName)
    || hasValue(candidate.cvMimeType);
}

export function normalizeVacancyDashboardSearches(query = {}) {
  const searches = {};

  for (const [key, rawValue] of Object.entries(query || {})) {
    const match = /^vs_(.+)_(field|text)$/.exec(String(key));
    if (!match) continue;

    const [, vacancyId, property] = match;
    searches[vacancyId] ||= { field: 'document', text: '' };

    if (property === 'field') {
      searches[vacancyId].field = rawValue === 'phone' ? 'phone' : 'document';
    } else {
      searches[vacancyId].text = String(rawValue || '').trim();
    }
  }

  return searches;
}

export function candidateMatchesVacancyDashboardSearch(candidate = {}, search = {}) {
  const queryValue = search.field === 'phone'
    ? normalizePhone(search.text)
    : normalizeDigits(search.text);
  if (!queryValue) return false;

  const candidateValue = search.field === 'phone'
    ? normalizePhone(candidate.phone)
    : normalizeDigits(candidate.documentNumber);

  return Boolean(candidateValue) && candidateValue.includes(queryValue);
}

export function isCandidateVisibleForVacancySearch(candidate = {}, { isDev = false } = {}) {
  if (isDev) return true;

  return hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && candidate.age !== null
    && candidate.age !== undefined
    && hasValue(getCandidateResidenceValue(candidate, candidate.vacancy))
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode)
    && candidateHasCv(candidate);
}

function candidateHasUnreadInbound(candidate = {}) {
  const inboundTime = timeValue(candidate.lastInboundAt);
  if (!inboundTime) return false;
  const reviewedTime = Math.max(
    timeValue(candidate.devLastSeenAt),
    timeValue(candidate.lastOutboundAt)
  );
  return !reviewedTime || inboundTime > reviewedTime;
}

function decorateSearchCandidate(candidate = {}) {
  const lastInboundAt = timeValue(candidate.lastInboundAt);
  const isFemaleHumanReview = candidate.gender === 'FEMALE'
    && Boolean(candidate.botPaused)
    && /revision humana|revisión humana|candidata femenina/i.test(candidate.botPauseReason || '');

  return {
    ...candidate,
    hasCv: candidateHasCv(candidate),
    isFemaleCandidate: candidate.gender === 'FEMALE',
    isFemaleHumanReview,
    isManualAttention: Boolean(candidate.botPaused) && !isFemaleHumanReview,
    outboundWindowOpen: Boolean(lastInboundAt) && Date.now() - lastInboundAt <= OUTBOUND_WINDOW_MS,
    hasNewInbound: candidateHasUnreadInbound(candidate),
    lastMessageAt: Math.max(
      timeValue(candidate.lastInboundAt),
      timeValue(candidate.lastOutboundAt),
      timeValue(candidate.createdAt)
    ) || null,
    lastMessageDirection: timeValue(candidate.lastInboundAt) >= timeValue(candidate.lastOutboundAt)
      ? 'INBOUND'
      : 'OUTBOUND'
  };
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

function displayedCandidateIds(vacancy = {}) {
  const ids = new Set();
  for (const booking of vacancy.bookingsToday || []) {
    if (booking?.candidate?.id) ids.add(booking.candidate.id);
  }
  for (const field of VACANCY_LIST_FIELDS) {
    for (const candidate of vacancy[field] || []) {
      if (candidate?.id) ids.add(candidate.id);
    }
  }
  return ids;
}

function candidateMatchesAndIsVisible(candidate, search, options) {
  return candidateMatchesVacancyDashboardSearch(candidate, search)
    && isCandidateVisibleForVacancySearch(candidate, options);
}

function removeUnauthorizedMatches(vacancy, search, options) {
  if (options.isDev) return;

  for (const field of VACANCY_LIST_FIELDS) {
    vacancy[field] = (vacancy[field] || []).filter((candidate) => (
      !candidateMatchesVacancyDashboardSearch(candidate, search)
      || isCandidateVisibleForVacancySearch(candidate, options)
    ));
  }
  vacancy.bookingsToday = (vacancy.bookingsToday || []).filter((booking) => (
    !candidateMatchesVacancyDashboardSearch(booking?.candidate, search)
    || isCandidateVisibleForVacancySearch(booking?.candidate, options)
  ));
}

function resolveSearchResultTarget(vacancy = {}, candidate = {}) {
  if (candidate.status === 'CONTRATADO') return 'contractedCandidates';
  if (candidate.status === 'APROBADO') return 'approvedCandidates';
  if (vacancy.schedulingEnabled) return 'registeredNoBooking';
  if (vacancy.acceptingApplications || vacancy.dashboardReviewEnabled) return 'registeredComplete';
  return 'approvedCandidates';
}

export function mergeVacancySearchResults(viewModel = {}, searches = {}, candidates = [], options = {}) {
  const resultsByVacancyId = new Map();
  for (const candidate of candidates) {
    const search = searches[String(candidate.vacancyId)];
    if (!search || !candidateMatchesAndIsVisible(candidate, search, options)) continue;
    const current = resultsByVacancyId.get(String(candidate.vacancyId)) || [];
    current.push(decorateSearchCandidate(candidate));
    resultsByVacancyId.set(String(candidate.vacancyId), current);
  }

  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      const search = searches[String(vacancy.id)];
      if (!search?.text) continue;

      removeUnauthorizedMatches(vacancy, search, options);
      const alreadyDisplayed = displayedCandidateIds(vacancy);
      const searchResults = resultsByVacancyId.get(String(vacancy.id)) || [];

      for (const candidate of searchResults) {
        if (alreadyDisplayed.has(candidate.id)) continue;
        const targetField = resolveSearchResultTarget(vacancy, candidate);
        vacancy[targetField] = [candidate, ...(vacancy[targetField] || [])];
        alreadyDisplayed.add(candidate.id);
      }
      applyVacancyCandidateRegistrationPolicy(
        vacancy,
        options.registrationFiltersByVacancyId?.[String(vacancy.id)] || {}
      );
    }
  }

  return viewModel;
}

async function loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds, registrationFiltersByVacancyId = {}) {
  const activeVacancyIds = Object.entries(searches)
    .filter(([vacancyId, search]) => search?.text && visibleVacancyIds.has(String(vacancyId)))
    .map(([vacancyId]) => vacancyId);
  if (!activeVacancyIds.length) return [];

  const accessContext = getRequestAccessContext(req);
  return prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(accessContext),
        {
          OR: activeVacancyIds.map((vacancyId) => buildVacancyRegistrationCandidateWhere(
            vacancyId,
            registrationFiltersByVacancyId[String(vacancyId)] || {}
          ))
        }
      ]
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      vacancyId: true,
      fullName: true,
      phone: true,
      documentType: true,
      documentNumber: true,
      age: true,
      neighborhood: true,
      locality: true,
      zone: true,
      status: true,
      rejectionReason: true,
      rejectionDetails: true,
      medicalRestrictions: true,
      transportMode: true,
      interviewNotes: true,
      cvOriginalName: true,
      cvMimeType: true,
      cvStorageKey: true,
      gender: true,
      createdAt: true,
      botPaused: true,
      botPausedAt: true,
      botPauseReason: true,
      currentStep: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      devLastSeenAt: true,
      vacancy: {
        select: {
          id: true,
          title: true,
          role: true,
          city: true
        }
      }
    }
  });
}

export async function expandVacancySearchCandidates(viewModel = {}, query = {}, req = {}) {
  const searches = normalizeVacancyDashboardSearches(query);
  const registrationFiltersByVacancyId = normalizeVacancyRegistrationDateFilters(query);
  if (!Object.values(searches).some((search) => search?.text)) return viewModel;

  const visibleVacancyIds = new Set();
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) visibleVacancyIds.add(String(vacancy.id));
  }

  const accessContext = getRequestAccessContext(req);
  const candidates = await loadAuthorizedSearchCandidates(
    req,
    searches,
    visibleVacancyIds,
    registrationFiltersByVacancyId
  );
  return mergeVacancySearchResults(viewModel, searches, candidates, {
    isDev: accessContext.isDev,
    registrationFiltersByVacancyId
  });
}

export function installVacancyDashboardSearchExpansion() {
  if (express.response[RENDER_PATCH_FLAG]) return;

  const originalRender = express.response.render;
  express.response.render = function renderWithCompleteVacancySearch(view, options, callback) {
    const hasDashboardData = view === 'list'
      && options
      && typeof options === 'object'
      && Array.isArray(options.cities);
    const searches = hasDashboardData
      ? normalizeVacancyDashboardSearches(this.req?.query || {})
      : {};
    const hasActiveSearch = Object.values(searches).some((search) => search?.text);

    if (!hasDashboardData || !hasActiveSearch) {
      return originalRender.call(this, view, options, callback);
    }

    const response = this;
    expandVacancySearchCandidates(options, response.req?.query || {}, response.req)
      .then(() => originalRender.call(response, view, options, callback))
      .catch((error) => {
        console.error('[vacancy_dashboard_search]', error?.message || error);
        originalRender.call(response, view, options, callback);
      });

    return response;
  };
  express.response[RENDER_PATCH_FLAG] = true;
}

installVacancyDashboardSearchExpansion();
