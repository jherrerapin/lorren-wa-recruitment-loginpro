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

async function loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds) {
  const activeVacancyIds = Object.entries(searches)
    .filter(([vacancyId, search]) => search?.text && visibleVacancyIds.has(String(vacancyId)))
    .map(([vacancyId]) => vacancyId);
  if (!activeVacancyIds.length) return [];

  const accessContext = getRequestAccessContext(req);
  return prisma.candidate.findMany({
    where: {
      AND: [
        buildCandidateAccessWhere(accessContext),
        { vacancyId: { in: activeVacancyIds } },
        { status: { in: RECRUITER_VISIBLE_STATUSES } }
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
  const visibleVacancyIds = new Set();
  for (const city of viewModel.cities || []) {
    for (const vacancy of city.vacancies || []) visibleVacancyIds.add(String(vacancy.id));
  }

  const accessContext = getRequestAccessContext(req);
  sanitizeVacancyDashboardVisibility(viewModel, { isDev: accessContext.isDev });
  if (!Object.values(searches).some((search) => search?.text)) return viewModel;

  const candidates = await loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds);
  return mergeVacancySearchResults(viewModel, searches, candidates, { isDev: accessContext.isDev });
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
  const candidates = Array.isArray(viewModel.candidates) ? [...viewModel.candidates] : [];
  const accessContext = getRequestAccessContext(req);
  const dateRange = normalizeApplicantDateRange(query);
  const vacancyId = normalizeString(query.vacancyId);

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
  return [
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

    const activeStatus = pageParams.get('status');
    if (activeStatus && activeStatus !== 'inbox') {
      const table = document.querySelector('#legacy-candidates-table');
      const firstHeader = table?.querySelector('thead th');
      if (firstHeader) firstHeader.textContent = 'Fecha de registro';
    }
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

  const script = buildApplicantLinkScript(dateRange);
  return output.includes('</body>')
    ? output.replace('</body>', `${script}\n</body>`)
    : `${output}${script}`;
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
