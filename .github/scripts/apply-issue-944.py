from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label, flags=0):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return updated


# ── Router administrativo ─────────────────────────────────────────────
admin_path = Path('src/routes/admin.js')
admin = admin_path.read_text(encoding='utf-8')
admin = replace_once(
    admin,
    "} from '../services/candidateExport.js';\n",
    "} from '../services/candidateExport.js';\nimport {\n  applyVacancyCandidateRegistrationPolicy,\n  buildCandidateRegistrationCreatedAtWhere,\n  compareCandidatesByRegistrationDesc,\n  normalizeCandidateRegistrationRange,\n  normalizeVacancyRegistrationDateFilters\n} from '../services/vacancyCandidateRegistrationPolicy.js';\n",
    'import de política de registro'
)
admin = replace_once(
    admin,
    "  const candidateFilters = options.candidateFilters || null;\n",
    "  const candidateFilters = options.candidateFilters || null;\n  const registrationFiltersByVacancyId = options.registrationFiltersByVacancyId || {};\n",
    'opciones de buildDashboardData'
)
admin = replace_once(
    admin,
    """    if (isDev) {
      registeredNoBooking.sort(compareCandidatesByRecentInbound);
      registeredComplete.sort(compareCandidatesByRecentInbound);
      completeWithoutCv.sort(compareCandidatesByRecentInbound);
      approvedCandidates.sort(compareCandidatesByRecentInbound);
      contractedCandidates.sort(compareCandidatesByRecentInbound);
    }

    const enriched = {
      ...v,
      bookingsToday: filteredBookingsToday,
      registeredNoBooking,
      registeredComplete,
      completeWithoutCv,
      approvedCandidates,
      contractedCandidates
    };

    citiesMap.get(city).push(enriched);
""",
    """    const enriched = applyVacancyCandidateRegistrationPolicy({
      ...v,
      bookingsToday: filteredBookingsToday,
      registeredNoBooking,
      registeredComplete,
      completeWithoutCv,
      approvedCandidates,
      contractedCandidates
    }, registrationFiltersByVacancyId[String(v.id)] || {});

    citiesMap.get(city).push(enriched);
""",
    'orden de listas por vacante'
)
admin = replace_once(
    admin,
    """    const vacancySearchById = normalizeVacancySearches(req.query);
    const botChatCount = await loadBotChatCount(prisma);
""",
    """    const vacancySearchById = normalizeVacancySearches(req.query);
    const vacancyRegistrationFiltersById = normalizeVacancyRegistrationDateFilters(req.query);
    const legacyVacancyId = normalizeString(req.query.vacancyId);
    const candidateRegistrationRange = normalizeCandidateRegistrationRange(req.query);
    const legacyCreatedAtWhere = buildCandidateRegistrationCreatedAtWhere(candidateRegistrationRange);
    const botChatCount = await loadBotChatCount(prisma);
""",
    'parámetros del dashboard'
)
admin = replace_once(
    admin,
    """        where: buildCandidateAccessWhere(accessContext),
        orderBy: { createdAt: 'desc' },
""",
    """        where: {
          ...buildCandidateAccessWhere(accessContext),
          ...(legacyVacancyId ? { vacancyId: legacyVacancyId } : {}),
          ...(legacyCreatedAtWhere ? { createdAt: legacyCreatedAtWhere } : {})
        },
        orderBy: { createdAt: 'desc' },
""",
    'where de ver todos'
)
admin = replace_once(
    admin,
    """        legacyQuery.where = {
          ...buildCandidateAccessWhere(accessContext),
          lastInboundAt: { not: null }
        };
""",
    """        legacyQuery.where = {
          ...legacyQuery.where,
          lastInboundAt: { not: null }
        };
""",
    'inbox conserva filtros'
)
admin = replace_once(
    admin,
    """      candidates.sort(compareCandidatesByRecentInbound);
      return res.render('list', {
""",
    """      if (requestedStatus === 'inbox' && req.userRole === 'dev') {
        candidates.sort(compareCandidatesByRecentInbound);
      } else {
        candidates.sort(compareCandidatesByRegistrationDesc);
      }
      return res.render('list', {
""",
    'orden de ver todos'
)
admin = replace_once(
    admin,
    """        vacancyFiltersById: {},
        vacancySearchById: {}
""",
    """        vacancyFiltersById: {},
        vacancySearchById: {},
        vacancyRegistrationFiltersById: {},
        legacyVacancyId,
        candidateRegistrationRange
""",
    'modelo legacy'
)
admin = replace_once(
    admin,
    """    const { cities, legacyCandidates, manualReviewCandidates } = await buildDashboardData(prisma, selectedDate, {
      role: req.userRole,
      accessContext
    });
""",
    """    const { cities, legacyCandidates, manualReviewCandidates } = await buildDashboardData(prisma, selectedDate, {
      role: req.userRole,
      accessContext,
      registrationFiltersByVacancyId: vacancyRegistrationFiltersById
    });
""",
    'rango en buildDashboardData'
)
admin = replace_once(
    admin,
    """      vacancyFiltersById,
      vacancySearchById
    });
""",
    """      vacancyFiltersById,
      vacancySearchById,
      vacancyRegistrationFiltersById,
      legacyVacancyId: null,
      candidateRegistrationRange: { dateFrom: '', dateTo: '' }
    });
""",
    'modelo de vacantes'
)
admin_path.write_text(admin, encoding='utf-8')


