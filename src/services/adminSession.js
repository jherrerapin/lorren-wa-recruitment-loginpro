import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import { normalizeAppUserEmail } from './appUsers.js';

export const ADMIN_SESSION_DEFAULTS = Object.freeze({
  cookieName: 'loginpro.sid',
  developmentSecret: 'dev-session-secret-change-me',
  maxAgeMs: 1000 * 60 * 60 * 8,
  storeTableName: 'session',
  pruneSessionIntervalSeconds: 60 * 60
});

const IDENTITY_PATH = '/account/identity';
const PROFILE_PATH = '/account/profile';
const IMPERSONATE_PATH = /^\/admin\/users\/([^/]+)\/impersonate$/;
const IMPERSONATION_STOP_PATH = '/admin/users/impersonation/stop';
const MIGRATED_USERNAME_SENTINEL = '__login_requires_email__';
const INITIAL_PASSWORD_POLICY_EFFECTIVE_AT = new Date('2026-08-20T23:11:06.000Z');
const INITIAL_PASSWORD_MIN_LENGTH = 12;
const BCRYPT_SAFE_MAX_BYTES = 72;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeProfilePhone(value) {
  const raw = normalizeString(value);
  if (!raw) return { valid: true, value: null, displayValue: '' };
  if (!/^[+\d\s().-]+$/.test(raw)) return { valid: false, value: null, displayValue: raw };
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return { valid: false, value: null, displayValue: raw };
  }
  return { valid: true, value: digits, displayValue: digits };
}

function requestPath(req = {}) {
  return String(req.path || req.originalUrl || req.url || '').split('?')[0] || '/';
}

function environmentSessionCanUseDispatch(sessionData = {}) {
  const username = normalizeString(sessionData.username);
  return sessionData.userRole === 'dev'
    || sessionData.canAccessDispatch === true
    || Boolean(username?.startsWith('operaciones-despacho'));
}

function environmentProfileData(sessionData, passwordHash, identity = {}) {
  const username = normalizeString(sessionData.username);
  const isDev = sessionData.userRole === 'dev';
  const dispatchByProfile = Boolean(username?.startsWith('operaciones-despacho'));
  return {
    username,
    passwordHash,
    displayName: normalizeString(identity.displayName),
    email: normalizeAppUserEmail(identity.email),
    identityMigratedAt: identity.identityMigratedAt || null,
    role: isDev ? 'DEV' : 'ADMIN',
    accessScope: 'ALL',
    scopeCity: null,
    scopeVacancyId: null,
    recoveryEmail: normalizeAppUserEmail(identity.email),
    createdByUsername: username,
    canAccessDispatch: isDev || sessionData.canAccessDispatch === true || dispatchByProfile,
    canAccessAttendance: isDev || sessionData.canAccessAttendance === true,
    canAccessStatistics: isDev || sessionData.canAccessStatistics === true,
    canAccessMetaAds: isDev || sessionData.canAccessMetaAds === true,
    canAccessCvAnalysis: isDev || sessionData.canAccessCvAnalysis === true,
    isActive: true
  };
}

