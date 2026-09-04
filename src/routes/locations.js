// routes/locations.js — CRUD de Sucursales, Operaciones y asignación territorial de usuarios
import express from 'express';
import {
  canCreateRecruiterUsers,
  canManageUserModulePermissions,
  encodeUserAccessCities,
  encodeUserAccessSelection,
  normalizeUserAccessScope
} from '../services/appUsers.js';
import { loadUnifiedCityOptions } from '../services/cityOptions.js';
import { resolvePayrollFeatureAccess, setPayrollFeatureAccess } from '../services/payrollFeatureAccess.js';
import {
  canManageOperationalPermissions,
  getOperationalAccessForUser,
  listOperationalAccess,
  operationalAccessCatalog,
  setOperationalAccess
} from '../services/operationalAccess.js';

function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userSource = req.session?.userSource || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  if (!['dev', 'admin'].includes(role)) return res.redirect('/admin');
  return next();
}

function canManageRecruiterUsers(req) {
  return canCreateRecruiterUsers(req);
}

function isProtectedRecruiterProfile(user = {}) {
  return user.username === 'reclutador-general';
}

function payrollAccessActor(req) {
  return {
    actorUserId: req.userId || req.session?.userId || null,
    actorUsername: req.username || req.session?.username || null,
    actorRole: req.userRole || req.session?.userRole || null,
    actorSource: req.userSource || req.session?.userSource || null,
    actorAccessScope: req.userAccessScope || req.session?.userAccessScope || 'ALL',
    ipAddress: normalize(req.ip),
    userAgent: normalize(req.get?.('user-agent'))
  };
}

function operationalAccessActor(req) {
  return {
    actorUserId: req.userId || req.session?.userId || null,
    actorUsername: req.username || req.session?.username || null,
    actorRole: req.userRole || req.session?.userRole || null,
    actorOperationalRole: req.operationalRole || req.session?.operationalRole || null,
    actorOperationalAccessConfigured: req.operationalAccessConfigured === true || req.session?.operationalAccessConfigured === true,
    actorEffectivePermissions: req.operationalEffectivePermissions || req.session?.operationalEffectivePermissions || [],
    actorDelegablePermissions: req.operationalDelegablePermissions || req.session?.operationalDelegablePermissions || [],
    ipAddress: normalize(req.ip),
    userAgent: normalize(req.get?.('user-agent'))
  };
}

async function loadPayrollPermissionTarget(prisma, userId) {
  if (!userId) return null;
  return prisma.appUser.findUnique({
    where: { id: userId },
    select: { id: true, username: true, role: true, isActive: true }
  });
}

function canEditPayrollPermissionTarget(req, user) {
  if (!user || user.role !== 'ADMIN') return false;
  if (req.userRole === 'dev') return true;
  return !isProtectedRecruiterProfile(user);
}

function canEditOperationalTarget(req, access) {
  if (!access) return false;
  if (req.userRole === 'dev') return true;
  if (!canManageOperationalPermissions(req)) return false;
  const actorId = req.userId || req.session?.userId || null;
  if (actorId && access.userId === actorId) return false;
  if (!access.configured || access.role === 'SUPERVISOR') return false;
  if (isProtectedRecruiterProfile(access)) return false;
  return true;
}

function operationalAccessErrorStatus(error) {
  const code = String(error?.message || '');
  if (code === 'operational_access_user_not_found') return 404;
  if ([
    'operational_access_manager_required',
    'operational_access_self_forbidden',
    'operational_access_supervisor_target_forbidden',
    'operational_access_capability_not_delegable'
  ].includes(code)) return 403;
  return 400;
}

function flash(res, type, msg) {
  res.cookie('_flash_type', type, { maxAge: 5000, httpOnly: false });
  res.cookie('_flash_msg', msg, { maxAge: 5000, httpOnly: false });
}

function readFlash(req, res) {
  const type = req.cookies?._flash_type || null;
  const msg = req.cookies?._flash_msg || null;
  res.clearCookie('_flash_type');
  res.clearCookie('_flash_msg');
  return {
    successMsg: type === 'success' ? msg : normalize(req.query?.success),
    errorMsg: type === 'error' ? msg : normalize(req.query?.error)
  };
}

