import express from 'express';
import { prisma } from '../lib/prisma.js';
import { buildCandidateAccessWhere, getAccessContext } from './appUsers.js';
import { getCandidateResidenceValue } from './candidateData.js';

const RENDER_PATCH_FLAG = Symbol.for('lorren.completeVacancyCandidateSearch');
const VACANCY_LIST_FIELDS = [
  'registeredNoBooking',
  'registeredComplete',
  'completeWithoutCv',
  'approvedCandidates',
  'contractedCandidates'
];
const OUTBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECRUITER_VISIBLE_STATUSES = [
  'NUEVO',
  'REGISTRADO',
  'VALIDANDO',
  'APROBADO',
  'CONTACTADO',
  'CONTRATADO'
];
const VACANCY_CYCLE_AUDIT_ACTIONS = [
  'VACANCY_CREATED',
  'VACANCY_UPDATED',
  'VACANCY_FLOW_TOGGLED'
];
const RECRUITMENT_BULK_STATUSES = [
  'REGISTRADO',
  'APROBADO',
  'CONTACTADO',
  'RECHAZADO'
];
const COMPLETE_RANGE_LEGACY_SCOPES = new Set([
  'contacted',
  'contracted',
  'rejected',
  'all'
]);

export function historicalBulkCandidateStatuses(role = '') {
  return role === 'dev'
    ? ['NUEVO', ...RECRUITMENT_BULK_STATUSES]
    : [...RECRUITMENT_BULK_STATUSES];
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function vacancyIsOpen(value = {}) {
  return Boolean(value?.isActive && value?.acceptingApplications);
}

export function normalizeVacancyHistoryScopes(query = {}) {
  const vacancyIds = new Set();
  for (const [key, rawValue] of Object.entries(query || {})) {
    const match = /^vh_(.+)$/.exec(String(key));
    if (!match) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (String(value || '').trim().toLowerCase() === 'all') vacancyIds.add(match[1]);
  }
  return vacancyIds;
}

export function resolveVacancyApplicationCycleStartedAt(events = [], vacancyId = '') {
  const normalizedVacancyId = String(vacancyId || '');
  const orderedEvents = [...(events || [])]
    .filter((event) => String(event?.entityId || '') === normalizedVacancyId)
    .sort((a, b) => timeValue(b?.createdAt) - timeValue(a?.createdAt));

  for (const event of orderedEvents) {
    if (!vacancyIsOpen(event?.toValue)) continue;
    if (event?.action === 'VACANCY_CREATED' || !vacancyIsOpen(event?.fromValue)) {
      const startedAt = event?.createdAt instanceof Date
        ? event.createdAt
        : new Date(event?.createdAt);
      if (!Number.isNaN(startedAt.getTime())) return startedAt;
    }
  }
  return null;
}

function candidateHasCv(candidate = {}) {
  return Boolean(candidate.cvStorageKey)
    || Boolean(candidate.cvData)
    || hasValue(candidate.cvOriginalName)
    || hasValue(candidate.cvMimeType);
}

export function isOperationallyCompleteForRecruiter(candidate = {}, vacancy = candidate?.vacancy) {
  return hasValue(candidate.fullName)
    && hasValue(candidate.documentType)
    && hasValue(candidate.documentNumber)
    && candidate.age !== null
    && candidate.age !== undefined
    && hasValue(getCandidateResidenceValue(candidate, vacancy))
    && hasValue(candidate.medicalRestrictions)
    && hasValue(candidate.transportMode);
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

export function isCandidateVisibleForVacancySearch(candidate = {}, { isDev = false, vacancy = candidate?.vacancy } = {}) {
  return isDev || isOperationallyCompleteForRecruiter(candidate, vacancy);
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

export function compareCandidatesByRegisteredAtDesc(candidateA = {}, candidateB = {}) {
  const difference = timeValue(candidateB.createdAt) - timeValue(candidateA.createdAt);
  if (difference !== 0) return difference;
  return String(candidateA.id || '').localeCompare(String(candidateB.id || ''));
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

function vacancyListCandidateIds(vacancy = {}) {
  const ids = new Set();
  for (const field of VACANCY_LIST_FIELDS) {
    for (const candidate of vacancy[field] || []) {
      if (candidate?.id) ids.add(candidate.id);
    }
  }
  return ids;
}

function resolveSearchResultTarget(vacancy = {}, candidate = {}) {
  if (!candidateHasCv(candidate)) return 'completeWithoutCv';
  if (candidate.status === 'CONTRATADO') return 'contractedCandidates';
  if (candidate.status === 'APROBADO') return 'approvedCandidates';
  if (vacancy.schedulingEnabled) return 'registeredNoBooking';
  return 'registeredComplete';
}

function sanitizeVacancyForRecruiter(vacancy = {}, options = {}) {
  if (options.isDev) return vacancy;

  const pendingWithoutCv = new Map();
  const candidatesWithCvByField = new Map();

  for (const field of VACANCY_LIST_FIELDS) {
    candidatesWithCvByField.set(field, []);
    for (const candidate of vacancy[field] || []) {
      if (!isOperationallyCompleteForRecruiter(candidate, vacancy)) continue;
      if (!candidateHasCv(candidate)) {
        pendingWithoutCv.set(candidate.id, candidate);
        continue;
      }

      const targetField = resolveSearchResultTarget(vacancy, candidate);
      const targetCandidates = candidatesWithCvByField.get(targetField) || [];
      if (!targetCandidates.some((current) => current.id === candidate.id)) {
        targetCandidates.push(candidate);
      }
      candidatesWithCvByField.set(targetField, targetCandidates);
    }
  }

  for (const field of VACANCY_LIST_FIELDS) {
    vacancy[field] = field === 'completeWithoutCv'
      ? Array.from(pendingWithoutCv.values())
      : candidatesWithCvByField.get(field) || [];
  }

  vacancy.bookingsToday = (vacancy.bookingsToday || []).filter((booking) => (
    isOperationallyCompleteForRecruiter(booking?.candidate, vacancy)
  ));
  return vacancy;
}

function sortVacancyCandidates(vacancy = {}, options = {}) {
  if (options.isDev) return vacancy;
  for (const field of VACANCY_LIST_FIELDS) {
    vacancy[field] = [...(vacancy[field] || [])].sort(compareCandidatesByRegisteredAtDesc);
  }
  return vacancy;
}

export function sanitizeVacancyDashboardVisibility(viewModel = {}, options = {}) {
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      sanitizeVacancyForRecruiter(vacancy, options);
      sortVacancyCandidates(vacancy, options);
    }
  }
  return viewModel;
}

export function mergeVacancySearchResults(viewModel = {}, searches = {}, candidates = [], options = {}) {
  const resultsByVacancyId = new Map();
  for (const candidate of candidates) {
    const search = searches[String(candidate.vacancyId)];
    const vacancy = candidate.vacancy || null;
    if (!search || !candidateMatchesVacancyDashboardSearch(candidate, search)) continue;
    if (!isCandidateVisibleForVacancySearch(candidate, { ...options, vacancy })) continue;
    const current = resultsByVacancyId.get(String(candidate.vacancyId)) || [];
    current.push(decorateSearchCandidate(candidate));
    resultsByVacancyId.set(String(candidate.vacancyId), current);
  }

  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      sanitizeVacancyForRecruiter(vacancy, options);
      const search = searches[String(vacancy.id)];
      if (!search?.text) {
        sortVacancyCandidates(vacancy, options);
        continue;
      }

      const alreadyDisplayed = displayedCandidateIds(vacancy);
      const searchResults = resultsByVacancyId.get(String(vacancy.id)) || [];

      for (const candidate of searchResults) {
        if (alreadyDisplayed.has(candidate.id)) continue;
        const targetField = resolveSearchResultTarget(vacancy, candidate);
        vacancy[targetField] = [...(vacancy[targetField] || []), candidate];
        alreadyDisplayed.add(candidate.id);
      }
      sortVacancyCandidates(vacancy, options);
    }
  }

  return viewModel;
}

