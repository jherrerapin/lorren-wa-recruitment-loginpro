// routes/locations.js — CRUD de Sucursales, Operaciones y asignación territorial de usuarios
import express from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  canCreateRecruiterUsers,
  canManageUserModulePermissions,
  encodeUserAccessCities,
  encodeUserAccessSelection,
  generateRecoveryCode,
  normalizeAppUserEmail,
  normalizeUserAccessScope
} from '../services/appUsers.js';
import { loadUnifiedCityOptions } from '../services/cityOptions.js';
import { resolvePayrollFeatureAccess, setPayrollFeatureAccess } from '../services/payrollFeatureAccess.js';
import {
  buildOperationalPermissionStates,
  canManageOperationalPermissions,
  getOperationalAccessForUser,
  listOperationalAccess,
  normalizeOperationalModuleAccess,
  operationalAccessCatalog,
  setOperationalAccess,
  supervisorAssignableOperationalCapabilities
} from '../services/operationalAccess.js';

function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  req.userId = req.session?.userId || null;
  req.username = req.session?.username || null;
  req.userSource = req.session?.userSource || null;
  req.userAccessScope = req.session?.userAccessScope || 'ALL';
  req.userAccessCity = req.session?.userAccessCity || null;
  req.userAccessVacancyId = req.session?.userAccessVacancyId || null;
  if (!['dev', 'admin'].includes(role)) return res.redirect('/admin');
  return next();
}

function canManageRecruiterUsers(req) {
  return canCreateRecruiterUsers(req);
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

function payrollAccessActor(req) {
  return {
    actorUserId: req.userId || req.session?.userId || null,
    actorUsername: req.username || req.session?.username || null,
    actorRole: req.userRole || req.session?.userRole || null,
    actorSource: req.userSource || req.session?.userSource || null,
    actorAccessScope: req.userAccessScope || req.session?.userAccessScope || 'ALL',
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
    select: {
      id: true,
      username: true,
      role: true,
      isActive: true,
      canAccessDispatch: true,
      canAccessAttendance: true
    }
  });
}

function canEditPayrollPermissionTarget(req, user) {
  if (!user || user.role !== 'ADMIN') return false;
  if (req.userRole === 'dev') return true;
  return true;
}

function canEditOperationalTarget(req, access) {
  if (!access) return false;
  if (req.userRole === 'dev') return true;
  if (!canManageOperationalPermissions(req)) return false;
  const actorId = req.userId || req.session?.userId || null;
  if (actorId && access.userId === actorId) return false;
  if (!access.configured || access.role === 'SUPERVISOR') return false;
  return true;
}

function operationalAccessErrorStatus(error) {
  const code = String(error?.message || '');
  if (code === 'operational_access_user_not_found') return 404;
  if ([
    'operational_access_manager_required',
    'operational_access_self_forbidden',
    'operational_access_supervisor_target_forbidden',
    'operational_access_capability_not_delegable',
    'operational_module_access_not_delegable',
    'operational_module_access_dev_required',
    'operational_role_dev_required',
    'operational_delegation_dev_required',
    'payroll_access_manager_required'
  ].includes(code)) return 403;
  return 400;
}

function parseOperationalAccessConfig(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('operational_access_config_invalid');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('operational_access_config_invalid');
  const moduleAccess = normalizeOperationalModuleAccess(parsed.moduleAccess);
  if (!moduleAccess) throw new Error('operational_module_access_invalid');
  return {
    role: parsed.role,
    permissions: parsed.permissions || {},
    delegablePermissions: parsed.delegablePermissions || [],
    moduleAccess
  };
}

async function moduleAccessForUser(prisma, user) {
  if (!user?.id) return { dispatch: false, attendance: false, time: false };
  let time = false;
  try {
    const access = await resolvePayrollFeatureAccess(prisma, {
      userRole: 'admin',
      userId: user.id,
      username: user.username
    });
    time = access.allowed === true;
  } catch {
    time = false;
  }
  return {
    dispatch: Boolean(user.canAccessDispatch),
    attendance: Boolean(user.canAccessAttendance),
    time
  };
}

function editableOperationalModules(req, catalog) {
  const roots = (catalog.capabilities || []).filter((item) => item.moduleAccess === true && item.moduleAccessKey);
  if (req.userRole === 'dev' || canManageOperationalPermissions(req)) return roots.map((item) => item.moduleAccessKey);
  return [];
}

