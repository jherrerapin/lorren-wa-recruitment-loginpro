from pathlib import Path

ADMIN_PATH = Path('src/routes/admin.js')
VIEW_PATH = Path('src/views/list.ejs')

admin = ADMIN_PATH.read_text(encoding='utf-8')

candidate_export_import = "} from '../services/candidateExport.js';\n"
search_import = "import { filterCandidateDashboardSearch } from '../services/candidateDashboardSearch.js';\n"
if candidate_export_import not in admin:
    raise SystemExit('No se encontró el import de candidateExport')
if search_import not in admin:
    admin = admin.replace(candidate_export_import, candidate_export_import + search_import, 1)

legacy_search = """      if (candidateSearch.text) {
        candidates = candidates.filter((candidate) => candidateMatchesSearch(candidate, candidateSearch));
      }
"""
legacy_replacement = """      if (candidateSearch.text) {
        candidates = filterCandidateDashboardSearch(candidates, candidateSearch, {
          isDev: req.userRole === 'dev'
        });
      }
"""
if legacy_search not in admin:
    raise SystemExit('No se encontró la búsqueda legacy esperada')
admin = admin.replace(legacy_search, legacy_replacement, 1)

old_match_function = """function candidateMatchesSearch(candidate, search = {}) {
  const searchText = normalizeString(search?.text);
  if (!searchText) return true;
  if ((search?.field || 'document') === 'phone') {
    const queryDigits = stripCountryCode57(searchText);
    const candidateDigits = stripCountryCode57(candidate?.phone);
    return Boolean(queryDigits) && candidateDigits.includes(queryDigits);
  }
  const queryDigits = normalizeDigits(searchText);
  const candidateDocument = normalizeDigits(candidate?.documentNumber);
  return Boolean(queryDigits) && candidateDocument.includes(queryDigits);
}

"""
if old_match_function not in admin:
    raise SystemExit('No se encontró candidateMatchesSearch legado')
admin = admin.replace(old_match_function, '', 1)

candidate_filters_anchor = "  const candidateFilters = options.candidateFilters || null;\n"
if candidate_filters_anchor not in admin:
    raise SystemExit('No se encontró candidateFilters en buildDashboardData')
admin = admin.replace(
    candidate_filters_anchor,
    candidate_filters_anchor + "  const vacancySearchById = options.vacancySearchById || {};\n",
    1
)

legacy_candidates_anchor = "  const legacyCandidates = isDev\n"
if legacy_candidates_anchor not in admin:
    raise SystemExit('No se encontró el inicio de legacyCandidates')

search_query_block = """  const activeVacancySearchEntries = Object.entries(vacancySearchById)
    .filter(([, search]) => normalizeString(search?.text));
  const searchedCandidatesByVacancyId = new Map();

  if (activeVacancySearchEntries.length) {
    const searchedVacancyIds = activeVacancySearchEntries.map(([vacancyId]) => vacancyId);
    const searchedCandidates = await prisma.candidate.findMany({
      where: {
        AND: [
          buildCandidateAccessWhere(accessContext),
          { vacancyId: { in: searchedVacancyIds } }
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

    for (const candidate of searchedCandidates) {
      const search = vacancySearchById[candidate.vacancyId];
      const matches = filterCandidateDashboardSearch([candidate], search, { isDev });
      if (!matches.length) continue;
      const decoratedCandidate = decorateDashboardCandidate(candidate);
      const current = searchedCandidatesByVacancyId.get(candidate.vacancyId) || [];
      current.push(decoratedCandidate);
      searchedCandidatesByVacancyId.set(candidate.vacancyId, current);
    }
  }

"""
admin = admin.replace(legacy_candidates_anchor, search_query_block + legacy_candidates_anchor, 1)

candidates_flags_anchor = "    const candidatesWithFlags = v.candidates.map(decorateDashboardCandidate);\n"
if candidates_flags_anchor not in admin:
    raise SystemExit('No se encontró candidatesWithFlags')
admin = admin.replace(
    candidates_flags_anchor,
    candidates_flags_anchor + "    const searchResults = searchedCandidatesByVacancyId.get(v.id) || [];\n",
    1
)

enriched_anchor = """      contractedCandidates
    };
"""
enriched_replacement = """      contractedCandidates,
      searchResults
    };
"""
if enriched_anchor not in admin:
    raise SystemExit('No se encontró el objeto enriched esperado')
admin = admin.replace(enriched_anchor, enriched_replacement, 1)

build_dashboard_call = """      role: req.userRole,
      accessContext
    });
"""
build_dashboard_replacement = """      role: req.userRole,
      accessContext,
      vacancySearchById
    });
"""
if build_dashboard_call not in admin:
    raise SystemExit('No se encontró la llamada a buildDashboardData')