# ── Expansión de búsqueda completa ────────────────────────────────────
search_path = Path('src/services/vacancyDashboardSearchExpansion.js')
search = search_path.read_text(encoding='utf-8')
search = replace_once(
    search,
    "import { getCandidateResidenceValue } from './candidateData.js';\n",
    "import { getCandidateResidenceValue } from './candidateData.js';\nimport {\n  applyVacancyCandidateRegistrationPolicy,\n  buildVacancyRegistrationCandidateWhere,\n  normalizeVacancyRegistrationDateFilters\n} from './vacancyCandidateRegistrationPolicy.js';\n",
    'import de rango en búsqueda'
)
search = replace_once(
    search,
    """      for (const candidate of searchResults) {
        if (alreadyDisplayed.has(candidate.id)) continue;
        const targetField = resolveSearchResultTarget(vacancy, candidate);
        vacancy[targetField] = [candidate, ...(vacancy[targetField] || [])];
        alreadyDisplayed.add(candidate.id);
      }
""",
    """      for (const candidate of searchResults) {
        if (alreadyDisplayed.has(candidate.id)) continue;
        const targetField = resolveSearchResultTarget(vacancy, candidate);
        vacancy[targetField] = [candidate, ...(vacancy[targetField] || [])];
        alreadyDisplayed.add(candidate.id);
      }
      applyVacancyCandidateRegistrationPolicy(
        vacancy,
        options.registrationFiltersByVacancyId?.[String(vacancy.id)] || {}
      );
""",
    'orden posterior a merge de búsqueda'
)
search = replace_once(
    search,
    "async function loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds) {",
    "async function loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds, registrationFiltersByVacancyId = {}) {",
    'firma de carga de búsqueda'
)
search = replace_once(
    search,
    """        buildCandidateAccessWhere(accessContext),
        { vacancyId: { in: activeVacancyIds } }
""",
    """        buildCandidateAccessWhere(accessContext),
        {
          OR: activeVacancyIds.map((vacancyId) => buildVacancyRegistrationCandidateWhere(
            vacancyId,
            registrationFiltersByVacancyId[String(vacancyId)] || {}
          ))
        }
""",
    'where de búsqueda por rango'
)
search = replace_once(
    search,
    """  const searches = normalizeVacancyDashboardSearches(query);
  if (!Object.values(searches).some((search) => search?.text)) return viewModel;
""",
    """  const searches = normalizeVacancyDashboardSearches(query);
  const registrationFiltersByVacancyId = normalizeVacancyRegistrationDateFilters(query);
  if (!Object.values(searches).some((search) => search?.text)) return viewModel;
""",
    'normalización de rango en búsqueda'
)
search = replace_once(
    search,
    """  const candidates = await loadAuthorizedSearchCandidates(req, searches, visibleVacancyIds);
  return mergeVacancySearchResults(viewModel, searches, candidates, { isDev: accessContext.isDev });
""",
    """  const candidates = await loadAuthorizedSearchCandidates(
    req,
    searches,
    visibleVacancyIds,
    registrationFiltersByVacancyId
  );
  return mergeVacancySearchResults(viewModel, searches, candidates, {
    isDev: accessContext.isDev,
    registrationFiltersByVacancyId
  });
""",
    'aplicación de rango en búsqueda'
)
search_path.write_text(search, encoding='utf-8')