export async function ensureEnvironmentDispatchProfile(sessionData, {
  prismaClient = defaultPrisma,
  bcryptModule = bcrypt,
  randomBytesFn = randomBytes
} = {}) {
  if (!sessionData || sessionData.userSource !== 'env' || sessionData.userId) return null;
  const username = normalizeString(sessionData.username);
  if (!username || !environmentSessionCanUseDispatch(sessionData) || !prismaClient?.appUser) return null;

  const existing = await prismaClient.appUser.findUnique({ where: { username } });
  if (existing) {
    if (existing.isActive !== false) sessionData.userId = existing.id;
    return existing;
  }

  const randomPassword = randomBytesFn(32).toString('hex');
  const passwordHash = await bcryptModule.hash(randomPassword, 10);
  let created;
  try {
    created = await prismaClient.appUser.create({
      data: environmentProfileData(sessionData, passwordHash)
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    created = await prismaClient.appUser.findUnique({ where: { username } });
  }

  if (created?.isActive !== false) sessionData.userId = created?.id || null;
  return created || null;
}

function identitySelect() {
  return {
    id: true,
    username: true,
    passwordHash: true,
    displayName: true,
    email: true,
    recoveryPhone: true,
    identityMigratedAt: true,
    lastPasswordResetAt: true,
    createdAt: true,
    role: true,
    accessScope: true,
    scopeCity: true,
    scopeVacancyId: true,
    canAccessDispatch: true,
    canAccessAttendance: true,
    canAccessStatistics: true,
    canAccessMetaAds: true,
    canAccessCvAnalysis: true,
    isActive: true
  };
}

async function findSessionProfile(prismaClient, sessionData = {}) {
  if (!prismaClient?.appUser || !sessionData?.userRole) return null;
  if (sessionData.userId) {
    return prismaClient.appUser.findUnique({
      where: { id: sessionData.userId },
      select: identitySelect()
    });
  }
  const username = normalizeString(sessionData.username);
  if (!username) return null;
  return prismaClient.appUser.findUnique({
    where: { username },
    select: identitySelect()
  });
}

function syncSessionIdentity(sessionData, profile) {
  if (!sessionData || !profile) return;
  if (profile.id && profile.isActive !== false) sessionData.userId = profile.id;
  sessionData.displayName = normalizeString(profile.displayName);
  sessionData.userEmail = normalizeAppUserEmail(profile.email);
  sessionData.identityMigratedAt = profile.identityMigratedAt
    ? new Date(profile.identityMigratedAt).toISOString()
    : null;
}

function identityPending(sessionData = {}, profile = null) {
  if (!sessionData.userRole || sessionData.userRole === 'dev') return false;
  if (sessionData.devImpersonation) return false;
  if (profile) return !profile.identityMigratedAt;
  return sessionData.userSource === 'env' && sessionData.userRole === 'admin';
}

function dateTimeValue(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

function initialPasswordChangePending(sessionData = {}, profile = null) {
  if (!profile || !sessionData.userRole || sessionData.userRole === 'dev') return false;
  if (sessionData.devImpersonation || sessionData.userSource !== 'db') return false;
  if (profile.role === 'DEV' || !String(profile.username || '').startsWith('user-')) return false;

  const createdAt = dateTimeValue(profile.createdAt);
  const identityMigratedAt = dateTimeValue(profile.identityMigratedAt);
  const lastPasswordResetAt = dateTimeValue(profile.lastPasswordResetAt);
  if (createdAt === null || identityMigratedAt === null || lastPasswordResetAt === null) return false;
  if (createdAt < INITIAL_PASSWORD_POLICY_EFFECTIVE_AT.getTime()) return false;
  return identityMigratedAt === lastPasswordResetAt;
}

function preserveCredentialPresentation(req, res) {
  if (!res || res.__identityCredentialPresentationWrapped) return;
  res.__identityCredentialPresentationWrapped = true;

  if (typeof res.render === 'function') {
    const originalRender = res.render.bind(res);
    res.render = (view, options, callback) => {
      if (typeof options === 'function') return originalRender(view, options);
      const visibleIdentifier = normalizeAppUserEmail(req.identityVisibleCredential);
      const nextOptions = visibleIdentifier && ['login', 'recover'].includes(view)
        ? { ...(options || {}), username: visibleIdentifier }
        : options;
      return originalRender(view, nextOptions, callback);
    };
  }

  if (typeof res.redirect === 'function') {
    const originalRedirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const visibleIdentifier = normalizeAppUserEmail(req.identityVisibleCredential);
      const locationIndex = args.length > 1 ? 1 : 0;
      const location = args[locationIndex];
      if (visibleIdentifier && typeof location === 'string' && location.startsWith('/login?')) {
        const [pathname, query = ''] = location.split('?');
        if (pathname === '/login') {
          const params = new URLSearchParams(query);
          if (params.has('username')) {
            params.set('username', visibleIdentifier);
            args[locationIndex] = `${pathname}?${params.toString()}`;
          }
        }
      }
      return originalRedirect(...args);
    };
  }
}

async function canonicalizeCredentialIdentifier(req, prismaClient) {
  const path = requestPath(req);
  if (req.method !== 'POST' || !['/login', '/recover'].includes(path)) return;
  if (!req.body || typeof req.body.username !== 'string' || !prismaClient?.appUser) return;

  const submitted = normalizeString(req.body.username);
  if (!submitted) return;
  const email = normalizeAppUserEmail(submitted);
  let profile = null;

  if (email) {
    req.identityVisibleCredential = email;
    profile = await prismaClient.appUser.findUnique({
      where: { email },
      select: { username: true, identityMigratedAt: true, role: true }
    });
    if (profile?.username) req.body.username = profile.username;
    return;
  }

  profile = await prismaClient.appUser.findUnique({
    where: { username: submitted },
    select: { username: true, identityMigratedAt: true, role: true }
  });
  if (profile?.identityMigratedAt && profile.role !== 'DEV') {
    req.body.username = MIGRATED_USERNAME_SENTINEL;
  }
}

async function verifyEnvironmentCredential(plain, configured, bcryptModule = bcrypt) {
  if (!plain || !configured) return false;
  if (configured.startsWith('$2b$') || configured.startsWith('$2a$')) {
    return bcryptModule.compare(plain, configured);
  }
  return plain === configured;
}

async function verifyAuthenticatedPassword(sessionData, profile, currentPassword, {
  env,
  bcryptModule
}) {
  if (!currentPassword) return false;
  if (sessionData.userSource === 'env') {
    const configuredPassword = sessionData.userRole === 'admin' ? env.ADMIN_PASS : null;
    return verifyEnvironmentCredential(currentPassword, configuredPassword, bcryptModule);
  }
  if (profile?.passwordHash) return bcryptModule.compare(currentPassword, profile.passwordHash);
  return false;
}

function renderIdentityMigration(res, values = {}) {
  return res.status(values.status || 200).render('identityMigration', {
    error: values.error || null,
    displayName: values.displayName || '',
    email: values.email || '',
    forcePasswordChange: values.forcePasswordChange === true
  });
}

async function migrateAuthenticatedIdentity(req, res, {
  prismaClient,
  bcryptModule,
  env
}) {
  const sessionData = req.session || {};
  if (!sessionData.userRole) return res.redirect('/login');
  if (sessionData.userRole === 'dev') return res.redirect('/admin');

  let profile = await findSessionProfile(prismaClient, sessionData);
  const forcePasswordChange = initialPasswordChangePending(sessionData, profile);

  if (req.method === 'GET') {
    return renderIdentityMigration(res, {
      displayName: profile?.displayName || sessionData.displayName || '',
      email: profile?.email || sessionData.userEmail || '',
      forcePasswordChange
    });
  }

  const submittedDisplayName = normalizeString(req.body?.displayName);
  const submittedEmail = normalizeAppUserEmail(req.body?.email);
  const submittedConfirmEmail = normalizeAppUserEmail(req.body?.confirmEmail);
  const displayName = forcePasswordChange ? normalizeString(profile?.displayName) : submittedDisplayName;
  const email = forcePasswordChange ? normalizeAppUserEmail(profile?.email) : submittedEmail;
  const confirmEmail = forcePasswordChange ? email : submittedConfirmEmail;
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const confirmNewPassword = typeof req.body?.confirmNewPassword === 'string' ? req.body.confirmNewPassword : '';
  const renderError = (status, error) => renderIdentityMigration(res, {
    status,
    error,
    displayName,
    email: email || '',
    forcePasswordChange
  });

  if (!displayName || displayName.length < 3) {
    return renderError(400, 'Ingresa tu nombre completo.');
  }
  if (!email || !confirmEmail || email !== confirmEmail) {
    return renderError(400, 'Ingresa el mismo correo electrónico en ambos campos.');
  }
  if (!currentPassword) {
    return renderError(400, 'Confirma tu contraseña actual para actualizar el acceso.');
  }
  if (forcePasswordChange) {
    if (newPassword.length < INITIAL_PASSWORD_MIN_LENGTH) {
      return renderError(400, `La nueva contraseña debe tener al menos ${INITIAL_PASSWORD_MIN_LENGTH} caracteres.`);
    }
    if (Buffer.byteLength(newPassword, 'utf8') > BCRYPT_SAFE_MAX_BYTES) {
      return renderError(400, 'La nueva contraseña es demasiado larga. Usa máximo 72 bytes.');
    }
    if (newPassword !== confirmNewPassword) {
      return renderError(400, 'La nueva contraseña y su confirmación no coinciden.');
    }
    if (newPassword === currentPassword) {
      return renderError(400, 'La nueva contraseña debe ser diferente de la contraseña inicial.');
    }
  }

  const passwordMatches = await verifyAuthenticatedPassword(sessionData, profile, currentPassword, { env, bcryptModule });
  if (!passwordMatches) {
    return renderError(401, 'La contraseña actual no es correcta.');
  }

  const emailOwner = await prismaClient.appUser.findUnique({
    where: { email },
    select: { id: true }
  });
  if (emailOwner && emailOwner.id !== profile?.id) {
    return renderError(409, 'Ese correo ya está asociado a otro usuario.');
  }

  const migratedAt = new Date();
  if (profile) {
    const data = forcePasswordChange
      ? {
          passwordHash: await bcryptModule.hash(newPassword, 10),
          lastPasswordResetAt: migratedAt
        }
      : {
          displayName,
          email,
          recoveryEmail: email,
          identityMigratedAt: migratedAt,
          ...(sessionData.userSource === 'env'
            ? {
                passwordHash: await bcryptModule.hash(currentPassword, 10),
                lastPasswordResetAt: migratedAt
              }
            : {})
        };
    profile = await prismaClient.appUser.update({
      where: { id: profile.id },
      data,
      select: identitySelect()
    });
  } else if (sessionData.userSource === 'env' && sessionData.userRole === 'admin') {
    const username = normalizeString(sessionData.username);
    if (!username) return renderError(400, 'No fue posible vincular esta sesión a una cuenta.');
    const passwordHash = await bcryptModule.hash(currentPassword, 10);
    try {
      profile = await prismaClient.appUser.create({
        data: {
          ...environmentProfileData(sessionData, passwordHash, {
            displayName,
            email,
            identityMigratedAt: migratedAt
          }),
          lastPasswordResetAt: migratedAt
        },
        select: identitySelect()
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      profile = await prismaClient.appUser.findUnique({
        where: { username },
        select: identitySelect()
      });
      if (!profile) throw error;
      profile = await prismaClient.appUser.update({
        where: { id: profile.id },
        data: {
          displayName,
          email,
          recoveryEmail: email,
          identityMigratedAt: migratedAt,
          passwordHash,
          lastPasswordResetAt: migratedAt
        },
        select: identitySelect()
      });
    }
  }

  if (!profile) return renderError(500, 'No fue posible actualizar tu acceso.');
  syncSessionIdentity(sessionData, profile);
  return res.redirect(303, '/admin');
}

function renderAccountProfile(res, values = {}) {
  return res.status(values.status || 200).render('accountProfile', {
    error: values.error || null,
    success: values.success || null,
    displayName: values.displayName || '',
    email: values.email || '',
    recoveryPhone: values.recoveryPhone || ''
  });
}

async function editAuthenticatedProfile(req, res, {
  prismaClient,
  bcryptModule,
  env,
  profile
}) {
  const sessionData = req.session || {};
  if (!sessionData.userRole) return res.redirect('/login');
  if (sessionData.devImpersonation) return res.status(403).send('No puedes editar el perfil mientras estás en una vista impersonada.');
  if (sessionData.userRole === 'dev' && sessionData.userSource === 'env') {
    return res.status(403).send('El perfil de la cuenta técnica DEV se administra fuera de esta pantalla.');
  }
  if (!profile || profile.isActive === false) {
    return renderAccountProfile(res, {
      status: profile?.isActive === false ? 403 : 404,
      error: 'No fue posible cargar un perfil activo para esta sesión.',
      displayName: sessionData.displayName || '',
      email: sessionData.userEmail || ''
    });
  }
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).send('Método no permitido');
  }

  if (req.method === 'GET') {
    return renderAccountProfile(res, {
      success: normalizeString(req.query?.success),
      displayName: profile.displayName || sessionData.displayName || '',
      email: profile.email || sessionData.userEmail || '',
      recoveryPhone: profile.recoveryPhone || ''
    });
  }

  const displayName = normalizeString(req.body?.displayName);
  const email = normalizeAppUserEmail(req.body?.email);
  const confirmEmail = normalizeAppUserEmail(req.body?.confirmEmail);
  const phone = normalizeProfilePhone(req.body?.recoveryPhone);
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const confirmNewPassword = typeof req.body?.confirmNewPassword === 'string' ? req.body.confirmNewPassword : '';
  const wantsPasswordChange = Boolean(newPassword || confirmNewPassword);
  const renderError = (status, error) => renderAccountProfile(res, {
    status,
    error,
    displayName: displayName || '',
    email: email || '',
    recoveryPhone: phone.displayValue
  });

  if (!displayName || displayName.length < 3 || displayName.length > 120) {
    return renderError(400, 'Ingresa un nombre completo válido.');
  }
  if (!email || !confirmEmail || email !== confirmEmail) {
    return renderError(400, 'Ingresa el mismo correo electrónico en ambos campos.');
  }
  if (!phone.valid) {
    return renderError(400, 'Ingresa un teléfono válido de 7 a 15 dígitos o deja el campo vacío.');
  }
  if (!currentPassword) {
    return renderError(400, 'Confirma tu contraseña actual para guardar los cambios.');
  }
  if (wantsPasswordChange) {
    if (newPassword.length < INITIAL_PASSWORD_MIN_LENGTH) {
      return renderError(400, `La nueva contraseña debe tener al menos ${INITIAL_PASSWORD_MIN_LENGTH} caracteres.`);
    }
    if (Buffer.byteLength(newPassword, 'utf8') > BCRYPT_SAFE_MAX_BYTES) {
      return renderError(400, 'La nueva contraseña es demasiado larga. Usa máximo 72 bytes.');
    }
    if (newPassword !== confirmNewPassword) {
      return renderError(400, 'La nueva contraseña y su confirmación no coinciden.');
    }
    if (newPassword === currentPassword) {
      return renderError(400, 'La nueva contraseña debe ser diferente de la contraseña actual.');
    }
  }

  const passwordMatches = await verifyAuthenticatedPassword(sessionData, profile, currentPassword, { env, bcryptModule });
  if (!passwordMatches) {
    return renderError(401, 'La contraseña actual no es correcta.');
  }

  const emailOwner = await prismaClient.appUser.findUnique({
    where: { email },
    select: { id: true }
  });
  if (emailOwner && emailOwner.id !== profile.id) {
    return renderError(409, 'Ese correo ya está asociado a otro usuario.');
  }

  const data = {
    displayName,
    email,
    recoveryEmail: email,
    recoveryPhone: phone.value
  };
  if (wantsPasswordChange) {
    data.passwordHash = await bcryptModule.hash(newPassword, 10);
    data.lastPasswordResetAt = new Date();
  }

  let updatedProfile;
  try {
    updatedProfile = await prismaClient.appUser.update({
      where: { id: profile.id },
      data,
      select: identitySelect()
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return renderError(409, 'Ese correo ya está asociado a otro usuario.');
    }
    throw error;
  }

  syncSessionIdentity(sessionData, updatedProfile);
  const success = wantsPasswordChange
    ? 'Perfil y contraseña actualizados correctamente.'
    : 'Perfil actualizado correctamente.';
  const params = new URLSearchParams({ success });
  return res.redirect(303, `${PROFILE_PATH}?${params.toString()}`);
}

function sessionSnapshot(sessionData = {}) {
  const keys = [
    'userId', 'userRole', 'username', 'userAccessScope', 'userAccessCity', 'userAccessVacancyId',
    'userSource', 'canAccessDispatch', 'canAccessAttendance', 'canAccessPayroll', 'canAccessTestWorkspace',
    'canAccessStatistics', 'canAccessMetaAds', 'canAccessCvAnalysis', 'displayName', 'userEmail', 'identityMigratedAt'
  ];
  return Object.fromEntries(keys.map((key) => [key, sessionData[key] ?? null]));
}

function applyProfileToSession(sessionData, profile) {
  sessionData.userId = profile.id;
  sessionData.userRole = profile.role === 'DEV' ? 'dev' : 'admin';
  sessionData.username = profile.username;
  sessionData.userAccessScope = profile.accessScope || 'ALL';
  sessionData.userAccessCity = profile.scopeCity || null;
  sessionData.userAccessVacancyId = profile.scopeVacancyId || null;
  sessionData.userSource = 'db';
  sessionData.canAccessDispatch = Boolean(profile.canAccessDispatch || profile.canAccessAttendance);
  sessionData.canAccessAttendance = Boolean(profile.canAccessAttendance);
  sessionData.canAccessPayroll = false;
  sessionData.canAccessTestWorkspace = false;
  sessionData.canAccessMetaAds = Boolean(profile.canAccessMetaAds);
  sessionData.canAccessCvAnalysis = Boolean(profile.canAccessCvAnalysis);
  sessionData.canAccessStatistics = Boolean(profile.canAccessMetaAds || profile.canAccessCvAnalysis);
  syncSessionIdentity(sessionData, profile);
}

async function recordImpersonationAudit(prismaClient, data = {}) {
  if (typeof prismaClient?.devAuditEvent?.create !== 'function') return;
  try {
    await prismaClient.devAuditEvent.create({
      data: {
        entityType: 'APP_USER',
        entityId: data.targetUserId || null,
        entityLabel: null,
        action: data.action,
        actorUserId: data.actorUserId || null,
        actorUsername: data.actorUsername || 'dev',
        actorRole: 'dev',
        actorSource: data.actorSource || 'dashboard',
        method: 'POST',
        path: data.path || null,
        metadata: { targetUserId: data.targetUserId || null }
      }
    });
  } catch (_error) {
    // La auditoría no debe dejar al DEV atrapado en la sesión objetivo.
  }
}

async function startDevImpersonation(req, res, prismaClient, targetUserId) {
  const sessionData = req.session || {};
  if (sessionData.userRole !== 'dev' || sessionData.devImpersonation) {
    return res.status(403).send('Acceso restringido a DEV');
  }

  const target = await prismaClient.appUser.findUnique({
    where: { id: targetUserId },
    select: identitySelect()
  });
  if (!target || target.role !== 'ADMIN' || target.isActive === false) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Usuario no disponible para vista DEV.'));
  }
  if (!target.identityMigratedAt || !target.displayName || !target.email) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Ese usuario debe actualizar primero su nombre y correo.'));
  }

  const origin = sessionSnapshot(sessionData);
  sessionData.devImpersonation = {
    origin,
    targetUserId: target.id
  };
  applyProfileToSession(sessionData, target);
  await recordImpersonationAudit(prismaClient, {
    action: 'USER_IMPERSONATION_STARTED',
    targetUserId: target.id,
    actorUserId: origin.userId,
    actorUsername: origin.username,
    actorSource: origin.userSource,
    path: requestPath(req)
  });
  return res.redirect(303, '/admin');
}

async function stopDevImpersonation(req, res, prismaClient) {
  const sessionData = req.session || {};
  const impersonation = sessionData.devImpersonation;
  if (!impersonation?.origin || impersonation.origin.userRole !== 'dev') {
    return res.status(403).send('No hay una vista DEV activa.');
  }
  const targetUserId = impersonation.targetUserId || sessionData.userId || null;
  const origin = impersonation.origin;
  delete sessionData.devImpersonation;
  for (const [key, value] of Object.entries(origin)) sessionData[key] = value;
  await recordImpersonationAudit(prismaClient, {
    action: 'USER_IMPERSONATION_FINISHED',
    targetUserId,
    actorUserId: origin.userId,
    actorUsername: origin.username,
    actorSource: origin.userSource,
    path: requestPath(req)
  });
  return res.redirect(303, '/admin/users');
}

async function handleIdentitySessionRequest(req, res, {
  prismaClient,
  bcryptModule,
  env
}) {
  preserveCredentialPresentation(req, res);
  await canonicalizeCredentialIdentifier(req, prismaClient);

  const path = requestPath(req);
  const impersonateMatch = req.method === 'POST' ? path.match(IMPERSONATE_PATH) : null;
  if (impersonateMatch) {
    return { handled: true, result: await startDevImpersonation(req, res, prismaClient, impersonateMatch[1]) };
  }
  if (req.method === 'POST' && path === IMPERSONATION_STOP_PATH) {
    return { handled: true, result: await stopDevImpersonation(req, res, prismaClient) };
  }

  if (!req.session?.userRole) {
    if (path === PROFILE_PATH) return { handled: true, result: res.redirect('/login') };
    return { handled: false };
  }
  if (path === PROFILE_PATH && req.session.devImpersonation) {
    return {
      handled: true,
      result: res.status(403).send('No puedes editar el perfil mientras estás en una vista impersonada.')
    };
  }

  const profile = await findSessionProfile(prismaClient, req.session);
  if (profile) syncSessionIdentity(req.session, profile);

  if (path === IDENTITY_PATH) {
    return {
      handled: true,
      result: await migrateAuthenticatedIdentity(req, res, { prismaClient, bcryptModule, env })
    };
  }

  if (path === PROFILE_PATH) {
    if (identityPending(req.session, profile) || initialPasswordChangePending(req.session, profile)) {
      return { handled: true, result: res.redirect(303, IDENTITY_PATH) };
    }
    return {
      handled: true,
      result: await editAuthenticatedProfile(req, res, { prismaClient, bcryptModule, env, profile })
    };
  }

  if ((identityPending(req.session, profile) || initialPasswordChangePending(req.session, profile))
    && (path === '/' || path.startsWith('/admin') || path.startsWith('/operaciones'))) {
    return { handled: true, result: res.redirect(303, IDENTITY_PATH) };
  }

  return { handled: false };
}

export function resolveAdminSessionConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const hasConfiguredSecret = Boolean(env.SESSION_SECRET);

  return {
    isProduction,
    hasConfiguredSecret,
    databaseUrl: env.DATABASE_URL,
    cookieName: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
    secret: env.SESSION_SECRET || ADMIN_SESSION_DEFAULTS.developmentSecret,
    storeOptions: {
      conString: env.DATABASE_URL,
      tableName: ADMIN_SESSION_DEFAULTS.storeTableName,
      createTableIfMissing: true,
      pruneSessionInterval: ADMIN_SESSION_DEFAULTS.pruneSessionIntervalSeconds
    },
    sessionOptions: {
      name: env.SESSION_COOKIE_NAME || ADMIN_SESSION_DEFAULTS.cookieName,
      secret: env.SESSION_SECRET || ADMIN_SESSION_DEFAULTS.developmentSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        path: '/',
        maxAge: ADMIN_SESSION_DEFAULTS.maxAgeMs
      }
    }
  };
}

