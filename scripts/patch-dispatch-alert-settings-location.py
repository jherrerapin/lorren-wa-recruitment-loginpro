from pathlib import Path

ROOT = Path('.')


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, content):
    (ROOT / path).write_text(content, encoding='utf-8')


def replace_once(path, old, new):
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'Expected one match in {path}, found {count}: {old[:100]!r}')
    write(path, content.replace(old, new, 1))


# 1) Remove dispatch alert settings from generic user administration.
replace_once(
    'src/routes/admin.js',
    '''function normalizeDispatchAlertPhoneInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return null;\n  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n  return /^3\\d{9}$/.test(local) ? `57${local}` : null;\n}\n\n''',
    ''
)

replace_once(
    'src/routes/admin.js',
    '''    const dispatchAlertPhoneRaw = normalizeString(req.body.dispatchAlertPhone);\n    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(dispatchAlertPhoneRaw);\n    const dispatchWindowExpiryReminderEnabled = req.body.dispatchWindowExpiryReminderEnabled === 'true';\n    if (dispatchAlertPhoneRaw && !dispatchAlertPhone) {\n      return res.redirect('/admin/users?error=' + encodeURIComponent('El WhatsApp de alertas debe ser un celular colombiano válido.'));\n    }\n    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {\n      return res.redirect('/admin/users?error=' + encodeURIComponent('Configura el WhatsApp de alertas antes de activar el recordatorio de ventana.'));\n    }\n''',
    ''
)

replace_once(
    'src/routes/admin.js',
    '''        recoveryPhone: normalizeString(req.body.recoveryPhone),\n        recoveryEmail: normalizeString(req.body.recoveryEmail),\n        dispatchAlertPhone,\n        dispatchWindowExpiryReminderEnabled,\n        createdByUsername: req.username || req.userRole || 'system',''',
    '''        recoveryPhone: normalizeString(req.body.recoveryPhone),\n        recoveryEmail: normalizeString(req.body.recoveryEmail),\n        createdByUsername: req.username || req.userRole || 'system','''
)

replace_once(
    'src/routes/locations.js',
    '''function normalizeDispatchAlertPhoneInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return null;\n  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n  return /^3\\d{9}$/.test(local) ? `57${local}` : null;\n}\n\n''',
    ''
)

replace_once(
    'src/routes/locations.js',
    '''    const dispatchAlertPhoneRaw = normalize(req.body.dispatchAlertPhone);\n    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(dispatchAlertPhoneRaw);\n    const dispatchWindowExpiryReminderEnabled = isChecked(req.body.dispatchWindowExpiryReminderEnabled);\n    if (dispatchAlertPhoneRaw && !dispatchAlertPhone) {\n      return res.redirect(usersRedirect('error', 'El WhatsApp de alertas debe ser un celular colombiano válido.', user.username));\n    }\n    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {\n      return res.redirect(usersRedirect('error', 'Configura el WhatsApp de alertas antes de activar el recordatorio de ventana.', user.username));\n    }\n\n    const data = {\n      accessScope: accessUpdate.accessScope,\n      scopeCity: accessUpdate.scopeCity,\n      scopeVacancyId: accessUpdate.scopeVacancyId,\n      recoveryPhone: normalize(req.body.recoveryPhone),\n      recoveryEmail: normalize(req.body.recoveryEmail),\n      dispatchAlertPhone,\n      dispatchWindowExpiryReminderEnabled\n    };''',
    '''    const data = {\n      accessScope: accessUpdate.accessScope,\n      scopeCity: accessUpdate.scopeCity,\n      scopeVacancyId: accessUpdate.scopeVacancyId,\n      recoveryPhone: normalize(req.body.recoveryPhone),\n      recoveryEmail: normalize(req.body.recoveryEmail)\n    };'''
)

