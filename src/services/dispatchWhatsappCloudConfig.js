const DEFAULT_GRAPH_VERSION = 'v23.0';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DUPLICATE_WINDOW_MS = 120000;

export const ACTIVE_LINK_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'];
export const INBOUND_LINK_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'DELIVERY_UNKNOWN'];
export const TERMINAL_LINK_STATUSES = new Set(['CONFIRMED', 'DECLINED', 'EXPIRED', 'FAILED']);
export const DELIVERY_RANK = new Map([
  ['PENDING', 0],
  ['SENT', 1],
  ['DELIVERED', 2],
  ['READ', 3]
]);
export const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';

export const SCOPE_DEFINITIONS = Object.freeze({
  operational: Object.freeze({
    envPrefix: 'DISPATCH_META',
    runtimeScope: 'operational',
    pendingAssignmentStatuses: ['ASSIGNED', 'CONFIRMATION_PENDING'],
    confirmedAssignmentStatus: 'CONFIRMED',
    declinedAssignmentStatus: 'NO_CONFIRMO',
    requestSource: null,
    requireProgrammingTemplate: true
  }),
  'dev-test': Object.freeze({
    envPrefix: 'DISPATCH_TEST_META',
    runtimeScope: 'dev-test',
    pendingAssignmentStatuses: ['DEV_TEST_ASSIGNED'],
    confirmedAssignmentStatus: 'DEV_TEST_CONFIRMED',
    declinedAssignmentStatus: 'DEV_TEST_NO_CONFIRMO',
    requestSource: 'DEV_TEST',
    requireProgrammingTemplate: false
  })
});

const runtimeState = new Map(Object.keys(SCOPE_DEFINITIONS).map((scope) => [scope, {
  lastOutboundAt: null,
  lastInboundAt: null,
  lastProviderStatusAt: null,
  lastProviderStatus: null,
  lastError: null
}]));

export function buildDispatchWhatsappError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function dispatchWhatsappScopeDefinition(scope = 'operational') {
  const definition = SCOPE_DEFINITIONS[scope];
  if (!definition) {
    throw buildDispatchWhatsappError('Scope de WhatsApp de despacho no soportado.', 500, 'dispatch_whatsapp_scope_invalid');
  }
  return definition;
}

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function envName(prefix, suffix) {
  return `${prefix}_${suffix}`;
}

function normalizeGraphVersion(value) {
  const version = String(value || '').trim();
  return /^v\d+\.\d+$/.test(version) ? version : '';
}

function positiveNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

export function getDispatchWhatsappCloudConfig(scope = 'operational') {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const prefix = definition.envPrefix;
  const graphVersion = normalizeGraphVersion(
    envValue(envName(prefix, 'GRAPH_VERSION'))
      || (scope === 'dev-test' ? '' : envValue('DISPATCH_META_GRAPH_VERSION'))
      || DEFAULT_GRAPH_VERSION
  );
  const config = {
    scope,
    runtimeScope: definition.runtimeScope,
    graphVersion,
    accessToken: envValue(envName(prefix, 'ACCESS_TOKEN')),
    phoneNumberId: envValue(envName(prefix, 'PHONE_NUMBER_ID')),
    verifyToken: envValue(envName(prefix, 'VERIFY_TOKEN')),
    appSecret: envValue(envName(prefix, 'APP_SECRET')),
    assignmentTemplateName: envValue(envName(prefix, 'ASSIGNMENT_TEMPLATE_NAME')),
    programmingTemplateName: envValue(envName(prefix, 'PROGRAMMING_TEMPLATE_NAME')),
    templateLanguage: envValue(envName(prefix, 'TEMPLATE_LANGUAGE')),
    timeoutMs: positiveNumber(envValue(envName(prefix, 'TIMEOUT_MS')), DEFAULT_TIMEOUT_MS, 1000),
    duplicateSendWindowMs: positiveNumber(envValue(envName(prefix, 'DUPLICATE_SEND_WINDOW_MS')), DEFAULT_DUPLICATE_WINDOW_MS, 0),
    webhookPath: '/webhook/dispatch'
  };

  const missing = [];
  if (!config.graphVersion) missing.push(envName(prefix, 'GRAPH_VERSION'));
  if (!config.accessToken) missing.push(envName(prefix, 'ACCESS_TOKEN'));
  if (!config.phoneNumberId) missing.push(envName(prefix, 'PHONE_NUMBER_ID'));
  if (!config.verifyToken) missing.push(envName(prefix, 'VERIFY_TOKEN'));
  if (!config.appSecret) missing.push(envName(prefix, 'APP_SECRET'));

  return { ...config, missing, configured: missing.length === 0 };
}