function editableOperationalCapabilities(req, catalog) {
  if (req.userRole === 'dev') return catalog.capabilities.map((item) => item.key);
  if (!canManageOperationalPermissions(req)) return [];
  const assignable = new Set(supervisorAssignableOperationalCapabilities());
  return catalog.capabilities
    .filter((item) => item.moduleAccess !== true && item.supervisorOnly !== true && assignable.has(item.key))
    .map((item) => item.key);
}

async function withOptionalTransaction(prisma, callback) {
  if (typeof prisma?.$transaction === 'function') return prisma.$transaction((tx) => callback(tx));
  return callback(prisma);
}

async function persistUnifiedOperationalAccess(prisma, req, targetUserId, config, { updateModuleFlags = true } = {}) {
  const moduleAccess = normalizeOperationalModuleAccess(config?.moduleAccess);
  if (!moduleAccess) throw new Error('operational_module_access_invalid');

  const accessInput = {
    targetUserId,
    permissions: config.permissions,
    moduleAccess,
    ...operationalAccessActor(req)
  };
  if (req.userRole === 'dev') {
    accessInput.role = config.role;
    accessInput.delegablePermissions = config.delegablePermissions;
  }
  const access = await setOperationalAccess(prisma, accessInput);

  if (updateModuleFlags) {
    await prisma.appUser.update({
      where: { id: targetUserId },
      data: {
        canAccessDispatch: moduleAccess.dispatch,
        canAccessAttendance: moduleAccess.attendance
      }
    });
  }

  await setPayrollFeatureAccess(prisma, {
    targetUserId,
    enabled: moduleAccess.time,
    ...payrollAccessActor(req)
  });

  return { ...access, moduleAccess };
}

function operationalConfigFromExisting(access, moduleAccess) {
  if (!access?.configured || !access.role) return null;
  return {
    role: access.role,
    permissions: buildOperationalPermissionStates(access.role, access.effectivePermissions || []),
    delegablePermissions: [],
    moduleAccess
  };
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

function isBogotaFamilyName(value) {
  return isBogotaName(value) || isSiberiaName(value);
}

function sameBranchName(left, right) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  if (leftKey === rightKey) return true;
  return isBogotaFamilyName(left) && isBogotaFamilyName(right);
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

function supervisorInheritedScope(req = {}) {
  const accessScope = normalizeUserAccessScope(req.userAccessScope || req.session?.userAccessScope || 'ALL');
  if (accessScope === 'ALL') {
    return { accessScope: 'ALL', scopeCity: null, scopeVacancyId: null };
  }
  const scopeCity = req.userAccessCity || req.session?.userAccessCity || null;
  const scopeVacancyId = accessScope === 'VACANCY'
    ? req.userAccessVacancyId || req.session?.userAccessVacancyId || null
    : null;
  return { accessScope, scopeCity, scopeVacancyId };
}

function parseScopeMetadata(value) {
  const raw = normalize(value);
  if (!raw) return { cities: [], vacancyIds: [] };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          cities: normalizeMany(parsed.cities),
          vacancyIds: normalizeMany(parsed.vacancyIds)
        };
      }
    } catch (_error) {
      return { cities: [raw], vacancyIds: [] };
    }
  }
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { cities: normalizeMany(parsed), vacancyIds: [] };
    } catch (_error) {
      return { cities: [raw], vacancyIds: [] };
    }
  }
  return { cities: [raw], vacancyIds: [] };
}

function requestBranchScope(req = {}) {
  if (req.userRole === 'dev') return { accessScope: 'ALL', cities: [], vacancyIds: [] };
  const inherited = supervisorInheritedScope(req);
  const metadata = parseScopeMetadata(inherited.scopeCity);
  return {
    accessScope: inherited.accessScope,
    cities: inherited.accessScope === 'ALL' ? [] : metadata.cities,
    vacancyIds: normalizeMany([...(metadata.vacancyIds || []), inherited.scopeVacancyId])
  };
}

function branchScopeAllowsCity(scope, cityName) {
  if (scope.accessScope === 'ALL') return true;
  return scope.cities.some((allowedCity) => sameBranchName(allowedCity, cityName));
}

function branchScopeCanCreateCity(scope) {
  return scope.accessScope === 'ALL';
}

function branchScopeCanManageOperation(scope, cityName) {
  return scope.accessScope !== 'VACANCY' && branchScopeAllowsCity(scope, cityName);
}