export function scopeVacancyToApplicationCycle(vacancy = {}, cycleStartedAt = null, options = {}) {
  const historicalCandidateCount = vacancyListCandidateIds(vacancy).size;
  const cycleStartTime = timeValue(cycleStartedAt);
  const showHistory = Boolean(options.showHistory);

  if (cycleStartTime && !showHistory) {
    for (const field of VACANCY_LIST_FIELDS) {
      vacancy[field] = (vacancy[field] || []).filter((candidate) => (
        timeValue(candidate?.createdAt) >= cycleStartTime
      ));
    }
  }

  return {
    cycleStartedAt: cycleStartTime ? new Date(cycleStartTime).toISOString() : null,
    showHistory,
    historicalCandidateCount,
    visibleCandidateCount: vacancyListCandidateIds(vacancy).size
  };
}

async function loadVacancyCycleEvents(vacancyIds = []) {
  if (!vacancyIds.length || typeof prisma?.devAuditEvent?.findMany !== 'function') return [];
  return prisma.devAuditEvent.findMany({
    where: {
      entityType: 'VACANCY',
      entityId: { in: vacancyIds },
      action: { in: VACANCY_CYCLE_AUDIT_ACTIONS }
    },
    orderBy: { createdAt: 'desc' },
    select: {
      entityId: true,
      action: true,
      fromValue: true,
      toValue: true,
      createdAt: true
    }
  });
}

