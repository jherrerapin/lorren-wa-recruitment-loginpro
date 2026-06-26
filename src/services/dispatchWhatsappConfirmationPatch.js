import express from 'express';
import { prisma } from '../lib/prisma.js';

const BASE_PATH = '/admin/operaciones/asignaciones';
const MARKER = 'data-dispatch-whatsapp-confirmation-patch="true"';
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';
const processedInboundIds = new Set();

const ASSIGNMENT_MESSAGE_TEMPLATE = [
  'Hola *{{nombre}}*,',
  '',
  'Mañana: *{{fecha}}*',
  'Llegar a: *{{operacion}}  - {{direccion}}*',
  'Hora : *{{horaInicio}} por favor.*',
  '',
  '',
  '*Confirmado?*'
].join('\n');

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  if (digits.startsWith('57')) return digits;
  return digits;
}

function normalizeConfirmationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isConfirmedText(value) {
  return normalizeConfirmationText(value) === 'confirmado';
}

function messageId(message = {}) {
  return message?.id?._serialized || message?.id?.id || message?._data?.id?._serialized || '';
}

function alreadyProcessed(message = {}) {
  const id = messageId(message);
  if (!id) return false;
  if (processedInboundIds.has(id)) return true;
  processedInboundIds.add(id);
  if (processedInboundIds.size > 500) processedInboundIds.delete(processedInboundIds.values().next().value);
  return false;
}

function messageText(message = {}) {
  return message.body || message?._data?.body || message.caption || '';
}

function messageSender(message = {}) {
  return String(message.from || message.author || message?._data?.from || message?._data?.author || '');
}

async function recalculateServiceRequestStatus(serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true }
  });
  if (!serviceRequest) return;

  const [activeCount, confirmedCount] = await Promise.all([
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);

  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';

  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}

async function findLatestPendingAssignmentByPhone(phone) {
  const lastTen = phone.slice(-10);
  if (!lastTen) return null;
  const candidates = await prisma.dispatchAssignment.findMany({
    where: {
      status: { in: PENDING_ASSIGNMENT_STATUSES },
      worker: { phone: { contains: lastTen } }
    },
    include: { worker: true },
    orderBy: { updatedAt: 'desc' },
    take: 20
  });
  return candidates.find((assignment) => normalizePhone(assignment.worker?.phone) === phone) || null;
}

async function processInboundConfirmation(client, message, eventName) {
  if (!message || message.fromMe) return false;
  if (alreadyProcessed(message)) return false;
  if (!isConfirmedText(messageText(message))) return false;

  const sender = messageSender(message);
  if (!sender || !sender.endsWith('@c.us')) return false;

  const phone = normalizePhone(sender.split('@')[0]);
  if (!phone) return false;

  // Pequeña espera para no duplicar respuesta si el servicio principal ya alcanzó a confirmar.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const assignment = await findLatestPendingAssignmentByPhone(phone);
  if (!assignment) {
    console.warn(`[dispatch-wa-fallback] Recibí confirmado, pero no encontré asignación pendiente. event=${eventName} phone=${phone}`);
    return false;
  }

  await prisma.dispatchAssignment.update({
    where: { id: assignment.id },
    data: { status: CONFIRMED_ASSIGNMENT_STATUS }
  });
  await recalculateServiceRequestStatus(assignment.serviceRequestId);
  await client.sendMessage(sender, AUTOMATIC_CONFIRMATION_REPLY);
  console.log(`[dispatch-wa-fallback] Confirmación automática aplicada. event=${eventName} assignment=${assignment.id} phone=${phone}`);
  return true;
}

