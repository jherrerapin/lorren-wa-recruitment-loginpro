import express from 'express';
import { prisma } from '../lib/prisma.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const WHATSAPP_ICON_SVG = '<svg class="official-whatsapp-icon" viewBox="0 0 448 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M380.9 97.1C339 55.1 283.2 32 223.9 32 101 32 1 132 1 255c0 39.2 10.2 77.4 29.6 111L0 480l116.7-30.6c32.4 17.7 68.9 27 106.1 27h.1c122.9 0 222.9-100 222.9-223 0-59.3-23.1-115.1-65-157.3zM223 438.7h-.1c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.2 18.2 18.5-67.5-4.4-6.9c-18.5-29.4-28.3-63.3-28.3-98.1 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 54 81.2 53.9 130.5 0 101.8-82.8 184.6-184.7 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.5-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.5-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>';
const ASSIGNMENT_UI_STYLE = `<style id="dispatch-assignment-source-ui-fix">
.assignment-page .icon-whatsapp.whatsapp-link{font-size:0!important;line-height:1!important;padding:0!important;width:32px!important;height:32px!important;min-width:32px!important;min-height:32px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;border-radius:999px!important;overflow:hidden!important;background:#25D366!important;border-color:#25D366!important;color:#fff!important}.assignment-page .official-whatsapp-icon{width:19px!important;height:19px!important;display:block!important;flex:0 0 19px!important;color:#fff!important}.assignment-page .assigned-card.assignment-final-card{display:grid!important;grid-template-columns:minmax(0,1fr) 30px!important;align-items:center!important;gap:6px!important;padding:6px 8px!important;min-height:0!important}.assignment-page .assigned-card.assignment-final-card .assigned-main{grid-column:1!important;grid-row:1!important;min-width:0!important}.assignment-page .assigned-card.assignment-final-card .assigned-actions{grid-column:2!important;grid-row:1!important;display:flex!important;justify-content:flex-end!important;align-items:center!important;gap:0!important;margin:0!important;width:30px!important;align-self:center!important}.assignment-page .assigned-card.assignment-final-card strong{font-size:12px!important;line-height:1.08!important;margin:0 0 1px!important}.assignment-page .assigned-card.assignment-final-card .meta{font-size:10px!important;line-height:1.08!important;gap:0!important;margin:0!important}.assignment-page .assigned-card.assignment-final-card .assignment-message,.assignment-page .assigned-card.assignment-final-card .whatsapp-link,.assignment-page .assigned-card.assignment-final-card details.incident-card,.assignment-page .assigned-card.assignment-final-card .assigned-actions form:not([data-async-assignment-action="unassign"]){display:none!important}.assignment-page .assigned-card.assignment-final-card form[data-async-assignment-action="unassign"]{display:flex!important;margin:0!important;width:30px!important;height:30px!important}.assignment-page .assigned-card.assignment-final-card .icon-remove-btn{width:28px!important;height:28px!important;min-width:28px!important;min-height:28px!important;padding:0!important;font-size:18px!important}
</style>`;
const ASSIGNMENT_UI_SCRIPT = `<script id="dispatch-assignment-final-card-fix">
(function(){
  const whatsappSvg = '${WHATSAPP_ICON_SVG.replace(/'/g, "\\'")}';
  function statusText(card){ return String(card.querySelector('.assignment-status-line')?.textContent || '').toLowerCase(); }
  function isFinalized(card){ const text = statusText(card); return text.includes('estado: confirmado') || text.includes('estado: no confirmó') || text.includes('estado: no confirmado'); }
  function apply(){
    document.querySelectorAll('.assigned-card .dispatch-wa-button, .assigned-card .whatsapp-link, .assigned-card .icon-whatsapp').forEach((button) => {
      button.innerHTML = whatsappSvg;
      button.classList.add('dispatch-official-whatsapp-icon');
      button.title = 'Enviar WhatsApp';
      button.setAttribute('aria-label', 'Enviar WhatsApp');
    });
    document.querySelectorAll('.assigned-card').forEach((card) => {
      const final = isFinalized(card) && !card.querySelector('form[data-async-assignment-action="confirmar"],form[data-async-assignment-action="no-confirmado"]');
      card.classList.toggle('assignment-final-card', final);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
</script>`;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeText(value) {
  return normalizeString(value)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || '';
}