admin = admin.replace(build_dashboard_call, build_dashboard_replacement, 1)

ADMIN_PATH.write_text(admin, encoding='utf-8')

view = VIEW_PATH.read_text(encoding='utf-8')

active_search_anchor = "        const vacancySearchActive = Boolean(currentVacancySearch.text);\n"
if active_search_anchor not in view:
    raise SystemExit('No se encontró vacancySearchActive')
view = view.replace(
    active_search_anchor,
    active_search_anchor + "        const vacancySearchResults = Array.isArray(v.searchResults) ? v.searchResults : [];\n",
    1
)

view = view.replace(
    "<option value=\"document\" <%= currentVacancySearch.field === 'document' ? 'selected' : '' %>>Documento</option>",
    "<option value=\"document\" <%= currentVacancySearch.field === 'document' ? 'selected' : '' %>>Número de documento</option>",
    1
)
view = view.replace('placeholder="Documento o celular"', 'placeholder="Escribe el número a buscar"', 1)

body_open = """        <div class="vacancy-body">
          <% if (isScheduling) { %>
"""
if body_open not in view:
    raise SystemExit('No se encontró la apertura de vacancy-body')

search_section = """        <% if (vacancySearchActive) { %>
        <div class="vacancy-body">
          <div class="section">
            <div class="section-header">
              <span class="section-title">Resultados de búsqueda</span>
              <span class="section-count"><%= vacancySearchResults.length %></span>
            </div>
            <% if (role !== 'dev') { %>
              <div class="filter-note" style="margin-bottom:10px;">Solo se muestran candidatos con información completa y hoja de vida.</div>
            <% } %>
            <% if (vacancySearchResults.length === 0) { %>
              <div class="empty-state"><div class="empty-icon">-</div><p>No se encontró un candidato disponible con ese número en esta vacante.</p></div>
            <% } else { %>
              <div class="candidates-list">
                <% for (const c of vacancySearchResults) { %>
                  <% const uiSt = normalizeCandidateStatusForUI(c.status); %>
                  <% const stBadge = candidateStatusBadge[uiSt] || { cls: 'badge-nuevo', label: uiSt }; %>
                  <div class="candidate-row <%= isFemaleCandidate(c) ? 'candidate-row-female' : '' %>">
                    <div>
                      <div class="candidate-name"><%= c.fullName || 'Sin nombre' %></div>
                      <div class="candidate-doc"><%= c.documentType && c.documentNumber ? c.documentType + ' ' + c.documentNumber : '-' %><% if (c.age) { %>&nbsp;&middot;&nbsp;<%= c.age %> años<% } %></div>
                      <% const resultMeta = candidateOperationalMeta(c, { residenceContext: v }); %>
                      <% if (resultMeta) { %><div class="candidate-extra"><%= resultMeta %></div><% } %>
                      <div class="candidate-dev-meta">Fecha de registro: <%= formatDateTimeCO(c.createdAt) %></div>
                      <% if (role === 'dev') { %><div class="candidate-dev-meta"><%= candidateLastMessageLabel(c) %></div><% } %>
                    </div>
                    <div class="candidate-phone"><a href="<%= candidateWhatsappHref(c) %>" <%= role === 'dev' ? '' : 'target="_blank" rel="noopener"' %>>Tel. <%= formatCandidatePhone(c.phone) %></a></div>
                    <span class="badge <%= stBadge.cls %>"><%= stBadge.label %></span>
                    <span class="cv-pill <%= c.hasCv ? 'cv-yes' : 'cv-no' %>"><%= c.hasCv ? 'OK HV' : 'Sin HV' %></span>
                    <div class="action-stack">
                      <% if (role === 'dev') { %><a href="<%= candidateWhatsappHref(c) %>" class="action-btn action-btn-neutral">Enviar mensaje</a><% } %>
                      <a href="<%= candidateDetailHref(c) %>" class="link-detail">Ver -&gt;</a>
                    </div>
                  </div>
                <% } %>
              </div>
            <% } %>
          </div>
        </div>
        <% } else { %>
        <div class="vacancy-body">
          <% if (isScheduling) { %>
"""
view = view.replace(body_open, search_section, 1)

search_start = view.index("        <% if (vacancySearchActive) { %>")
export_anchor = '\n        <div class="export-bar">'
export_index = view.find(export_anchor, search_start)
if export_index < 0:
    raise SystemExit('No se encontró export-bar después de vacancy-body')
view = view[:export_index] + "\n        <% } %>" + view[export_index:]

VIEW_PATH.write_text(view, encoding='utf-8')