replace_once(
    'src/views/users.ejs',
    '''        <div class="form-section">\n          <h3 class="form-section-title">Alertas de despacho por WhatsApp</h3>\n          <div class="grid">\n            <div class="field full"><label for="dispatchAlertPhone">WhatsApp del administrador para alertas</label><input id="dispatchAlertPhone" name="dispatchAlertPhone" type="tel" inputmode="numeric" placeholder="3001234567" /><span class="hint">Número independiente del teléfono de recuperación. Recibe novedades operativas como NO PUEDO.</span></div>\n            <div class="field full"><label class="dispatch-row" for="dispatchWindowExpiryReminderEnabled"><input id="dispatchWindowExpiryReminderEnabled" name="dispatchWindowExpiryReminderEnabled" type="checkbox" value="true" /><span><strong>Recordarme antes de que venza la ventana de 24 horas</strong><small>Envía un aviso por WhatsApp aproximadamente 20 minutos antes del vencimiento de la ventana de cada auxiliar gestionado por este usuario.</small></span></label></div>\n          </div>\n          <p class="hint" style="margin-top:10px;">El número de alertas también está sujeto a las reglas de ventana de WhatsApp de Meta para mensajes libres.</p>\n        </div>\n''',
    ''
)

replace_once(
    'src/views/users.ejs',
    '''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessAttendance) { %><small>Asistencia operativa</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %><% if (user.dispatchAlertPhone) { %><small>Alertas despacho: <%= user.dispatchAlertPhone %></small><small>Recordatorio ventana: <%= user.dispatchWindowExpiryReminderEnabled ? 'Activo' : 'Inactivo' %></small><% } %></td>''',
    '''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessAttendance) { %><small>Asistencia operativa</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %></td>'''
)

replace_once(
    'src/views/users.ejs',
    '''                        <div class="field"><label for="edit-dispatchAlertPhone-<%= user.id %>">WhatsApp del administrador para alertas</label><input id="edit-dispatchAlertPhone-<%= user.id %>" name="dispatchAlertPhone" type="tel" inputmode="numeric" value="<%= user.dispatchAlertPhone || '' %>" placeholder="3001234567" /></div>\n                        <div class="field full"><label class="dispatch-row" for="edit-dispatchWindowExpiryReminderEnabled-<%= user.id %>"><input id="edit-dispatchWindowExpiryReminderEnabled-<%= user.id %>" name="dispatchWindowExpiryReminderEnabled" type="checkbox" value="true" <%= user.dispatchWindowExpiryReminderEnabled ? 'checked' : '' %> /><span><strong>Recordarme antes de que venza la ventana de 24 horas</strong><small>Alerta por WhatsApp aproximadamente 20 minutos antes del vencimiento.</small></span></label></div>\n''',
    ''
)

# 2) Make the setting self-service inside the dispatch dashboard.
replace_once(
    'src/routes/dispatchDashboardMetrics.js',
    '''function normalizeString(value) {\n  if (typeof value !== 'string') return null;\n  const trimmed = value.trim();\n  return trimmed.length ? trimmed : null;\n}\n\n''',
    '''function normalizeString(value) {\n  if (typeof value !== 'string') return null;\n  const trimmed = value.trim();\n  return trimmed.length ? trimmed : null;\n}\n\nfunction normalizeDispatchAlertPhoneInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return null;\n  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n  return /^3\\d{9}$/.test(local) ? `57${local}` : null;\n}\n\nfunction dispatchAlertPhoneForInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  return digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n}\n\nasync function findCurrentDispatchAppUser(prisma, req) {\n  const userId = normalizeString(req.session?.userId || req.userId);\n  if (userId) {\n    const byId = await prisma.appUser.findUnique({ where: { id: userId } });\n    if (byId) return byId;\n  }\n  const username = normalizeString(req.session?.username || req.username);\n  if (!username) return null;\n  return prisma.appUser.findUnique({ where: { username } });\n}\n\nasync function loadCurrentDispatchAlertSettings(prisma, req) {\n  const user = await findCurrentDispatchAppUser(prisma, req);\n  return {\n    available: Boolean(user),\n    phone: dispatchAlertPhoneForInput(user?.dispatchAlertPhone),\n    reminderEnabled: Boolean(user?.dispatchWindowExpiryReminderEnabled)\n  };\n}\n\n'''
)

