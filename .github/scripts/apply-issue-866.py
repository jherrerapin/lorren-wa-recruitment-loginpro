from pathlib import Path

ADMIN_PATH = Path('src/routes/admin.js')
LIST_PATH = Path('src/views/list.ejs')
TEST_PATH = Path('test/adminCandidateDocumentNumberSearch.test.js')

admin = ADMIN_PATH.read_text(encoding='utf-8')

old_candidate_search = """function normalizeCandidateSearch(source = {}) {
  const field = normalizeString(source.searchField);
  const text = normalizeString(source.searchText);
  return {
    field: ['document', 'phone'].includes(field) ? field : 'document',
    text: text || ''
  };
}
"""
new_candidate_search = """function normalizeCandidateSearchField(value) {
  const field = normalizeString(value);
  if (field === 'phone') return 'phone';
  if (field === 'document' || field === 'documentNumber') return 'documentNumber';
  return 'documentNumber';
}

function normalizeCandidateSearch(source = {}) {
  const text = normalizeString(source.searchText);
  return {
    field: normalizeCandidateSearchField(source.searchField),
    text: text || ''
  };
}
"""
if old_candidate_search not in admin:
    raise SystemExit('No se encontró normalizeCandidateSearch esperado')
admin = admin.replace(old_candidate_search, new_candidate_search, 1)

old_vacancy_default = "searchesByVacancyId[vacancyId] = { field: 'document', text: '' };"
new_vacancy_default = "searchesByVacancyId[vacancyId] = { field: 'documentNumber', text: '' };"
if old_vacancy_default not in admin:
    raise SystemExit('No se encontró el valor por defecto de búsqueda por vacante')
admin = admin.replace(old_vacancy_default, new_vacancy_default, 1)

old_vacancy_field = """      const normalizedField = normalizeString(value);
      searchesByVacancyId[vacancyId].field = ['document', 'phone'].includes(normalizedField)
        ? normalizedField
        : 'document';
"""
new_vacancy_field = """      searchesByVacancyId[vacancyId].field = normalizeCandidateSearchField(value);
"""
if old_vacancy_field not in admin:
    raise SystemExit('No se encontró la normalización de búsqueda por vacante')
admin = admin.replace(old_vacancy_field, new_vacancy_field, 1)
admin = admin.replace("if ((search?.field || 'document') === 'phone') {", "if ((search?.field || 'documentNumber') === 'phone') {", 1)
ADMIN_PATH.write_text(admin, encoding='utf-8')

view = LIST_PATH.read_text(encoding='utf-8')

legacy_option = """        <option value="document" <%= (candidateSearch?.field || 'document') === 'document' ? 'selected' : '' %>>Documento</option>"""
legacy_replacement = """        <option value="documentNumber" <%= (candidateSearch?.field || 'documentNumber') === 'documentNumber' ? 'selected' : '' %>>Número de documento</option>"""
if legacy_option not in view:
    raise SystemExit('No se encontró la opción documental del filtro general')
view = view.replace(legacy_option, legacy_replacement, 1)

vacancy_option = """              <option value="document" <%= currentVacancySearch.field === 'document' ? 'selected' : '' %>>Documento</option>"""
vacancy_replacement = """              <option value="documentNumber" <%= currentVacancySearch.field === 'documentNumber' ? 'selected' : '' %>>Número de documento</option>"""
if vacancy_option not in view:
    raise SystemExit('No se encontró la opción documental del filtro por vacante')
view = view.replace(vacancy_option, vacancy_replacement, 1)

view = view.replace("{ field: 'document', text: '' }", "{ field: 'documentNumber', text: '' }")
view = view.replace("<select name=\"searchField\" style=", "<select name=\"searchField\" data-candidate-search-field style=", 1)
view = view.replace("name=\"searchText\" value=\"<%= candidateSearch?.text || '' %>\"", "name=\"searchText\" data-candidate-search-input inputmode=\"numeric\" value=\"<%= candidateSearch?.text || '' %>\"", 1)
view = view.replace("id=\"vacancySearchField_<%= v.id %>\" name=\"vs_<%= v.id %>_field\"", "id=\"vacancySearchField_<%= v.id %>\" name=\"vs_<%= v.id %>_field\" data-candidate-search-field", 1)
view = view.replace("id=\"vacancySearchText_<%= v.id %>\" type=\"text\" name=\"vs_<%= v.id %>_text\"", "id=\"vacancySearchText_<%= v.id %>\" type=\"text\" name=\"vs_<%= v.id %>_text\" data-candidate-search-input inputmode=\"numeric\"", 1)
view = view.replace('placeholder="Documento o celular"', 'placeholder="Escribe el número de documento"', 1)

search_ui_script = """
  <script>
    document.querySelectorAll('[data-candidate-search-field]').forEach((fieldSelect) => {
      const searchInput = fieldSelect.closest('form')?.querySelector('[data-candidate-search-input]');
      if (!searchInput) return;
      const syncCandidateSearchInput = () => {
        const isPhone = fieldSelect.value === 'phone';
        const label = isPhone ? 'número de celular' : 'número de documento';
        searchInput.placeholder = `Escribe el ${label}`;
        searchInput.setAttribute('aria-label', `Buscar por ${label}`);
      };
      fieldSelect.addEventListener('change', syncCandidateSearchInput);
      syncCandidateSearchInput();
    });
  </script>
"""
if 'data-candidate-search-field' not in view:
    raise SystemExit('No se añadieron los atributos de búsqueda esperados')
if search_ui_script.strip() not in view:
    if '</body>' not in view:
        raise SystemExit('No se encontró el cierre body de list.ejs')
    view = view.rsplit('</body>', 1)[0] + search_ui_script + '</body>' + view.rsplit('</body>', 1)[1]
LIST_PATH.write_text(view, encoding='utf-8')

TEST_PATH.write_text("""import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const adminRoute = fs.readFileSync('src/routes/admin.js', 'utf8');
const listView = fs.readFileSync('src/views/list.ejs', 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `No se encontró ${name}`);
  assert.notEqual(end, -1, `No se encontró el límite de ${name}`);
  return source.slice(start, end);
}

test('el filtro documental usa número de documento y conserva el alias antiguo', () => {
  const normalizeSource = functionSource(adminRoute, 'normalizeCandidateSearchField', 'normalizeCandidateSearch');
  const matchSource = functionSource(adminRoute, 'candidateMatchesSearch', 'normalizeGenderInput');

  assert.match(normalizeSource, /field === 'document' \|\| field === 'documentNumber'/);
  assert.match(normalizeSource, /return 'documentNumber'/);
  assert.match(matchSource, /candidate\?\.documentNumber/);
  assert.doesNotMatch(matchSource, /documentType/);
});

test('el panel identifica explícitamente número de documento', () => {
  assert.match(listView, /value="documentNumber"[^>]*>Número de documento<\/option>/);
  assert.doesNotMatch(listView, /value="document"[^>]*>Documento<\/option>/);
  assert.match(listView, /data-candidate-search-field/);
  assert.match(listView, /data-candidate-search-input/);
  assert.match(listView, /Escribe el número de documento/);
});

test('la búsqueda por vacante compara documentNumber y no documentType', () => {
  const matchSource = functionSource(listView, 'candidateMatchesVacancySearch', 'candidateObservationSnippet');
  assert.match(matchSource, /candidate\.documentNumber/);
  assert.doesNotMatch(matchSource, /documentType/);
});
""", encoding='utf-8')