export async function applyVacancyApplicationCycleScope(viewModel = {}, query = {}) {
  const vacancies = [];
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      vacancies.push({ vacancy, cityName: city.name || vacancy.city || '' });
    }
  }

  const vacancyIds = vacancies.map(({ vacancy }) => String(vacancy.id || '')).filter(Boolean);
  const cycleEvents = await loadVacancyCycleEvents(vacancyIds);
  const historyScopes = normalizeVacancyHistoryScopes(query);
  const cycleMetadata = {};

  for (const { vacancy, cityName } of vacancies) {
    const vacancyId = String(vacancy.id || '');
    const cycleStartedAt = resolveVacancyApplicationCycleStartedAt(cycleEvents, vacancyId);
    const showHistory = historyScopes.has(vacancyId);
    const scoped = scopeVacancyToApplicationCycle(vacancy, cycleStartedAt, { showHistory });
    cycleMetadata[vacancyId] = {
      vacancyId,
      cityName,
      ...scoped
    };
  }

  viewModel.vacancyApplicationCycles = cycleMetadata;
  return viewModel;
}

function applicantCreatedAtWhere(dateRange = {}) {
  if (!dateRange.isActive) return null;
  const createdAt = {};
  if (dateRange.start) createdAt.gte = dateRange.start;
  if (dateRange.end) createdAt.lte = dateRange.end;
  return Object.keys(createdAt).length ? createdAt : null;
}

function hasCompleteApplicantDateRange(dateRange = {}) {
  return Boolean(dateRange.dateFrom && dateRange.dateTo && dateRange.isActive && !dateRange.error);
}

function candidateMatchesCompleteLegacyScope(candidate = {}, scope = '', options = {}) {
  const status = String(candidate.status || '').trim().toUpperCase();
  if (options.approvedOnly) return status === 'APROBADO';
  if (scope === 'contacted') return status === 'CONTACTADO';
  if (scope === 'contracted') return status === 'CONTRATADO';
  if (scope === 'rejected') return status === 'RECHAZADO';
  if (scope === 'all') return options.isDev || status !== 'NUEVO';
  return true;
}

async function loadCompleteLegacyDateRangeCandidates(req, query, dateRange, vacancyId) {
  const scope = normalizeString(query.status);
  if (!vacancyId || !hasCompleteApplicantDateRange(dateRange) || !COMPLETE_RANGE_LEGACY_SCOPES.has(scope)) {
    return null;
  }

  const accessContext = getRequestAccessContext(req);
  const createdAt = applicantCreatedAtWhere(dateRange);
  const candidates = await prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(accessContext),
        { vacancyId },
        ...(createdAt ? [{ createdAt }] : [])
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

  const approvedOnly = String(query.approvedOnly || '') === '1';
  return candidates
    .filter((candidate) => candidateMatchesCompleteLegacyScope(candidate, scope, {
      approvedOnly,
      isDev: accessContext.isDev
    }))
    .map(decorateSearchCandidate);
}

export function applyApplicantDateRangeToVacancyLists(viewModel = {}, dateRange = {}) {
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      for (const field of VACANCY_LIST_FIELDS) {
        vacancy[field] = (vacancy[field] || []).filter((candidate) => (
          candidateMatchesApplicantDateRange(candidate, dateRange)
        ));
      }
      const metadata = viewModel.vacancyApplicationCycles?.[String(vacancy.id || '')];
      if (metadata) metadata.visibleCandidateCount = vacancyListCandidateIds(vacancy).size;
    }
  }
  return viewModel;
}

async function loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds, dateRange = {}) {
  const activeVacancyIds = Object.entries(searches)
    .filter(([vacancyId, search]) => search?.text && visibleVacancyIds.has(String(vacancyId)))
    .map(([vacancyId]) => vacancyId);
  if (!activeVacancyIds.length) return [];

  const accessContext = getRequestAccessContext(req);
  const createdAt = applicantCreatedAtWhere(dateRange);
  return prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(accessContext),
        { vacancyId: { in: activeVacancyIds } },
        { status: { in: RECRUITER_VISIBLE_STATUSES } },
        ...(createdAt ? [{ createdAt }] : [])
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
  const dateRange = normalizeApplicantDateRange(query);
  const visibleVacancyIds = new Set();
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) visibleVacancyIds.add(String(vacancy.id));
  }

  viewModel.applicantDateRange = dateRange;
  if (dateRange.error && !viewModel.errorMsg) viewModel.errorMsg = dateRange.error;

  const accessContext = getRequestAccessContext(req);
  sanitizeVacancyDashboardVisibility(viewModel, { isDev: accessContext.isDev });

  if (Object.values(searches).some((search) => search?.text)) {
    const candidates = await loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds, dateRange);
    mergeVacancySearchResults(viewModel, searches, candidates, { isDev: accessContext.isDev });
  }

  await applyVacancyApplicationCycleScope(viewModel, query);
  applyApplicantDateRangeToVacancyLists(viewModel, dateRange);
  return viewModel;
}

