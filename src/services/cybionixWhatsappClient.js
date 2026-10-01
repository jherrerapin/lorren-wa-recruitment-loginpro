import axios from 'axios';
import { normalizeCybionixPhone } from './cybionixBillingConfig.js';

export function getCybionixWhatsappConfig(env = process.env) {
  return {
    graphVersion: String(env.CYBIONIX_WHATSAPP_GRAPH_VERSION || 'v23.0').trim(),
    accessToken: String(env.CYBIONIX_WHATSAPP_ACCESS_TOKEN || '').trim() || null,
    phoneNumberId: String(env.CYBIONIX_WHATSAPP_PHONE_NUMBER_ID || '').trim() || null,
    verifyToken: String(env.CYBIONIX_WHATSAPP_VERIFY_TOKEN || '').trim() || null,
    approvalTemplateName: String(env.CYBIONIX_WHATSAPP_APPROVAL_TEMPLATE_NAME || '').trim() || null,
    accountTemplateName: String(env.CYBIONIX_WHATSAPP_ACCOUNT_TEMPLATE_NAME || '').trim() || null,
    alertTemplateName: String(env.CYBIONIX_WHATSAPP_ALERT_TEMPLATE_NAME || '').trim() || null,
    templateLanguage: String(env.CYBIONIX_WHATSAPP_TEMPLATE_LANGUAGE || 'es_CO').trim(),
    timeoutMs: Math.max(5000, Number(env.CYBIONIX_WHATSAPP_TIMEOUT_MS) || 20000)
  };
}

function requireSendConfig(env = process.env) {
  const config = getCybionixWhatsappConfig(env);
  if (!config.accessToken || !config.phoneNumberId) throw new Error('cybionix_whatsapp_not_configured');
  return config;
}

function messagesUrl(config) {
  return `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
}

function mediaUrl(config) {
  return `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/media`;
}

async function postMessage(config, payload, axiosClient = axios) {
  const response = await axiosClient.post(messagesUrl(config), payload, {
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    timeout: config.timeoutMs
  });
  const id = String(response?.data?.messages?.[0]?.id || '').trim();
  if (!id) throw new Error('cybionix_whatsapp_provider_message_missing');
  return id;
}

async function uploadPdf(config, buffer, filename, axiosClient = axios) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('cybionix_whatsapp_media_invalid');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const response = await axiosClient.post(mediaUrl(config), form, {
    headers: { Authorization: `Bearer ${config.accessToken}` }, timeout: config.timeoutMs
  });
  const id = String(response?.data?.id || '').trim();
  if (!id) throw new Error('cybionix_whatsapp_media_upload_failed');
  return id;
}

function templatePayload(phone, name, language, components) {
  const to = normalizeCybionixPhone(phone);
  if (!to) throw new Error('cybionix_whatsapp_phone_invalid');
  if (!name) throw new Error('cybionix_whatsapp_template_missing');
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name, language: { code: language }, components } };
}

export async function sendCybionixAttendanceApproval({ phone, supervisorName, invoice, pdfBuffer, axiosClient = axios, env = process.env } = {}) {
  const config = requireSendConfig(env);
  if (!config.approvalTemplateName) throw new Error('cybionix_whatsapp_approval_template_missing');
  const filename = `${invoice.invoiceNumber}.pdf`;
  const mediaId = await uploadPdf(config, pdfBuffer, filename, axiosClient);
  return postMessage(config, templatePayload(phone, config.approvalTemplateName, config.templateLanguage, [
    { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
    { type: 'body', parameters: [
      { type: 'text', text: String(supervisorName || 'Supervisor').slice(0, 200) },
      { type: 'text', text: String(invoice.invoiceNumber || '').slice(0, 80) },
      { type: 'text', text: String(invoice.count || 0) },
      { type: 'text', text: new Intl.NumberFormat('es-CO').format(Number(invoice.total || 0)) }
    ] },
    { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `cybionix_billing:approve:${invoice.invoiceNumber}` }] },
    { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `cybionix_billing:reject:${invoice.invoiceNumber}` }] }
  ]), axiosClient);
}

export async function sendCybionixAccountCharge({ phone, recipientName, account, pdfBuffer, axiosClient = axios, env = process.env } = {}) {
  const config = requireSendConfig(env);
  if (!config.accountTemplateName) throw new Error('cybionix_whatsapp_account_template_missing');
  const filename = `${account.accountNumber}.pdf`;
  const mediaId = await uploadPdf(config, pdfBuffer, filename, axiosClient);
  return postMessage(config, templatePayload(phone, config.accountTemplateName, config.templateLanguage, [
    { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] },
    { type: 'body', parameters: [
      { type: 'text', text: String(recipientName || 'Destinatario').slice(0, 200) },
      { type: 'text', text: String(account.accountNumber || '').slice(0, 80) },
      { type: 'text', text: new Intl.NumberFormat('es-CO').format(Number(account.total || 0)) }
    ] }
  ]), axiosClient);
}

export async function sendCybionixDevAlert({ phone, invoiceNumber, reason, axiosClient = axios, env = process.env } = {}) {
  const config = requireSendConfig(env);
  if (!config.alertTemplateName) return { skipped: true, reason: 'alert_template_missing' };
  const providerMessageId = await postMessage(config, templatePayload(phone, config.alertTemplateName, config.templateLanguage, [
    { type: 'body', parameters: [
      { type: 'text', text: String(invoiceNumber || '').slice(0, 80) },
      { type: 'text', text: String(reason || 'No aprobada por el supervisor').slice(0, 300) }
    ] }
  ]), axiosClient);
  return { skipped: false, providerMessageId };
}

export function cybionixWebhookVerification(req, res) {
  const config = getCybionixWhatsappConfig();
  if (req.query['hub.mode'] === 'subscribe' && config.verifyToken && req.query['hub.verify_token'] === config.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
}
