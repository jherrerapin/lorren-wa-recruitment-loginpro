from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one literal match, found {count}')
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement, flags=0):
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{path}: expected one regex match for {pattern!r}, found {count}')
    write(path, updated)


# Prisma: permiso individual, deny-by-default.
replace_once(
    'prisma/schema.prisma',
    '  canAccessDispatch   Boolean         @default(false)\n  canAccessStatistics Boolean         @default(false)',
    '  canAccessDispatch   Boolean         @default(false)\n  canAccessAttendance Boolean         @default(false)\n  canAccessStatistics Boolean         @default(false)'
)
replace_once(
    'prisma/schema.prisma',
    '  @@index([canAccessDispatch])\n  @@index([canAccessStatistics])',
    '  @@index([canAccessDispatch])\n  @@index([canAccessAttendance])\n  @@index([canAccessStatistics])'
)
write(
    'prisma/migrations/20260724040000_add_attendance_user_access/migration.sql',
    '''ALTER TABLE "AppUser"\nADD COLUMN "canAccessAttendance" BOOLEAN NOT NULL DEFAULT false;\n\nCREATE INDEX "AppUser_canAccessAttendance_idx"\nON "AppUser"("canAccessAttendance");\n'''
)

# Autoridad única de acceso: DEV siempre; ADMIN únicamente con permiso individual activo.
write(
    'src/services/attendanceFeatureAccess.js',
    '''function normalizeString(value) {\n  if (typeof value !== 'string') return null;\n  const normalized = value.trim();\n  return normalized.length ? normalized : null;\n}\n\nfunction requirePrismaModel(prisma, modelName, methodName) {\n  if (!prisma?.[modelName] || typeof prisma[modelName][methodName] !== 'function') {\n    throw new Error(`attendance_access_${modelName}_${methodName}_required`);\n  }\n}\n\nexport async function resolveAttendanceFeatureAccess(prisma, source = {}) {\n  const role = normalizeString(source.userRole || source.role)?.toLowerCase();\n  const username = normalizeString(source.username);\n\n  if (role === 'dev') {\n    return { allowed: true, reason: 'dev' };\n  }\n\n  if (role !== 'admin') {\n    return { allowed: false, reason: 'role_not_allowed' };\n  }\n\n  if (!username) {\n    return { allowed: false, reason: 'user_not_identified' };\n  }\n\n  requirePrismaModel(prisma, 'appUser', 'findUnique');\n  const user = await prisma.appUser.findUnique({\n    where: { username },\n    select: {\n      id: true,\n      role: true,\n      isActive: true,\n      canAccessAttendance: true\n    }\n  });\n\n  if (!user) {\n    return { allowed: false, reason: 'user_not_found' };\n  }\n  if (!user.isActive || String(user.role || '').toUpperCase() !== 'ADMIN') {\n    return { allowed: false, reason: 'user_not_active' };\n  }\n\n  const allowed = user.canAccessAttendance === true;\n  return {\n    allowed,\n    reason: allowed ? 'user_permission_enabled' : 'user_permission_disabled'\n  };\n}\n'''
)

