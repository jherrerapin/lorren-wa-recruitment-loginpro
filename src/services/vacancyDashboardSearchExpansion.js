import express from 'express';

const RENDER_PATCH_FLAG = Symbol.for('lorren.vacancyDashboardSearchExpansion');
const VACANCY_LIST_FIELDS = [
  'registeredNoBooking',
  'registeredComplete',
  'completeWithoutCv',
  'approvedCandidates',
  'contractedCandidates'
];

function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizePhone(value) {
  const digits = normalizeDigits(value);
  return digits.startsWith('57') && digits.length > 10 ? digits.slice(2) : digits;
}

function normalizeSearchField(value) {
  return value === 'phone' ? 'phone' : 'document';
}

export function normalizeVacancyDashboardSearches(query = {}) {
  const searches = {};

  for (const [key, rawValue] of Object.entries(query || {})) {
    const match = /^vs_(.+)_(field|text)$/.exec(String(key));
    if (!match) continue;

    const [, vacancyId, property] = match;
    searches[vacancyId] ||= { field: 'document', text: '' };

    if (property === 'field') {
      searches[vacancyId].field = normalizeSearchField(rawValue);
    } else {
      searches[vacancyId].text = String(rawValue || '').trim();
    }
  }

  return searches;
}

export function candidateMatchesVacancyDashboardSearch(candidate = {}, search = {}) {
  const query = search.field === 'phone'
    ? normalizePhone(search.text)
    : normalizeDigits(search.text);
  if (!query) return false;

  const candidateValue = search.field === 'phone'
    ? normalizePhone(candidate.phone)
    : normalizeDigits(candidate.documentNumber);

  return Boolean(candidateValue) && candidateValue.includes(query);
}

function candidateHasCv(candidate = {}) {
  if (typeof candidate.hasCv === 'boolean') return candidate.hasCv;
  return Boolean(candidate.cvStorageKey)
    || Boolean(candidate.cvData)
    || Boolean(String(candidate.cvOriginalName || '').trim())
    || Boolean(String(candidate.cvMimeType || '').trim());
}

function decorateSearchCandidate(candidate = {}) {
  const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
  const outboundWindowOpen = lastInboundAt instanceof Date
    && !Number.isNaN(lastInboundAt.getTime())
    && Date.now() - lastInboundAt.getTime() <= 24 * 60 * 60 * 1000;
  const isFemaleHumanReview = candidate.gender === 'FEMALE'
    && Boolean(candidate.botPaused)
    && /revision humana|revisión humana|candidata femenina/i.test(candidate.botPauseReason || '');

  return {
    ...candidate,
    hasCv: candidateHasCv(candidate),
    isFemaleCandidate: candidate.gender === 'FEMALE',
    isFemaleHumanReview,
    outboundWindowOpen
  };
}

function collectVacancyCandidates(vacancy = {}) {
  const candidatesById = new Map();
  const addCandidate = (candidate) => {
    if (!candidate?.id) return;
    candidatesById.set(candidate.id, candidate);
  };

  for (const candidate of vacancy.candidates || []) addCandidate(candidate);
  for (const booking of vacancy.bookingsToday || []) addCandidate(booking?.candidate);
  for (const field of VACANCY_LIST_FIELDS) {
    for (const candidate of vacancy[field] || []) addCandidate(candidate);
  }

  return [...candidatesById.values()];
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

function resolveSearchResultTarget(vacancy = {}) {
  if (vacancy.schedulingEnabled) return 'registeredNoBooking';
  if (vacancy.acceptingApplications || vacancy.dashboardReviewEnabled) return 'registeredComplete';
  return 'approvedCandidates';
}

export function expandVacancySearchCandidates(viewModel = {}, query = {}) {
  const searches = normalizeVacancyDashboardSearches(query);
  if (!Object.values(searches).some((search) => search.text)) return viewModel;

  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) {
      const search = searches[String(vacancy.id)];
      if (!search?.text) continue;

      const alreadyDisplayed = displayedCandidateIds(vacancy);
      const missingMatches = collectVacancyCandidates(vacancy)
        .filter((candidate) => candidateMatchesVacancyDashboardSearch(candidate, search))
        .filter((candidate) => !alreadyDisplayed.has(candidate.id))
        .map(decorateSearchCandidate);

      if (!missingMatches.length) continue;

      const targetField = resolveSearchResultTarget(vacancy);
      vacancy[targetField] = [
        ...missingMatches,
        ...(Array.isArray(vacancy[targetField]) ? vacancy[targetField] : [])
      ];
    }
  }

  return viewModel;
}

export function installVacancyDashboardSearchExpansion() {
  if (express.response[RENDER_PATCH_FLAG]) return;

  const originalRender = express.response.render;
  express.response.render = function renderWithExpandedVacancySearch(view, options, callback) {
    if (view === 'list' && options && typeof options === 'object' && Array.isArray(options.cities)) {
      expandVacancySearchCandidates(options, this.req?.query || {});
    }
    return originalRender.call(this, view, options, callback);
  };
  express.response[RENDER_PATCH_FLAG] = true;
}

installVacancyDashboardSearchExpansion();