function normalize(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length ? text : null;
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isSiberiaName(value) {
  return normalizeKey(value) === 'siberia';
}

function isBogotaName(value) {
  return ['bogota', 'bogota d.c.', 'bogota dc'].includes(normalizeKey(value));
}

function normalizeMany(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function isChecked(value) {
  return value === 'on' || value === 'true' || value === true || value === '1';
}

function usersRedirect(type, message, username = null) {
  const params = new URLSearchParams();
  params.set(type, message);
  if (username) params.set('username', username);
  return `/admin/users?${params.toString()}`;
}

function unifiedBranchCompatibilityData() {
  // Campos legacy: mientras existan físicamente, todas las sucursales pertenecen a
  // ambos módulos. Ya no constituyen una decisión ni una autoridad de negocio.
  return {
    usedForRecruitment: true,
    usedForDispatch: true,
    sourceModule: 'RECRUITMENT'
  };
}

/**
 * Resuelve el permiso de reclutamiento solicitado.
 *
 * `scopeCity` y `scopeVacancyId` siguen siendo nombres técnicos de compatibilidad.
 * No definen el catálogo de Sucursales ni la disponibilidad de Despacho.
 */
async function resolveRecruiterAccessUpdate(prisma, body = {}) {
  const accessScope = normalizeUserAccessScope(body.accessScope);

  if (accessScope === 'ALL') {
    return {
      accessScope: 'ALL',
      scopeCity: null,
      scopeVacancyId: null,
      selectedCities: [],
      selectedVacancyIds: [],
      selectedVacancies: []
    };
  }

  const requestedCities = normalizeMany(body.scopeCities)
    .sort((a, b) => a.localeCompare(b, 'es'));
  if (!requestedCities.length) {
    return { error: 'Selecciona al menos una sucursal para este usuario.' };
  }

  const cityOptions = await loadUnifiedCityOptions(prisma);
  const canonicalCityNames = new Set(cityOptions.map((city) => city.name));
  const invalidCities = requestedCities.filter((city) => !canonicalCityNames.has(city));
  if (invalidCities.length) {
    return { error: 'Una o varias sucursales seleccionadas ya no existen.' };
  }

  if (accessScope === 'CITY') {
    return {
      accessScope: 'CITY',
      scopeCity: encodeUserAccessCities(requestedCities),
      scopeVacancyId: null,
      selectedCities: requestedCities,
      selectedVacancyIds: [],
      selectedVacancies: []
    };
  }

  const requestedVacancyIds = normalizeMany(body.scopeVacancyIds);
  if (!requestedVacancyIds.length) {
    return { error: 'Selecciona al menos una vacante para este usuario.' };
  }

  const selectedVacancies = await prisma.vacancy.findMany({
    where: { id: { in: requestedVacancyIds } },
    select: {
      id: true,
      title: true,
      role: true,
      city: true
    }
  });

  const foundIds = new Set(selectedVacancies.map((vacancy) => vacancy.id));
  const missingVacancyIds = requestedVacancyIds.filter((id) => !foundIds.has(id));
  if (missingVacancyIds.length) {
    return { error: 'Una o varias vacantes seleccionadas ya no existen.' };
  }

  const requestedCityKeys = new Set(requestedCities.map(normalizeKey));
  const outsideSelectedCities = selectedVacancies.filter((vacancy) => !requestedCityKeys.has(normalizeKey(vacancy.city)));
  if (outsideSelectedCities.length) {
    return { error: 'Solo puedes asignar vacantes pertenecientes a las sucursales seleccionadas.' };
  }

  const selectedVacancyCityKeys = new Set(selectedVacancies.map((vacancy) => normalizeKey(vacancy.city)).filter(Boolean));
  const selectedCities = requestedCities.filter((city) => selectedVacancyCityKeys.has(normalizeKey(city)));

  return {
    accessScope: 'VACANCY',
    scopeCity: encodeUserAccessSelection({
      cities: selectedCities,
      vacancyIds: requestedVacancyIds
    }),
    scopeVacancyId: requestedVacancyIds[0],
    selectedCities,
    selectedVacancyIds: requestedVacancyIds,
    selectedVacancies
  };
}

function wantsJson(req) {
  return isChecked(req.body?.returnJson) || req.get('accept')?.includes('application/json');
}

function operationError(req, res, status, message) {
  if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
  flash(res, 'error', message);
  return res.redirect('/admin/locations');
}

export function locationsRouter(prisma) {
  const router = express.Router();
  router.use(sessionAuth);

  router.get('/', async (req, res) => {
    const cities = await prisma.city.findMany({
      orderBy: [{ name: 'asc' }],
      include: {
        operations: {
          orderBy: { name: 'asc' },
          include: {
            vacancies: {
              orderBy: { createdAt: 'asc' },
              include: {
                interviewSlots: {
                  where: { isActive: true },
                  orderBy: [{ dayOfWeek: 'asc' }, { specificDate: 'asc' }, { startTime: 'asc' }]
                },
                _count: { select: { candidates: true, interviewBookings: true } }
              }
            }
          }
        }
      }
    });
    const { successMsg, errorMsg } = readFlash(req, res);
    res.render('locations', {
      cities,
      successMsg,
      errorMsg,
      role: req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch)
    });
  });

  router.get('/api/cities', async (req, res) => {
    if (!canManageRecruiterUsers(req)) return res.status(403).json({ error: 'forbidden' });
    const cities = await loadUnifiedCityOptions(prisma);
    res.json(cities.map((city) => ({ id: city.id, name: city.name })));
  });

  router.get('/api/operations', async (_req, res) => {
    const operations = await prisma.operation.findMany({
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
      include: { city: { select: { name: true } } }
    });
    res.json(operations);
  });

  router.post('/cities', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre de la sucursal no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    if (isSiberiaName(name)) {
      flash(res, 'error', 'Siberia pertenece a la sucursal Bogotá. Créala como vacante o zona dentro de Bogotá, no como sucursal independiente.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.city.create({ data: { name, ...unifiedBranchCompatibilityData() } });
      flash(res, 'success', `Sucursal "${name}" creada correctamente.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una sucursal con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al crear la sucursal.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    if (isSiberiaName(name)) {
      flash(res, 'error', 'Siberia pertenece a la sucursal Bogotá y no puede existir como sucursal independiente.');
      return res.redirect('/admin/locations');
    }

    const city = await prisma.city.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { operations: true } } }
    });
    if (!city) {
      flash(res, 'error', 'Sucursal no encontrada.');
      return res.redirect('/admin/locations');
    }
    if (city.name !== name && city._count.operations > 0) {
      flash(res, 'error', 'No se puede renombrar una sucursal que ya tiene vacantes porque existen referencias históricas de reclutamiento. Crea la sucursal correcta y migra sus vacantes de forma controlada.');
      return res.redirect('/admin/locations');
    }

    try {
      await prisma.city.update({
        where: { id: city.id },
        data: { name, ...unifiedBranchCompatibilityData() }
      });
      flash(res, 'success', `Sucursal "${name}" actualizada correctamente.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una sucursal con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al actualizar la sucursal.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:id/delete', async (req, res) => {
    try {
      const city = await prisma.city.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { operations: true } } }
      });
      if (!city) {
        flash(res, 'error', 'Sucursal no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (city._count.operations > 0) {
        flash(res, 'error', `No se puede eliminar "${city.name}" porque tiene vacantes asociadas.`);
        return res.redirect('/admin/locations');
      }
      await prisma.city.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Sucursal "${city.name}" eliminada.`);
    } catch (_error) {
      flash(res, 'error', 'Error al eliminar la sucursal.');
    }
    return res.redirect('/admin/locations');
  });

  // Esta ruta solo persiste la entidad Operation. La configuración de reclutamiento
  // se delega al CRUD canónico ya existente en admin.js para evitar un segundo
  // escritor de Vacancy/InterviewSlot.
  router.post('/cities/:cityId/operations', async (req, res) => {
    const name = normalize(req.body.name);
    const city = await prisma.city.findUnique({
      where: { id: req.params.cityId },
      select: { id: true, name: true }
    });
    if (!city) return operationError(req, res, 404, 'Sucursal no encontrada.');
    if (!name) return operationError(req, res, 400, 'El nombre de la vacante no puede estar vacío.');
    if (isSiberiaName(name) && !isBogotaName(city.name)) {
      return operationError(req, res, 400, 'La vacante Siberia solo puede pertenecer a la sucursal Bogotá.');
    }

    try {
      const operation = await prisma.operation.create({ data: { name, cityId: city.id } });
      if (wantsJson(req)) {
        return res.status(201).json({
          ok: true,
          operation: { id: operation.id, name: operation.name, cityId: city.id, cityName: city.name }
        });
      }
      flash(res, 'success', `Vacante "${name}" creada. Completa su información para activar Lórren.`);
    } catch (error) {
      if (error.code === 'P2002') {
        return operationError(req, res, 409, `Ya existe una vacante "${name}" en esta sucursal.`);
      }
      return operationError(req, res, 500, 'Error al crear la vacante.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }

    const operation = await prisma.operation.findUnique({
      where: { id: req.params.id },
      include: { city: { select: { name: true } } }
    });
    if (!operation) {
      flash(res, 'error', 'Vacante no encontrada.');
      return res.redirect('/admin/locations');
    }
    if (isSiberiaName(name) && !isBogotaName(operation.city?.name)) {
      flash(res, 'error', 'La vacante Siberia solo puede pertenecer a la sucursal Bogotá.');
      return res.redirect('/admin/locations');
    }

    try {
      await prisma.operation.update({ where: { id: operation.id }, data: { name } });
      flash(res, 'success', `Vacante renombrada a "${name}".`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', 'Ya existe una vacante con ese nombre en la misma sucursal.');
      } else {
        flash(res, 'error', 'Error al renombrar la vacante.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:id/delete', async (req, res) => {
    try {
      const operation = await prisma.operation.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { vacancies: true } } }
      });
      if (!operation) {
        flash(res, 'error', 'Vacante no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (operation._count.vacancies > 0) {
        flash(res, 'error', `No se puede eliminar la vacante "${operation.name}" porque ya tiene configuración de reclutamiento asociada.`);
        return res.redirect('/admin/locations');
      }
      await prisma.operation.delete({ where: { id: operation.id } });
      flash(res, 'success', `Vacante "${operation.name}" eliminada.`);
    } catch (_error) {
      flash(res, 'error', 'Error al eliminar la vacante.');
    }
    return res.redirect('/admin/locations');
  });

  router.get('/users/operational-access/catalog', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const catalog = operationalAccessCatalog();
    const isDev = req.userRole === 'dev';
    return res.json({
      ok: true,
      ...catalog,
      actor: {
        isDev,
        role: isDev ? 'DEV' : req.operationalRole || req.session?.operationalRole || null,
        delegablePermissions: isDev
          ? catalog.capabilities.map((item) => item.key).filter((key) => key !== 'SUPERVISE_PERMISSIONS')
          : req.operationalDelegablePermissions || req.session?.operationalDelegablePermissions || []
      }
    });
  });

  router.get('/users/operational-access', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const users = await prisma.appUser.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true, username: true, displayName: true, role: true, isActive: true },
      orderBy: [{ displayName: 'asc' }, { username: 'asc' }]
    });
    const accesses = await listOperationalAccess(prisma, users);
    const isDev = req.userRole === 'dev';
    const actorId = req.userId || req.session?.userId || null;
    const visible = isDev
      ? accesses
      : accesses.filter((access) => canEditOperationalTarget(req, access) && access.userId !== actorId);
    const catalog = operationalAccessCatalog();
    return res.json({
      ok: true,
      users: visible,
      roles: catalog.roles,
      capabilities: catalog.capabilities,
      editableCapabilities: isDev
        ? catalog.capabilities.map((item) => item.key)
        : req.operationalDelegablePermissions || req.session?.operationalDelegablePermissions || []
    });
  });

  router.get('/users/:id/operational-access', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const access = await getOperationalAccessForUser(prisma, req.params.id);
      if (!access) return res.status(404).json({ ok: false, error: 'user_not_found' });
      if (!canEditOperationalTarget(req, access)) return res.status(403).json({ ok: false, error: 'forbidden' });
      const catalog = operationalAccessCatalog();
      return res.json({
        ok: true,
        access,
        roles: catalog.roles,
        capabilities: catalog.capabilities,
        canEditRole: req.userRole === 'dev',
        canEditDelegation: req.userRole === 'dev',
        editableCapabilities: req.userRole === 'dev'
          ? catalog.capabilities.map((item) => item.key)
          : req.operationalDelegablePermissions || req.session?.operationalDelegablePermissions || []
      });
    } catch (error) {
      return res.status(operationalAccessErrorStatus(error)).json({ ok: false, error: error?.message || 'operational_access_failed' });
    }
  });

  router.post('/users/:id/operational-access', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const current = await getOperationalAccessForUser(prisma, req.params.id);
      if (!current) return res.status(404).json({ ok: false, error: 'user_not_found' });
      if (!canEditOperationalTarget(req, current)) return res.status(403).json({ ok: false, error: 'forbidden' });
      const result = await setOperationalAccess(prisma, {
        targetUserId: req.params.id,
        role: req.body?.role,
        permissions: req.body?.permissions,
        delegablePermissions: req.body?.delegablePermissions,
        ...operationalAccessActor(req)
      });
      return res.json({ ok: true, access: result });
    } catch (error) {
      return res.status(operationalAccessErrorStatus(error)).json({ ok: false, error: error?.message || 'operational_access_failed' });
    }
  });

  router.get('/users/:id/payroll-access', async (req, res) => {
    if (!canManageUserModulePermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const user = await loadPayrollPermissionTarget(prisma, req.params.id);
    if (!user || user.role !== 'ADMIN') return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (!canEditPayrollPermissionTarget(req, user)) return res.status(403).json({ ok: false, error: 'forbidden' });

    try {
      const access = await resolvePayrollFeatureAccess(prisma, {
        userRole: 'admin',
        userId: user.id,
        username: user.username
      });
      return res.json({ ok: true, enabled: access.allowed === true, userId: user.id });
    } catch (_error) {
      return res.status(400).json({ ok: false, error: 'payroll_access_failed' });
    }
  });

  router.post('/users/:id/payroll-access', async (req, res) => {
    if (!canManageUserModulePermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const user = await loadPayrollPermissionTarget(prisma, req.params.id);
    if (!user || user.role !== 'ADMIN') return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (!canEditPayrollPermissionTarget(req, user)) return res.status(403).json({ ok: false, error: 'forbidden' });

    try {
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: user.id,
        enabled: req.body?.enabled === true,
        ...payrollAccessActor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (_error) {
      return res.status(400).json({ ok: false, error: 'payroll_access_failed' });
    }
  });

  router.post('/users/:id/access', async (req, res) => {
    if (!canManageRecruiterUsers(req)) {
      return res.redirect(usersRedirect('error', 'No tienes permisos para editar usuarios.'));
    }

    const user = await prisma.appUser.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        username: true,
        role: true,
        canAccessDispatch: true,
        canAccessAttendance: true,
        canAccessStatistics: true,
        canAccessMetaAds: true,
        canAccessCvAnalysis: true
      }
    });
    if (!user || user.role !== 'ADMIN') {
      return res.redirect(usersRedirect('error', 'Usuario reclutador no encontrado.'));
    }
    if (req.userRole !== 'dev' && isProtectedRecruiterProfile(user)) {
      return res.redirect(usersRedirect('error', 'Solo DEV puede editar este perfil protegido.', user.username));
    }

    const accessUpdate = await resolveRecruiterAccessUpdate(prisma, req.body);
    if (accessUpdate.error) {
      return res.redirect(usersRedirect('error', accessUpdate.error, user.username));
    }

    const data = {
      accessScope: accessUpdate.accessScope,
      scopeCity: accessUpdate.scopeCity,
      scopeVacancyId: accessUpdate.scopeVacancyId,
      recoveryPhone: normalize(req.body.recoveryPhone),
      recoveryEmail: normalize(req.body.recoveryEmail)
    };
    if (canManageUserModulePermissions(req)) {
      data.canAccessAttendance = isChecked(req.body.canAccessAttendance);
      data.canAccessDispatch = isChecked(req.body.canAccessDispatch) || data.canAccessAttendance;
      data.canAccessMetaAds = isChecked(req.body.canAccessMetaAds);
      data.canAccessCvAnalysis = isChecked(req.body.canAccessCvAnalysis);
      data.canAccessStatistics = data.canAccessMetaAds || data.canAccessCvAnalysis;
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data
    });

    const accessDescription = accessUpdate.accessScope === 'ALL'
      ? 'todas las sucursales y vacantes'
      : accessUpdate.accessScope === 'CITY'
        ? `${accessUpdate.selectedCities.length} sucursal(es): ${accessUpdate.selectedCities.join(', ')}`
        : `${accessUpdate.selectedVacancyIds.length} vacante(s) de ${accessUpdate.selectedCities.join(', ')}`;

    return res.redirect(usersRedirect(
      'success',
      `Usuario ${user.username} actualizado con acceso a ${accessDescription}.`,
      user.username
    ));
  });

  return router;
}