# ── Vista administrativa ───────────────────────────────────────────────
view_path = Path('src/views/list.ejs')
view = view_path.read_text(encoding='utf-8')
view = replace_once(
    view,
    "  const vacancyFilterFields = ['transportMode', 'neighborhood', 'locality'];\n",
    "  const vacancyFilterFields = ['transportMode', 'neighborhood', 'locality'];\n  const vacancyRegistrationDateFields = ['dateFrom', 'dateTo'];\n",
    'campos de rango en vista'
)
view = replace_once(
    view,
    """  ['neighborhood', 'locality', 'transportMode'].forEach((key) => {
    if (adminFilters && adminFilters[key]) legacyParams.set(key, adminFilters[key]);
  });
""",
    """  ['neighborhood', 'locality', 'transportMode'].forEach((key) => {
    if (adminFilters && adminFilters[key]) legacyParams.set(key, adminFilters[key]);
  });
  if (legacyVacancyId) legacyParams.set('vacancyId', legacyVacancyId);
  if (candidateRegistrationRange?.dateFrom) legacyParams.set('dateFrom', candidateRegistrationRange.dateFrom);
  if (candidateRegistrationRange?.dateTo) legacyParams.set('dateTo', candidateRegistrationRange.dateTo);
""",
    'parámetros legacy'
)
view = replace_once(
    view,
    """  function appendVacancySearches(params, excludedVacancyId = null) {
    if (!vacancySearchById) return;
    for (const [vacancyId, search] of Object.entries(vacancySearchById)) {
      if (!search || vacancyId === excludedVacancyId) continue;
      if (search.field) params.set('vs_' + vacancyId + '_field', search.field);
      if (search.text) params.set('vs_' + vacancyId + '_text', search.text);
    }
  }
""",
    """  function appendVacancySearches(params, excludedVacancyId = null) {
    if (!vacancySearchById) return;
    for (const [vacancyId, search] of Object.entries(vacancySearchById)) {
      if (!search || vacancyId === excludedVacancyId) continue;
      if (search.field) params.set('vs_' + vacancyId + '_field', search.field);
      if (search.text) params.set('vs_' + vacancyId + '_text', search.text);
    }
  }
  function appendVacancyRegistrationFilters(params, excludedVacancyId = null) {
    if (!vacancyRegistrationFiltersById) return;
    for (const [vacancyId, range] of Object.entries(vacancyRegistrationFiltersById)) {
      if (!range || vacancyId === excludedVacancyId) continue;
      if (range.dateFrom) params.set('vr_' + vacancyId + '_dateFrom', range.dateFrom);
      if (range.dateTo) params.set('vr_' + vacancyId + '_dateTo', range.dateTo);
    }
  }
""",
    'helper para conservar rangos'
)
view = replace_once(
    view,
    """  appendVacancyFilters(dashboardParams);
  appendVacancySearches(dashboardParams);
""",
    """  appendVacancyFilters(dashboardParams);
  appendVacancySearches(dashboardParams);
  appendVacancyRegistrationFilters(dashboardParams);
""",
    'ruta actual conserva rangos'
)
view = replace_once(
    view,
    """  const currentAdminReturnPath = isLegacyMode ? currentLegacyPath : currentDashboardPath;

  function candidateWhatsappHref(candidate) {
""",
    """  const currentAdminReturnPath = isLegacyMode ? currentLegacyPath : currentDashboardPath;

  function vacancyAllCandidatesHref(vacancyId, scope, range = {}) {
    const params = new URLSearchParams();
    params.set('status', scope);
    params.set('vacancyId', vacancyId);
    if (range.dateFrom) params.set('dateFrom', range.dateFrom);
    if (range.dateTo) params.set('dateTo', range.dateTo);
    return '/admin?' + params.toString();
  }

  function candidateWhatsappHref(candidate) {
""",
    'helper ver todos'
)
# Conservación en selector superior de fecha de entrevistas.
view = replace_once(
    view,
    """      <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (search?.field) { %>
        <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
      <% } if (search?.text) { %>
        <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
      <% } } } %>
      <div class="date-strip">
""",
    """      <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (search?.field) { %>
        <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
      <% } if (search?.text) { %>
        <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
      <% } } } %>
      <% if (vacancyRegistrationFiltersById) { for (const [vacancyId, range] of Object.entries(vacancyRegistrationFiltersById)) { if (range?.dateFrom) { %>
        <input type="hidden" name="vr_<%= vacancyId %>_dateFrom" value="<%= range.dateFrom %>" />
      <% } if (range?.dateTo) { %>
        <input type="hidden" name="vr_<%= vacancyId %>_dateTo" value="<%= range.dateTo %>" />
      <% } } } %>
      <div class="date-strip">
""",
    'fecha entrevistas conserva rangos'
)
view = replace_once(
    view,
    """            appendVacancyFilters(todayParams);
            appendVacancySearches(todayParams);
""",
    """            appendVacancyFilters(todayParams);
            appendVacancySearches(todayParams);
            appendVacancyRegistrationFilters(todayParams);
""",
    'hoy conserva rangos'
)
# Datos de la vacante y URLs de limpieza.
view = replace_once(
    view,
    """        const currentVacancySearch = (vacancySearchById && vacancySearchById[v.id]) || { field: 'document', text: '' };
        const currentVacancyFilterFields = getVacancyFilterFields(v);
""",
    """        const currentVacancySearch = (vacancySearchById && vacancySearchById[v.id]) || { field: 'document', text: '' };
        const currentVacancyRegistrationRange = (vacancyRegistrationFiltersById && vacancyRegistrationFiltersById[v.id]) || { dateFrom: '', dateTo: '' };
        const currentVacancyFilterFields = getVacancyFilterFields(v);
""",
    'rango actual de vacante'
)
view = replace_once(
    view,
    """        const vacancyFiltersActive = vacancyFilterFields.some((field) => currentVacancyFilters[field]);
        const vacancySearchActive = Boolean(currentVacancySearch.text);
""",
    """        const vacancyFiltersActive = vacancyFilterFields.some((field) => currentVacancyFilters[field]);
        const vacancySearchActive = Boolean(currentVacancySearch.text);
        const vacancyRegistrationRangeActive = Boolean(currentVacancyRegistrationRange.dateFrom || currentVacancyRegistrationRange.dateTo);
""",
    'estado del rango'
)
view = replace_once(
    view,
    """        appendVacancyFilters(clearVacancyFilterParams, v.id);
        appendVacancySearches(clearVacancyFilterParams);
""",
    """        appendVacancyFilters(clearVacancyFilterParams, v.id);
        appendVacancySearches(clearVacancyFilterParams);
        appendVacancyRegistrationFilters(clearVacancyFilterParams);
""",
    'limpiar filtros conserva rango'
)
view = replace_once(
    view,
    """        appendVacancyFilters(clearVacancySearchParams);
        appendVacancySearches(clearVacancySearchParams, v.id);
        const clearVacancySearchHref = '/admin' + (clearVacancySearchParams.toString() ? '?' + clearVacancySearchParams.toString() : '');
""",
    """        appendVacancyFilters(clearVacancySearchParams);
        appendVacancySearches(clearVacancySearchParams, v.id);
        appendVacancyRegistrationFilters(clearVacancySearchParams);
        const clearVacancySearchHref = '/admin' + (clearVacancySearchParams.toString() ? '?' + clearVacancySearchParams.toString() : '');
        const clearVacancyRegistrationParams = new URLSearchParams();
        if (activeCity) clearVacancyRegistrationParams.set('city', activeCity);
        if (selectedDate) clearVacancyRegistrationParams.set('date', selectedDate);
        appendVacancyFilters(clearVacancyRegistrationParams);
        appendVacancySearches(clearVacancyRegistrationParams);
        appendVacancyRegistrationFilters(clearVacancyRegistrationParams, v.id);
        const clearVacancyRegistrationHref = '/admin' + (clearVacancyRegistrationParams.toString() ? '?' + clearVacancyRegistrationParams.toString() : '');
""",
    'URL para quitar rango'
)
# La búsqueda debe conservar todos los rangos.
view = replace_once(
    view,
    """          <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (vacancyId !== v.id) { if (search?.field) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
          <% } if (search?.text) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
          <% } } } } %>
          <div class="filter-field">
""",
    """          <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (vacancyId !== v.id) { if (search?.field) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
          <% } if (search?.text) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
          <% } } } } %>
          <% if (vacancyRegistrationFiltersById) { for (const [vacancyId, range] of Object.entries(vacancyRegistrationFiltersById)) { if (range?.dateFrom) { %>
            <input type="hidden" name="vr_<%= vacancyId %>_dateFrom" value="<%= range.dateFrom %>" />
          <% } if (range?.dateTo) { %>
            <input type="hidden" name="vr_<%= vacancyId %>_dateTo" value="<%= range.dateTo %>" />
          <% } } } %>
          <div class="filter-field">
""",
    'búsqueda conserva rangos'
)
# Formulario de filtros conserva otros rangos y expone el actual.
view = replace_once(
    view,
    """          <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (search?.field) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
          <% } if (search?.text) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
          <% } } } %>
          <% for (const field of currentVacancyFilterFields) { %>
""",
    """          <% if (vacancySearchById) { for (const [vacancyId, search] of Object.entries(vacancySearchById)) { if (search?.field) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_field" value="<%= search.field %>" />
          <% } if (search?.text) { %>
            <input type="hidden" name="vs_<%= vacancyId %>_text" value="<%= search.text %>" />
          <% } } } %>
          <% if (vacancyRegistrationFiltersById) { for (const [vacancyId, range] of Object.entries(vacancyRegistrationFiltersById)) { if (vacancyId !== v.id) { if (range?.dateFrom) { %>
            <input type="hidden" name="vr_<%= vacancyId %>_dateFrom" value="<%= range.dateFrom %>" />
          <% } if (range?.dateTo) { %>
            <input type="hidden" name="vr_<%= vacancyId %>_dateTo" value="<%= range.dateTo %>" />
          <% } } } } %>
          <% for (const field of currentVacancyFilterFields) { %>
""",
    'filtros conservan otros rangos'
)
view = replace_once(
    view,
    """          <button type="submit" class="export-btn" style="cursor:pointer;">Aplicar filtros</button>
          <a href="<%= clearVacancyFilterHref %>#vacancy-<%= v.id %>" class="export-btn">Quitar filtros</a>
          <% if (vacancyFiltersActive) { %>
            <span class="filter-note">Filtro activo en esta vacante.</span>
          <% } %>
""",
    """          <div class="filter-field">
            <label for="vacancyRegistrationFrom_<%= v.id %>">Registrados desde</label>
            <input id="vacancyRegistrationFrom_<%= v.id %>" type="date" name="vr_<%= v.id %>_dateFrom" value="<%= currentVacancyRegistrationRange.dateFrom || '' %>" />
          </div>
          <div class="filter-field">
            <label for="vacancyRegistrationTo_<%= v.id %>">Registrados hasta</label>
            <input id="vacancyRegistrationTo_<%= v.id %>" type="date" name="vr_<%= v.id %>_dateTo" value="<%= currentVacancyRegistrationRange.dateTo || '' %>" />
          </div>
          <button type="submit" class="export-btn" style="cursor:pointer;">Aplicar filtros</button>
          <a href="<%= clearVacancyFilterHref %>#vacancy-<%= v.id %>" class="export-btn">Quitar filtros operativos</a>
          <a href="<%= clearVacancyRegistrationHref %>#vacancy-<%= v.id %>" class="export-btn">Quitar fechas</a>
          <% if (vacancyFiltersActive || vacancyRegistrationRangeActive) { %>
            <span class="filter-note">Filtros activos en esta vacante.</span>
          <% } %>
""",
    'campos visibles de fecha'
)
# Ver todos conserva vacante y rango.
view = view.replace(
    '<a href="/admin?status=registered" style="color:var(--teal);font-weight:600;">ver todos</a>',
    '<a href="<%= vacancyAllCandidatesHref(v.id, \'registered\', currentVacancyRegistrationRange) %>" style="color:var(--teal);font-weight:600;">ver todos</a>'
)
view = view.replace(
    '<a href="/admin/export?scope=missing_cv_complete&vacancyId=<%= encodeURIComponent(v.id) %>" style="color:var(--teal);font-weight:600;">ver todos</a>',
    '<a href="<%= vacancyAllCandidatesHref(v.id, \'missing_cv_complete\', currentVacancyRegistrationRange) %>" style="color:var(--teal);font-weight:600;">ver todos</a>'
)
if '/admin?status=registered" style="color:var(--teal);font-weight:600;">ver todos</a>' in view:
    raise SystemExit('Quedó un enlace ver todos sin vacante')
