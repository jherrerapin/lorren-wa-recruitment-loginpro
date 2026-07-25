from pathlib import Path
import re

files = {}


def read(path):
    text = Path(path).read_text(encoding='utf-8')
    files[path] = text
    return text


def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {text.count(old)}')
    return text.replace(old, new, 1)


def sub_once(text, pattern, replacement, label, flags=0):
    result, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 sustitución y se encontraron {count}')
    return result

# 1. Prisma schema
path = 'prisma/schema.prisma'
text = read(path)
text = replace_once(
    text,
    '  isActive          Boolean                  @default(true)\n  createdByUsername String?',
    '  isActive          Boolean                  @default(true)\n  isTestClient      Boolean                  @default(false)\n  createdByUsername String?',
    'schema DispatchClient.isTestClient'
)
files[path] = text

# 2. Client creation/edit authority
path = 'src/routes/publicDispatchClient.js'
text = read(path)
text = replace_once(
    text,
    "    isActive: normalizeString(body.isActive) !== 'false'\n",
    "    isActive: normalizeString(body.isActive) !== 'false',\n    isTestClient: normalizeString(body.isTestClient) === 'true'\n",
    'public client data'
)
files[path] = text

# 3. Legacy/core routes and server-side edit policy
path = 'src/routes/dispatchBridgeCore.js'
text = read(path)
text = replace_once(
    text,
    "import { normalizeTransportMode, uniqueNormalizedTransportModes } from '../services/transportMode.js';\n",
    "import { normalizeTransportMode, uniqueNormalizedTransportModes } from '../services/transportMode.js';\nimport {\n  DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE,\n  dispatchServiceRequestPolicyInclude,\n  isDispatchServiceRequestEditLocked\n} from '../services/dispatchServiceRequestPolicy.js';\n",
    'bridge policy import'
)
text = replace_once(
    text,
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', createdByUsername:",
    "notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', isTestClient: normalizeString(req.body.isTestClient) === 'true', createdByUsername:",
    'bridge create client test flag'
)
text = replace_once(
    text,
    "contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false' } }); return res.redirect(`/admin/operaciones/clientes?message=",
    "contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', isTestClient: normalizeString(req.body.isTestClient) === 'true' } }); return res.redirect(`/admin/operaciones/clientes?message=",
    'bridge edit client test flag'
)
old_get = "  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => { const [serviceRequest, clients] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.id }, include: { service: true } }), loadRequestFormClients()]); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); return res.render('operacionesSolicitudEditar', { serviceRequest, clients, role: req.session?.userRole || req.userRole }); });"
new_get = """  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const [serviceRequest, clients] = await Promise.all([
      prisma.dispatchServiceRequest.findUnique({
        where: { id: req.params.id },
        include: { ...dispatchServiceRequestPolicyInclude(), service: true }
      }),
      loadRequestFormClients()
    ]);
    if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');
    if (isDispatchServiceRequestEditLocked(serviceRequest)) {
      return res.status(409).send(DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE);
    }
    return res.render('operacionesSolicitudEditar', { serviceRequest, clients, role: req.session?.userRole || req.userRole });
  });"""