# Bridge de asistencia: retira el interruptor global temporal y conserva guards server-side.
replace_once(
    'src/routes/dispatchBridge.js',
    "import {\n  resolveAttendanceFeatureAccess,\n  setRecruiterGeneralAttendanceEnabled\n} from '../services/attendanceFeatureAccess.js';",
    "import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';"
)
replace_once(
    'src/routes/dispatchBridge.js',
    "    return res.status(403).send('La asistencia operativa esta habilitada temporalmente solo para DEV.');",
    "    return res.status(403).send('No tienes permiso para acceder a Asistencia operativa.');"
)
regex_once(
    'src/routes/dispatchBridge.js',
    r"\nfunction requestIpDetails\(req\) \{.*?\n\}\n\nfunction requestOrigin",
    '\nfunction requestOrigin',
    re.S
)
replace_once(
    'src/routes/dispatchBridge.js',
    '''    req.canAccessAttendanceFeature = access.allowed;\n    req.recruiterGeneralAttendanceEnabled = access.recruiterGeneralEnabled;\n    res.locals.canAccessAttendanceFeature = access.allowed;\n    res.locals.recruiterGeneralAttendanceEnabled = access.recruiterGeneralEnabled;''',
    '''    req.canAccessAttendanceFeature = access.allowed;\n    res.locals.canAccessAttendanceFeature = access.allowed;'''
)
replace_once(
    'src/routes/dispatchBridge.js',
    '''    req.canAccessAttendanceFeature = false;\n    req.recruiterGeneralAttendanceEnabled = false;\n    res.locals.canAccessAttendanceFeature = false;\n    res.locals.recruiterGeneralAttendanceEnabled = false;''',
    '''    req.canAccessAttendanceFeature = false;\n    res.locals.canAccessAttendanceFeature = false;'''
)
regex_once(
    'src/routes/dispatchBridge.js',
    r"\nfunction attendanceDevControlHtml\(enabled\) \{.*?\n\}\n\nfunction normalizeLeafletScriptIntegrity",
    '\nfunction normalizeLeafletScriptIntegrity',
    re.S
)
regex_once(
    'src/routes/dispatchBridge.js',
    r"export function filterAttendanceFeatureHtml\(html, \{ allowed = false, isDev = false, recruiterGeneralEnabled = false \} = \{\}\) \{.*?\n\}\n\nexport function filterAttendanceAdminHtml",
    '''export function filterAttendanceFeatureHtml(html, { allowed = false } = {}) {\n  if (typeof html !== 'string') return html;\n  let output = normalizeLeafletScriptIntegrity(html);\n  output = injectAttendanceMapReliability(output);\n  output = normalizeAttendanceGeocodingEndpoint(output);\n  output = defaultAttendanceEnablement(output);\n\n  if (!allowed) {\n    output = output.replace(\n      /\\s*<details\\s+[^>]*class=["'][^"']*\\battendance-config\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/details>/gi,\n      ''\n    );\n  }\n\n  return output;\n}\n\nexport function filterAttendanceAdminHtml''',
    re.S
)
regex_once(
    'src/routes/dispatchBridge.js',
    r"filterAttendanceFeatureHtml\(html, \{\s*allowed: Boolean\(req\.canAccessAttendanceFeature\),\s*isDev: .*?\s*recruiterGeneralEnabled: Boolean\(req\.recruiterGeneralAttendanceEnabled\)\s*\}\)",
    "filterAttendanceFeatureHtml(html, { allowed: Boolean(req.canAccessAttendanceFeature) })",
    re.S
)
regex_once(
    'src/routes/dispatchBridge.js',
    r"\n  router\.post\(\n    '/asistencia-acceso/reclutador-general',.*?\n  \);\n\n  router\.use\(\n    '/portal-activaciones'",
    "\n  router.use(\n    '/portal-activaciones'",
    re.S
)

# Creación de usuarios: el permiso solo puede ser concedido por DEV y habilita su módulo padre.
replace_once(
    'src/routes/admin.js',
    '  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);\n  return next();',
    '  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);\n  req.canAccessAttendance = Boolean(req.session?.canAccessAttendance);\n  return next();'
)
replace_once(
    'src/routes/admin.js',
    '''        canAccessDispatch: false,\n        canAccessStatistics: false,''',
    '''        canAccessDispatch: false,\n        canAccessAttendance: false,\n        canAccessStatistics: false,'''
)
replace_once(
    'src/routes/admin.js',
    '''    const canAccessDispatch = req.userRole === 'dev' && req.body.canAccessDispatch === 'true';\n    const canAccessMetaAds = req.userRole === 'dev' && req.body.canAccessMetaAds === 'true';''',
    '''    const canAccessAttendance = req.userRole === 'dev' && req.body.canAccessAttendance === 'true';\n    const canAccessDispatch = req.userRole === 'dev'\n      && (req.body.canAccessDispatch === 'true' || canAccessAttendance);\n    const canAccessMetaAds = req.userRole === 'dev' && req.body.canAccessMetaAds === 'true';'''
)
replace_once(
    'src/routes/admin.js',
    '''        canAccessDispatch,\n        canAccessStatistics: canAccessMetaAds || canAccessCvAnalysis,''',
    '''        canAccessDispatch,\n        canAccessAttendance,\n        canAccessStatistics: canAccessMetaAds || canAccessCvAnalysis,'''
)