replace_once(
    'src/routes/dispatchDashboardMetrics.js',
    '''function renderHome(res, req, selectedDate, requests, attendanceAccess) {\n  const metrics = buildOperationsDashboardMetrics(requests);\n  return res.render('operacionesDashboard', {\n    role: req.session?.userRole || req.userRole,\n    pageTitle: 'Operaciones / Despacho',\n    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',\n    activeSection: 'dashboard',\n    selectedDate,\n    metrics,\n    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch),\n    canAccessAttendanceFeature: Boolean(attendanceAccess?.allowed)\n  });\n}\n''',
    '''function renderHome(res, req, selectedDate, requests, attendanceAccess, dispatchAlertSettings) {\n  const metrics = buildOperationsDashboardMetrics(requests);\n  return res.render('operacionesDashboard', {\n    role: req.session?.userRole || req.userRole,\n    pageTitle: 'Operaciones / Despacho',\n    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',\n    activeSection: 'dashboard',\n    selectedDate,\n    metrics,\n    dispatchAlertSettings,\n    alertSettingsMessage: normalizeString(req.query.alertSettingsMessage),\n    alertSettingsError: normalizeString(req.query.alertSettingsError),\n    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch),\n    canAccessAttendanceFeature: Boolean(attendanceAccess?.allowed)\n  });\n}\n'''
)

replace_once(
    'src/routes/dispatchDashboardMetrics.js',
    '''  router.get('/', requireOps, async (req, res) => {\n    const selectedDate = selectedDateFromQuery(req.query);\n    const [requests, attendanceAccess] = await Promise.all([\n      loadServiceRequestsForDate(prisma, selectedDate),\n      loadAttendanceAccessForDashboard(prisma, req)\n    ]);\n    return renderHome(res, req, selectedDate, requests, attendanceAccess);\n  });\n\n  router.get('/resumen', requireOps, async (req, res) => {''',
    '''  router.get('/', requireOps, async (req, res) => {\n    const selectedDate = selectedDateFromQuery(req.query);\n    const [requests, attendanceAccess, dispatchAlertSettings] = await Promise.all([\n      loadServiceRequestsForDate(prisma, selectedDate),\n      loadAttendanceAccessForDashboard(prisma, req),\n      loadCurrentDispatchAlertSettings(prisma, req)\n    ]);\n    return renderHome(res, req, selectedDate, requests, attendanceAccess, dispatchAlertSettings);\n  });\n\n  router.post('/alertas-whatsapp', requireOps, express.urlencoded({ extended: false }), async (req, res) => {\n    const selectedDate = selectedDateFromQuery({ fecha: req.body?.fecha });\n    const redirectWith = (key, message) => {\n      const params = new URLSearchParams({ fecha: selectedDate, [key]: message });\n      return res.redirect(`/admin/operaciones?${params.toString()}`);\n    };\n\n    const rawPhone = normalizeString(req.body?.dispatchAlertPhone);\n    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(rawPhone);\n    const dispatchWindowExpiryReminderEnabled = req.body?.dispatchWindowExpiryReminderEnabled === 'true';\n    if (rawPhone && !dispatchAlertPhone) {\n      return redirectWith('alertSettingsError', 'El WhatsApp de alertas debe ser un celular colombiano válido.');\n    }\n    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {\n      return redirectWith('alertSettingsError', 'Configura un WhatsApp de alertas antes de activar el recordatorio de ventana.');\n    }\n\n    const user = await findCurrentDispatchAppUser(prisma, req);\n    if (!user) {\n      return redirectWith('alertSettingsError', 'No fue posible identificar tu usuario para guardar esta configuración.');\n    }\n\n    await prisma.appUser.update({\n      where: { id: user.id },\n      data: { dispatchAlertPhone, dispatchWindowExpiryReminderEnabled }\n    });\n    return redirectWith('alertSettingsMessage', 'Configuración de alertas de despacho guardada.');\n  });\n\n  router.get('/resumen', requireOps, async (req, res) => {'''
)