text = replace_once(text, old_get, new_get, 'bridge edit GET authority')
old_post = "  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => { const requiredWorkersRaw = Number(req.body.requiredWorkers); if (!Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Cantidad de auxiliares inválida.'); const selection = await resolveRequestSelection(req.body); if (selection.error) return res.status(400).send(selection.error); let requestTimes; try { requestTimes = resolveRequestTimes(req.body); } catch (error) { return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.'); } await prisma.dispatchServiceRequest.update({ where: { id: req.params.id }, data: { operationPointId: selection.operationPoint.id, clientName: selection.client.name, operationPointName: selection.operationPoint.name, cityName: selection.operationPoint.cityName || selection.client.cityName, address: selection.operationPoint.address, ...serviceRequestServiceData(selection.selectedService), serviceDate: new Date(req.body.serviceDate), ...requestTimes, requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: normalizeString(req.body.status) || 'PENDING_ASSIGNMENT' } }); await recalculateServiceRequestStatus(req.params.id); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${req.params.id}`); });"
new_post = """  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const currentRequest = await prisma.dispatchServiceRequest.findUnique({
      where: { id: req.params.id },
      include: dispatchServiceRequestPolicyInclude()
    });
    if (!currentRequest) return res.status(404).send('Solicitud no encontrada');
    if (isDispatchServiceRequestEditLocked(currentRequest)) {
      return res.status(409).send(DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE);
    }
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    if (!Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Cantidad de auxiliares inválida.');
    const selection = await resolveRequestSelection(req.body);
    if (selection.error) return res.status(400).send(selection.error);
    let requestTimes;
    try { requestTimes = resolveRequestTimes(req.body); } catch (error) { return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.'); }
    await prisma.dispatchServiceRequest.update({
      where: { id: req.params.id },
      data: {
        operationPointId: selection.operationPoint.id,
        clientName: selection.client.name,
        operationPointName: selection.operationPoint.name,
        cityName: selection.operationPoint.cityName || selection.client.cityName,
        address: selection.operationPoint.address,
        ...serviceRequestServiceData(selection.selectedService),
        serviceDate: new Date(req.body.serviceDate),
        ...requestTimes,
        requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)),
        notes: normalizeString(req.body.notes),
        status: normalizeString(req.body.status) || 'PENDING_ASSIGNMENT'
      }
    });
    await recalculateServiceRequestStatus(req.params.id);
    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${req.params.id}`);
  });"""
text = replace_once(text, old_post, new_post, 'bridge edit POST authority')
files[path] = text

# 4. Canonical delete route
path = 'src/routes/dispatchOpsExtras.js'
text = read(path)
text = replace_once(
    text,
    "import { recalculateDispatchServiceRequestStatus } from '../services/dispatchOperationalCoverage.js';\n",
    "import { recalculateDispatchServiceRequestStatus } from '../services/dispatchOperationalCoverage.js';\nimport {\n  DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE,\n  deleteDispatchServiceRequest\n} from '../services/dispatchServiceRequestPolicy.js';\n",
    'extras policy import'
)
old_delete = "  router.post('/solicitudes/:serviceRequestId/eliminar', requireOps, async (req, res) => { const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.serviceRequestId }, select: { id: true } }); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); await prisma.dispatchServiceRequest.delete({ where: { id: serviceRequest.id } }); return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent('Solicitud eliminada.')}`);\n  });"
new_delete = """  router.post('/solicitudes/:serviceRequestId/eliminar', requireOps, async (req, res) => {
    const result = await deleteDispatchServiceRequest(prisma, req.params.serviceRequestId);
    if (result.reason === 'not_found') return res.status(404).send('Solicitud no encontrada');
    if (result.reason === 'locked') return res.status(409).send(DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE);
    const message = result.policy?.isTestClient
      ? 'Solicitud de prueba eliminada permanentemente.'
      : 'Solicitud eliminada.';
    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent(message)}`);
  });"""
text = replace_once(text, old_delete, new_delete, 'canonical delete route')
files[path] = text

# 5. Dashboard policy presentation
path = 'src/routes/dispatchDashboardMetrics.js'
text = read(path)
text = replace_once(
    text,
    "import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';\n",
    "import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';\nimport {\n  canDeleteDispatchServiceRequest,\n  isDispatchServiceRequestEditLocked,\n  isDispatchTestClientRequest\n} from '../services/dispatchServiceRequestPolicy.js';\n",
    'metrics policy import'
)
text = replace_once(text, "const EDIT_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000;\n", "", 'remove duplicate grace constant')
text = sub_once(
    text,
    r"function serviceRequestStartAt\(request\) \{[\s\S]*?\n\}\n\nfunction isServiceRequestEditLocked\(request, now = new Date\(\)\) \{[\s\S]*?\n\}\n\n",
    "",
    'remove duplicate lock helpers'
)
text = replace_once(
    text,
    "      service: true,\n      assignments:",
    "      service: { include: { client: { select: { id: true, isTestClient: true } } } },\n      operationPoint: { include: { client: { select: { id: true, isTestClient: true } } } },\n      assignments:",
    'metrics request client includes'
)
text = replace_once(
    text,
    "    isServiceRequestEditLocked,\n    canAccessDispatch:",
    "    isServiceRequestEditLocked,\n    canDeleteDispatchServiceRequest,\n    isDispatchTestClientRequest,\n    canAccessDispatch:",
    'metrics render helpers'
)
files[path] = text

