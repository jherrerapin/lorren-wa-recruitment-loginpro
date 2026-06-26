import express from 'express';

const ASSIGNMENTS_PATH = '/admin/operaciones/asignaciones';
const WHATSAPP_STATUS_PATH = '/admin/operaciones/whatsapp';
const MARKER = 'data-dispatch-whatsapp-confirmation-patch="true"';
const STATUS_MARKER = 'data-dispatch-whatsapp-status-start-patch="true"';

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

function assignmentScript() {
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