# 3) Add the editable section to the dispatch home view.
replace_once(
    'src/views/operacionesDashboard.ejs',
    '''    .programming-note { color: var(--muted); font-size: 12px; line-height: 1.45; }\n    .async-toast{position:fixed;right:18px;bottom:18px;max-width:360px;background:#172033;color:#fff;border-radius:14px;padding:11px 13px;box-shadow:var(--shadow);font-size:13px;line-height:1.35;z-index:9999;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}.async-toast.show{opacity:1;transform:translateY(0)}''',
    '''    .programming-note { color: var(--muted); font-size: 12px; line-height: 1.45; }\n    .dispatch-alert-settings { background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow-sm); padding:18px; display:grid; gap:14px; }\n    .dispatch-alert-settings-head { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; flex-wrap:wrap; }\n    .dispatch-alert-settings h2 { margin:0 0 4px; color:var(--navy); font-size:18px; }\n    .dispatch-alert-settings p { margin:0; color:var(--muted); font-size:13px; line-height:1.45; }\n    .dispatch-alert-settings-form { display:grid; grid-template-columns:minmax(220px, 360px) minmax(260px, 1fr) auto; gap:12px; align-items:end; }\n    .dispatch-alert-settings-form .field label { display:block; color:var(--navy); font-size:12px; font-weight:900; margin-bottom:5px; }\n    .dispatch-alert-settings-form input[type="tel"] { width:100%; border:1px solid var(--border); border-radius:10px; padding:10px 11px; font:inherit; }\n    .dispatch-alert-reminder { display:flex; gap:9px; align-items:flex-start; padding:10px 12px; border:1px solid #bfdbfe; background:#eff6ff; border-radius:12px; color:#1e3a8a; min-height:42px; }\n    .dispatch-alert-reminder input { margin-top:2px; width:17px; height:17px; accent-color:var(--teal); }\n    .dispatch-alert-reminder strong { display:block; font-size:12px; }\n    .dispatch-alert-reminder small { display:block; margin-top:2px; color:#475569; font-size:11px; line-height:1.3; }\n    .dispatch-settings-alert { border-radius:10px; padding:10px 12px; font-size:12px; font-weight:800; }\n    .dispatch-settings-alert.success { background:#dcfce7; color:#166534; }\n    .dispatch-settings-alert.error { background:#fee2e2; color:#991b1b; }\n    @media (max-width: 900px) { .dispatch-alert-settings-form { grid-template-columns:1fr; } }\n    .async-toast{position:fixed;right:18px;bottom:18px;max-width:360px;background:#172033;color:#fff;border-radius:14px;padding:11px 13px;box-shadow:var(--shadow);font-size:13px;line-height:1.35;z-index:9999;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}.async-toast.show{opacity:1;transform:translateY(0)}'''
)

replace_once(
    'src/views/operacionesDashboard.ejs',
    '''    </section>\n\n    <section class="dashboard-toolbar" aria-label="Filtro de fecha del panel operativo">''',
    '''    </section>\n\n    <section class="dispatch-alert-settings" aria-label="Configuración personal de alertas de despacho por WhatsApp">\n      <div class="dispatch-alert-settings-head">\n        <div>\n          <h2>Mis alertas de despacho por WhatsApp</h2>\n          <p>Configura el número al que quieres recibir novedades de tus auxiliares. Puedes cambiarlo en cualquier momento desde aquí.</p>\n        </div>\n      </div>\n      <% if (alertSettingsMessage) { %><div class="dispatch-settings-alert success"><%= alertSettingsMessage %></div><% } %>\n      <% if (alertSettingsError) { %><div class="dispatch-settings-alert error"><%= alertSettingsError %></div><% } %>\n      <% if (dispatchAlertSettings?.available) { %>\n        <form class="dispatch-alert-settings-form" method="post" action="/admin/operaciones/alertas-whatsapp">\n          <input type="hidden" name="fecha" value="<%= selectedDate %>" />\n          <div class="field">\n            <label for="dispatchAlertPhone">WhatsApp para mis alertas de despacho</label>\n            <input id="dispatchAlertPhone" name="dispatchAlertPhone" type="tel" inputmode="numeric" value="<%= dispatchAlertSettings.phone || '' %>" placeholder="3001234567" />\n          </div>\n          <label class="dispatch-alert-reminder" for="dispatchWindowExpiryReminderEnabled">\n            <input id="dispatchWindowExpiryReminderEnabled" name="dispatchWindowExpiryReminderEnabled" type="checkbox" value="true" <%= dispatchAlertSettings.reminderEnabled ? 'checked' : '' %> />\n            <span><strong>Recordarme antes de que venza la ventana de 24 horas</strong><small>Si está activo, recibirás el aviso aproximadamente 25 minutos antes. Las novedades NO PUEDO se notifican aunque este check esté apagado.</small></span>\n          </label>\n          <button class="btn btn-primary" type="submit">Guardar cambios</button>\n        </form>\n      <% } else { %>\n        <div class="dispatch-settings-alert error">No fue posible asociar esta configuración a tu usuario. Puedes seguir usando Despacho, pero las alertas personales no podrán guardarse hasta resolver el perfil.</div>\n      <% } %>\n    </section>\n\n    <section class="dashboard-toolbar" aria-label="Filtro de fecha del panel operativo">'''
)