function isValidDateString(value) {
  const text = normalizeString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function colombiaDayBounds(dateValue) {
  const [year, month, day] = dateValue.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0)),
    end: new Date(Date.UTC(year, month - 1, day + 1, 4, 59, 59, 999))
  };
}

export function normalizeApplicantDateRange(query = {}) {
  const dateFrom = isValidDateString(query.dateFrom) ? query.dateFrom : '';
  const dateTo = isValidDateString(query.dateTo) ? query.dateTo : '';

  if (dateFrom && dateTo && dateFrom > dateTo) {
    return {
      dateFrom,
      dateTo,
      start: null,
      end: null,
      isActive: false,
      error: 'La fecha inicial no puede ser posterior a la fecha final.'
    };
  }

  return {
    dateFrom,
    dateTo,
    start: dateFrom ? colombiaDayBounds(dateFrom).start : null,
    end: dateTo ? colombiaDayBounds(dateTo).end : null,
    isActive: Boolean(dateFrom || dateTo),
    error: null
  };
}

export function candidateMatchesApplicantDateRange(candidate = {}, dateRange = {}) {
  if (!dateRange.isActive) return true;
  const registeredAt = timeValue(candidate.createdAt);
  if (!registeredAt) return false;
  if (dateRange.start && registeredAt < dateRange.start.getTime()) return false;
  if (dateRange.end && registeredAt > dateRange.end.getTime()) return false;
  return true;
}

async function candidateIdsForVacancy(candidates = [], vacancyId = '') {
  const candidateIds = candidates.map((candidate) => candidate?.id).filter(Boolean);
  if (!vacancyId || !candidateIds.length) return new Set(candidateIds);

  const matches = await prisma.candidate.findMany({
    where: {
      id: { in: candidateIds },
      vacancyId
    },
    select: { id: true }
  });
  return new Set(matches.map((candidate) => candidate.id));
}

export async function enhanceLegacyApplicantList(viewModel = {}, query = {}, req = {}) {
  let candidates = Array.isArray(viewModel.candidates) ? [...viewModel.candidates] : [];
  const accessContext = getRequestAccessContext(req);
  const dateRange = normalizeApplicantDateRange(query);
  const vacancyId = normalizeString(query.vacancyId);
  const completeRangeCandidates = await loadCompleteLegacyDateRangeCandidates(
    req,
    query,
    dateRange,
    vacancyId
  );
  if (completeRangeCandidates) candidates = completeRangeCandidates;

  let visibleCandidates = accessContext.isDev
    ? candidates
    : candidates.filter((candidate) => isOperationallyCompleteForRecruiter(candidate, candidate.vacancy));

  if (vacancyId) {
    const matchingIds = await candidateIdsForVacancy(visibleCandidates, vacancyId);
    visibleCandidates = visibleCandidates.filter((candidate) => matchingIds.has(candidate.id));
  }

  visibleCandidates = visibleCandidates
    .filter((candidate) => candidateMatchesApplicantDateRange(candidate, dateRange));

  const keepInboxActivityOrder = accessContext.isDev && normalizeString(query.status) === 'inbox';
  if (!keepInboxActivityOrder) visibleCandidates.sort(compareCandidatesByRegisteredAtDesc);

  viewModel.candidates = visibleCandidates;
  viewModel.applicantDateRange = dateRange;
  viewModel.applicantVacancyId = vacancyId;
  if (dateRange.error && !viewModel.errorMsg) viewModel.errorMsg = dateRange.error;
  return viewModel;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isPreservableQueryKey(key) {
  return /^vh_.+/.test(key) || [
    'status',
    'vacancyId',
    'searchField',
    'searchText',
    'neighborhood',
    'locality',
    'transportMode'
  ].includes(key);
}

function preservedQueryParams(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (!isPreservableQueryKey(key)) continue;
    const normalized = normalizeString(Array.isArray(value) ? value[0] : value);
    if (normalized) params.set(key, normalized);
  }
  return params;
}