function filterCitiesForBranchScope(cities = [], scope = { accessScope: 'ALL', cities: [], vacancyIds: [] }) {
  const visibleVacancyIds = new Set(scope.vacancyIds || []);
  return cities
    .filter((city) => branchScopeAllowsCity(scope, city?.name))
    .map((city) => {
      if (scope.accessScope !== 'VACANCY') return city;
      const operations = (city.operations || [])
        .map((operation) => ({
          ...operation,
          vacancies: (operation.vacancies || []).filter((vacancy) => visibleVacancyIds.has(vacancy.id))
        }))
        .filter((operation) => operation.vacancies.length > 0);
      return { ...city, operations };
    })
    .filter((city) => scope.accessScope !== 'VACANCY' || city.operations.length > 0);
}

function territorialScopeForUser(user = {}) {
  const accessScope = normalizeUserAccessScope(user.accessScope);
  const metadata = parseScopeMetadata(user.scopeCity);
  return {
    accessScope,
    cities: accessScope === 'ALL' ? [] : metadata.cities,
    vacancyIds: normalizeMany([...(metadata.vacancyIds || []), user.scopeVacancyId])
  };
}

async function supervisorCreationScopeOptions(prisma, req = {}) {
  const inherited = supervisorInheritedScope(req);
  const metadata = parseScopeMetadata(inherited.scopeCity);
  const inheritedVacancyIds = normalizeMany([...(metadata.vacancyIds || []), inherited.scopeVacancyId]);
  const allCities = typeof prisma?.city?.findMany === 'function'
    ? (await loadUnifiedCityOptions(prisma)).map((city) => city.name)
    : [];
  const allVacancies = typeof prisma?.vacancy?.findMany === 'function'
    ? await prisma.vacancy.findMany({
      orderBy: [{ city: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, role: true, city: true }
    })
    : [];

  if (inherited.accessScope === 'ALL') {
    return {
      actorScope: 'ALL',
      canCreateAll: true,
      allowedCities: allCities,
      allowedVacancies: allVacancies
    };
  }

  if (inherited.accessScope === 'CITY') {
    const actorCities = metadata.cities;
    return {
      actorScope: 'CITY',
      canCreateAll: false,
      allowedCities: allCities.length ? allCities.filter((city) => actorCities.includes(city)) : actorCities,
      allowedVacancies: allVacancies.filter((vacancy) => actorCities.includes(vacancy.city))
    };
  }

  const allowedVacancyIdSet = new Set(inheritedVacancyIds);
  const allowedVacancies = allVacancies.filter((vacancy) => allowedVacancyIdSet.has(vacancy.id));
  const allowedCities = normalizeMany([
    ...metadata.cities,
    ...allowedVacancies.map((vacancy) => vacancy.city)
  ]).sort((a, b) => a.localeCompare(b, 'es'));
  return {
    actorScope: 'VACANCY',
    canCreateAll: false,
    allowedCities,
    allowedVacancies
  };
}

async function resolveSupervisorRequestedScope(prisma, req, body = {}) {
  if (!normalize(body.accessScope)) {
    return {
      ...supervisorInheritedScope(req),
      selectedCities: [],
      selectedVacancyIds: []
    };
  }

  const options = await supervisorCreationScopeOptions(prisma, req);
  const resolved = await resolveRecruiterAccessUpdate(prisma, body);
  if (resolved.error) return resolved;
  if (options.actorScope === 'ALL') return resolved;
  if (resolved.accessScope === 'ALL') {
    return { error: 'No puedes asignar un alcance mayor al tuyo.' };
  }

  const allowedCities = new Set(options.allowedCities || []);
  const allowedVacancyIds = new Set((options.allowedVacancies || []).map((vacancy) => vacancy.id));
  if (options.actorScope === 'CITY') {
    if (resolved.accessScope === 'CITY' && resolved.selectedCities.some((city) => !allowedCities.has(city))) {
      return { error: 'Solo puedes asignar sucursales que estén dentro de tu propio alcance.' };
    }
    if (resolved.accessScope === 'VACANCY' && resolved.selectedVacancyIds.some((id) => !allowedVacancyIds.has(id))) {
      return { error: 'Solo puedes asignar vacantes que estén dentro de tu propio alcance.' };
    }
    return resolved;
  }

  if (resolved.accessScope !== 'VACANCY') {
    return { error: 'Tu perfil solo puede asignar usuarios con alcance por vacantes.' };
  }
  if (resolved.selectedVacancyIds.some((id) => !allowedVacancyIds.has(id))) {
    return { error: 'Solo puedes asignar vacantes que estén dentro de tu propio alcance.' };
  }
  return resolved;
}

function unifiedBranchCompatibilityData() {
  return {
    usedForRecruitment: true,
    usedForDispatch: true,
    sourceModule: 'RECRUITMENT'
  };
}

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
  if (!requestedCities.length) return { error: 'Selecciona al menos una sucursal para este usuario.' };

  const cityOptions = await loadUnifiedCityOptions(prisma);
  const canonicalCityNames = new Set(cityOptions.map((city) => city.name));
  const invalidCities = requestedCities.filter((city) => !canonicalCityNames.has(city));
  if (invalidCities.length) return { error: 'Una o varias sucursales seleccionadas ya no existen.' };

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
  if (!requestedVacancyIds.length) return { error: 'Selecciona al menos una vacante para este usuario.' };

  const selectedVacancies = await prisma.vacancy.findMany({
    where: { id: { in: requestedVacancyIds } },
    select: { id: true, title: true, role: true, city: true }
  });
  const foundIds = new Set(selectedVacancies.map((vacancy) => vacancy.id));
  const missingVacancyIds = requestedVacancyIds.filter((id) => !foundIds.has(id));
  if (missingVacancyIds.length) return { error: 'Una o varias vacantes seleccionadas ya no existen.' };

  const requestedCityKeys = new Set(requestedCities.map(normalizeKey));
  const outsideSelectedCities = selectedVacancies.filter((vacancy) => !requestedCityKeys.has(normalizeKey(vacancy.city)));
  if (outsideSelectedCities.length) return { error: 'Solo puedes asignar vacantes pertenecientes a las sucursales seleccionadas.' };

  const selectedVacancyCityKeys = new Set(selectedVacancies.map((vacancy) => normalizeKey(vacancy.city)).filter(Boolean));
  const selectedCities = requestedCities.filter((city) => selectedVacancyCityKeys.has(normalizeKey(city)));
  return {
    accessScope: 'VACANCY',
    scopeCity: encodeUserAccessSelection({ cities: selectedCities, vacancyIds: requestedVacancyIds }),
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
    const allCities = await prisma.city.findMany({
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
    const branchScope = requestBranchScope(req);
    const cities = filterCitiesForBranchScope(allCities, branchScope);
    const { successMsg, errorMsg } = readFlash(req, res);
    res.render('locations', {
      cities,
      successMsg,
      errorMsg,
      role: req.userRole,
      accessScope: branchScope.accessScope,
      canCreateBranch: branchScopeCanCreateCity(branchScope),
      canManageBranchStructure: branchScope.accessScope !== 'VACANCY',
      canAccessDispatch: Boolean(req.session?.canAccessDispatch)
    });
  });

  router.get('/users', async (req, res) => {
    if (req.userRole === 'dev') return res.redirect('/admin/users');
    if (!canManageOperationalPermissions(req)) return res.status(403).send('No tienes acceso para administrar permisos operativos.');
    const { successMsg, errorMsg } = readFlash(req, res);
    const creationScopeOptions = await supervisorCreationScopeOptions(prisma, req);
    return res.render('supervisor-users', {
      role: req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch),
      successMsg,
      errorMsg,
      revealedRecoveryCode: normalize(req.query?.recoveryCode),
      createdUserId: normalize(req.query?.createdUserId),
      creationScopeOptions
    });
  });

  router.post('/users/create', express.urlencoded({ extended: true }), async (req, res) => {
    if (req.userRole === 'dev') return res.redirect('/admin/users');
    if (!canManageOperationalPermissions(req)) return res.status(403).send('No tienes acceso para crear usuarios.');

    const displayName = normalize(req.body.displayName);
    const email = normalizeAppUserEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const recoveryPhone = normalize(req.body.recoveryPhone);
    if (!displayName || displayName.length < 3) {
      flash(res, 'error', 'Debes ingresar el nombre completo del usuario.');
      return res.redirect('/admin/locations/users');
    }
    if (!email) {
      flash(res, 'error', 'Debes ingresar un correo electrónico válido.');
      return res.redirect('/admin/locations/users');
    }
    if (password.length < 6) {
      flash(res, 'error', 'La contraseña inicial debe tener al menos 6 caracteres.');
      return res.redirect('/admin/locations/users');
    }

    const existingEmail = await prisma.appUser.findUnique({ where: { email }, select: { id: true } });
    if (existingEmail) {
      flash(res, 'error', 'Ese correo ya está asociado a otro usuario.');
      return res.redirect('/admin/locations/users');
    }

    const scopeResolution = await resolveSupervisorRequestedScope(prisma, req, req.body);
    if (scopeResolution.error) {
      flash(res, 'error', scopeResolution.error);
      return res.redirect('/admin/locations/users');
    }

    let operationalConfig = {
      role: 'CONSULTA',
      permissions: {},
      delegablePermissions: [],
      moduleAccess: { dispatch: false, attendance: false, time: false }
    };
    if (normalize(req.body.operationalAccessConfig)) {
      try {
        const parsed = parseOperationalAccessConfig(req.body.operationalAccessConfig);
        operationalConfig = {
          role: 'CONSULTA',
          permissions: parsed.permissions || {},
          delegablePermissions: [],
          moduleAccess: parsed.moduleAccess
        };
      } catch (_error) {
        flash(res, 'error', 'La configuración de módulos y funciones no es válida.');
        return res.redirect('/admin/locations/users');
      }
    }

    const username = `user-${randomUUID()}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 10);
    const identityMigratedAt = new Date();
    let createdUser = null;

    try {
      await withOptionalTransaction(prisma, async (db) => {
        createdUser = await db.appUser.create({
          data: {
            username,
            passwordHash,
            displayName,
            email,
            identityMigratedAt,
            recoveryCodeHash,
            role: 'ADMIN',
            accessScope: scopeResolution.accessScope,
            scopeCity: scopeResolution.scopeCity,
            scopeVacancyId: scopeResolution.scopeVacancyId,
            canAccessDispatch: operationalConfig.moduleAccess.dispatch,
            canAccessAttendance: operationalConfig.moduleAccess.attendance,
            canAccessStatistics: false,
            canAccessMetaAds: false,
            canAccessCvAnalysis: false,
            recoveryPhone,
            recoveryEmail: email,
            createdByUsername: req.username || req.session?.username || 'supervisor',
            lastPasswordResetAt: identityMigratedAt,
            isActive: true
          }
        });
        await persistUnifiedOperationalAccess(db, req, createdUser.id, operationalConfig, { updateModuleFlags: false });
      });
    } catch (error) {
      if (error?.code === 'P2002') flash(res, 'error', 'Ese correo ya está asociado a otro usuario.');
      else {
        console.error('[supervisor-user-create]', error);
        flash(res, 'error', 'No fue posible crear el usuario.');
      }
      return res.redirect('/admin/locations/users');
    }

    flash(res, 'success', `${displayName} fue creado como usuario Consulta con el alcance y los permisos seleccionados.`);
    const params = new URLSearchParams({ recoveryCode, createdUserId: createdUser.id });
    return res.redirect(`/admin/locations/users?${params.toString()}`);
  });

  router.get('/api/cities', async (req, res) => {
    if (!canManageRecruiterUsers(req)) return res.status(403).json({ error: 'forbidden' });
    const branchScope = requestBranchScope(req);
    const cities = await loadUnifiedCityOptions(prisma);
    res.json(cities
      .filter((city) => branchScopeAllowsCity(branchScope, city.name))
      .map((city) => ({ id: city.id, name: city.name })));
  });

  router.get('/api/operations', async (req, res) => {
    const branchScope = requestBranchScope(req);
    const operations = await prisma.operation.findMany({
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
      include: {
        city: { select: { name: true } },
        vacancies: { select: { id: true } }
      }
    });
    const visibleVacancyIds = new Set(branchScope.vacancyIds || []);
    res.json(operations
      .filter((operation) => branchScopeAllowsCity(branchScope, operation.city?.name))
      .filter((operation) => branchScope.accessScope !== 'VACANCY' || operation.vacancies.some((vacancy) => visibleVacancyIds.has(vacancy.id)))
      .map(({ vacancies: _vacancies, ...operation }) => operation));
  });

  router.post('/cities', async (req, res) => {
    const branchScope = requestBranchScope(req);
    if (!branchScopeCanCreateCity(branchScope)) {
      return operationError(req, res, 403, 'Tu alcance no permite crear nuevas sucursales.');
    }
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
      if (error.code === 'P2002') flash(res, 'error', `Ya existe una sucursal con el nombre "${name}".`);
      else flash(res, 'error', 'Error al crear la sucursal.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:id/edit', async (req, res) => {
    const branchScope = requestBranchScope(req);
    if (!branchScopeCanCreateCity(branchScope)) {
      return operationError(req, res, 403, 'Tu alcance no permite modificar la estructura de sucursales.');
    }
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
      await prisma.city.update({ where: { id: city.id }, data: { name, ...unifiedBranchCompatibilityData() } });
      flash(res, 'success', `Sucursal "${name}" actualizada correctamente.`);
    } catch (error) {
      if (error.code === 'P2002') flash(res, 'error', `Ya existe una sucursal con el nombre "${name}".`);
      else flash(res, 'error', 'Error al actualizar la sucursal.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/cities/:id/delete', async (req, res) => {
    const branchScope = requestBranchScope(req);
    if (!branchScopeCanCreateCity(branchScope)) {
      return operationError(req, res, 403, 'Tu alcance no permite eliminar sucursales.');
    }
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

  router.post('/cities/:cityId/operations', async (req, res) => {
    const name = normalize(req.body.name);
    const city = await prisma.city.findUnique({ where: { id: req.params.cityId }, select: { id: true, name: true } });
    if (!city) return operationError(req, res, 404, 'Sucursal no encontrada.');
    const branchScope = requestBranchScope(req);
    if (!branchScopeCanManageOperation(branchScope, city.name)) {
      return operationError(req, res, 403, 'No tienes acceso para crear vacantes en esta sucursal.');
    }
    if (!name) return operationError(req, res, 400, 'El nombre de la vacante no puede estar vacío.');
    if (isSiberiaName(name) && !isBogotaName(city.name)) return operationError(req, res, 400, 'La vacante Siberia solo puede pertenecer a la sucursal Bogotá.');

    try {
      const operation = await prisma.operation.create({ data: { name, cityId: city.id } });
      if (wantsJson(req)) {
        return res.status(201).json({ ok: true, operation: { id: operation.id, name: operation.name, cityId: city.id, cityName: city.name } });
      }
      flash(res, 'success', `Vacante "${name}" creada. Completa su información para activar Lórren.`);
    } catch (error) {
      if (error.code === 'P2002') return operationError(req, res, 409, `Ya existe una vacante "${name}" en esta sucursal.`);
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
    const branchScope = requestBranchScope(req);
    if (!branchScopeCanManageOperation(branchScope, operation.city?.name)) {
      return operationError(req, res, 403, 'No tienes acceso para modificar vacantes de esta sucursal.');
    }
    if (isSiberiaName(name) && !isBogotaName(operation.city?.name)) {
      flash(res, 'error', 'La vacante Siberia solo puede pertenecer a la sucursal Bogotá.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.operation.update({ where: { id: operation.id }, data: { name } });
      flash(res, 'success', `Vacante renombrada a "${name}".`);
    } catch (error) {
      if (error.code === 'P2002') flash(res, 'error', 'Ya existe una vacante con ese nombre en la misma sucursal.');
      else flash(res, 'error', 'Error al renombrar la vacante.');
    }
    return res.redirect('/admin/locations');
  });

  router.post('/operations/:id/delete', async (req, res) => {
    try {
      const operation = await prisma.operation.findUnique({
        where: { id: req.params.id },
        include: {
          city: { select: { name: true } },
          _count: { select: { vacancies: true } }
        }
      });
      if (!operation) {
        flash(res, 'error', 'Vacante no encontrada.');
        return res.redirect('/admin/locations');
      }
      const branchScope = requestBranchScope(req);
      if (!branchScopeCanManageOperation(branchScope, operation.city?.name)) {
        return operationError(req, res, 403, 'No tienes acceso para eliminar vacantes de esta sucursal.');
      }
      if (operation._count.vacancies > 0) {
        flash(res, 'error', `No se puede eliminar la vacante "${operation.name}" porque ya tiene configuración de reclutamiento asociada.`);
        return res.redirect('/admin/locations');
      }
      await prisma.operation.delete({ where: { id: req.params.id } });
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
        delegablePermissions: editableOperationalCapabilities(req, catalog),
        editableModules: editableOperationalModules(req, catalog)
      }
    });
  });

  router.get('/users/operational-access', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const users = await prisma.appUser.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
        accessScope: true,
        scopeCity: true,
        scopeVacancyId: true,
        canAccessDispatch: true,
        canAccessAttendance: true
      },
      orderBy: [{ displayName: 'asc' }, { username: 'asc' }]
    });
    const accesses = await listOperationalAccess(prisma, users);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const withModules = await Promise.all(accesses.map(async (access) => {
      const user = usersById.get(access.userId);
      return {
        ...access,
        moduleAccess: await moduleAccessForUser(prisma, user),
        territorialScope: territorialScopeForUser(user)
      };
    }));
    const isDev = req.userRole === 'dev';
    const actorId = req.userId || req.session?.userId || null;
    const visible = isDev
      ? withModules
      : withModules.filter((access) => canEditOperationalTarget(req, access) && access.userId !== actorId);
    const catalog = operationalAccessCatalog();
    const scopeOptions = await supervisorCreationScopeOptions(prisma, req);
    return res.json({
      ok: true,
      users: visible,
      roles: catalog.roles,
      capabilities: catalog.capabilities,
      editableCapabilities: editableOperationalCapabilities(req, catalog),
      editableModules: editableOperationalModules(req, catalog),
      scopeOptions: {
        actorScope: scopeOptions.actorScope,
        canAssignAll: scopeOptions.canCreateAll === true,
        allowedCities: scopeOptions.allowedCities || []
      }
    });
  });

  router.post('/users/:id/territorial-scope', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const current = await getOperationalAccessForUser(prisma, req.params.id);
      if (!current) return res.status(404).json({ ok: false, error: 'user_not_found' });
      if (!canEditOperationalTarget(req, current)) return res.status(403).json({ ok: false, error: 'forbidden' });

      const target = await prisma.appUser.findUnique({
        where: { id: req.params.id },
        select: { id: true, role: true, accessScope: true, scopeCity: true, scopeVacancyId: true }
      });
      if (!target || target.role !== 'ADMIN') return res.status(404).json({ ok: false, error: 'user_not_found' });

      const requestedScope = String(req.body?.accessScope || '').toUpperCase();
      if (!['ALL', 'CITY'].includes(requestedScope)) {
        return res.status(400).json({ ok: false, error: 'territorial_scope_invalid', message: 'Selecciona todas las sucursales o una lista concreta de sucursales.' });
      }
      const scopeResolution = await resolveSupervisorRequestedScope(prisma, req, {
        accessScope: requestedScope,
        scopeCities: Array.isArray(req.body?.scopeCities) ? req.body.scopeCities : []
      });
      if (scopeResolution.error) {
        return res.status(400).json({ ok: false, error: 'territorial_scope_forbidden', message: scopeResolution.error });
      }

      const updated = await prisma.appUser.update({
        where: { id: target.id },
        data: {
          accessScope: scopeResolution.accessScope,
          scopeCity: scopeResolution.scopeCity,
          scopeVacancyId: scopeResolution.scopeVacancyId
        },
        select: { id: true, accessScope: true, scopeCity: true, scopeVacancyId: true }
      });
      return res.json({ ok: true, territorialScope: territorialScopeForUser(updated) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'territorial_scope_failed' });
    }
  });

  router.get('/users/:id/operational-access', async (req, res) => {
    if (!canManageOperationalPermissions(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const access = await getOperationalAccessForUser(prisma, req.params.id);
      if (!access) return res.status(404).json({ ok: false, error: 'user_not_found' });
      if (!canEditOperationalTarget(req, access)) return res.status(403).json({ ok: false, error: 'forbidden' });
      const user = await loadPayrollPermissionTarget(prisma, req.params.id);
      const catalog = operationalAccessCatalog();
      return res.json({
        ok: true,
        access,
        moduleAccess: await moduleAccessForUser(prisma, user),
        roles: catalog.roles,
        capabilities: catalog.capabilities,
        canEditRole: req.userRole === 'dev',
        canEditDelegation: false,
        editableCapabilities: editableOperationalCapabilities(req, catalog),
        editableModules: editableOperationalModules(req, catalog)
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

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'moduleAccess')) {
        const config = parseOperationalAccessConfig(req.body);
        const result = await withOptionalTransaction(prisma, (db) => persistUnifiedOperationalAccess(db, req, req.params.id, config));
        return res.json({ ok: true, access: result, moduleAccess: result.moduleAccess });
      }

      const accessInput = {
        targetUserId: req.params.id,
        permissions: req.body?.permissions,
        ...operationalAccessActor(req)
      };
      if (req.userRole === 'dev') {
        accessInput.role = req.body?.role;
        accessInput.delegablePermissions = [];
      }
      const result = await setOperationalAccess(prisma, accessInput);
      const user = await loadPayrollPermissionTarget(prisma, req.params.id);
      return res.json({ ok: true, access: result, moduleAccess: await moduleAccessForUser(prisma, user) });
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
      const access = await resolvePayrollFeatureAccess(prisma, { userRole: 'admin', userId: user.id, username: user.username });
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
      const current = await getOperationalAccessForUser(prisma, user.id);
      if (current?.configured) {
        if (req.userRole !== 'dev') return res.status(403).json({ ok: false, error: 'operational_module_access_dev_required' });
        const moduleAccess = await moduleAccessForUser(prisma, user);
        moduleAccess.time = req.body?.enabled === true;
        const config = operationalConfigFromExisting(current, normalizeOperationalModuleAccess(moduleAccess));
        const result = await withOptionalTransaction(prisma, (db) => persistUnifiedOperationalAccess(db, req, user.id, config));
        return res.json({ ok: true, enabled: result.moduleAccess.time, userId: user.id });
      }
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: user.id,
        enabled: req.body?.enabled === true,
        ...payrollAccessActor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(operationalAccessErrorStatus(error)).json({ ok: false, error: error?.message || 'payroll_access_failed' });
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
    if (!user || user.role !== 'ADMIN') return res.redirect(usersRedirect('error', 'Usuario reclutador no encontrado.'));
    if (req.userRole !== 'dev' && isProtectedRecruiterProfile(user)) {
      return res.redirect(usersRedirect('error', 'Solo DEV puede editar este perfil protegido.', user.username));
    }

    const accessUpdate = await resolveRecruiterAccessUpdate(prisma, req.body);
    if (accessUpdate.error) return res.redirect(usersRedirect('error', accessUpdate.error, user.username));

    let operationalConfig = null;
    try {
      operationalConfig = req.userRole === 'dev' ? parseOperationalAccessConfig(req.body.operationalAccessConfig) : null;
    } catch (error) {
      return res.redirect(usersRedirect('error', 'La configuración de módulos y funciones no es válida.', user.username));
    }

    const existingOperational = await getOperationalAccessForUser(prisma, user.id);
    const currentModuleAccess = await moduleAccessForUser(prisma, user);
    if (!operationalConfig && req.userRole === 'dev' && existingOperational?.configured) {
      const legacyModuleAccess = normalizeOperationalModuleAccess({
        dispatch: isChecked(req.body.canAccessDispatch),
        attendance: isChecked(req.body.canAccessAttendance),
        time: currentModuleAccess.time
      });
      operationalConfig = operationalConfigFromExisting(existingOperational, legacyModuleAccess);
    }

    const data = {
      accessScope: accessUpdate.accessScope,
      scopeCity: accessUpdate.scopeCity,
      scopeVacancyId: accessUpdate.scopeVacancyId,
      recoveryPhone: normalize(req.body.recoveryPhone),
      recoveryEmail: normalize(req.body.recoveryEmail)
    };
    if (canManageUserModulePermissions(req)) {
      if (req.userRole === 'dev') {
        const roots = operationalConfig?.moduleAccess || normalizeOperationalModuleAccess({
          dispatch: isChecked(req.body.canAccessDispatch),
          attendance: isChecked(req.body.canAccessAttendance),
          time: currentModuleAccess.time
        });
        data.canAccessDispatch = roots.dispatch;
        data.canAccessAttendance = roots.attendance;
      }
      data.canAccessMetaAds = isChecked(req.body.canAccessMetaAds);
      data.canAccessCvAnalysis = isChecked(req.body.canAccessCvAnalysis);
      data.canAccessStatistics = data.canAccessMetaAds || data.canAccessCvAnalysis;
    }

    try {
      await withOptionalTransaction(prisma, async (db) => {
        await db.appUser.update({ where: { id: user.id }, data });
        if (operationalConfig) await persistUnifiedOperationalAccess(db, req, user.id, operationalConfig, { updateModuleFlags: false });
      });
    } catch (error) {
      return res.redirect(usersRedirect('error', 'No fue posible guardar el rol, los módulos y sus funciones.', user.username));
    }

    const accessDescription = accessUpdate.accessScope === 'ALL'
      ? 'todas las sucursales y vacantes'
      : accessUpdate.accessScope === 'CITY'
        ? `${accessUpdate.selectedCities.length} sucursal(es): ${accessUpdate.selectedCities.join(', ')}`
        : `${accessUpdate.selectedVacancyIds.length} vacante(s) de ${accessUpdate.selectedCities.join(', ')}`;

    return res.redirect(usersRedirect('success', `Usuario ${user.username} actualizado con acceso a ${accessDescription}.`, user.username));
  });

  return router;
}