# 6. Client form and list
path = 'src/views/operacionesClientes.ejs'
text = read(path)
text = replace_once(
    text,
    "            <div class=\"field\"><label for=\"isActive\">Estado</label><select id=\"isActive\" name=\"isActive\"><option value=\"true\" <%= formClient.isActive !== false ? 'selected' : '' %>>Activo</option><option value=\"false\" <%= formClient.isActive === false ? 'selected' : '' %>>Inactivo</option></select></div>\n",
    "            <div class=\"field\"><label for=\"isActive\">Estado</label><select id=\"isActive\" name=\"isActive\"><option value=\"true\" <%= formClient.isActive !== false ? 'selected' : '' %>>Activo</option><option value=\"false\" <%= formClient.isActive === false ? 'selected' : '' %>>Inactivo</option></select></div>\n            <div class=\"field\"><label for=\"isTestClient\">Tipo de cliente</label><select id=\"isTestClient\" name=\"isTestClient\"><option value=\"false\" <%= formClient.isTestClient !== true ? 'selected' : '' %>>Cliente real</option><option value=\"true\" <%= formClient.isTestClient === true ? 'selected' : '' %>>Cliente de prueba</option></select><small class=\"muted\">Las solicitudes de un cliente de prueba se pueden eliminar sin límite de antigüedad.</small></div>\n",
    'client form test selector'
)
text = replace_once(
    text,
    "              <td><strong><%= c.name %></strong><div class=\"muted\">NIT: <%= c.nit || '—' %></div></td>",
    "              <td><strong><%= c.name %></strong><% if (c.isTestClient) { %> <span class=\"pill pill-amber\">Cliente de prueba</span><% } %><div class=\"muted\">NIT: <%= c.nit || '—' %></div></td>",
    'client list test badge'
)
files[path] = text

# 7. Summary view actions
path = 'src/views/operacionesSolicitudesResumen.ejs'
text = read(path)
text = replace_once(
    text,
    "  <% const expiredMessage = 'Esta solicitud ya superó las 2 horas posteriores a la hora del servicio. Puedes verla a detalle, pero no editarla.'; %>",
    "  <% const expiredMessage = 'Esta solicitud ya superó las 2 horas posteriores a la hora de inicio del servicio y quedó disponible solo para consulta.'; %>",
    'summary expired message'
)
text = replace_once(
    text,
    "    <div class=\"readonly-note\">Las solicitudes solo se pueden editar o eliminar hasta 2 horas después de la hora de inicio del servicio. Después quedan disponibles únicamente para consulta.</div>",
    "    <div class=\"readonly-note\">Las solicitudes de clientes reales se pueden editar o eliminar hasta 2 horas después de la hora de inicio del servicio. Los clientes de prueba conservan el límite de edición, pero sus solicitudes se pueden eliminar en cualquier momento.</div>",
    'summary policy note'
)
text = replace_once(
    text,
    "      <% requests.forEach((request) => { const required = Number(request.requiredWorkers || 0); const active = activeCount(request); const confirmed = confirmedCount(request); const editLocked = isServiceRequestEditLocked(request); const requestDate = formatDate(request.serviceDate); %>",
    "      <% requests.forEach((request) => { const required = Number(request.requiredWorkers || 0); const active = activeCount(request); const confirmed = confirmedCount(request); const editLocked = isServiceRequestEditLocked(request); const deleteAllowed = canDeleteDispatchServiceRequest(request); const testClient = isDispatchTestClientRequest(request); const requestDate = formatDate(request.serviceDate); %>",
    'summary request policy variables'
)
text = replace_once(
    text,
    "              <h2><%= request.clientName || 'Sin cliente' %></h2>",
    "              <h2><%= request.clientName || 'Sin cliente' %> <% if (testClient) { %><span class=\"pill pill-amber\">Cliente de prueba</span><% } %></h2>",
    'summary test client badge'
)
old_actions = """            <% if (!editLocked) { %>
              <form method="post" action="/admin/operaciones/solicitudes/<%= request.id %>/eliminar" onsubmit="return confirm('¿Eliminar esta solicitud de servicio? También se eliminarán sus asignaciones y novedades asociadas.');">
                <button class="btn danger-btn" type="submit">Eliminar</button>
              </form>
            <% } %>
            <% if (editLocked) { %>
              <span class="muted">Modo consulta: edición y eliminación bloqueadas porque ya pasaron más de 2 horas desde la hora del servicio.</span>
            <% } %>"""