function hiddenInputsFromParams(params) {
  return Array.from(params.entries())
    .map(([key, value]) => `      <input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join('\n');
}

function buildApplicantDateFilterForm(req, dateRange) {
  const preservedParams = preservedQueryParams(req?.query || {});
  const clearHref = preservedParams.toString()
    ? `/admin?${preservedParams.toString()}`
    : '/admin';
  const hiddenInputs = hiddenInputsFromParams(preservedParams);
  const note = dateRange.isActive
    ? 'Rango aplicado. Los resultados siguen ordenados del más reciente al más antiguo.'
    : 'Ordenados del registro más reciente al más antiguo.';

  return `
  <section class="applicant-date-range" aria-label="Filtrar postulados por fecha de registro" style="margin-bottom:16px;">
    <form method="get" action="/admin" class="filter-strip" style="width:100%;">
${hiddenInputs}
      <div class="filter-field">
        <label for="applicantDateFrom">Postulados desde</label>
        <input id="applicantDateFrom" type="date" name="dateFrom" value="${escapeHtml(dateRange.dateFrom)}" />
      </div>
      <div class="filter-field">
        <label for="applicantDateTo">Postulados hasta</label>
        <input id="applicantDateTo" type="date" name="dateTo" value="${escapeHtml(dateRange.dateTo)}" />
      </div>
      <button type="submit" class="export-btn" style="cursor:pointer;">Filtrar fechas</button>
      <a href="${escapeHtml(clearHref)}" class="export-btn" data-clear-applicant-dates>Quitar fechas</a>
      <span class="filter-note">${escapeHtml(note)}</span>
    </form>
  </section>`;
}

function buildApplicantLinkScript(dateRange) {
  const serializedRange = JSON.stringify({
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo
  }).replaceAll('<', '\\u003c');

  return `
<script>
  (function () {
    const applicantDateRange = ${serializedRange};

    function applyDateRange(url) {
      if (applicantDateRange.dateFrom) url.searchParams.set('dateFrom', applicantDateRange.dateFrom);
      else url.searchParams.delete('dateFrom');
      if (applicantDateRange.dateTo) url.searchParams.set('dateTo', applicantDateRange.dateTo);
      else url.searchParams.delete('dateTo');
    }

    function relativeHref(url) {
      const query = url.searchParams.toString();
      return url.pathname + (query ? '?' + query : '') + (url.hash || '');
    }

    function ensureHiddenInput(form, name, value) {
      const existing = form.querySelector('input[name="' + name + '"]');
      if (!value) {
        if (existing && existing.type === 'hidden') existing.remove();
        return;
      }
      if (existing) {
        existing.value = value;
        return;
      }
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }

    document.querySelectorAll('[data-vacancy-panel]').forEach((panel) => {
      const vacancyId = panel.getAttribute('data-vacancy-panel');
      if (!vacancyId) return;

      panel.querySelectorAll('a[href]').forEach((anchor) => {
        const text = String(anchor.textContent || '').trim().toLowerCase();
        if (!text.includes('ver todos')) return;
        const url = new URL(anchor.getAttribute('href'), window.location.origin);
        const scope = url.searchParams.get('status') || url.searchParams.get('scope') || '';
        if (scope !== 'registered' && scope !== 'missing_cv_complete') return;
        url.pathname = '/admin';
        url.search = '';
        url.searchParams.set('status', scope);
        url.searchParams.set('vacancyId', vacancyId);
        applyDateRange(url);
        anchor.setAttribute('href', relativeHref(url));
      });
    });

    const pageParams = new URLSearchParams(window.location.search);
    const activeVacancyId = pageParams.get('vacancyId');
    document.querySelectorAll('form[method="get"], form[method="GET"]').forEach((form) => {
      if (form.closest('.applicant-date-range')) return;
      const action = new URL(form.getAttribute('action') || window.location.href, window.location.origin);
      if (action.pathname !== '/admin') return;
      ensureHiddenInput(form, 'vacancyId', activeVacancyId);
      ensureHiddenInput(form, 'dateFrom', applicantDateRange.dateFrom);
      ensureHiddenInput(form, 'dateTo', applicantDateRange.dateTo);
    });

    document.querySelectorAll('a[href]').forEach((anchor) => {
      if (anchor.hasAttribute('data-clear-applicant-dates')) return;
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      if (url.pathname !== '/admin' && url.pathname !== '/admin/export') return;
      if (activeVacancyId && !url.searchParams.has('vacancyId')) {
        url.searchParams.set('vacancyId', activeVacancyId);
      }
      applyDateRange(url);
      anchor.setAttribute('href', relativeHref(url));
    });

    document.addEventListener('candidate-date-range-change', (event) => {
      const controls = event.target;
      if (!controls || typeof controls.closest !== 'function') return;
      const bar = controls.closest('.export-bar');
      if (!bar || bar.dataset.globalCandidateExport === 'true') return;
      const nextFrom = String(event.detail?.dateFrom || '');
      const nextTo = String(event.detail?.dateTo || '');
      const completeRange = (!nextFrom && !nextTo) || (nextFrom && nextTo);
      if (!completeRange) return;

      const target = new URL(window.location.href);
      if (nextFrom) target.searchParams.set('dateFrom', nextFrom);
      else target.searchParams.delete('dateFrom');
      if (nextTo) target.searchParams.set('dateTo', nextTo);
      else target.searchParams.delete('dateTo');
      window.location.assign(relativeHref(target));
    });

    const activeStatus = pageParams.get('status');
    if (activeStatus && activeStatus !== 'inbox') {
      const table = document.querySelector('#legacy-candidates-table');
      const firstHeader = table?.querySelector('thead th');
      if (firstHeader) firstHeader.textContent = 'Fecha de registro';
    }
  })();
</script>`;
}

export function buildVacancyApplicationCycleScript(cycleMetadata = {}, role = '') {
  const serializedCycles = JSON.stringify(cycleMetadata || {}).replaceAll('<', '\\u003c');
  const serializedBulkStatuses = JSON.stringify(historicalBulkCandidateStatuses(role)).replaceAll('<', '\\u003c');

  return `
<script>
  (function () {
    const cycles = ${serializedCycles};
    const bulkStatuses = ${serializedBulkStatuses};
    const entries = Object.values(cycles || {});
    if (!entries.length) return;

    const bulkStatusLabels = {
      NUEVO: 'Nuevo',
      REGISTRADO: 'Registrado',
      APROBADO: 'Aprobado',
      CONTACTADO: 'Contactado',
      RECHAZADO: 'Rechazado'
    };

    function relativeHref(url) {
      const query = url.searchParams.toString();
      return url.pathname + (query ? '?' + query : '') + (url.hash || '');
    }

    function ensureHiddenInput(form, name, value) {
      let input = form.querySelector('input[name="' + name + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        form.appendChild(input);
      }
      input.value = value;
    }

    function formattedCycleDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).format(date);
    }

    function updateCount(container, value) {
      if (!container) return;
      let count = container.querySelector('.count');
      if (!count) {
        count = document.createElement('span');
        count.className = 'count';
        container.appendChild(count);
      }
      count.textContent = String(value);
      count.hidden = false;
    }

    function candidateIdFromDetailLink(anchor) {
      if (!anchor) return '';
      const url = new URL(anchor.getAttribute('href') || '', window.location.origin);
      const prefix = '/admin/candidates/';
      if (!url.pathname.startsWith(prefix)) return '';
      const encodedCandidateId = url.pathname.slice(prefix.length);
      if (!encodedCandidateId || encodedCandidateId.includes('/')) return '';
      return decodeURIComponent(encodedCandidateId);
    }

    function buildCandidateCheckbox(candidateId) {
      const label = document.createElement('label');
      label.setAttribute('data-history-bulk-checkbox', candidateId);
      label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:0 8px 5px 0;font-size:11px;font-weight:700;color:var(--text-muted);cursor:pointer;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = candidateId;
      checkbox.setAttribute('data-history-candidate-id', candidateId);
      checkbox.setAttribute('aria-label', 'Seleccionar candidato para cambio de estado');

      const text = document.createElement('span');
      text.textContent = 'Seleccionar';
      label.append(checkbox, text);
      return label;
    }

    function attachHistoricalBulkControls(meta, panel, cycleBar) {
      if (!meta.showHistory || !meta.cycleStartedAt || !panel || !cycleBar || !bulkStatuses.length) return;
      if (panel.querySelector('[data-vacancy-bulk-status="' + meta.vacancyId + '"]')) return;

      const candidateIds = new Set();
      panel.querySelectorAll('a.link-detail[href]').forEach((anchor) => {
        const candidateId = candidateIdFromDetailLink(anchor);
        if (!candidateId || candidateIds.has(candidateId)) return;
        const row = anchor.closest('.candidate-row, tr');
        if (!row || row.querySelector('.badge-contratado')) return;

        const mount = row.classList.contains('candidate-row')
          ? row.firstElementChild
          : (row.querySelector('td:nth-child(2)') || row.querySelector('td'));
        if (!mount) return;

        candidateIds.add(candidateId);
        mount.prepend(buildCandidateCheckbox(candidateId));
      });

      if (!candidateIds.size) return;

      const toolbar = document.createElement('form');
      toolbar.setAttribute('data-vacancy-bulk-status', meta.vacancyId);
      toolbar.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--border-soft);background:#f8fafc;';

      const selectAllLabel = document.createElement('label');
      selectAllLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--navy);cursor:pointer;';
      const selectAll = document.createElement('input');
      selectAll.type = 'checkbox';
      selectAll.setAttribute('data-history-select-all', meta.vacancyId);
      const selectAllText = document.createElement('span');
      selectAllText.textContent = 'Seleccionar visibles';
      selectAllLabel.append(selectAll, selectAllText);

      const selectedCount = document.createElement('span');
      selectedCount.className = 'filter-note';
      selectedCount.setAttribute('data-history-selected-count', meta.vacancyId);
      selectedCount.textContent = '0 seleccionados';

      const statusSelect = document.createElement('select');
      statusSelect.setAttribute('aria-label', 'Nuevo estado para seleccionados');
      statusSelect.style.cssText = 'min-height:34px;border:1px solid var(--border);border-radius:6px;padding:5px 9px;background:var(--surface);color:var(--navy);';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Cambiar estado a...';
      statusSelect.appendChild(placeholder);
      bulkStatuses.forEach((status) => {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = bulkStatusLabels[status] || status;
        statusSelect.appendChild(option);
      });

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'export-btn';
      submit.style.cursor = 'pointer';
      submit.disabled = true;
      submit.textContent = 'Aplicar a seleccionados';

      const feedback = document.createElement('span');
      feedback.className = 'filter-note';
      feedback.setAttribute('data-history-bulk-feedback', meta.vacancyId);
      feedback.textContent = 'Contratados se gestionan individualmente.';

      toolbar.append(selectAllLabel, selectedCount, statusSelect, submit, feedback);
      cycleBar.insertAdjacentElement('afterend', toolbar);

      const candidateCheckboxes = () => Array.from(panel.querySelectorAll('input[data-history-candidate-id]'));
      const syncControls = () => {
        const checkboxes = candidateCheckboxes();
        const selected = checkboxes.filter((checkbox) => checkbox.checked);
        selectedCount.textContent = selected.length + ' seleccionado' + (selected.length === 1 ? '' : 's');
        selectAll.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
        selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;
        submit.disabled = selected.length === 0 || !statusSelect.value;
      };

      candidateCheckboxes().forEach((checkbox) => checkbox.addEventListener('change', syncControls));
      statusSelect.addEventListener('change', syncControls);
      selectAll.addEventListener('change', () => {
        candidateCheckboxes().forEach((checkbox) => { checkbox.checked = selectAll.checked; });
        syncControls();
      });

      toolbar.addEventListener('submit', async (event) => {
        event.preventDefault();
        const selectedIds = candidateCheckboxes()
          .filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.value);
        const status = statusSelect.value;
        if (!selectedIds.length || !bulkStatuses.includes(status)) return;

        submit.disabled = true;
        selectAll.disabled = true;
        statusSelect.disabled = true;
        candidateCheckboxes().forEach((checkbox) => { checkbox.disabled = true; });
        let completed = 0;
        const returnTo = pageUrl.pathname + pageUrl.search;

        try {
          for (const candidateId of selectedIds) {
            feedback.textContent = 'Actualizando ' + (completed + 1) + ' de ' + selectedIds.length + '...';
            const body = new URLSearchParams();
            body.set('status', status);
            body.set('returnTo', returnTo);
            const response = await fetch('/admin/candidates/' + encodeURIComponent(candidateId) + '/status', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
              body: body.toString()
            });
            const finalUrl = new URL(response.url || window.location.href, window.location.origin);
            const detailPrefix = '/admin/candidates/';
            const finalCandidateId = finalUrl.pathname.startsWith(detailPrefix)
              ? finalUrl.pathname.slice(detailPrefix.length)
              : '';
            if (!response.ok || !finalCandidateId || finalCandidateId.includes('/')) {
              throw new Error('bulk_status_request_failed');
            }
            completed += 1;
          }

          const target = new URL(window.location.href);
          target.searchParams.delete('error');
          target.searchParams.set('success', completed + ' registro' + (completed === 1 ? '' : 's') + ' actualizado' + (completed === 1 ? '' : 's') + ' a ' + (bulkStatusLabels[status] || status) + '.');
          target.hash = 'vacancy-' + meta.vacancyId;
          window.location.assign(relativeHref(target));
        } catch (_error) {
          const target = new URL(window.location.href);
          target.searchParams.delete('success');
          target.searchParams.set('error', completed
            ? 'Se actualizaron ' + completed + ' de ' + selectedIds.length + ' registros. Revisa el listado antes de reintentar.'
            : 'No fue posible aplicar el cambio masivo. Ningún registro fue confirmado como actualizado.');
          target.hash = 'vacancy-' + meta.vacancyId;
          window.location.assign(relativeHref(target));
        }
      });

      syncControls();
    }

    const pageUrl = new URL(window.location.href);
    const activeHistory = entries.filter((meta) => meta.showHistory && meta.cycleStartedAt);

    entries.forEach((meta) => {
      if (!meta || !meta.vacancyId) return;
      const panel = document.getElementById('vacancy-' + meta.vacancyId);
      let cycleBar = panel?.querySelector('[data-vacancy-cycle-scope]') || null;
      if (panel && meta.cycleStartedAt) {
        if (!cycleBar) {
          const bar = document.createElement('div');
          bar.setAttribute('data-vacancy-cycle-scope', meta.vacancyId);
          bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--border-soft);background:var(--surface);';

          const note = document.createElement('span');
          note.className = 'filter-note';
          note.textContent = meta.showHistory
            ? 'Histórico visible: ' + meta.visibleCandidateCount + ' registro(s).'
            : 'Ciclo actual: ' + meta.visibleCandidateCount + ' postulación(es) desde ' + formattedCycleDate(meta.cycleStartedAt) + '.';

          const link = document.createElement('a');
          link.className = 'export-btn';
          link.setAttribute('data-vacancy-cycle-toggle', meta.vacancyId);
          const target = new URL(window.location.href);
          if (meta.showHistory) target.searchParams.delete('vh_' + meta.vacancyId);
          else target.searchParams.set('vh_' + meta.vacancyId, 'all');
          target.hash = 'vacancy-' + meta.vacancyId;
          link.href = relativeHref(target);
          link.textContent = meta.showHistory ? 'Ver ciclo actual' : 'Ver todos los registros';

          bar.append(note, link);
          const header = panel.querySelector('.vacancy-header');
          if (header) header.insertAdjacentElement('afterend', bar);
          else panel.prepend(bar);
          cycleBar = bar;
        }
        attachHistoricalBulkControls(meta, panel, cycleBar);
      }

      const tab = Array.from(document.querySelectorAll('[data-vacancy-tab]'))
        .find((candidate) => candidate.dataset.vacancyTab === meta.vacancyId);
      updateCount(tab, meta.visibleCandidateCount);
    });

    document.querySelectorAll('.city-tab[href]').forEach((anchor) => {
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      const cityName = url.searchParams.get('city');
      if (!cityName) return;
      const total = entries
        .filter((meta) => meta.cityName === cityName)
        .reduce((sum, meta) => sum + Number(meta.visibleCandidateCount || 0), 0);
      updateCount(anchor, total);
    });

    if (!activeHistory.length) return;

    document.querySelectorAll('form[method="get"], form[method="GET"]').forEach((form) => {
      const action = new URL(form.getAttribute('action') || window.location.href, window.location.origin);
      if (action.pathname !== '/admin') return;
      activeHistory.forEach((meta) => ensureHiddenInput(form, 'vh_' + meta.vacancyId, 'all'));
    });

    document.querySelectorAll('a[href]').forEach((anchor) => {
      if (anchor.hasAttribute('data-vacancy-cycle-toggle')) return;
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      if (url.pathname !== '/admin') return;
      activeHistory.forEach((meta) => {
        if (!url.searchParams.has('vh_' + meta.vacancyId)) {
          url.searchParams.set('vh_' + meta.vacancyId, 'all');
        }
      });
      anchor.setAttribute('href', relativeHref(url));
    });
  })();