# Legacy: conservar contexto y permitir editar el rango.
view = replace_once(
    view,
    """      if (adminFilters?.transportMode) tabParams.set('transportMode', adminFilters.transportMode);
""",
    """      if (adminFilters?.transportMode) tabParams.set('transportMode', adminFilters.transportMode);
      if (legacyVacancyId) tabParams.set('vacancyId', legacyVacancyId);
      if (candidateRegistrationRange?.dateFrom) tabParams.set('dateFrom', candidateRegistrationRange.dateFrom);
      if (candidateRegistrationRange?.dateTo) tabParams.set('dateTo', candidateRegistrationRange.dateTo);
""",
    'tabs legacy conservan contexto'
)
view = replace_once(
    view,
    """    <% if (adminFilters?.transportMode) { %><input type="hidden" name="transportMode" value="<%= adminFilters.transportMode %>" /><% } %>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Buscar por
""",
    """    <% if (adminFilters?.transportMode) { %><input type="hidden" name="transportMode" value="<%= adminFilters.transportMode %>" /><% } %>
    <% if (legacyVacancyId) { %><input type="hidden" name="vacancyId" value="<%= legacyVacancyId %>" /><% } %>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Registrados desde
      <input type="date" name="dateFrom" value="<%= candidateRegistrationRange?.dateFrom || '' %>" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;" />
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Registrados hasta
      <input type="date" name="dateTo" value="<%= candidateRegistrationRange?.dateTo || '' %>" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;" />
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Buscar por
""",
    'rango visible en ver todos'
)
view = replace_once(
    view,
    """    <a href="/admin?status=<%= activeStatusScope || 'all' %>" class="export-btn">Limpiar búsqueda</a>
""",
    """    <a href="/admin?status=<%= activeStatusScope || 'all' %><%= legacyVacancyId ? '&vacancyId=' + encodeURIComponent(legacyVacancyId) : '' %><%= candidateRegistrationRange?.dateFrom ? '&dateFrom=' + encodeURIComponent(candidateRegistrationRange.dateFrom) : '' %><%= candidateRegistrationRange?.dateTo ? '&dateTo=' + encodeURIComponent(candidateRegistrationRange.dateTo) : '' %>" class="export-btn">Limpiar búsqueda</a>
""",
    'limpiar búsqueda conserva rango'
)
view = replace_once(
    view,
    """      <% if (candidateSearch?.text) { %><input type="hidden" name="searchText" value="<%= candidateSearch.text %>" /><% } %>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Barrio
""",
    """      <% if (candidateSearch?.text) { %><input type="hidden" name="searchText" value="<%= candidateSearch.text %>" /><% } %>
      <% if (legacyVacancyId) { %><input type="hidden" name="vacancyId" value="<%= legacyVacancyId %>" /><% } %>
      <% if (candidateRegistrationRange?.dateFrom) { %><input type="hidden" name="dateFrom" value="<%= candidateRegistrationRange.dateFrom %>" /><% } %>
      <% if (candidateRegistrationRange?.dateTo) { %><input type="hidden" name="dateTo" value="<%= candidateRegistrationRange.dateTo %>" /><% } %>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted);font-weight:600;">Barrio
""",
    'filtros legacy conservan rango'
)
view_path.write_text(view, encoding='utf-8')
