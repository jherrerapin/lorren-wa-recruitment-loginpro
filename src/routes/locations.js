// routes/locations.js — CRUD de Ciudad, Operación y asignación territorial de usuarios
import express from 'express';
import {
  encodeUserAccessSelection,
  normalizeUserAccessScope
} from '../services/appUsers.js';

const CITY_USAGE_ORDER = ['RECRUITMENT', 'DISPATCH'];

const CITY_USAGE_LABELS = {
  RECRUITMENT: 'Bot / Reclutamiento',
  DISPATCH: 'Despacho'
};

const CITY_USAGE_DESCRIPTIONS = {
  RECRUITMENT: 'Ciudades habilitadas para vacantes, candidatos, entrevistas y flujo del bot.',
  DISPATCH: 'Ciudades habilitadas para operación, despacho, asignaciones o personal operativo.'
};

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

function normalizeMany(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalize).filter(Boolean))];
}

function isChecked(value) {
  return value === 'on' || value === 'true' || value === true;
}

function usersRedirect(type, message, username = null) {
  const params = new URLSearchParams();
  params.set(type, message);
  if (username) params.set('username', username);
  return `/admin/users?${params.toString()}`;
}

function resolveCityUsage(body) {
  const usedForRecruitment = isChecked(body.usedForRecruitment);
  const usedForDispatch = isChecked(body.usedForDispatch);
  if (!usedForRecruitment && !usedForDispatch) {
    return { error: 'Debes seleccionar al menos un uso: Bot / Reclutamiento o Despacho.' };
  }
  return {
    usedForRecruitment,
    usedForDispatch,
    sourceModule: usedForDispatch && !usedForRecruitment ? 'DISPATCH' : 'RECRUITMENT'
  };
}

function cityHasUsage(city, usage) {
  if (usage === 'RECRUITMENT') return Boolean(city.usedForRecruitment) || city.sourceModule === 'RECRUITMENT';
  if (usage === 'DISPATCH') return Boolean(city.usedForDispatch) || city.sourceModule === 'DISPATCH';
  return false;
}

function cityUsageBadges(city) {
  return CITY_USAGE_ORDER.filter((usage) => cityHasUsage(city, usage)).map((usage) => ({
    usage,
    label: CITY_USAGE_LABELS[usage]
  }));
}

function groupCitiesByUsage(cities = []) {
  return CITY_USAGE_ORDER.map((usage) => ({
    usage,
    label: CITY_USAGE_LABELS[usage],
    description: CITY_USAGE_DESCRIPTIONS[usage],
    cities: cities.filter((city) => cityHasUsage(city, usage))
  }));
}

/**
 * Resuelve el permiso de reclutamiento solicitado.
 *
 * La ciudad solo funciona como filtro de organización en la interfaz. El acceso
 * efectivo se concede exclusivamente a los IDs de vacante seleccionados.
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
    return { error: 'Selecciona al menos una ciudad para filtrar sus vacantes.' };
  }
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

  const requestedCitySet = new Set(requestedCities);
  const outsideSelectedCities = selectedVacancies.filter((vacancy) => !requestedCitySet.has(vacancy.city));
  if (outsideSelectedCities.length) {
    return { error: 'Solo puedes asignar vacantes pertenecientes a las ciudades seleccionadas.' };
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
          include: { _count: { select: { vacancies: true } } }
        }
      }
    });
    const { successMsg, errorMsg } = readFlash(req, res);
    res.render('locations', {
      cities,
      citySections: groupCitiesByUsage(cities),
      cityUsageOrder: CITY_USAGE_ORDER,
      cityUsageLabels: CITY_USAGE_LABELS,
      cityUsageBadges,
      cityHasUsage,
      successMsg,
      errorMsg,
      role: req.userRole
    });
  });

  router.get('/api/operations', async (_req, res) => {
    const operations = await prisma.operation.findMany({
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
      include: { city: { select: { name: true, sourceModule: true, usedForRecruitment: true, usedForDispatch: true } } }
    });
    res.json(operations);
  });

  router.post('/cities', async (req, res) => {
    const name = normalize(req.body.name);
    const usage = resolveCityUsage(req.body);
    if (!name) {
      flash(res, 'error', 'El nombre de la ciudad no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    if (usage.error) {
      flash(res, 'error', usage.error);
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.city.create({ data: { name, ...usage } });
      flash(res, 'success', `Ciudad "${name}" creada correctamente.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una ciudad con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al crear la ciudad.');
      }
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    const usage = resolveCityUsage(req.body);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    if (usage.error) {
      flash(res, 'error', usage.error);
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.city.update({ where: { id: req.params.id }, data: { name, ...usage } });
      flash(res, 'success', `Ciudad "${name}" actualizada correctamente.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una ciudad con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al actualizar la ciudad.');
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
        flash(res, 'error', 'Ciudad no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (city._count.operations > 0) {
        flash(res, 'error', `No se puede eliminar "${city.name}" porque tiene operaciones asociadas.`);
        return res.redirect('/admin/locations');
      }
      await prisma.city.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Ciudad "${city.name}" eliminada.`);
    } catch (_error) {
      flash(res, 'error', 'Error al eliminar la ciudad.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:cityId/operations', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre de la operación no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.operation.create({ data: { name, cityId: req.params.cityId } });
      flash(res, 'success', `Operación "${name}" creada.`);
    } catch (error) {
      if (error.code === 'P2002') {
        flash(res, 'error', `Ya existe una operación "${name}" en esta ciudad.`);
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
        flash(res, 'error', 'Ya existe una operación con ese nombre en la misma ciudad.');
      } else {
        flash(res, 'error', 'Error al renombrar la operación.');
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
        flash(res, 'error', 'Operación no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (operation._count.vacancies > 0) {
        flash(res, 'error', `No se puede eliminar "${operation.name}" porque tiene ${operation._count.vacancies} vacante(s) asociada(s). Reasigna o elimina las vacantes primero.`);
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
      data.canAccessDispatch = isChecked(req.body.canAccessDispatch);
      data.canAccessMetaAds = isChecked(req.body.canAccessMetaAds);
      data.canAccessCvAnalysis = isChecked(req.body.canAccessCvAnalysis);
      data.canAccessStatistics = data.canAccessMetaAds || data.canAccessCvAnalysis;
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data
    });

    const accessDescription = accessUpdate.accessScope === 'ALL'
      ? 'todas las ciudades y vacantes'
      : `${accessUpdate.selectedVacancyIds.length} vacante(s) de ${accessUpdate.selectedCities.join(', ')}`;

    return res.redirect(usersRedirect(
      'success',
      `Usuario ${user.username} actualizado con acceso a ${accessDescription}.`,
      user.username
    ));
  });

  return router;
}