export function ensureDispatchWhatsappConfigured(scope = 'operational', { programming = false, assignmentTemplate = false } = {}) {
  const config = getDispatchWhatsappCloudConfig(scope);
  const definition = dispatchWhatsappScopeDefinition(scope);
  const required = [
    ['GRAPH_VERSION', config.graphVersion],
    ['ACCESS_TOKEN', config.accessToken],
    ['PHONE_NUMBER_ID', config.phoneNumberId],
    ['VERIFY_TOKEN', config.verifyToken],
    ['APP_SECRET', config.appSecret]
  ];
  if (assignmentTemplate) required.push(['ASSIGNMENT_TEMPLATE_NAME', config.assignmentTemplateName]);
  if (programming) required.push(['PROGRAMMING_TEMPLATE_NAME', config.programmingTemplateName]);
  if (assignmentTemplate || programming) required.push(['TEMPLATE_LANGUAGE', config.templateLanguage]);
  const missing = required.filter(([, value]) => !value).map(([suffix]) => envName(definition.envPrefix, suffix));
  if (missing.length) {
    throw buildDispatchWhatsappError(
      `WhatsApp oficial de despacho no está configurado. Faltan: ${missing.join(', ')}.`,
      503,
      'dispatch_whatsapp_not_configured'
    );
  }
  return config;
}

export function normalizeDispatchWhatsappPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

function maskedIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return `***${text.slice(-4)}`;
}

export function setDispatchWhatsappRuntimeState(scope, patch = {}) {
  const current = runtimeState.get(scope) || {};
  runtimeState.set(scope, { ...current, ...patch });
}

export function getDispatchWhatsappStatus(scope = 'operational') {
  const config = getDispatchWhatsappCloudConfig(scope);
  const state = runtimeState.get(scope) || {};
  return {
    provider: 'META_CLOUD_API',
    runtimeScope: config.runtimeScope,
    ready: config.configured,
    configured: config.configured,
    missingConfiguration: config.missing,
    graphVersion: config.graphVersion || null,
    phoneNumberIdMasked: maskedIdentifier(config.phoneNumberId),
    assignmentTemplateName: config.assignmentTemplateName || null,
    programmingTemplateName: config.programmingTemplateName || null,
    templateLanguage: config.templateLanguage || null,
    webhookPath: config.webhookPath,
    lastOutboundAt: state.lastOutboundAt || null,
    lastInboundAt: state.lastInboundAt || null,
    lastProviderStatusAt: state.lastProviderStatusAt || null,
    lastProviderStatus: state.lastProviderStatus || null,
    lastError: state.lastError || null
  };
}

export async function getDispatchWhatsappStatusView(options = {}) {
  return getDispatchWhatsappStatus(options.scope || 'operational');
}

export function resolveDispatchWhatsappScopeByPhoneNumberId(phoneNumberId) {
  const value = String(phoneNumberId || '').trim();
  if (!value) return null;
  for (const scope of Object.keys(SCOPE_DEFINITIONS)) {
    if (getDispatchWhatsappCloudConfig(scope).phoneNumberId === value) return scope;
  }
  return null;
}

export function dispatchWhatsappVerifyTokens() {
  return Object.keys(SCOPE_DEFINITIONS)
    .map((scope) => getDispatchWhatsappCloudConfig(scope).verifyToken)
    .filter(Boolean);
}

export function dispatchWhatsappAppSecret(scope = 'operational') {
  return getDispatchWhatsappCloudConfig(scope).appSecret;
}