</script>`;
}

export function injectAdminApplicantControls(html, req, viewModel = {}) {
  if (typeof html !== 'string') return html;
  const dateRange = viewModel.applicantDateRange || normalizeApplicantDateRange(req?.query || {});
  let output = html;

  if (viewModel.mode === 'legacy' || normalizeString(req?.query?.status)) {
    const pageMarker = '<div class="page">';
    const pageIndex = output.indexOf(pageMarker);
    if (pageIndex >= 0) {
      const insertionIndex = pageIndex + pageMarker.length;
      const form = buildApplicantDateFilterForm(req, dateRange);
      output = `${output.slice(0, insertionIndex)}\n${form}${output.slice(insertionIndex)}`;
    }
  }

  const applicantScript = buildApplicantLinkScript(dateRange);
  const cycleScript = buildVacancyApplicationCycleScript(viewModel.vacancyApplicationCycles || {}, viewModel.role || '');
  const scripts = `${applicantScript}\n${cycleScript}`;
  return output.includes('</body>')
    ? output.replace('</body>', `${scripts}\n</body>`)
    : `${output}${scripts}`;
}

async function enhanceAdminListView(viewModel = {}, query = {}, req = {}) {
  const mode = viewModel.mode;
  if (mode === 'legacy' || (!mode && Array.isArray(viewModel.candidates))) {
    return enhanceLegacyApplicantList(viewModel, query, req);
  }
  if (Array.isArray(viewModel.cities)) {
    return expandVacancySearchCandidates(viewModel, query, req);
  }
  return viewModel;
}

export function installVacancyDashboardSearchExpansion() {
  if (express.response[RENDER_PATCH_FLAG]) return;

  const originalRender = express.response.render;
  express.response.render = function renderWithAdminApplicantEnhancements(view, options, callback) {
    const isAdminList = view === 'list' && options && typeof options === 'object';
    if (!isAdminList) return originalRender.call(this, view, options, callback);

    const response = this;
    const query = response.req?.query || {};
    enhanceAdminListView(options, query, response.req)
      .then((resolvedOptions) => {
        originalRender.call(response, view, resolvedOptions, (error, html) => {
          if (error) {
            if (typeof callback === 'function') return callback(error);
            return response.status(500).send('No fue posible mostrar el listado de candidatos.');
          }
          const output = injectAdminApplicantControls(html, response.req, resolvedOptions);
          if (typeof callback === 'function') return callback(null, output);
          return response.send(output);
        });
      })
      .catch((error) => {
        console.error('[ADMIN_APPLICANT_LIST_ENHANCEMENT_ERROR]', {
          message: error?.message || String(error),
          stack: error?.stack || null,
          path: response.req?.originalUrl || response.req?.url || null
        });
        originalRender.call(response, view, options, callback);
      });

    return response;
  };
  express.response[RENDER_PATCH_FLAG] = true;
}

installVacancyDashboardSearchExpansion();