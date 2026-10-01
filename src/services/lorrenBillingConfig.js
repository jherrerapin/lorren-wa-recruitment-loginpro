export const LORREN_BILLING_CONFIG_ENTITY_TYPE = 'LORREN_BILLING_CONFIG';
export const LORREN_BILLING_CONFIG_ENTITY_ID = 'GLOBAL';
export const LORREN_BILLING_CONFIG_ACTION = 'LORREN_BILLING_CONFIG_UPDATED';

const MAX_MODULES = 24;
const MAX_RECIPIENTS = 24;

function text(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function normalizeLorrenPhone(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (/^57[3]\d{9}$/.test(digits)) return digits;
  if (/^3\d{9}$/.test(digits)) return `57${digits}`;
  return null;
}

function moneyValue(value) {
  const normalized = String(value ?? '').replace(/[^0-9]/g, '');
  const amount = Number(normalized || 0);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeModules(input = {}) {
  const names = asArray(input.moduleName);
  const values = asArray(input.moduleValue);
  const actives = new Set(asArray(input.moduleActive).map(String));
  const rows = [];
  for (let index = 0; index < Math.min(MAX_MODULES, Math.max(names.length, values.length)); index += 1) {
    const name = text(names[index], 160);
    const value = moneyValue(values[index]);
    if (!name || value === null) continue;
    rows.push({ id: `fixed-${index + 1}`, name, value, active: actives.has(String(index)), source: 'FIXED' });
  }
  return rows;
}

function normalizeRecipients(input = {}) {
  const names = asArray(input.recipientName);
  const phones = asArray(input.recipientPhone);
  const rows = [];
  for (let index = 0; index < Math.min(MAX_RECIPIENTS, Math.max(names.length, phones.length)); index += 1) {
    const name = text(names[index], 160);
    const phone = normalizeLorrenPhone(phones[index]);
    if (!name && !phone) continue;
    if (!name || !phone) throw new Error('lorren_billing_recipient_invalid');
    rows.push({ id: `recipient-${index + 1}`, name, phone, active: true });
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.phone)) return false;
    seen.add(row.phone);
    return true;
  });
}

export function normalizeLorrenBillingConfigInput(input = {}) {
  const supervisorName = text(input.supervisorName, 160);
  const supervisorPhone = normalizeLorrenPhone(input.supervisorPhone);
  const devAlertPhone = normalizeLorrenPhone(input.devAlertPhone);
  if ((supervisorName && !supervisorPhone) || (!supervisorName && supervisorPhone)) throw new Error('lorren_billing_supervisor_invalid');
  return {
    enabled: input.enabled === true || input.enabled === 'true' || input.enabled === 'on',
    modules: normalizeModules(input), recipients: normalizeRecipients(input),
    supervisor: supervisorName && supervisorPhone ? { name: supervisorName, phone: supervisorPhone } : null,
    devAlertPhone: devAlertPhone || null, accountHeading: text(input.accountHeading, 160) || null,
    updatedAt: new Date().toISOString()
  };
}

function configFromEvent(event) {
  const source = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata : {};
  return {
    enabled: source.enabled === true,
    modules: Array.isArray(source.modules) ? source.modules : [], recipients: Array.isArray(source.recipients) ? source.recipients : [],
    supervisor: source.supervisor && typeof source.supervisor === 'object' ? source.supervisor : null,
    devAlertPhone: normalizeLorrenPhone(source.devAlertPhone) || null, accountHeading: text(source.accountHeading, 160),
    configured: Boolean(event), configuredAt: event?.createdAt || null
  };
}

export async function loadLorrenBillingConfig(prisma) {
  if (!prisma?.devAuditEvent?.findFirst) throw new Error('lorren_billing_config_prisma_contract_invalid');
  const event = await prisma.devAuditEvent.findFirst({
    where: { entityType: LORREN_BILLING_CONFIG_ENTITY_TYPE, entityId: LORREN_BILLING_CONFIG_ENTITY_ID, action: LORREN_BILLING_CONFIG_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  return configFromEvent(event);
}

export async function saveLorrenBillingConfig(prisma, input = {}) {
  if (!prisma?.devAuditEvent?.create || !prisma?.devAuditEvent?.findFirst) throw new Error('lorren_billing_config_prisma_contract_invalid');
  const config = normalizeLorrenBillingConfigInput(input);
  const previous = await loadLorrenBillingConfig(prisma);
  const event = await prisma.devAuditEvent.create({ data: {
    entityType: LORREN_BILLING_CONFIG_ENTITY_TYPE, entityId: LORREN_BILLING_CONFIG_ENTITY_ID,
    entityLabel: 'Configuración de facturación Lórren', action: LORREN_BILLING_CONFIG_ACTION,
    actorUsername: text(input.actorUsername, 160), actorRole: text(input.actorRole, 80), actorSource: 'lorren-billing-admin',
    ipAddress: text(input.ipAddress, 120), userAgent: text(input.userAgent, 500),
    fromValue: previous.configured ? previous : undefined, toValue: config, metadata: config
  } });
  return { ...configFromEvent(event), changed: true };
}

export function lorrenBillingReadiness(config = {}, channel = {}) {
  const missing = [];
  if (!config.enabled) missing.push('billing_disabled');
  if (!config.supervisor?.phone) missing.push('supervisor_missing');
  if (!config.recipients?.length) missing.push('recipients_missing');
  if (!channel.accessToken) missing.push('access_token_missing');
  if (!channel.phoneNumberId) missing.push('phone_number_id_missing');
  if (!channel.verifyToken) missing.push('verify_token_missing');
  if (!channel.appSecret) missing.push('app_secret_missing');
  if (!channel.approvalTemplateName) missing.push('approval_template_missing');
  if (!channel.accountTemplateName) missing.push('account_template_missing');
  return { ready: missing.length === 0, missing };
}
