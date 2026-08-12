import axios from 'axios';
import { dispatchServiceDateKey } from './dispatchDate.js';
import {
  buildDispatchWhatsappError,
  ensureDispatchWhatsappConfigured,
  normalizeDispatchWhatsappPhone,
  setDispatchWhatsappRuntimeState
} from './dispatchWhatsappCloudConfig.js';

function hourLabel(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '').trim();
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function formatServiceDate(value) {
  const key = dispatchServiceDateKey(value);
  if (!key) return '';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function parameterText(value, fallback = 'Por confirmar') {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, 1024);
}

function assignmentTemplateValues(assignment) {
  const request = assignment.serviceRequest || {};
  return [
    parameterText(assignment.worker?.fullName, 'Auxiliar'),
    parameterText(formatServiceDate(request.serviceDate)),
    parameterText(request.operationPointName || request.serviceName || 'Operación LoginPro'),
    parameterText(request.address || request.operationPoint?.address),
    parameterText(hourLabel(request.startTime))
  ];
}

export function buildDispatchAssignmentMessageBody(assignment) {
  const [name, date, operation, address, startTime] = assignmentTemplateValues(assignment);
  return `Hola *${name}*,\n\nMañana: *${date}*\nLlegar a: *${operation}  - ${address}*\nHora : *${startTime} por favor.*\n\n\n*Confirmado?*`;
}

export function buildDispatchAssignmentInteractivePayload({ assignment, phone }) {
  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);
  if (!normalizedPhone) throw buildDispatchWhatsappError('Debes indicar un número válido para enviar WhatsApp.', 400, 'dispatch_whatsapp_phone_invalid');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: buildDispatchAssignmentMessageBody(assignment) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `dispatch_confirm:${assignment.id}`, title: 'CONFIRMADO' } },
          { type: 'reply', reply: { id: `dispatch_novelty:${assignment.id}`, title: 'REPORTAR NOVEDAD' } }
        ]
      }
    }
  };
}

export function buildDispatchAssignmentTemplatePayload({ config, assignment, phone }) {
  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);
  if (!normalizedPhone) throw buildDispatchWhatsappError('Debes indicar un número válido para enviar WhatsApp.', 400, 'dispatch_whatsapp_phone_invalid');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedPhone,
    type: 'template',
    template: {
      name: config.assignmentTemplateName,
      language: { code: config.templateLanguage },
      components: [
        { type: 'body', parameters: assignmentTemplateValues(assignment).map((text) => ({ type: 'text', text })) },
        {
          type: 'button', sub_type: 'quick_reply', index: '0',
          parameters: [{ type: 'payload', payload: `dispatch_confirm:${assignment.id}` }]
        },
        {
          type: 'button', sub_type: 'quick_reply', index: '1',
          parameters: [{ type: 'payload', payload: `dispatch_novelty:${assignment.id}` }]
        }
      ]
    }
  };
}

export function buildDispatchProgrammingTemplatePayload({ config, phone, mediaId, filename, templateValues = {} }) {
  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);
  if (!normalizedPhone) throw buildDispatchWhatsappError('Debes indicar un número válido para enviar WhatsApp.', 400, 'dispatch_whatsapp_phone_invalid');
  if (!mediaId) throw buildDispatchWhatsappError('Meta no devolvió un identificador del documento.', 502, 'dispatch_whatsapp_media_id_missing');
  const values = [
    parameterText(templateValues.selectedDate),
    parameterText(templateValues.scopeLabel),
    parameterText(templateValues.requestsIncluded, '0'),
    parameterText(templateValues.completionLabel),
    parameterText(templateValues.workersLabel),
    parameterText(templateValues.managedBy, 'LoginPro Operaciones')
  ];
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedPhone,
    type: 'template',
    template: {
      name: config.programmingTemplateName,
      language: { code: config.templateLanguage },
      components: [
        {
          type: 'header',
          parameters: [{ type: 'document', document: { id: mediaId, filename: parameterText(filename, 'programacion.pdf') } }]
        },
        { type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }
      ]
    }
  };
}

