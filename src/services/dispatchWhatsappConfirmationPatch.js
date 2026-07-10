import express from 'express';

const ASSIGNMENTS_PATH = '/admin/operaciones/asignaciones';
const WHATSAPP_STATUS_PATH = '/admin/operaciones/whatsapp';
const MARKER = 'data-dispatch-whatsapp-confirmation-patch="true"';
const STATUS_MARKER = 'data-dispatch-whatsapp-status-start-patch="true"';
const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';

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
  var ASSIGNMENT_MESSAGE_TYPE = ${JSON.stringify(ASSIGNMENT_MESSAGE_TYPE)};
  var UI_STYLE_ID = 'dispatch-assignment-ui-only-fixes';

  function installUiStyle(){
    if (document.getElementById(UI_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = UI_STYLE_ID;
    style.textContent = [
      '.assignment-page .dispatch-hidden-duplicate-wa{display:none!important}',
      '.assignment-page .dispatch-wa-official{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:6px!important}',
      '.assignment-page .dispatch-wa-official svg{width:18px!important;height:18px!important;display:block!important;flex:0 0 18px!important}',
      '.assignment-page .assigned-card .dispatch-wa-official{width:32px!important;height:32px!important;min-width:32px!important;min-height:32px!important;padding:0!important;border-radius:999px!important;overflow:hidden!important;font-size:0!important}',
      '.assignment-page .assigned-card .dispatch-wa-official svg{width:20px!important;height:20px!important}',
      '.assignment-page .assigned-card .dispatch-wa-official .dispatch-wa-label{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}',
      '.assignment-page .assigned-card.assigned-card--finalized{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;gap:6px 8px!important;padding:7px 10px!important;min-height:auto!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .assigned-main{min-width:0!important;width:100%!important}',
      '.assignment-page .assigned-card.assigned-card--finalized strong{font-size:12.5px!important;line-height:1.1!important;margin:0 0 1px 0!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .meta{font-size:10.5px!important;line-height:1.1!important;margin:0!important;gap:0!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .assignment-message{display:none!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .assigned-actions{display:flex!important;align-items:center!important;justify-content:flex-end!important;width:auto!important;min-width:0!important;max-width:none!important;gap:4px!important;margin:0!important;align-self:center!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .assigned-actions form{margin:0!important;width:auto!important;flex:0 0 auto!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .assigned-actions form:not(.dispatch-remove-form){display:none!important}',
      '.assignment-page .assigned-card.assigned-card--finalized .icon-remove-btn{width:28px!important;height:28px!important;min-width:28px!important;min-height:28px!important;padding:0!important;font-size:18px!important}',
      '@media(max-width:760px){.assignment-page .assigned-card.assigned-card--finalized{grid-template-columns:minmax(0,1fr) auto!important;padding:6px 8px!important}.assignment-page .assigned-card.assigned-card--finalized strong{font-size:12px!important}.assignment-page .assigned-card.assigned-card--finalized .meta{font-size:10px!important}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function whatsappIconSvg(){
    return '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="#25D366" d="M16.01 3.2c-7.07 0-12.8 5.73-12.8 12.8 0 2.25.59 4.45 1.7 6.39L3.2 28.8l6.58-1.68a12.74 12.74 0 0 0 6.22 1.61h.01c7.06 0 12.79-5.73 12.79-12.8 0-3.43-1.34-6.65-3.76-9.08A12.7 12.7 0 0 0 16.01 3.2z"/><path fill="#fff" d="M16.01 5.38c2.83 0 5.49 1.1 7.49 3.1a10.52 10.52 0 0 1 3.1 7.49c0 5.85-4.76 10.61-10.59 10.61h-.01a10.6 10.6 0 0 1-5.4-1.48l-.39-.23-3.9 1 1.04-3.8-.25-.39A10.6 10.6 0 0 1 16.01 5.38z"/><path fill="#25D366" d="M19.11 17.23c-.28-.14-1.65-.81-1.91-.9-.25-.09-.44-.14-.62.14-.18.28-.71.9-.87 1.08-.16.18-.32.21-.6.07-.28-.14-1.16-.43-2.2-1.38-.81-.72-1.35-1.61-1.51-1.88-.16-.28-.02-.42.12-.56.13-.13.28-.32.42-.48.14-.16.18-.28.28-.46.09-.18.05-.35-.02-.49-.07-.14-.62-1.5-.85-2.05-.22-.53-.45-.46-.62-.46h-.53c-.18 0-.46.07-.69.32-.23.25-.9.88-.9 2.15 0 1.27.92 2.49 1.04 2.67.12.18 1.8 2.75 4.36 3.86.61.26 1.08.42 1.45.54.61.2 1.16.17 1.59.1.49-.07 1.51-.62 1.72-1.22.21-.6.21-1.11.14-1.22-.07-.11-.25-.18-.53-.32z"/></svg>';
  }

  function isCanonicalAssignmentTemplate(value){
    var text = String(value || '');
    return /hola\s+\*?\{\{\s*nombre\s*\}\}\*?,/i.test(text)
      && /\bma[nñ]ana\s*:\s*\*?\{\{\s*fecha\s*\}\}\*?/i.test(text)
      && /llegar\s+a\s*:\s*\*?\{\{\s*operacion\s*\}\}/i.test(text)
      && /hora\s*:\s*\*?\{\{\s*horaInicio\s*\}\}\s+por\s+favor/i.test(text)
      && /\*?confirmado\?\*?/i.test(text);
  }

  function shouldApplyTemplate(value){
    var text = String(value || '');
    if (!text.trim()) return true;
    if (isCanonicalAssignmentTemplate(text)) return false;
    return /te confirmamos la asignaci[oó]n del servicio/i.test(text)
      || /cliente\s*:\s*\*?\{\{\s*cliente\s*\}\}/i.test(text)
      || /hora de inicio\s*:\s*\*?\{\{\s*horaInicio\s*\}\}/i.test(text)
      || /por favor responde exactamente\s*:\s*confirmado/i.test(text)
      || /te confirmamos asignaci[oó]n para/i.test(text)
      || /por favor confirma recibido/i.test(text);
  }

  function setTemplate(){
    var globalTemplate = document.getElementById('globalTemplate');
    if (globalTemplate && shouldApplyTemplate(globalTemplate.value)) {
      globalTemplate.value = ASSIGNMENT_MESSAGE_TEMPLATE;
      globalTemplate.dataset.confirmationInstructionApplied = 'true';
      globalTemplate.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelectorAll('.assigned-card .assignment-message').forEach(function(textarea){
      if (shouldApplyTemplate(textarea.value)) {
        textarea.value = ASSIGNMENT_MESSAGE_TEMPLATE;
        textarea.dataset.confirmationInstructionApplied = 'true';
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
      messageType: ASSIGNMENT_MESSAGE_TYPE
    };
  }

  function markRemoveForms(){
    document.querySelectorAll('.assigned-card .assigned-actions form').forEach(function(form){
      var action = String(form.getAttribute('action') || '').toLowerCase();
      var text = String(form.textContent || '').trim();
      if (action.indexOf('/unassign') >= 0 || text === '-' || /quitar|eliminar/i.test(text)) form.classList.add('dispatch-remove-form');
    });
  }

  function isFinalizedCard(card){
    var text = String(card.textContent || '').toLowerCase();
    return text.indexOf('estado: confirmado') >= 0 || text.indexOf('estado: no confirmó') >= 0 || text.indexOf('estado: no confirmado') >= 0;
  }

  function compactFinalizedCards(){
    document.querySelectorAll('.assigned-card').forEach(function(card){
      if (isFinalizedCard(card)) card.classList.add('assigned-card--finalized');
      else card.classList.remove('assigned-card--finalized');
    });
  }

  function enhanceWhatsappButtons(){
    document.querySelectorAll('.assigned-card .dispatch-wa-button, .assigned-card .whatsapp-link, .assigned-card .icon-whatsapp').forEach(function(button){
      if (button.dataset.dispatchWaIconApplied === 'true') return;
      button.classList.add('dispatch-wa-official');
      button.innerHTML = whatsappIconSvg() + '<span class="dispatch-wa-label">WhatsApp</span>';
      button.title = button.title || 'Enviar WhatsApp';
      button.setAttribute('aria-label', button.getAttribute('aria-label') || 'Enviar WhatsApp');
      button.dataset.dispatchWaIconApplied = 'true';
    });
  }

  function dedupeBulkWhatsappButtons(){
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button, a')).filter(function(item){
      return /enviar\s+whatsapp\s+a\s+todos/i.test(String(item.textContent || '').trim());
    });
    var seenByPanel = [];
    buttons.forEach(function(button){
      var panel = button.closest('.template-card') || button.parentElement || document.body;
      var existing = seenByPanel.find(function(item){ return item.panel === panel; });
      if (existing) button.classList.add('dispatch-hidden-duplicate-wa');
      else {
        seenByPanel.push({ panel: panel, button: button });
        button.classList.remove('dispatch-hidden-duplicate-wa');
      }
    });
  }

  function applyUiOnlyFixes(){
    installUiStyle();
    setTemplate();
    markRemoveForms();
    compactFinalizedCards();
    enhanceWhatsappButtons();
    dedupeBulkWhatsappButtons();
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

  applyUiOnlyFixes();
  new MutationObserver(applyUiOnlyFixes).observe(document.body, { childList: true, subtree: true });
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