# 4) Update regression contract to enforce the new ownership/location.
replace_once(
    'test/dispatchWhatsappAdminAlerts.test.js',
    '''test('usuario tiene WhatsApp de alertas y check independiente de recordatorio de ventana', () => {\n  const schema = read('prisma/schema.prisma');\n  const view = read('src/views/users.ejs');\n  const admin = read('src/routes/admin.js');\n  const locations = read('src/routes/locations.js');\n  assert.match(schema, /dispatchAlertPhone\\s+String\\?/);\n  assert.match(schema, /dispatchWindowExpiryReminderEnabled\\s+Boolean\\s+@default\\(false\\)/);\n  assert.match(view, /name="dispatchAlertPhone"/);\n  assert.match(view, /name="dispatchWindowExpiryReminderEnabled"/);\n  assert.match(view, /Recordarme antes de que venza la ventana de 24 horas/);\n  assert.match(admin, /dispatchAlertPhone,/);\n  assert.match(admin, /dispatchWindowExpiryReminderEnabled,/);\n  assert.match(locations, /dispatchAlertPhone,/);\n  assert.match(locations, /dispatchWindowExpiryReminderEnabled/);\n});''',
    '''test('cada usuario configura sus alertas dentro de Despacho y no desde administración de usuarios', () => {\n  const schema = read('prisma/schema.prisma');\n  const usersView = read('src/views/users.ejs');\n  const admin = read('src/routes/admin.js');\n  const locations = read('src/routes/locations.js');\n  const dashboard = read('src/views/operacionesDashboard.ejs');\n  const dashboardRoute = read('src/routes/dispatchDashboardMetrics.js');\n  assert.match(schema, /dispatchAlertPhone\\s+String\\?/);\n  assert.match(schema, /dispatchWindowExpiryReminderEnabled\\s+Boolean\\s+@default\\(false\\)/);\n  assert.doesNotMatch(usersView, /name="dispatchAlertPhone"/);\n  assert.doesNotMatch(usersView, /name="dispatchWindowExpiryReminderEnabled"/);\n  assert.doesNotMatch(admin, /normalizeDispatchAlertPhoneInput/);\n  assert.doesNotMatch(locations, /normalizeDispatchAlertPhoneInput/);\n  assert.match(dashboard, /Mis alertas de despacho por WhatsApp/);\n  assert.match(dashboard, /action="\\/admin\\/operaciones\\/alertas-whatsapp"/);\n  assert.match(dashboard, /name="dispatchAlertPhone"/);\n  assert.match(dashboard, /name="dispatchWindowExpiryReminderEnabled"/);\n  assert.match(dashboard, /Guardar cambios/);\n  assert.match(dashboardRoute, /router\\.post\\('\/alertas-whatsapp'/);\n  assert.match(dashboardRoute, /findCurrentDispatchAppUser/);\n  assert.match(dashboardRoute, /prisma\\.appUser\\.update/);\n});'''
)

print('dispatch alert settings relocation patch applied')