function isBogotaSiberiaName(cityName) {
  const normalized = normalizeText(cityName);
  return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia';
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

async function resolveCompatibleOperationalCityIds(operationalCityId) {
  if (!operationalCityId) return [];
  const selectedCity = await prisma.city.findFirst({ where: { id: operationalCityId, usedForDispatch: true }, select: { id: true, name: true } });
  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];
  const cities = await prisma.city.findMany({ where: { usedForDispatch: true }, select: { id: true, name: true } });
  const compatibleIds = cities.filter((city) => isBogotaSiberiaName(city.name)).map((city) => city.id);
  return compatibleIds.length ? compatibleIds : [selectedCity.id];
}

function buildOperationalCityFilter(compatibleOperationalCityIds) {
  if (!compatibleOperationalCityIds.length) return {};
  return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } };
}

async function loadDispatchCities() {
  return prisma.city.findMany({ where: { usedForDispatch: true }, orderBy: { name: 'asc' } });
}

function normalizeAssignmentBoardHtml(html) {
  if (typeof html !== 'string') return html;
  let output = html;
  output = output.replace('id="sendAllWhatsapp"', 'id="sendAllAssignmentWhatsapp"');
  output = output.replace("qs('#sendAllWhatsapp')", "qs('#sendAllAssignmentWhatsapp')");
  output = output.replace(/(<button[^>]*class="[^"]*icon-whatsapp[^"]*"[^>]*>)(?:\s*WA\s*)<\/button>/g, `$1${WHATSAPP_ICON_SVG}</button>`);
  if (!output.includes('dispatch-assignment-source-ui-fix')) output = output.replace('</head>', `${ASSIGNMENT_UI_STYLE}\n</head>`);
  if (!output.includes('dispatch-assignment-final-card-fix')) output = output.replace('</body>', `${ASSIGNMENT_UI_SCRIPT}\n</body>`);
  return output;
}

function renderAssignmentsBoard(res, locals) {
  return res.render('operacionesAsignacionesConfirmacion', locals, (error, html) => {
    if (error) throw error;
    return res.send(normalizeAssignmentBoardHtml(html));
  });
}

export function dispatchAssignmentConfirmationsRouter() {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res, next) => {
    try {
      const q = normalizeString(req.query.q);
      const operationalCityId = normalizeString(req.query.operationalCityId);
      const vacancyId = normalizeString(req.query.vacancyId);
      const transportMode = normalizeString(req.query.transportMode);
      const locality = normalizeString(req.query.locality);
      const status = normalizeString(req.query.status);
      const serviceRequestId = normalizeString(req.query.serviceRequestId);

      const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(operationalCityId);
      const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
      const baseWorkerWhere = {
        ...(status ? { operationalStatus: status } : {}),
        ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}),
        ...operationalCityFilter,
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
        ...(transportMode ? { transportMode } : {}),
        ...(locality ? { residenceLocality: locality } : {})
      };

      const localityWhere = {
        ...operationalCityFilter,
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
        ...(transportMode ? { transportMode } : {}),
        ...(status ? { operationalStatus: status } : {})
      };

      const [workers, cities, vacancies, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
        prisma.dispatchWorker.findMany({ where: baseWorkerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
        loadDispatchCities(),
        prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }),
        prisma.dispatchWorker.findMany({ select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
        prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
        prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
        prisma.dispatchClient.findMany({ where: { isActive: true }, include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
      ]);

      const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
      const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
      const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));

      return renderAssignmentsBoard(res, {
        activeStatuses: ACTIVE_ASSIGNMENT_STATUSES,
        workers,
        availableWorkers,
        cities,
        vacancies,
        serviceRequests,
        selectedServiceRequest,
        selectedServiceRequestId: selectedServiceRequest?.id || '',
        clients,
        message: normalizeString(req.query.message),
        filters: { q: q || '', operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', transportMode: transportMode || '', locality: locality || '', status: status || '' },
        transportModes: transportModeRows.map((row) => row.transportMode).filter(Boolean),
        localities: localityRows.map((row) => row.residenceLocality).filter(Boolean),
        role: req.session?.userRole || req.userRole,
        canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