# Edición de usuarios: solo el bloque DEV puede modificar permisos adicionales.
replace_once(
    'src/routes/locations.js',
    '''        canAccessDispatch: true,\n        canAccessStatistics: true,''',
    '''        canAccessDispatch: true,\n        canAccessAttendance: true,\n        canAccessStatistics: true,'''
)
replace_once(
    'src/routes/locations.js',
    '''    if (req.userRole === 'dev') {\n      data.canAccessDispatch = isChecked(req.body.canAccessDispatch);\n      data.canAccessMetaAds = isChecked(req.body.canAccessMetaAds);''',
    '''    if (req.userRole === 'dev') {\n      data.canAccessAttendance = isChecked(req.body.canAccessAttendance);\n      data.canAccessDispatch = isChecked(req.body.canAccessDispatch) || data.canAccessAttendance;\n      data.canAccessMetaAds = isChecked(req.body.canAccessMetaAds);'''
)

# Sesión y autenticación.
replace_once(
    'src/server.js',
    '''    canAccessDispatch: Boolean(user.canAccessDispatch),\n    canAccessMetaAds: Boolean(user.canAccessMetaAds),''',
    '''    canAccessDispatch: Boolean(user.canAccessDispatch),\n    canAccessAttendance: Boolean(user.canAccessAttendance),\n    canAccessMetaAds: Boolean(user.canAccessMetaAds),'''
)
replace_once(
    'src/server.js',
    '''  req.session.canAccessDispatch = Boolean(payload.canAccessDispatch);\n  req.session.canAccessMetaAds = Boolean(payload.canAccessMetaAds);''',
    '''  req.session.canAccessDispatch = Boolean(payload.canAccessDispatch);\n  req.session.canAccessAttendance = Boolean(payload.canAccessAttendance);\n  req.session.canAccessMetaAds = Boolean(payload.canAccessMetaAds);'''
)
replace_once(
    'src/server.js',
    '''  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);\n  req.canAccessMetaAds = Boolean(req.session?.canAccessMetaAds);''',
    '''  req.canAccessDispatch = Boolean(req.session?.canAccessDispatch);\n  req.canAccessAttendance = Boolean(req.session?.canAccessAttendance);\n  req.canAccessMetaAds = Boolean(req.session?.canAccessMetaAds);'''
)
replace_once(
    'src/server.js',
    '''  res.locals.canAccessDispatch = req.userRole === 'dev' || req.canAccessDispatch;\n  res.locals.canSeeLorenV2 = canSeeLorenV2(req);''',
    '''  res.locals.canAccessDispatch = req.userRole === 'dev' || req.canAccessDispatch;\n  res.locals.canAccessAttendance = req.userRole === 'dev' || req.canAccessAttendance;\n  res.locals.canSeeLorenV2 = canSeeLorenV2(req);'''
)
replace_once(
    'src/server.js',
    '''      canAccessDispatch: true,\n      canAccessMetaAds: true,''',
    '''      canAccessDispatch: true,\n      canAccessAttendance: true,\n      canAccessMetaAds: true,'''
)
replace_once(
    'src/server.js',
    '''         canAccessDispatch: role === 'dev',\n         canAccessMetaAds: role === 'dev',''',
    '''         canAccessDispatch: role === 'dev',\n         canAccessAttendance: role === 'dev',\n         canAccessMetaAds: role === 'dev','''
)