function installBackendFallback() {
  import('whatsapp-web.js')
    .then((module) => {
      const whatsappWeb = module.default || module;
      const Client = whatsappWeb.Client;
      if (!Client || Client.prototype.__dispatchConfirmationFallbackInstalled) return;
      const originalEmit = Client.prototype.emit;
      Client.prototype.emit = function patchedEmit(eventName, ...args) {
        const result = originalEmit.call(this, eventName, ...args);
        if (eventName === 'message' || eventName === 'message_create') {
          processInboundConfirmation(this, args[0], eventName).catch((error) => {
            console.error('[dispatch-wa-fallback] Error procesando confirmado entrante.', error);
          });
        }
        return result;
      };
      Client.prototype.__dispatchConfirmationFallbackInstalled = true;
      console.log('[dispatch-wa-fallback] Fallback de confirmación automática instalado.');
    })
    .catch((error) => {
      console.warn('[dispatch-wa-fallback] No fue posible instalar fallback de confirmación automática.', error);
    });
}

function script() {
  return `<script ${MARKER}>
(function(){
  var ASSIGNMENT_MESSAGE_TEMPLATE = ${JSON.stringify(ASSIGNMENT_MESSAGE_TEMPLATE)};

  function setTemplate(){
    var globalTemplate = document.getElementById('globalTemplate');
    if (globalTemplate && globalTemplate.value !== ASSIGNMENT_MESSAGE_TEMPLATE) {
      globalTemplate.value = ASSIGNMENT_MESSAGE_TEMPLATE;
      globalTemplate.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelectorAll('.assigned-card .assignment-message').forEach(function(textarea){
      if (!textarea.value || /Por favor confirma recibido/i.test(textarea.value) || /te confirmamos asignaci[oó]n/i.test(textarea.value)) {
        textarea.value = ASSIGNMENT_MESSAGE_TEMPLATE;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  function selectedServiceRequestId(){
    var input = document.querySelector('input[name="serviceRequestId"]');
    if (input && input.value) return input.value;
    return new URLSearchParams(window.location.search).get('serviceRequestId') || '';
  }

  function contextFromButton(button){
    var card = button && button.closest ? button.closest('.assigned-card') : null;
    if (!card) return null;
    return {
      assignmentId: card.dataset.assignmentId || '',
      serviceRequestId: selectedServiceRequestId(),
      workerId: card.dataset.workerId || '',
      recipientName: card.dataset.workerName || '',
      messageType: 'ASSIGNMENT_CONFIRMATION'
    };
  }

  document.addEventListener('click', function(event){
    var button = event.target && event.target.closest ? event.target.closest('.assigned-card .dispatch-wa-button, .assigned-card .whatsapp-link, .assigned-card .icon-whatsapp') : null;
    if (!button) return;
    window.__dispatchLastAssignmentWhatsappContext = contextFromButton(button);
  }, true);

  if (!window.__dispatchWhatsappFetchPatched) {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function(input, init){
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/admin/operaciones/whatsapp/enviar') >= 0 && init && typeof init.body === 'string') {
          var payload = JSON.parse(init.body);
          if (payload && payload.phone && payload.message && !payload.context) {
            var ctx = window.__dispatchLastAssignmentWhatsappContext || null;
            if (ctx && ctx.assignmentId) {
              payload.context = ctx;
              init = Object.assign({}, init, { body: JSON.stringify(payload) });
            }
          }
        }
      } catch (_error) {}
      return originalFetch(input, init);
    };
    window.__dispatchWhatsappFetchPatched = true;
  }

  setTemplate();
  new MutationObserver(setTemplate).observe(document.body, { childList: true, subtree: true });
})();
</script>`;
}

function installPatch() {
  if (express.response.__dispatchWhatsappConfirmationPatchInstalled) return;
  const originalSend = express.response.send;
  express.response.send = function patchedSend(body) {
    let output = body;
    if (typeof output === 'string' && this.req?.method === 'GET' && requestPath(this.req) === BASE_PATH && output.includes('</body>') && !output.includes(MARKER)) {
      output = output.replace('</body>', `${script()}\n</body>`);
    }
    return originalSend.call(this, output);
  };
  express.response.__dispatchWhatsappConfirmationPatchInstalled = true;
}

installBackendFallback();
installPatch();