function messagesUrl(config) {
  return `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
}

function mediaUrl(config) {
  return `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/media`;
}

export function dispatchWhatsappProviderErrorMessage(error) {
  const metaError = error?.response?.data?.error;
  const code = metaError?.code ? ` código ${metaError.code}` : '';
  const subcode = metaError?.error_subcode ? `/${metaError.error_subcode}` : '';
  const message = String(metaError?.message || error?.message || 'Error desconocido de Meta').slice(0, 220);
  return `Meta rechazó la operación${code}${subcode}: ${message}`;
}

async function postGraph(config, payload, axiosClient = axios) {
  return axiosClient.post(messagesUrl(config), payload, {
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    timeout: config.timeoutMs
  });
}

function providerMessageIdFromResponse(response) {
  return String(response?.data?.messages?.[0]?.id || '').trim() || null;
}

export async function sendCloudAssignmentTemplate({ scope = 'operational', assignment, phone, axiosClient = axios }) {
  const config = ensureDispatchWhatsappConfigured(scope, { assignmentTemplate: true });
  const response = await postGraph(config, buildDispatchAssignmentTemplatePayload({ config, assignment, phone }), axiosClient);
  const providerMessageId = providerMessageIdFromResponse(response);
  if (!providerMessageId) {
    throw buildDispatchWhatsappError('Meta aceptó la solicitud sin devolver un identificador de mensaje.', 502, 'dispatch_whatsapp_provider_message_missing');
  }
  return { config, providerMessageId };
}

export async function sendCloudAssignmentInteractive({ scope = 'operational', assignment, phone, axiosClient = axios }) {
  const config = ensureDispatchWhatsappConfigured(scope);
  const response = await postGraph(config, buildDispatchAssignmentInteractivePayload({ assignment, phone }), axiosClient);
  const providerMessageId = providerMessageIdFromResponse(response);
  if (!providerMessageId) {
    throw buildDispatchWhatsappError('Meta aceptó la solicitud sin devolver un identificador de mensaje.', 502, 'dispatch_whatsapp_provider_message_missing');
  }
  return { config, providerMessageId };
}

export async function sendDispatchWhatsappTextMessage({ scope = 'operational', phone, text, axiosClient = axios }) {
  const config = ensureDispatchWhatsappConfigured(scope);
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: normalizeDispatchWhatsappPhone(phone), type: 'text', text: { body: String(text || '').trim() }
  };
  const response = await postGraph(config, payload, axiosClient);
  return providerMessageIdFromResponse(response);
}

async function uploadMedia(config, { buffer, filename, mimeType }, axiosClient = axios) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw buildDispatchWhatsappError('El archivo de WhatsApp está vacío o no es válido.', 400, 'dispatch_whatsapp_media_invalid');
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType || 'application/octet-stream');
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'archivo');
  const response = await axiosClient.post(mediaUrl(config), form, {
    headers: { Authorization: `Bearer ${config.accessToken}` }, timeout: config.timeoutMs
  });
  const id = response?.data?.id;
  if (!id) throw buildDispatchWhatsappError('Meta no devolvió el identificador del archivo cargado.', 502, 'dispatch_whatsapp_media_upload_invalid');
  return id;
}

export async function sendDispatchWhatsappMediaMessage({
  phone, buffer, filename, mimeType = 'application/pdf', templateValues = {}, scope = 'operational', axiosClient = axios
} = {}) {
  const config = ensureDispatchWhatsappConfigured(scope, { programming: true });
  try {
    const mediaId = await uploadMedia(config, { buffer, filename, mimeType }, axiosClient);
    const payload = buildDispatchProgrammingTemplatePayload({ config, phone, mediaId, filename, templateValues });
    const response = await postGraph(config, payload, axiosClient);
    const providerMessageId = providerMessageIdFromResponse(response);
    if (!providerMessageId) {
      throw buildDispatchWhatsappError('Meta no devolvió el identificador del mensaje de programación.', 502, 'dispatch_whatsapp_provider_message_missing');
    }
    const now = new Date().toISOString();
    setDispatchWhatsappRuntimeState(scope, { lastOutboundAt: now, lastError: null, lastProviderStatus: 'SENT', lastProviderStatusAt: now });
    return {
      phone: normalizeDispatchWhatsappPhone(phone), providerMessageId,
      templateName: config.programmingTemplateName, provider: 'META_CLOUD_API'
    };
  } catch (error) {
    const message = error?.code?.startsWith?.('dispatch_') ? error.message : dispatchWhatsappProviderErrorMessage(error);
    setDispatchWhatsappRuntimeState(scope, { lastError: message });
    if (error?.statusCode) throw error;
    throw buildDispatchWhatsappError(message, 502, 'dispatch_whatsapp_provider_error');
  }
}