# Refresco inmediato de permisos desde base de datos.
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''      canAccessDispatch: true,\n      canAccessStatistics: true,''',
    '''      canAccessDispatch: true,\n      canAccessAttendance: true,\n      canAccessStatistics: true,'''
)
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''    req.session.canAccessDispatch = false;\n    req.session.canAccessStatistics = false;''',
    '''    req.session.canAccessDispatch = false;\n    req.session.canAccessAttendance = false;\n    req.session.canAccessStatistics = false;'''
)
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''    req.canAccessDispatch = false;\n    req.canAccessStatistics = false;''',
    '''    req.canAccessDispatch = false;\n    req.canAccessAttendance = false;\n    req.canAccessStatistics = false;'''
)
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''  const canAccessDispatch = Boolean(user.canAccessDispatch);\n  // La migración convierte el permiso general anterior en ambos permisos.''',
    '''  const canAccessAttendance = Boolean(user.canAccessAttendance);\n  const canAccessDispatch = Boolean(user.canAccessDispatch) || canAccessAttendance;\n  // La migración convierte el permiso general anterior en ambos permisos.'''
)
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''  req.session.canAccessDispatch = canAccessDispatch;\n  req.session.canAccessStatistics = canAccessStatistics;''',
    '''  req.session.canAccessDispatch = canAccessDispatch;\n  req.session.canAccessAttendance = canAccessAttendance;\n  req.session.canAccessStatistics = canAccessStatistics;'''
)
replace_once(
    'src/services/dispatchAuditMiddleware.js',
    '''  req.canAccessDispatch = canAccessDispatch;\n  req.canAccessStatistics = canAccessStatistics;''',
    '''  req.canAccessDispatch = canAccessDispatch;\n  req.canAccessAttendance = canAccessAttendance;\n  req.canAccessStatistics = canAccessStatistics;'''
)

# Panel de usuarios: crear, listar y editar el permiso únicamente en la vista DEV.
regex_once(
    'src/views/users.ejs',
    r"        <% if \(role === 'dev'\) \{ %><div class=\"form-section\"><h3 class=\"form-section-title\">Permisos del panel</h3>.*?</div><% \} %>",
    '''        <% if (role === 'dev') { %>\n          <div class="form-section">\n            <h3 class="form-section-title">Permisos del panel</h3>\n            <div class="permission-stack">\n              <label class="permission-card" for="canAccessDispatch">\n                <input id="canAccessDispatch" name="canAccessDispatch" type="checkbox" value="true" />\n                <span><strong>Operaciones / Despacho</strong><small>Permite entrar al panel operativo además del alcance de reclutamiento seleccionado.</small></span>\n              </label>\n              <label class="permission-card" for="canAccessAttendance">\n                <input id="canAccessAttendance" name="canAccessAttendance" type="checkbox" value="true" />\n                <span><strong>Asistencia operativa</strong><small>Permite ver y administrar marcaciones, geocercas, evidencias y configuración de puntos. También activa Operaciones / Despacho.</small></span>\n              </label>\n              <div class="statistics-permissions">\n                <strong>Estadísticas</strong><small>Marca únicamente las herramientas que podrá usar este usuario.</small>\n                <label class="dispatch-row"><input name="canAccessMetaAds" type="checkbox" value="true" /><span><strong>Meta Ads</strong><small>Consulta inversión, resultados y costos de los anuncios.</small></span></label>\n                <label class="dispatch-row"><input name="canAccessCvAnalysis" type="checkbox" value="true" /><span><strong>Análisis de hojas de vida</strong><small>Organiza candidatos según la vacante y el perfil buscado.</small></span></label>\n              </div>\n            </div>\n            <p class="hint" style="margin-top:10px;">Solo DEV puede conceder o retirar estos permisos.</p>\n          </div>\n        <% } %>''',
    re.S
)
replace_once(
    'src/views/users.ejs',
    '''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %></td>''',
    '''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessAttendance) { %><small>Asistencia operativa</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %></td>'''
)
regex_once(
    'src/views/users.ejs',
    r"                        <% if \(role === 'dev'\) \{ %><div class=\"field full\"><label>Permisos adicionales</label>.*?</div><% \} %>",
    '''                        <% if (role === 'dev') { %>\n                          <div class="field full">\n                            <label>Permisos adicionales</label>\n                            <label class="dispatch-row"><input id="edit-canAccessDispatch-<%= user.id %>" type="checkbox" name="canAccessDispatch" value="true" <%= user.canAccessDispatch ? 'checked' : '' %> />Acceso a Operaciones / Despacho</label>\n                            <label class="dispatch-row"><input id="edit-canAccessAttendance-<%= user.id %>" type="checkbox" name="canAccessAttendance" value="true" <%= user.canAccessAttendance ? 'checked' : '' %> /><span><strong>Asistencia operativa</strong><small>Panel, revisión, geocerca, evidencia y configuración de puntos.</small></span></label>\n                            <div class="statistics-permissions"><strong>Estadísticas</strong><small>Selecciona por separado las herramientas que podrá abrir.</small><label class="dispatch-row"><input type="checkbox" name="canAccessMetaAds" value="true" <%= user.canAccessMetaAds ? 'checked' : '' %> /><span><strong>Meta Ads</strong><small>Inversión, resultados y costos de los anuncios.</small></span></label><label class="dispatch-row"><input type="checkbox" name="canAccessCvAnalysis" value="true" <%= user.canAccessCvAnalysis ? 'checked' : '' %> /><span><strong>Análisis de hojas de vida</strong><small>Revisión y organización de candidatos con IA.</small></span></label></div>\n                            <span class="hint">Solo DEV puede modificar estos permisos. Asistencia activa también el acceso al módulo padre de Operaciones.</span>\n                          </div>\n                        <% } %>''',
    re.S
)
replace_once(
    'src/views/users.ejs',
    '''    function syncVacancyGroups(userId) {''',
    '''    function bindAttendanceParent(attendanceInput, dispatchInput) {\n      if (!attendanceInput || !dispatchInput) return;\n      const requireDispatch = () => { if (attendanceInput.checked) dispatchInput.checked = true; };\n      attendanceInput.addEventListener('change', requireDispatch);\n      requireDispatch();\n    }\n\n    bindAttendanceParent(\n      document.getElementById('canAccessAttendance'),\n      document.getElementById('canAccessDispatch')\n    );\n    document.querySelectorAll('[id^="edit-canAccessAttendance-"]').forEach((attendanceInput) => {\n      const userId = attendanceInput.id.replace('edit-canAccessAttendance-', '');\n      bindAttendanceParent(attendanceInput, document.getElementById('edit-canAccessDispatch-' + userId));\n    });\n\n    function syncVacancyGroups(userId) {'''
)

# Pruebas unitarias de la autoridad.
write(
    'test/attendanceFeatureAccess.test.js',
    '''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { resolveAttendanceFeatureAccess } from '../src/services/attendanceFeatureAccess.js';\n\ntest('DEV siempre conserva acceso sin consultar usuarios', async () => {\n  const access = await resolveAttendanceFeatureAccess({}, { userRole: 'dev', username: 'devloginpro' });\n  assert.deepEqual(access, { allowed: true, reason: 'dev' });\n});\n\ntest('un rol distinto de ADMIN o DEV queda denegado', async () => {\n  let queried = false;\n  const prisma = { appUser: { async findUnique() { queried = true; } } };\n  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'viewer', username: 'consulta' });\n  assert.deepEqual(access, { allowed: false, reason: 'role_not_allowed' });\n  assert.equal(queried, false);\n});\n\ntest('ADMIN sin identidad queda denegado por defecto', async () => {\n  const access = await resolveAttendanceFeatureAccess({}, { userRole: 'admin' });\n  assert.deepEqual(access, { allowed: false, reason: 'user_not_identified' });\n});\n\ntest('ADMIN activo con permiso individual puede entrar', async () => {\n  const prisma = {\n    appUser: {\n      async findUnique(query) {\n        assert.deepEqual(query, {\n          where: { username: 'reclutador-bogota' },\n          select: { id: true, role: true, isActive: true, canAccessAttendance: true }\n        });\n        return { id: 'u1', role: 'ADMIN', isActive: true, canAccessAttendance: true };\n      }\n    }\n  };\n  const access = await resolveAttendanceFeatureAccess(prisma, {\n    userRole: 'admin',\n    username: 'reclutador-bogota'\n  });\n  assert.deepEqual(access, { allowed: true, reason: 'user_permission_enabled' });\n});\n\ntest('ADMIN activo sin permiso individual queda denegado', async () => {\n  const prisma = {\n    appUser: { async findUnique() { return { id: 'u1', role: 'ADMIN', isActive: true, canAccessAttendance: false }; } }\n  };\n  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'reclutador-general' });\n  assert.deepEqual(access, { allowed: false, reason: 'user_permission_disabled' });\n});\n\ntest('un usuario inactivo queda denegado aunque conserve el permiso', async () => {\n  const prisma = {\n    appUser: { async findUnique() { return { id: 'u1', role: 'ADMIN', isActive: false, canAccessAttendance: true }; } }\n  };\n  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'reclutador-general' });\n  assert.deepEqual(access, { allowed: false, reason: 'user_not_active' });\n});\n\ntest('un ADMIN inexistente queda denegado', async () => {\n  const prisma = { appUser: { async findUnique() { return null; } } };\n  const access = await resolveAttendanceFeatureAccess(prisma, { userRole: 'admin', username: 'desconocido' });\n  assert.deepEqual(access, { allowed: false, reason: 'user_not_found' });\n});\n\ntest('la autoridad falla cerrada si falta el repositorio de usuarios', async () => {\n  await assert.rejects(\n    () => resolveAttendanceFeatureAccess({}, { userRole: 'admin', username: 'reclutador-general' }),\n    /attendance_access_appUser_findUnique_required/\n  );\n});\n'''
)

# Contratos del gate y retiro del interruptor global.
write(
    'test/attendanceFeatureGateContracts.test.js',
    '''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { filterAttendanceFeatureHtml } from '../src/routes/dispatchBridge.js';\n\nconst routeSource = fs.readFileSync(new URL('../src/routes/dispatchBridge.js', import.meta.url), 'utf8');\n\nconst sampleHtml = `<!doctype html><html><body><main class="page"><section>Operaciones</section><details class="crud-details attendance-config"><summary>Configurar asistencia</summary><form action="/admin/operaciones/clientes/c1/operaciones/o1/asistencia"><button>Guardar asistencia</button></form></details></main></body></html>`;\nconst reformattedHtml = `<!doctype html><html><body><main id="operations" data-view="client" class="layout page wide"><details data-module="attendance" class='attendance-config crud-details extra'><summary>Configurar asistencia</summary><form><button>Guardar asistencia</button></form></details></main></body></html>`;\nconst leafletHtmlWithInvalidIntegrity = `<!doctype html><html><body><main class="page"></main><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9coqIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script></body></html>`;\nconst attendanceSearchHtml = `<!doctype html><html><body><main class="page"><details class="attendance-config"><form class="attendance-map-form"><input type="checkbox" name="attendanceEnabled" value="true" /></form></details></main><script>fetch(\`https://nominatim.openstreetmap.org/search?\${params.toString()}\`);</script></body></html>`;\n\ntest('una persona sin permiso no recibe la configuración de asistencia', () => {\n  const output = filterAttendanceFeatureHtml(sampleHtml, { allowed: false });\n  assert.doesNotMatch(output, /attendance-config/);\n  assert.doesNotMatch(output, /Guardar asistencia/);\n});\n\ntest('el ocultamiento tolera atributos, comillas y clases reordenadas', () => {\n  const output = filterAttendanceFeatureHtml(reformattedHtml, { allowed: false });\n  assert.doesNotMatch(output, /attendance-config/);\n});\n\ntest('una persona autorizada conserva la configuración sin controles globales', () => {\n  const output = filterAttendanceFeatureHtml(sampleHtml, { allowed: true });\n  assert.match(output, /attendance-config/);\n  assert.doesNotMatch(output, /data-attendance-dev-control/);\n  assert.doesNotMatch(output, /reclutador-general/);\n});\n\ntest('el HTML entregado corrige el hash oficial de Leaflet 1.9.4', () => {\n  const output = filterAttendanceFeatureHtml(leafletHtmlWithInvalidIntegrity, { allowed: true });\n  assert.match(output, /sha256-20nQCchB9co0qIjJZRGuk2\\/Z9VM\\+kNiyxNV1lvTlZBo=/);\n  assert.doesNotMatch(output, /sha256-20nQCchB9coqIjJZRGuk2\\/Z9VM\\+kNiyxNV1lvTlZBo=/);\n});\n\ntest('el HTML usa el geocodificador interno y prepara la habilitación al guardar', () => {\n  const output = filterAttendanceFeatureHtml(attendanceSearchHtml, { allowed: true });\n  assert.match(output, /\\/admin\\/operaciones\\/asistencia\\/geocodificar\\?\\$\\{params\\.toString\\(\\)\\}/);\n  assert.doesNotMatch(output, /nominatim\\.openstreetmap\\.org\\/search/);\n  assert.match(output, /name="attendanceEnabled" value="true" checked/);\n});\n\ntest('panel, geocodificación y configuración exigen el permiso en servidor', () => {\n  assert.match(routeSource, /router\\.use\\(\\s*['"]\\/asistencia['"]\\s*,\\s*requireOps\\s*,\\s*requireAttendanceAccess\\s*,\\s*dispatchAttendanceAdminRouter\\(prisma\\)/s);\n  assert.match(routeSource, /\\/asistencia\\/geocodificar[\\s\\S]*?requireOps[\\s\\S]*?requireAttendanceAccess[\\s\\S]*?geocodeAttendanceAddress/);\n  assert.match(routeSource, /\\/clientes\\/:clientId\\/operaciones\\/:operationId\\/asistencia[\\s\\S]*?requireOps[\\s\\S]*?requireAttendanceAccess[\\s\\S]*?dispatchAttendancePointConfigRouter/);\n});\n\ntest('las activaciones de dispositivos continúan restringidas a DEV', () => {\n  assert.match(routeSource, /['"]\\/portal-activaciones['"][\\s\\S]*?requireDev[\\s\\S]*?dispatchWorkerPortalActivationAdminRouter/);\n});\n\ntest('se retiró el interruptor global temporal de reclutador-general', () => {\n  assert.doesNotMatch(routeSource, /asistencia-acceso\\/reclutador-general/);\n  assert.doesNotMatch(routeSource, /setRecruiterGeneralAttendanceEnabled/);\n  assert.doesNotMatch(routeSource, /attendanceDevControlHtml/);\n});\n\ntest('el control se carga con denegación segura cuando falla la persistencia', () => {\n  assert.match(routeSource, /ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED/);\n  assert.match(routeSource, /req\\s*\\.\\s*canAccessAttendanceFeature\\s*=\\s*false/);\n  assert.match(routeSource, /res\\s*\\.\\s*locals\\s*\\.\\s*canAccessAttendanceFeature\\s*=\\s*false/);\n});\n\ntest('el wrapper normaliza la firma res.render(view, callback)', () => {\n  assert.match(routeSource, /typeof\\s+locals\\s*===\\s*['"]function['"]/);\n  assert.match(routeSource, /renderCallback\\s*=\\s*locals/);\n  assert.match(routeSource, /renderLocals\\s*=\\s*\\{\\s*\\}/);\n});\n'''
)

# Contrato transversal de persistencia, sesión y UI DEV-only.
write(
    'test/attendanceUserPermissionContracts.test.js',
    '''import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');\nconst migration = fs.readFileSync(new URL('../prisma/migrations/20260724040000_add_attendance_user_access/migration.sql', import.meta.url), 'utf8');\nconst server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');\nconst admin = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');\nconst locations = fs.readFileSync(new URL('../src/routes/locations.js', import.meta.url), 'utf8');\nconst audit = fs.readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');\nconst users = fs.readFileSync(new URL('../src/views/users.ejs', import.meta.url), 'utf8');\n\ntest('el permiso se persiste con denegación por defecto e índice', () => {\n  assert.match(schema, /canAccessAttendance\\s+Boolean\\s+@default\\(false\\)/);\n  assert.match(schema, /@@index\\(\\[canAccessAttendance\\]\\)/);\n  assert.match(migration, /ADD COLUMN "canAccessAttendance" BOOLEAN NOT NULL DEFAULT false/);\n  assert.match(migration, /AppUser_canAccessAttendance_idx/);\n});\n\ntest('autenticación, sesión y refresco transportan el permiso', () => {\n  assert.match(server, /canAccessAttendance: Boolean\\(user\\.canAccessAttendance\\)/);\n  assert.match(server, /req\\.session\\.canAccessAttendance = Boolean\\(payload\\.canAccessAttendance\\)/);\n  assert.match(server, /canAccessAttendance: true/);\n  assert.match(audit, /canAccessAttendance: true/);\n  assert.match(audit, /req\\.session\\.canAccessAttendance = canAccessAttendance/);\n  assert.match(audit, /req\\.canAccessAttendance = canAccessAttendance/);\n});\n\ntest('solo DEV interpreta checkboxes de permisos al crear y editar', () => {\n  assert.match(admin, /const canAccessAttendance = req\\.userRole === 'dev'/);\n  assert.match(admin, /canAccessDispatch = req\\.userRole === 'dev'[\\s\\S]*canAccessAttendance/);\n  assert.match(locations, /if \\(req\\.userRole === 'dev'\\) \\{[\\s\\S]*data\\.canAccessAttendance = isChecked\\(req\\.body\\.canAccessAttendance\\)/);\n  assert.match(locations, /data\\.canAccessDispatch = isChecked\\(req\\.body\\.canAccessDispatch\\) \\|\\| data\\.canAccessAttendance/);\n});\n\ntest('el panel DEV permite crear y editar Asistencia como permiso individual', () => {\n  assert.match(users, /role === 'dev'[\\s\\S]*name="canAccessAttendance"/);\n  assert.match(users, /edit-canAccessAttendance-/);\n  assert.match(users, /Asistencia operativa/);\n  assert.match(users, /Solo DEV puede conceder o retirar estos permisos/);\n  assert.match(users, /user\\.canAccessAttendance/);\n});\n'''
)

# Documentación de la nueva autoridad.
write(
    'docs/architecture/11_asistencia_operativa_acceso_temporal.md',
    '''# Asistencia operativa: permiso individual administrado por DEV\n\n## Política\n\nLa función de Asistencia se rige por denegación predeterminada y menor privilegio:\n\n- `DEV` conserva acceso completo;\n- un usuario `ADMIN` solo puede entrar cuando su registro activo en `AppUser` tenga `canAccessAttendance = true`;\n- el permiso se concede o retira únicamente desde el panel de Usuarios por una sesión `DEV`;\n- conocer o escribir una URL directa no evita la autorización del servidor.\n\nEl permiso anterior, basado en un interruptor global temporal para `reclutador-general`, deja de ser autoridad. Los eventos históricos pueden conservarse como auditoría, pero no conceden acceso.\n\n## Alcance del permiso\n\n`canAccessAttendance` protege conjuntamente:\n\n- el botón y el panel de Asistencia;\n- revisión, validación, rechazo y corrección manual auditada;\n- consulta de fotografías y evidencia;\n- visualización de ubicación, geocerca y precisión;\n- geocodificación interna;\n- configuración de asistencia en los puntos operativos.\n\nComo Asistencia pertenece a Operaciones / Despacho, habilitarla también deja activo `canAccessDispatch`. No modifica ciudades, vacantes ni alcance de reclutamiento.\n\n## Funciones reservadas a DEV\n\nLa emisión de enlaces de activación del Portal del Auxiliar permanece exclusivamente para `DEV`. Esos enlaces autorizan un dispositivo primario y no forman parte del permiso administrativo ordinario de revisión de asistencia.\n\n## Autoridad\n\n`src/services/attendanceFeatureAccess.js` es la autoridad única. Para usuarios no DEV consulta el registro vigente de `AppUser` por username y exige simultáneamente:\n\n1. rol de sesión `admin`;\n2. usuario existente;\n3. usuario activo;\n4. rol persistido `ADMIN`;\n5. `canAccessAttendance` estrictamente verdadero.\n\nAnte errores de persistencia, ausencia de identidad o campos faltantes, el acceso se deniega.\n\n## Persistencia y sesión\n\nLa columna `AppUser.canAccessAttendance` inicia en `false`. El login la copia a la sesión y `dispatchAuditMiddleware` la refresca desde base de datos en cada solicitud administrativa relevante, por lo que una revocación no depende de que el usuario cierre sesión.\n\n## Interfaz DEV\n\nEl panel de Usuarios muestra Asistencia dentro de `Permisos del panel`, tanto al crear como al editar. Los checkboxes no se renderizan para administradores no DEV y el backend ignora cualquier intento de esos actores por enviar manualmente los campos de permisos.\n\n## Protección en servidor\n\n`requireAttendanceAccess` se ejecuta en el panel, geocodificación y configuración por punto. Ocultar el botón es solo una ayuda visual; la decisión efectiva siempre se toma en el servidor.\n\n## Rollback\n\nRevertir el PR retira la autoridad y la UI nuevas. Si la migración ya fue aplicada, la columna puede permanecer sin uso durante el rollback; no contiene datos operativos ni modifica asistencias existentes.\n'''
)

print('Attendance user permission patch applied successfully.')
