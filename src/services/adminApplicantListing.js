const ADMIN_LIST_PATH = '/admin';
const APPLICANT_LIST_NAMES = [
  'registeredNoBooking',
  'registeredComplete',
  'completeWithoutCv',
  'approvedCandidates',
  'contractedCandidates'
];

function normalizeString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
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

function dateTimestamp(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
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
    'city',
    'date',
    'searchField',
    'searchText',
    'neighborhood',
    'locality',
    'transportMode'
  ].includes(key)
    || /^vf_[A-Za-z0-9-]+_(transportMode|neighborhood|locality)$/.test(key)
    || /^vs_[A-Za-z0-9-]+_(field|text)$/.test(key);
}

function appendQueryValue(params, key, value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeString(item);
      if (normalized) params.append(key, normalized);
    }
    return;
  }
  const normalized = normalizeString(value);
  if (normalized) params.set(key, normalized);
}

function preservedQueryParams(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!isPreservableQueryKey(key)) continue;
    appendQueryValue(params, key, value);
  }
  return params;
}

function hiddenInputsFromParams(params) {
  return Array.from(params.entries())
    .map(([key, value]) => `      <input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join('\n');
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

export function compareCandidatesByRegisteredAtDesc(candidateA, candidateB) {
  const difference = dateTimestamp(candidateB?.createdAt) - dateTimestamp(candidateA?.createdAt);
  if (difference !== 0) return difference;
  return String(candidateA?.id || '').localeCompare(String(candidateB?.id || ''));
}

export function candidateMatchesApplicantDateRange(candidate, dateRange) {
  if (!dateRange?.isActive) return true;
  const registeredAt = dateTimestamp(candidate?.createdAt);
  if (!registeredAt) return false;
  if (dateRange.start && registeredAt < dateRange.start.getTime()) return false;
  if (dateRange.end && registeredAt > dateRange.end.getTime()) return false;
  return true;
}

function filterAndSortCandidates(candidates, dateRange, options = {}) {
  const filtered = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidateMatchesApplicantDateRange(candidate, dateRange));
  if (options.keepCurrentOrder) return filtered;
  return filtered.sort(compareCandidatesByRegisteredAtDesc);
}

async function visibleCandidateIdsForVacancy(prisma, candidates, vacancyId) {
  const candidateIds = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => normalizeString(candidate?.id))
    .filter(Boolean);
  if (!vacancyId || candidateIds.length === 0) return new Set(candidateIds);

  const matches = await prisma.candidate.findMany({
    where: {
      id: { in: candidateIds },
      vacancyId
    },
    select: { id: true }
  });
  return new Set(matches.map((candidate) => candidate.id));
}

function enhanceVacancyDashboard(cities, dateRange) {
  return (Array.isArray(cities) ? cities : []).map((city) => ({
    ...city,
    vacancies: (Array.isArray(city?.vacancies) ? city.vacancies : []).map((vacancy) => {
      const enhancedVacancy = { ...vacancy };
      for (const listName of APPLICANT_LIST_NAMES) {
        enhancedVacancy[listName] = filterAndSortCandidates(vacancy?.[listName], dateRange);
      }
      return enhancedVacancy;
    })
  }));
}

export async function enhanceAdminApplicantListView(prisma, req, locals = {}) {
  const dateRange = normalizeApplicantDateRange(req?.query || {});
  const requestedVacancyId = normalizeString(req?.query?.vacancyId);
  const enhanced = {
    ...locals,
    applicantDateRange: dateRange
  };

  if (dateRange.error && !enhanced.errorMsg) {
    enhanced.errorMsg = dateRange.error;
  }

  if (locals.mode === 'legacy' || typeof locals.mode === 'undefined') {
    let candidates = Array.isArray(locals.candidates) ? [...locals.candidates] : [];
    if (requestedVacancyId) {
      try {
        const matchingIds = await visibleCandidateIdsForVacancy(prisma, candidates, requestedVacancyId);
        candidates = candidates.filter((candidate) => matchingIds.has(candidate.id));
      } catch (error) {
        console.error('[ADMIN_APPLICANT_VACANCY_FILTER_ERROR]', error);
        candidates = [];
        enhanced.errorMsg = 'No fue posible filtrar los postulados de la vacante seleccionada.';
      }
    }

    enhanced.candidates = filterAndSortCandidates(candidates, dateRange, {
      keepCurrentOrder: normalizeString(req?.query?.status) === 'inbox'
    });
    return enhanced;
  }

  enhanced.cities = enhanceVacancyDashboard(locals.cities, dateRange);
  return enhanced;
}

function buildApplicantDateFilterForm(req, dateRange) {
  const preservedParams = preservedQueryParams(req?.query || {});
  const clearHref = preservedParams.toString()
    ? `${ADMIN_LIST_PATH}?${preservedParams.toString()}`
    : ADMIN_LIST_PATH;
  const hiddenInputs = hiddenInputsFromParams(preservedParams);
  const activeNote = dateRange.isActive
    ? 'Rango activo. Los conteos y listados corresponden a esas fechas.'
    : 'Los postulados se muestran del registro más reciente al más antiguo.';

  return `
  <section class="applicant-date-range" aria-label="Filtrar postulados por fecha de registro" style="margin-bottom:16px;">
    <form method="get" action="${ADMIN_LIST_PATH}" class="filter-strip" style="width:100%;">
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
      <span class="filter-note">${escapeHtml(activeNote)}</span>
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

    function ensureHiddenRangeInput(form, name, value) {
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

    document.querySelectorAll('form[method="get"], form[method="GET"]').forEach((form) => {
      if (form.closest('.applicant-date-range')) return;
      const action = new URL(form.getAttribute('action') || window.location.href, window.location.origin);
      if (action.pathname !== '/admin') return;
      ensureHiddenRangeInput(form, 'dateFrom', applicantDateRange.dateFrom);
      ensureHiddenRangeInput(form, 'dateTo', applicantDateRange.dateTo);
    });

    document.querySelectorAll('a[href]').forEach((anchor) => {
      if (anchor.hasAttribute('data-clear-applicant-dates')) return;
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      if (url.pathname !== '/admin' && url.pathname !== '/admin/export') return;
      applyDateRange(url);
      anchor.setAttribute('href', relativeHref(url));
    });

    const activeStatus = new URLSearchParams(window.location.search).get('status');
    if (activeStatus && activeStatus !== 'inbox') {
      const legacyTable = document.querySelector('#legacy-candidates-table');
      if (legacyTable) {
        const firstHeader = legacyTable.querySelector('thead th');
        if (firstHeader) firstHeader.textContent = 'Fecha de registro';
        legacyTable.querySelectorAll('tbody tr').forEach((row) => {
          const registrationMeta = Array.from(row.querySelectorAll('.candidate-dev-meta'))
            .find((element) => String(element.textContent || '').trim().startsWith('Fecha de registro:'));
          if (!registrationMeta || !row.cells || !row.cells[0]) return;
          row.cells[0].textContent = String(registrationMeta.textContent || '')
            .replace(/^Fecha de registro:\s*/, '')
            .trim();
        });
      }
    }

    document.querySelectorAll('[data-vacancy-panel]').forEach((panel) => {
      const vacancyId = panel.getAttribute('data-vacancy-panel');
      if (!vacancyId) return;

      panel.querySelectorAll('a[href]').forEach((anchor) => {
        const text = String(anchor.textContent || '').trim().toLowerCase();
        const url = new URL(anchor.getAttribute('href'), window.location.origin);

        if (text.includes('ver todos') && url.pathname === '/admin/export') {
          const scope = url.searchParams.get('scope') || 'all';
          url.pathname = '/admin';
          url.search = '';
          url.searchParams.set('status', scope);
          url.searchParams.set('vacancyId', vacancyId);
          applyDateRange(url);
          anchor.setAttribute('href', relativeHref(url));
          return;
        }

        if (text.includes('ver todos') && url.pathname === '/admin') {
          url.searchParams.set('vacancyId', vacancyId);
          applyDateRange(url);
          anchor.setAttribute('href', relativeHref(url));
          return;
        }

        if (url.pathname === '/admin/export') {
          applyDateRange(url);
          anchor.setAttribute('href', relativeHref(url));
        }
      });
    });
  })();
</script>`;
}

export function injectAdminApplicantControls(html, req) {
  if (typeof html !== 'string') return html;
  const dateRange = normalizeApplicantDateRange(req?.query || {});
  const pageMarker = '<div class="page">';
  const pageIndex = html.indexOf(pageMarker);
  if (pageIndex < 0) return html;

  const insertionIndex = pageIndex + pageMarker.length;
  const form = buildApplicantDateFilterForm(req, dateRange);
  let output = `${html.slice(0, insertionIndex)}\n${form}${html.slice(insertionIndex)}`;
  const script = buildApplicantLinkScript(dateRange);
  output = output.includes('</body>')
    ? output.replace('</body>', `${script}\n</body>`)
    : `${output}${script}`;
  return output;
}