export function buildAdminSessionCookieClearOptions(config = resolveAdminSessionConfig()) {
  const cookie = config?.sessionOptions?.cookie || {};
  return {
    path: cookie.path || '/',
    httpOnly: cookie.httpOnly !== false,
    sameSite: cookie.sameSite || 'lax',
    secure: Boolean(cookie.secure)
  };
}

export function createAdminLogoutHandler({
  config = resolveAdminSessionConfig(),
  logger = console
} = {}) {
  const cookieName = config.cookieName;
  const cookieOptions = buildAdminSessionCookieClearOptions(config);

  return function destroyAdminSession(req, res) {
    const finishLogout = () => {
      res.set('Cache-Control', 'no-store');
      res.clearCookie(cookieName, cookieOptions);
      return res.redirect(303, '/login');
    };

    if (!req.session || typeof req.session.destroy !== 'function') {
      return finishLogout();
    }

    return req.session.destroy((error) => {
      if (error) logger.error('[LOGOUT_DESTROY_ERROR]', error);
      return finishLogout();
    });
  };
}

export function createAdminSessionMiddleware({
  env = process.env,
  logger = console,
  sessionModule = session,
  connectPgSimpleModule = connectPgSimple,
  prismaClient = defaultPrisma,
  bcryptModule = bcrypt,
  randomBytesFn = randomBytes
} = {}) {
  const config = resolveAdminSessionConfig(env);

  if (!config.hasConfiguredSecret) {
    logger.warn('SESSION_SECRET no esta configurada. Usa un valor robusto en produccion.');
  }

  const PgStore = connectPgSimpleModule(sessionModule);
  const store = new PgStore(config.storeOptions);
  store.on('error', (error) => {
    logger.error('[SESSION_STORE_ERROR]', error);
  });

  const baseMiddleware = sessionModule({
    ...config.sessionOptions,
    store
  });

  const middleware = (req, res, next) => baseMiddleware(req, res, (sessionError) => {
    if (sessionError) return next(sessionError);
    return Promise.resolve()
      .then(() => ensureEnvironmentDispatchProfile(req.session, { prismaClient, bcryptModule, randomBytesFn }))
      .catch((error) => {
        logger.warn('[ENV_DISPATCH_PROFILE_BRIDGE_FAILED]', error);
      })
      .then(() => handleIdentitySessionRequest(req, res, { prismaClient, bcryptModule, env }))
      .then((result) => {
        if (result?.handled) return result.result;
        return next();
      })
      .catch((error) => next(error));
  });

  return { middleware, store, config };
}
