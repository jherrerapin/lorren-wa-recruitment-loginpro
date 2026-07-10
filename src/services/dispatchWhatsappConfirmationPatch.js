import express from 'express';

const ASSIGNMENTS_PATH = '/admin/operaciones/asignaciones';
const WHATSAPP_STATUS_PATH = '/admin/operaciones/whatsapp';
const MARKER = 'data-dispatch-whatsapp-confirmation-patch="true"';
const STATUS_MARKER = 'data-dispatch-whatsapp-status-start-patch="true"';
const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';

const ASSIGNMENT_MESSAGE_TEMPLATE = [
  'Hola *{{nombre}}*.',
  '',
  'Te confirmamos la asignación del servicio:',
  '',
  'Cliente: *{{cliente}}*',
  'Operación: *{{operacion}}*',
  'Dirección: *{{direccion}}*',
  'Fecha: *{{fecha}}*',
  'Hora de inicio: *{{horaInicio}}*',
  'Servicio: *{{servicio}}*',
  '',
  'Por favor responde exactamente: Confirmado.'
].join('\n');

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function assignmentScript() {
  return `<script ${MARKER}>
(function(){
  var ASSIGNMENT_MESSAGE_TEMPLATE = ${JSON.stringify(ASSIGNMENT_MESSAGE_TEMPLATE)};

  function isLegacyAssignmentTemplate(value){
    var text = String(value || '');
    if (!text.trim()) return true;
    return /te confirmamos asignaci[oó]n para/i.test(text)
      || /por favor confirma recibido/i.test(text)
      || /\bma[nñ]ana\s*:/i.test(text)
      || /\bhora\s*:\s*\*?\{\{\s*horaInicio\s*\}\}/i.test(text)
      || /\*?confirmado\?\*?/i.test(text);
  }

  function setTemplate(){
    var globalTemplate = document.getElementById('globalTemplate');
    if (globalTemplate && isLegacyAssignmentTemplate(globalTemplate.value)) {
      globalTemplate.value = ASSIGNMENT_MESSAGE_TEMPLATE;
      globalTemplate.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelectorAll('.assigned-card .assignment-message').forEach(function(textarea){
      if (isLegacyAssignmentTemplate(textarea.value)) {
        textarea.value = ASSIGNMENT_MESSAGE_TEMPLATE;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  function selectedServiceRequestId(){
    var selectedSummary = document.querySelector('#selectedRequestSummary');
    if (selectedSummary && selectedSummary.dataset.serviceRequestId) return selectedSummary.dataset.serviceRequestId;
    var input = document.querySelector('input[name="serviceRequestId"]');
    if (input && input.value) return input.value;
    return new URLSearchParams(window.location.search).get('serviceRequestId') || '';
  }

  function contextFromButton(button){
    var card = button && button.closest ? button.closest('.assigned-card') : null;
    if (!card) return null;
    return {
      assignmentId: card.dataset.assignmentId || '',
      serviceRequestId: card.dataset.serviceRequestId || selectedServiceRequestId(),
      workerId: card.dataset.workerId || '',
      recipientName: card.dataset.workerName || '',
      messageType: ${JSON.stringify(ASSIGNMENT_MESSAGE_TYPE)}
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
            if (ctx && ctx.assignmentId && ctx.serviceRequestId) {
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

function statusScript() {
  return `<script ${STATUS_MARKER}>
(function(){
  var originalFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    if (typeof input === 'string' && input === '/admin/operaciones/whatsapp/estado') {
      input = '/admin/operaciones/whatsapp/estado?start=1';
    }
    return originalFetch(input, init);
  };
  setTimeout(function(){
    originalFetch('/admin/operaciones/whatsapp/estado?start=1', { cache: 'no-store' }).then(function(response){ return response.ok ? response.json() : null; }).then(function(data){
      if (!data) return;
      if (typeof window.renderStatus === 'function') window.renderStatus(data);
    }).catch(function(){});
  }, 500);
})();
</script>`;
}

function installPatch() {
  if (express.response.__dispatchWhatsappConfirmationPatchInstalled) return;
  const originalSend = express.response.send;
  express.response.send = function patchedSend(body) {
    let output = body;
    const pathname = requestPath(this.req);
    if (typeof output === 'string' && this.req?.method === 'GET' && pathname === ASSIGNMENTS_PATH && output.includes('</body>') && !output.includes(MARKER)) {
      output = output.replace('</body>', `${assignmentScript()}\n</body>`);
    }
    if (typeof output === 'string' && this.req?.method === 'GET' && pathname === WHATSAPP_STATUS_PATH && output.includes('</body>') && !output.includes(STATUS_MARKER)) {
      output = output.replace('</body>', `${statusScript()}\n</body>`);
    }
    return originalSend.call(this, output);
  };
  express.response.__dispatchWhatsappConfirmationPatchInstalled = true;
}

installPatch();