new_actions = """            <% if (deleteAllowed) { %>
              <form method="post" action="/admin/operaciones/solicitudes/<%= request.id %>/eliminar" data-expired-delete-form="true" data-expired-delete="false" data-unlimited-delete="<%= testClient ? 'true' : 'false' %>" data-service-date="<%= requestDate %>" data-start-time="<%= request.startTime || '' %>" data-expired-message="<%= expiredMessage %>" onsubmit="return confirm('¿Eliminar esta solicitud de servicio? También se eliminarán sus asignaciones, novedades y registros de asistencia asociados.');">
                <button class="btn danger-btn" type="submit">Eliminar</button>
              </form>
            <% } %>
            <% if (editLocked && testClient) { %>
              <span class="muted">Modo consulta: la edición está bloqueada por antigüedad. Cliente de prueba: eliminación sin límite.</span>
            <% } else if (editLocked) { %>
              <span class="muted">Modo consulta: edición y eliminación bloqueadas porque ya pasaron más de 2 horas desde la hora de inicio del servicio.</span>
            <% } %>"""
text = replace_once(text, old_actions, new_actions, 'summary delete policy actions')
files[path] = text

# 8. Browser fallback reflects server policy; does not invent midnight
path = 'src/public/expired-service-request-modal.js'
text = read(path)
text = replace_once(
    text,
    "    const startTime = /^([01]?\\d|2[0-3]):[0-5]\\d$/.test(String(time || '')) ? String(time).padStart(5, '0') : '00:00';\n    const start = new Date(`${date}T${startTime}:00-05:00`);",
    "    const startTime = String(time || '').trim();\n    if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(startTime)) return null;\n    const start = new Date(`${date}T${startTime}:00-05:00`);",
    'browser missing time behavior'
)
text = replace_once(
    text,
    "  function isLocked(element) {\n    if (element?.dataset?.expiredEdit === 'true') return true;\n    const start = findContextStart(element);\n    if (!start) return false;\n    return Date.now() > start.getTime() + TWO_HOURS_MS;\n  }",
    """  function isTimeLocked(element) {
    const start = findContextStart(element);
    if (!start) return false;
    return Date.now() >= start.getTime() + TWO_HOURS_MS;
  }

  function isEditLocked(element) {
    if (element?.dataset?.expiredEdit === 'true') return true;
    return isTimeLocked(element);
  }

  function isDeleteLocked(element) {
    if (element?.dataset?.unlimitedDelete === 'true') return false;
    if (element?.dataset?.expiredDelete === 'true') return true;
    return isTimeLocked(element);
  }""",
    'browser separate edit/delete policy'
)
text = replace_once(text, "    if (!link || !isLocked(link)) return;", "    if (!link || !isEditLocked(link)) return;", 'browser edit handler')
text = replace_once(text, "    if (!form || !isLocked(form)) return;", "    if (!form || !isDeleteLocked(form)) return;", 'browser delete handler')
files[path] = text

# 9. Service helper expected by dashboard
path = 'src/services/dispatchServiceRequestPolicy.js'
text = read(path)
text = replace_once(
    text,
    "export function dispatchServiceRequestPolicyInclude() {",
    "export function canDeleteDispatchServiceRequest(request = {}, now = new Date()) {\n  return buildDispatchServiceRequestPolicy(request, now).canDelete;\n}\n\nexport function dispatchServiceRequestPolicyInclude() {",
    'service delete helper'
)
files[path] = text

# Persist only after every transformation passed.
for path, content in files.items():
    Path(path).write_text(content, encoding='utf-8')
