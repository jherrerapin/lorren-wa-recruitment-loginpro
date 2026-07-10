import express from 'express';
import { prisma } from '../lib/prisma.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const WHATSAPP_ICON_SVG = '<svg class="official-whatsapp-icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="#25D366" d="M16.01 3.2c-7.07 0-12.8 5.73-12.8 12.8 0 2.25.59 4.45 1.7 6.39L3.2 28.8l6.58-1.68a12.74 12.74 0 0 0 6.22 1.61h.01c7.06 0 12.79-5.73 12.79-12.8 0-3.43-1.34-6.65-3.76-9.08A12.7 12.7 0 0 0 16.01 3.2z"/><path fill="#fff" d="M16.01 5.38c2.83 0 5.49 1.1 7.49 3.1a10.52 10.52 0 0 1 3.1 7.49c0 5.85-4.76 10.61-10.59 10.61h-.01a10.6 10.6 0 0 1-5.4-1.48l-.39-.23-3.9 1 1.04-3.8-.25-.39A10.6 10.6 0 0 1 16.01 5.38z"/><path fill="#25D366" d="M19.11 17.23c-.28-.14-1.65-.81-1.91-.9-.25-.09-.44-.14-.62.14-.18.28-.71.9-.87 1.08-.16.18-.32.21-.6.07-.28-.14-1.16-.43-2.2-1.38-.81-.72-1.35-1.61-1.51-1.88-.16-.28-.02-.42.12-.56.13-.13.28-.32.42-.48.14-.16.18-.28.28-.46.09-.18.05-.35-.02-.49-.07-.14-.62-1.5-.85-2.05-.22-.53-.45-.46-.62-.46h-.53c-.18 0-.46.07-.69.32-.23.25-.9.88-.9 2.15 0 1.27.92 2.49 1.04 2.67.12.18 1.8 2.75 4.36 3.86.61.26 1.08.42 1.45.54.61.2 1.16.17 1.59.1.49-.07 1.51-.62 1.72-1.22.21-.6.21-1.11.14-1.22-.07-.11-.25-.18-.53-.32z"/></svg>';
const ASSIGNMENT_UI_STYLE = `<style id="dispatch-assignment-source-ui-fix">
.assignment-page .icon-whatsapp.whatsapp-link{font-size:0!important;line-height:1!important;padding:0!important;width:32px!important;height:32px!important;min-width:32px!important;min-height:32px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;border-radius:999px!important;overflow:hidden!important}.assignment-page .official-whatsapp-icon{width:20px!important;height:20px!important;display:block!important;flex:0 0 20px!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])){display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;gap:6px 8px!important;padding:6px 8px!important;min-height:0!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .assigned-main{min-width:0!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) strong{font-size:12px!important;line-height:1.08!important;margin:0 0 1px!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .meta{font-size:10px!important;line-height:1.08!important;gap:0!important;margin:0!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .assignment-message,.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .whatsapp-link,.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) details.incident-card{display:none!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .assigned-actions{display:flex!important;justify-content:flex-end!important;align-items:center!important;gap:4px!important;margin:0!important;width:auto!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) form[data-async-assignment-action="unassign"]{display:flex!important;margin:0!important;width:auto!important}.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])) .icon-remove-btn{width:28px!important;height:28px!important;min-width:28px!important;min-height:28px!important;padding:0!important;font-size:18px!important}@media(max-width:760px){.assignment-page .assigned-card:not(:has(form[data-async-assignment-action="confirmar"])):not(:has(form[data-async-assignment-action="no-confirmado"])){grid-template-columns:minmax(0,1fr) auto!important}}
</style>`;

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
  output = output.replace('title="Enviar WhatsApp" aria-label="Enviar WhatsApp">WA</button>', `title="Enviar WhatsApp" aria-label="Enviar WhatsApp">${WHATSAPP_ICON_SVG}</button>`);
  if (!output.includes('dispatch-assignment-source-ui-fix')) output = output.replace('</head>', `${ASSIGNMENT_UI_STYLE}\n</head>`);
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
