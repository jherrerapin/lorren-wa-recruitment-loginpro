// routes/locations.js — CRUD de Sucursales, Operaciones y asignación territorial de usuarios
import express from 'express';
import {
  encodeUserAccessSelection,
  normalizeUserAccessScope
} from '../services/appUsers.js';

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
  if (req.userSource === 'env' && ['dev', 'admin'].includes(req.userRole)) return true;
  return req.userSource === 'db'
    && req.userRole === 'admin'
    && req.username === 'reclutador-general'
    && req.userAccessScope === 'ALL';
}

function isProtectedRecruiterProfile(user = {}) {
  const environmentAdminUsername = normalize(process.env.ADMIN_USER);
  return user.username === 'reclutador-general'
    || Boolean(environmentAdminUsername && user.username === environmentAdminUsername);
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
  return { successMsg: type === 'success' ? msg : null, errorMsg: type === 'error' ? msg : null };
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

function slugify(value) {
  return normalizeKey(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isSiberiaName(value) {
  return normalizeKey(value) === 'siberia';
}

function normalizeMany(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function isChecked(value) {
  return value === 'on' || value === 'true' || value === true || value === '1';
}

function normalizeInteger(value, { min = null, max = null } = {}) {
  const text = normalize(value);
  if (text === null) return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) return null;
  if (min !== null && parsed < min) return null;
  if (max !== null && parsed > max) return null;
  return parsed;
}

function normalizeExperienceRequirement(value) {
  const normalized = normalize(value)?.toUpperCase();
  return ['YES', 'NO', 'INDIFFERENT'].includes(normalized) ? normalized : 'INDIFFERENT';
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

function buildRecruitmentConfigData(body = {}, { cityName, operationName } = {}) {
  const title = normalize(body.title);
  const role = normalize(body.role) || title;
  const operationAddress = normalize(body.operationAddress);
  const requirements = normalize(body.requirements);
  const conditions = normalize(body.conditions);

  if (!title || !role || !operationAddress || !requirements || !conditions) {
    return {
      error: 'Completa título, cargo, zona de operación, requisitos y condiciones de la operación.'
    };
  }

  const minAge = normalizeInteger(body.minAge, { min: 14, max: 99 });
  const maxAge = normalizeInteger(body.maxAge, { min: 14, max: 99 });
  if (minAge !== null && maxAge !== null && minAge > maxAge) {
    return { error: 'La edad mínima no puede ser mayor que la edad máxima.' };
  }

  const isActive = isChecked(body.isActive);
  const acceptingApplications = isChecked(body.acceptingApplications);

  return {
    data: {
      title,
      role,
      roleDescription: normalize(body.roleDescription),
      city: cityName,
      operationAddress,
      interviewAddress: normalize(body.interviewAddress),
      requirements,
      conditions,
      requiredDocuments: normalize(body.requiredDocuments),
      minAge,
      maxAge,
      experienceRequired: normalizeExperienceRequirement(body.experienceRequired),
      experienceTimeText: normalize(body.experienceTimeText),
      schedulingEnabled: isChecked(body.schedulingEnabled),
      acceptingApplications: isActive && acceptingApplications,
      isActive
    },
    label: `${operationName || 'Operación'} · ${title}`
  };
}

async function buildUniqueVacancyKey(prisma, cityName, operationName, title) {
  const base = [cityName, operationName, title]
    .map(slugify)
    .filter(Boolean)
    .join('-')
    .slice(0, 80) || 'operacion';

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const key = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const exists = await prisma.vacancy.findUnique({ where: { key }, select: { id: true } });
    if (!exists) return key;
  }
  throw new Error('No fue posible generar un identificador único para la operación.');
}

async function loadOperationWithBranch(prisma, operationId) {
  return prisma.operation.findUnique({
    where: { id: operationId },
    include: {
      city: { select: { id: true, name: true } },
      _count: { select: { vacancies: true } }
    }
  });
}

/**
 * Resuelve el permiso de reclutamiento solicitado.
 *
 * `scopeCity` se conserva por compatibilidad del control de acceso existente.
 * Este flujo no define el catálogo de Sucursales ni su uso por módulo.
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

  const requestedCities = normalizeMany(body.scopeCities);
  const requestedVacancyIds = normalizeMany(body.scopeVacancyIds);

  if (!requestedCities.length) {
    return { error: 'Selecciona al menos una sucursal para filtrar sus operaciones.' };
  }
  if (!requestedVacancyIds.length) {
    return { error: 'Selecciona al menos una operación para este usuario.' };
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
    return { error: 'Una o varias operaciones seleccionadas ya no existen.' };
  }

  const requestedCitySet = new Set(requestedCities);
  const outsideSelectedCities = selectedVacancies.filter((vacancy) => !requestedCitySet.has(vacancy.city));
  if (outsideSelectedCities.length) {
    return { error: 'Solo puedes asignar operaciones pertenecientes a las sucursales seleccionadas.' };
  }

  const selectedCities = [...new Set(selectedVacancies.map((vacancy) => vacancy.city).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));

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
                interviewSlots: { orderBy: [{ dayOfWeek: 'asc' }, { specificDate: 'asc' }, { startTime: 'asc' }] },
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
      flash(res, 'error', 'Siberia pertenece a la sucursal Bogotá. Créala como operación o zona dentro de Bogotá, no como sucursal independiente.');
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
    try {
      await prisma.city.update({
        where: { id: req.params.id },
        data: { name, ...unifiedBranchCompatibilityData() }
      });
      await prisma.vacancy.updateMany({
        where: { operation: { cityId: req.params.id } },
        data: { city: name }
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
        flash(res, 'error', `No se puede eliminar "${city.name}" porque tiene operaciones asociadas.`);
        return res.redirect('/admin/locations');
      }
      await prisma.city.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Sucursal "${city.name}" eliminada.`);
    } catch (_error) {
      flash(res, 'error', 'Error al eliminar la sucursal.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:cityId/operations', async (req, res) => {
    const name = normalize(req.body.name);
    const city = await prisma.city.findUnique({ where: { id: req.params.cityId }, select: { id: true, name: true } });
    if (!city) {
      flash(res, 'error', 'Sucursal no encontrada.');
      return res.redirect('/admin/locations');
    }
    if (!name) {
      flash(res, 'error', 'El nombre de la operación no puede estar vacío.');
      return res.redirect('/admin/locations');
    }

    const config = buildRecruitmentConfigData(req.body, { cityName: city.name, operationName: name });
    if (config.error) {
      flash(res, 'error', config.error);
      return res.redirect('/admin/locations');
    }

    try {
      const key = await buildUniqueVacancyKey(prisma, city.name, name, config.data.title);
      await prisma.$transaction(async (tx) => {
        const operation = await tx.operation.create({ data: { name, cityId: city.id } });
        await tx.vacancy.create({ data: { ...config.data, key, operationId: operation.id } });
      });
      flash(res, 'success', `Operación "${name}" creada con su configuración para Lórren.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una operación "${name}" en esta sucursal.`);
      } else {
        flash(res, 'error', 'Error al crear la operación.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.operation.update({ where: { id: req.params.id }, data: { name } });
      flash(res, 'success', `Operación renombrada a "${name}".`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', 'Ya existe una operación con ese nombre en la misma sucursal.');
      } else {
        flash(res, 'error', 'Error al renombrar la operación.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:id/recruitment', async (req, res) => {
    const operation = await loadOperationWithBranch(prisma, req.params.id);
    if (!operation) {
      flash(res, 'error', 'Operación no encontrada.');
      return res.redirect('/admin/locations');
    }
    if (operation._count.vacancies > 0) {
      flash(res, 'error', 'Esta operación ya tiene configuración para Lórren. Edita la configuración existente.');
      return res.redirect('/admin/locations');
    }

    const config = buildRecruitmentConfigData(req.body, { cityName: operation.city.name, operationName: operation.name });
    if (config.error) {
      flash(res, 'error', config.error);
      return res.redirect('/admin/locations');
    }

    try {
      const key = await buildUniqueVacancyKey(prisma, operation.city.name, operation.name, config.data.title);
      await prisma.vacancy.create({ data: { ...config.data, key, operationId: operation.id } });
      flash(res, 'success', `Configuración de "${operation.name}" creada para Lórren.`);
    } catch (_error) {
      flash(res, 'error', 'No fue posible crear la configuración de la operación.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:operationId/recruitment/:vacancyId/edit', async (req, res) => {
    const vacancy = await prisma.vacancy.findFirst({
      where: { id: req.params.vacancyId, operationId: req.params.operationId },
      include: { operation: { include: { city: { select: { name: true } } } } }
    });
    if (!vacancy?.operation?.city) {
      flash(res, 'error', 'Configuración de operación no encontrada.');
      return res.redirect('/admin/locations');
    }

    const config = buildRecruitmentConfigData(req.body, {
      cityName: vacancy.operation.city.name,
      operationName: vacancy.operation.name
    });
    if (config.error) {
      flash(res, 'error', config.error);
      return res.redirect('/admin/locations');
    }

    try {
      await prisma.vacancy.update({
        where: { id: vacancy.id },
        data: config.data
      });
      flash(res, 'success', `Configuración de "${vacancy.operation.name}" actualizada.`);
    } catch (_error) {
      flash(res, 'error', 'No fue posible actualizar la configuración de la operación.');
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
        flash(res, 'error', 'Operación no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (operation._count.vacancies > 0) {
        flash(res, 'error', `No se puede eliminar "${operation.name}" porque tiene ${operation._count.vacancies} configuración(es) de reclutamiento asociada(s).`);
        return res.redirect('/admin/locations');
      }
      await prisma.operation.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Operación "${operation.name}" eliminada.`);
    } catch (_error) {
      flash(res, 'error', 'Error al eliminar la operación.');
    }
    return res.redirect('/admin/locations');
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
    if (req.userRole === 'dev') {
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
      ? 'todas las sucursales y operaciones'
      : `${accessUpdate.selectedVacancyIds.length} operación(es) de ${accessUpdate.selectedCities.join(', ')}`;

    return res.redirect(usersRedirect(
      'success',
      `Usuario ${user.username} actualizado con acceso a ${accessDescription}.`,
      user.username
    ));
  });

  return router;
}