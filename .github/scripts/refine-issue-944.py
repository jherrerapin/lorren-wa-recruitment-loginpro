from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return text.replace(old, new, 1)


admin_path = Path('src/routes/admin.js')
admin = admin_path.read_text(encoding='utf-8')
admin = replace_once(
    admin,
    """        where: {
          ...buildCandidateAccessWhere(accessContext),
          ...(legacyVacancyId ? { vacancyId: legacyVacancyId } : {}),
          ...(legacyCreatedAtWhere ? { createdAt: legacyCreatedAtWhere } : {})
        },
""",
    """        where: {
          AND: [
            buildCandidateAccessWhere(accessContext),
            ...(legacyVacancyId ? [{ vacancyId: legacyVacancyId }] : []),
            ...(legacyCreatedAtWhere ? [{ createdAt: legacyCreatedAtWhere }] : [])
          ]
        },
""",
    'composición segura del alcance en ver todos'
)
admin_path.write_text(admin, encoding='utf-8')


view_path = Path('src/views/list.ejs')
view = view_path.read_text(encoding='utf-8')
view = replace_once(
    view,
    """        appendVacancyFilters(cityUrlParams);
        appendVacancySearches(cityUrlParams);
        const cityUrl = '/admin?' + cityUrlParams.toString();
""",
    """        appendVacancyFilters(cityUrlParams);
        appendVacancySearches(cityUrlParams);
        appendVacancyRegistrationFilters(cityUrlParams);
        const cityUrl = '/admin?' + cityUrlParams.toString();
""",
    'pestaña de ciudad conserva rangos'
)
view_path.write_text(view, encoding='utf-8')


test_path = Path('test/vacancyDashboardSearchExpansion.test.js')
test_source = test_path.read_text(encoding='utf-8')
test_source = replace_once(
    test_source,
    "import assert from 'node:assert/strict';\n",
    "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport ejs from 'ejs';\n",
    'imports de contratos fuente y plantilla'
)
source_contract = r'''

test('ver todos combina la vacante solicitada con el alcance autorizado y conserva fechas entre ciudades', () => {
  const adminSource = fs.readFileSync('src/routes/admin.js', 'utf8');
  const viewSource = fs.readFileSync('src/views/list.ejs', 'utf8');

  assert.match(
    adminSource,
    /AND:\s*\[\s*buildCandidateAccessWhere\(accessContext\),\s*\.\.\.\(legacyVacancyId \? \[\{ vacancyId: legacyVacancyId \}\] : \[\]\)/
  );
  assert.doesNotMatch(
    adminSource,
    /\.\.\.buildCandidateAccessWhere\(accessContext\),\s*\.\.\.\(legacyVacancyId \? \{ vacancyId: legacyVacancyId \}/
  );
  assert.match(
    viewSource,
    /appendVacancySearches\(cityUrlParams\);\s*appendVacancyRegistrationFilters\(cityUrlParams\);/
  );
  assert.match(
    viewSource,
    /params\.set\('vacancyId', vacancyId\);[\s\S]*params\.set\('dateFrom', range\.dateFrom\)/
  );
});

test('la plantilla administrativa compila después de agregar los filtros de fecha', () => {
  const viewSource = fs.readFileSync('src/views/list.ejs', 'utf8');
  assert.doesNotThrow(() => ejs.compile(viewSource, { filename: 'src/views/list.ejs' }));
});
'''
test_source = (test_source.rstrip() + source_contract).rstrip() + '\n'
test_path.write_text(test_source, encoding='utf-8')