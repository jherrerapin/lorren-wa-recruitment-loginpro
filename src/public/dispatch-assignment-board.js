(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let selectedWorkerIds = new Set();
  let restBatchHasDirect = false;
  let restBatchWorkers = [];
  let restDatePolicy = { valid: false, restDate: null, isSunday: false, isHoliday: false, isNaturalRestDay: false };
  let restDatePolicySequence = 0;
  let boardRequestController = null;

  function showToast(message) {
    const toast = qs('#asyncToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function encodeForm(form) {
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => params.append(key, value));
    return params;
  }

  function currentDateFilter() {
    return qs('#assignmentDateFilter')?.value || '';
  }

  function todayDateInColombia() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function syncDateProxy() {
    const value = currentDateFilter();
    qsa('[data-date-proxy="true"]').forEach((input) => {
      input.value = value;
    });
  }

  function syncRestDateUi() {
    const value = currentDateFilter() || todayDateInColombia();
    const chip = qs('.rest-date-chip');
    if (chip) chip.textContent = `Fecha mostrada: ${value}`;
  }

  function normalizeCity(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  function compatibleCitiesForRequest(cityName) {
    const normalized = normalizeCity(cityName);
    if (!normalized) return [];
    if (normalized === 'siberia') {
      return ['siberia', 'bogota', 'bogota d.c.', 'bogota dc', 'madrid', 'funza', 'mosquera'];
    }
    return [normalized];
  }

  function applyAutomaticCityFilter() {
    const city = qs('#selectedRequestSummary')?.dataset.requestCity || '';
    const allowed = compatibleCitiesForRequest(city);
    const cards = qsa('.worker-card');
    const empty = qs('#autoFilterEmpty');

    if (!allowed.length) {
      cards.forEach((card) => { card.hidden = false; });
      if (empty) empty.hidden = true;
      const text = qs('#cityAutoFilterText');
      if (text) text.textContent = 'Selecciona una solicitud para aplicar filtro automático por ciudad.';
      return;
    }

    let visible = 0;
    cards.forEach((card) => {
      const workerCities = String(card.dataset.workerCities || '').split('|').map(normalizeCity).filter(Boolean);
      const vacancyCities = String(card.dataset.vacancyCities || '').split('|').map(normalizeCity).filter(Boolean);
      const matches = workerCities.some((item) => allowed.includes(item))
        || vacancyCities.some((item) => allowed.includes(item));
      card.hidden = !matches;
      if (matches) visible += 1;
    });

    const text = qs('#cityAutoFilterText');
    if (text) text.textContent = `Filtro automático aplicado por ciudad: ${city}.`;
    if (empty) empty.hidden = visible > 0;
  }

  function buildBoardUrl({ date = currentDateFilter(), serviceRequestId = null, allDates = false } = {}) {
    const url = new URL(window.location.href);
    url.searchParams.delete('message');
    url.searchParams.delete('date');

    if (allDates) {
      url.searchParams.delete('fecha');
      url.searchParams.set('allDates', '1');
    } else {
      url.searchParams.delete('allDates');
      if (date) url.searchParams.set('fecha', date);
      else url.searchParams.delete('fecha');
    }

    if (serviceRequestId) url.searchParams.set('serviceRequestId', serviceRequestId);
    else url.searchParams.delete('serviceRequestId');

    return url;
  }

  function setBoardBusy(isBusy) {
    const board = qs('.board-layout');
    if (!board) return;
    if (isBusy) board.setAttribute('aria-busy', 'true');
    else board.removeAttribute('aria-busy');
  }

  function replaceInnerFromDocument(selector, nextDocument) {
    const current = qs(selector);
    const next = nextDocument.querySelector(selector);
    if (!current || !next) return false;
    current.innerHTML = next.innerHTML;
    return true;
  }

  function syncMessageNote(nextDocument) {
    const current = qs('.section-note');
    const next = nextDocument.querySelector('.section-note');
    if (current && next) {
      current.textContent = next.textContent;
      return;
    }
    if (current && !next) {
      current.remove();
      return;
    }
    if (!current && next) {
      document.querySelector('.hero')?.insertAdjacentElement('afterend', next.cloneNode(true));
    }
  }

  function applyBoardDocument(nextDocument, {
    url,
    date,
    preserveRequestScroll = true,
    preserveWorkerScroll = true,
    updateHistory = true
  } = {}) {
    const workerList = qs('#workerList');
    const requestList = qs('#requestList');
    const pageY = window.scrollY || 0;
    const workerScroll = workerList?.scrollTop || 0;
    const requestScroll = requestList?.scrollTop || 0;

    const nextWorkerList = nextDocument.querySelector('#workerList');
    const nextRequestList = nextDocument.querySelector('#requestList');
    const currentAssignmentBody = qs('.assignment-body');
    const nextAssignmentBody = nextDocument.querySelector('.assignment-body');
    const currentRestPanel = qs('#workerRestPanel');
    const nextRestPanel = nextDocument.querySelector('#workerRestPanel');

    if (!nextWorkerList || !nextRequestList || !currentAssignmentBody || !nextAssignmentBody) {
      throw new Error('No fue posible leer el tablero actualizado.');
    }

    workerList.innerHTML = nextWorkerList.innerHTML;
    requestList.innerHTML = nextRequestList.innerHTML;
    currentAssignmentBody.innerHTML = nextAssignmentBody.innerHTML;
    if (currentRestPanel && nextRestPanel) currentRestPanel.innerHTML = nextRestPanel.innerHTML;

    const currentWorkerRequest = qs('#workerFilterForm input[name="serviceRequestId"]');
    const nextWorkerRequest = nextDocument.querySelector('#workerFilterForm input[name="serviceRequestId"]');
    if (currentWorkerRequest) currentWorkerRequest.value = nextWorkerRequest?.value || '';

    syncMessageNote(nextDocument);

    const dateInput = qs('#assignmentDateFilter');
    if (dateInput) dateInput.value = date || '';
    syncDateProxy();
    syncRestDateUi();

    selectedWorkerIds.clear();
    bindDynamicBoard();

    if (preserveWorkerScroll && workerList) workerList.scrollTop = workerScroll;
    if (requestList) requestList.scrollTop = preserveRequestScroll ? requestScroll : 0;
    window.scrollTo(0, pageY);

    if (updateHistory && url) history.replaceState(null, '', url.toString());
  }

  async function loadBoard(url, options = {}) {
    if (boardRequestController) boardRequestController.abort();
    boardRequestController = new AbortController();
    const controller = boardRequestController;
    setBoardBusy(true);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'X-Requested-With': 'fetch' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('No fue posible actualizar el tablero.');
      const html = await response.text();
      if (controller.signal.aborted) return;
      const nextDocument = new DOMParser().parseFromString(html, 'text/html');
      applyBoardDocument(nextDocument, {
        ...options,
        url,
        date: options.date ?? (url.searchParams.has('allDates') ? '' : (url.searchParams.get('fecha') || ''))
      });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      throw error;
    } finally {
      if (boardRequestController === controller) {
        boardRequestController = null;
        setBoardBusy(false);
      }
    }
  }

  async function applyPostResponse(response, { successMessage = null } = {}) {
    if (!response.ok) throw new Error('No fue posible completar la acción.');
    const html = await response.text();
    const nextDocument = new DOMParser().parseFromString(html, 'text/html');
    const responseUrl = new URL(response.url || window.location.href);
    const date = responseUrl.searchParams.has('allDates') ? '' : (responseUrl.searchParams.get('fecha') || currentDateFilter());
    applyBoardDocument(nextDocument, {
      url: responseUrl,
      date,
      preserveRequestScroll: true,
      preserveWorkerScroll: true,
      updateHistory: true
    });
    if (successMessage) showToast(successMessage);
  }

  async function selectRequest(link) {
    const card = link.closest('.request-card');
    const serviceRequestId = card?.dataset.requestId;
    if (!serviceRequestId) return;
    const date = currentDateFilter() || card.dataset.requestDate || '';
    const url = buildBoardUrl({ date, serviceRequestId });
    await loadBoard(url, {
      date,
      preserveRequestScroll: true,
      preserveWorkerScroll: true,
      updateHistory: true
    });
  }

  async function changeOperationalDate(value) {
    if (!value) return;
    const url = buildBoardUrl({ date: value, serviceRequestId: null });
    await loadBoard(url, {
      date: value,
      preserveRequestScroll: false,
      preserveWorkerScroll: true,
      updateHistory: true
    });
  }

  async function showAllDates() {
    const url = buildBoardUrl({ allDates: true, serviceRequestId: null });
    await loadBoard(url, {
      date: '',
      preserveRequestScroll: false,
      preserveWorkerScroll: true,
      updateHistory: true
    });
  }

  function getSelectedWorkerIds() {
    return Array.from(selectedWorkerIds).filter(Boolean);
  }

  function visibleWorkerCards() {
    return qsa('.worker-card').filter((card) => !card.hidden);
  }

  function syncSelectAllUi() {
    const checkbox = qs('#selectAllWorkers');
    if (!checkbox) return;
    const visibleIds = visibleWorkerCards().map((card) => card.dataset.workerId).filter(Boolean);
    const selectedVisible = visibleIds.filter((workerId) => selectedWorkerIds.has(workerId)).length;
    checkbox.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    checkbox.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
    checkbox.disabled = visibleIds.length === 0;
  }

  function refreshSelectionUi() {
    qsa('.worker-card').forEach((card) => {
      const selected = selectedWorkerIds.has(card.dataset.workerId);
      card.classList.toggle('selected', selected);
      const checkbox = card.querySelector('.worker-select');
      if (checkbox) checkbox.checked = selected;
    });
    const count = qs('#selectedWorkersCount');
    if (count) count.textContent = String(selectedWorkerIds.size);
    syncSelectAllUi();
  }

  function setWorkerSelection(workerId, selected) {
    if (!workerId) return;
    if (selected) selectedWorkerIds.add(workerId);
    else selectedWorkerIds.delete(workerId);
    refreshSelectionUi();
  }

  function setVisibleWorkersSelection(selected) {
    visibleWorkerCards().forEach((card) => {
      const workerId = card.dataset.workerId;
      if (!workerId) return;
      if (selected) selectedWorkerIds.add(workerId);
      else selectedWorkerIds.delete(workerId);
    });
    refreshSelectionUi();
  }

  function clearWorkerSelection() {
    selectedWorkerIds.clear();
    refreshSelectionUi();
  }

  function ensureSelectAllControl() {
    const actions = qs('.worker-toolbar-actions');
    if (!actions || qs('#selectAllWorkers')) return;

    const label = document.createElement('label');
    label.className = 'btn';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'selectAllWorkers';
    checkbox.className = 'worker-select';
    checkbox.setAttribute('aria-label', 'Seleccionar todos los auxiliares visibles');
    const text = document.createElement('span');
    text.textContent = 'Seleccionar todos';
    label.append(checkbox, text);
    actions.insertBefore(label, actions.firstChild);

    checkbox.addEventListener('change', () => setVisibleWorkersSelection(checkbox.checked));
    syncSelectAllUi();
  }

  async function assignWorkers(workerIds) {
    const ids = [...new Set(workerIds)].filter(Boolean);
    if (!ids.length) return;

    const drop = qs('#assignmentDropZone');
    const form = qs('#assignForm');
    const serviceRequestId = form?.querySelector('input[name="serviceRequestId"]')?.value;
    if (drop?.dataset.disabled === 'true') {
      showToast('La solicitud no está disponible para asignar en este momento.');
      return;
    }
    if (!serviceRequestId || !form) {
      showToast('Selecciona una solicitud antes de asignar auxiliares.');
      return;
    }

    showToast(`Asignando ${ids.length} auxiliar${ids.length !== 1 ? 'es' : ''}...`);
    if (drop) drop.classList.add('disabled');

    let lastResponse = null;
    for (const workerId of ids) {
      const payload = new URLSearchParams();
      payload.set('serviceRequestId', serviceRequestId);
      payload.set('workerId', workerId);
      lastResponse = await fetch(form.action, {
        method: 'POST',
        body: payload,
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'fetch'
        }
      });
      if (!lastResponse.ok) {
        if (drop) drop.classList.remove('disabled');
        throw new Error('No fue posible asignar uno de los auxiliares.');
      }
    }

    clearWorkerSelection();
    if (lastResponse) {
      await applyPostResponse(lastResponse, {
        successMessage: `${ids.length} auxiliar${ids.length !== 1 ? 'es enviados' : ' enviado'} a asignación.`
      });
    }
  }

  async function postFormWithoutRefresh(form, successMessage) {
    const buttons = qsa('button,a', form.closest('.assigned-card') || form);
    buttons.forEach((button) => {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    });

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: encodeForm(form),
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'fetch'
        }
      });
      await applyPostResponse(response, { successMessage });
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
        button.removeAttribute('aria-disabled');
      });
    }
  }

  function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('57')) return digits;
    if (digits.length === 10) return `57${digits}`;
    return digits;
  }

  async function sendDispatchWhatsapp(button) {
    const phone = button.dataset.waPhone;
    const card = button.closest('.assigned-card');
    const context = {
      assignmentId: card?.dataset.assignmentId || '',
      serviceRequestId: card?.dataset.serviceRequestId || qs('#selectedRequestSummary')?.dataset.serviceRequestId || '',
      workerId: card?.dataset.workerId || '',
      recipientName: card?.dataset.workerName || '',
      messageType: 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST'
    };

    if (!phone) {
      showToast('No hay número de WhatsApp para este auxiliar.');
      return;
    }
    if (!context.assignmentId || !context.serviceRequestId || !context.workerId) {
      showToast('No se pudo identificar la asignación. Recarga el tablero e intenta nuevamente.');
      return;
    }

    button.disabled = true;
    const originalText = button.innerHTML;
    button.innerHTML = '...';
    try {
      const response = await fetch('/admin/operaciones/whatsapp/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, context })
      });
      const data = await response.json();
      if (response.status === 503) {
        showToast(data.message || 'WhatsApp oficial de despacho no está configurado.');
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.message || 'No se pudo enviar el mensaje oficial.');
      showToast('Mensaje oficial enviado correctamente.');
    } catch (error) {
      showToast(error.message || 'Error enviando WhatsApp.');
    } finally {
      button.disabled = false;
      button.innerHTML = originalText;
    }
  }

  function refreshLinks() {
    qsa('.assigned-card').forEach((card) => {
      const link = card.querySelector('.whatsapp-link');
      if (!link) return;
      link.dataset.waPhone = normalizePhone(card.dataset.workerPhone);
      link.onclick = () => sendDispatchWhatsapp(link);
    });
  }

  async function refreshRestDatePolicy(dateValue = qs('#restDateValue')?.value || '') {
    const form = qs('#restAssignmentForm');
    const submitButton = form?.querySelector('button[type="submit"]');
    const requestSequence = ++restDatePolicySequence;
    if (!form || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ''))) {
      restDatePolicy = { valid: false, restDate: null, isSunday: false, isHoliday: false, isNaturalRestDay: false };
      syncRestFields();
      return restDatePolicy;
    }

    if (submitButton) submitButton.disabled = true;
    try {
      const payload = new URLSearchParams();
      payload.set('checkOnly', 'rest-date-policy');
      payload.set('restDate', dateValue);
      const response = await fetch(form.action, {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'fetch'
        }
      });
      if (!response.ok) throw new Error('No fue posible validar la fecha de descanso.');
      const data = await response.json();
      if (requestSequence !== restDatePolicySequence) return restDatePolicy;
      restDatePolicy = data?.datePolicy || { valid: false, restDate: null, isSunday: false, isHoliday: false, isNaturalRestDay: false };
      syncRestFields();
      return restDatePolicy;
    } catch (error) {
      if (requestSequence === restDatePolicySequence) {
        restDatePolicy = { valid: false, restDate: null, isSunday: false, isHoliday: false, isNaturalRestDay: false };
        syncRestFields();
      }
      throw error;
    } finally {
      if (requestSequence === restDatePolicySequence && submitButton) submitButton.disabled = false;
    }
  }

  function syncRestFields() {
    const naturalRestDay = restDatePolicy.isNaturalRestDay === true;
    const sundayRestDay = restDatePolicy.isSunday === true;
    const holidayRestDay = restDatePolicy.isHoliday === true;
    const reasonAvailable = restBatchHasDirect;
    const reasonRequired = false;
    const directWorkers = restBatchWorkers.filter((worker) => worker.contractType === 'DIRECTO');
    const reasonField = qs('#restReasonField');
    const reasonInput = qs('#restReasonInput');
    const rule = qs('#restContractRule');

    if (reasonField) reasonField.hidden = !reasonAvailable;
    if (reasonInput) {
      reasonInput.disabled = !reasonAvailable;
      reasonInput.required = reasonRequired;
      const compensatoryOption = reasonInput.querySelector('option[value="COMPENSATORIO"]');
      if (compensatoryOption) {
        compensatoryOption.textContent = 'Compensatorio';
        compensatoryOption.hidden = naturalRestDay;
        compensatoryOption.disabled = naturalRestDay;
      }
      if (naturalRestDay && reasonInput.value === 'COMPENSATORIO') reasonInput.value = '';
      if (!reasonAvailable) reasonInput.value = '';
    }
    if (rule) {
      rule.textContent = sundayRestDay && restBatchHasDirect
        ? 'Domingo: la justificación es opcional para auxiliares Directos.'
        : holidayRestDay && restBatchHasDirect
          ? 'Festivo: la justificación es opcional para auxiliares Directos.'
          : reasonAvailable
            ? 'Día hábil: la justificación es opcional para auxiliares Directos.'
            : 'La justificación es opcional para esta fecha.';
    }

    const compensatorio = reasonAvailable && !naturalRestDay && reasonInput?.value === 'COMPENSATORIO';
    const bulkCompensatorio = compensatorio && restBatchWorkers.length > 1;
    const field = qs('#originSundayField');
    const origin = qs('#originSundayDateInput');
    if (field) {
      field.hidden = !compensatorio || bulkCompensatorio;
      const label = field.querySelector('label');
      if (label) label.textContent = 'Domingo que generó el compensatorio';
    }
    if (origin) {
      origin.required = compensatorio && !bulkCompensatorio;
      origin.disabled = !compensatorio || bulkCompensatorio;
      if (!compensatorio || bulkCompensatorio) origin.value = '';
    }
    if (rule && bulkCompensatorio) {
      rule.textContent = `${directWorkers.length} Directo${directWorkers.length !== 1 ? 's' : ''}: al continuar asignarás el domingo que generó el compensatorio de cada uno.`;
    }
  }

  function openRestDialog(workerIds) {
    const ids = [...new Set(Array.isArray(workerIds) ? workerIds : [workerIds])].filter(Boolean);
    const cards = ids
      .map((workerId) => qsa('.worker-card').find((item) => item.dataset.workerId === workerId))
      .filter(Boolean);

    if (!cards.length) {
      showToast('Selecciona al menos un auxiliar para descanso.');
      return;
    }

    const selectedDate = currentDateFilter();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(selectedDate || ''))) {
      showToast('Selecciona una fecha operativa antes de registrar un descanso.');
      return;
    }

    const workerInput = qs('#restWorkerId');
    const restDate = qs('#restDateValue');
    const allowAssignedRestInput = qs('#allowAssignedRestInput');

    restBatchWorkers = cards.map((card) => ({
      workerId: card.dataset.workerId,
      workerName: card.dataset.workerName || 'Auxiliar',
      contractType: card.dataset.contractType || 'DIRECTO',
      sameDayAssignment: card.dataset.sameDayAssignment === 'true'
    }));
    restBatchHasDirect = cards.some((card) => card.dataset.contractType === 'DIRECTO');

    if (workerInput) workerInput.value = cards.map((card) => card.dataset.workerId).join(',');
    if (restDate) restDate.value = selectedDate;
    if (allowAssignedRestInput) allowAssignedRestInput.value = 'false';

    const assignedWorkers = restBatchWorkers.filter((worker) => worker.sameDayAssignment);
    if (assignedWorkers.length) {
      const conflictMessage = qs('#restConflictMessage');
      const names = assignedWorkers.map((worker) => worker.workerName).join(', ');
      if (conflictMessage) {
        conflictMessage.textContent = `${names} ${assignedWorkers.length === 1 ? 'ya está asignado a una solicitud activa' : 'ya están asignados a solicitudes activas'} en la fecha mostrada. Si deseas continuar, pulsa “Dar descanso”. La justificación de los Directos se gestiona después desde su tarjeta.`;
      }
      qs('#restConflictDialog')?.showModal();
      return;
    }

    assignRestBatchWithoutJustification().catch((error) => {
      console.error(error);
      showToast(error.message || 'No fue posible asignar los descansos.');
    });
  }

  function openRestJustificationDialog(button) {
    const workerId = button?.dataset.workerId || '';
    const workerNameValue = button?.dataset.workerName || 'Auxiliar';
    const restDateValue = button?.dataset.restDate || '';
    if (!workerId || !/^\d{4}-\d{2}-\d{2}$/.test(restDateValue)) {
      showToast('No se pudo identificar el descanso seleccionado.');
      return;
    }

    restBatchWorkers = [{
      workerId,
      workerName: workerNameValue,
      contractType: 'DIRECTO',
      sameDayAssignment: false
    }];
    restBatchHasDirect = true;

    const dialog = qs('#restAssignmentDialog');
    const title = dialog?.querySelector('h3');
    const workerInput = qs('#restWorkerId');
    const workerName = qs('#restWorkerName');
    const reasonInput = qs('#restReasonInput');
    const originInput = qs('#originSundayDateInput');
    const restDate = qs('#restDateValue');
    const allowAssignedRestInput = qs('#allowAssignedRestInput');
    const existingReason = button.dataset.restReason || '';

    if (title) title.textContent = existingReason ? 'Editar justificación' : 'Asignar justificación';
    if (workerInput) workerInput.value = workerId;
    if (workerName) workerName.textContent = workerNameValue;
    if (reasonInput) reasonInput.value = existingReason;
    if (originInput) originInput.value = button.dataset.originSundayDate || '';
    if (restDate) restDate.value = restDateValue;
    if (allowAssignedRestInput) allowAssignedRestInput.value = 'false';

    restDatePolicy = { valid: false, restDate: null, isSunday: false, isHoliday: false, isNaturalRestDay: false };
    syncRestFields();
    refreshRestDatePolicy(restDateValue)
      .then((policy) => {
        if (!policy.valid) throw new Error('La fecha del descanso no es válida.');
        dialog?.showModal();
      })
      .catch((error) => {
        console.error(error);
        showToast(error.message || 'No fue posible abrir la justificación.');
      });
  }

  function renderRestOriginBatchDialog() {
    const directWorkers = restBatchWorkers.filter((worker) => worker.contractType === 'DIRECTO');
    const list = qs('#restOriginBatchList');
    if (!list || !directWorkers.length) {
      showToast('No hay auxiliares Directos que requieran domingo asociado.');
      return;
    }

    list.innerHTML = '';
    directWorkers.forEach((worker) => {
      const row = document.createElement('label');
      row.className = 'rest-origin-row';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = worker.workerName;
      const contract = document.createElement('span');
      contract.textContent = 'Contrato Directo · selecciona el domingo que generó este compensatorio';
      details.append(name, contract);
      const input = document.createElement('input');
      input.type = 'date';
      input.required = true;
      input.setAttribute('data-rest-origin-worker', worker.workerId);
      input.dataset.workerName = worker.workerName;
      row.append(details, input);
      list.append(row);
    });

    qs('#restAssignmentDialog')?.close();
    qs('#restOriginBatchDialog')?.showModal();
  }

  async function postRestWorker(worker, originSundayDate, options = {}) {
    const form = qs('#restAssignmentForm');
    if (!form) throw new Error('No se encontró el formulario de descanso.');

    const payload = new URLSearchParams();
    payload.set('workerId', worker.workerId);
    payload.set('restDate', qs('#restDateValue')?.value || '');
    if (qs('#allowAssignedRestInput')?.value === 'true') payload.set('allowAssignedRest', 'true');
    if (options.deferJustification === true) payload.set('reason', '');
    const serviceRequestId = form.querySelector('input[name="serviceRequestId"]')?.value;
    if (serviceRequestId) payload.set('serviceRequestId', serviceRequestId);
    const canSendReason = worker.contractType === 'DIRECTO';
    if (options.includeReason === true && canSendReason) {
      payload.set('reason', qs('#restReasonInput')?.value || '');
      if (originSundayDate) payload.set('originSundayDate', originSundayDate);
    }

    const response = await fetch(form.action, {
      method: 'POST',
      body: payload,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'fetch'
      }
    });
    const html = await response.text();
    const nextDocument = new DOMParser().parseFromString(html, 'text/html');
    const message = nextDocument.querySelector('.section-note')?.textContent?.trim() || '';
    if (!response.ok || /\bno guardad[oa]s?\b/i.test(message) || /No fue posible/i.test(message)) {
      throw new Error(message || 'No fue posible guardar el descanso.');
    }
    return message;
  }

  async function assignRestBatchWithoutJustification() {
    if (!restBatchWorkers.length) return;
    const workers = [...restBatchWorkers];
    showToast(`Asignando ${workers.length} descanso${workers.length !== 1 ? 's' : ''}...`);

    let saved = 0;
    const failures = [];
    for (const worker of workers) {
      try {
        await postRestWorker(worker, '', { includeReason: false, deferJustification: true });
        saved += 1;
      } catch (error) {
        failures.push(`${worker.workerName}: ${error.message || 'No fue posible guardar.'}`);
      }
    }

    clearWorkerSelection();
    const url = buildBoardUrl({
      date: currentDateFilter(),
      serviceRequestId: qs('#selectedRequestSummary')?.dataset.serviceRequestId || null,
      allDates: !currentDateFilter()
    });
    await loadBoard(url, { date: currentDateFilter(), updateHistory: false });

    const parts = [];
    if (saved) parts.push(`${saved} descanso${saved !== 1 ? 's asignados' : ' asignado'}`);
    if (failures.length) parts.push(`${failures.length} no guardado${failures.length !== 1 ? 's' : ''}: ${failures.join(' · ')}`);
    showToast(parts.join('. ') || 'No fue posible guardar los descansos.');
  }

  async function submitRestBatchWithOrigins(event) {
    event.preventDefault();
    const list = qs('#restOriginBatchList');
    const inputs = qsa('[data-rest-origin-worker]', list);
    const originByWorker = new Map();

    for (const input of inputs) {
      const origin = input.value;
      const originDate = /^\d{4}-\d{2}-\d{2}$/.test(String(origin || ''))
        ? new Date(`${origin}T12:00:00.000Z`)
        : null;
      if (!originDate || originDate.getUTCDay() !== 0) {
        showToast(`Selecciona un domingo válido para ${input.dataset.workerName || 'el auxiliar'}.`);
        input.focus();
        return;
      }
      originByWorker.set(input.getAttribute('data-rest-origin-worker'), origin);
    }

    const button = qs('#confirmRestOriginBatch');
    const cancelButton = qs('#cancelRestOriginBatch');
    if (button) {
      button.disabled = true;
      button.textContent = 'Asignando...';
    }
    if (cancelButton) cancelButton.disabled = true;

    let saved = 0;
    const failures = [];
    try {
      for (const worker of restBatchWorkers) {
        try {
          const originSundayDate = worker.contractType === 'DIRECTO'
            ? (originByWorker.get(worker.workerId) || '')
            : '';
          await postRestWorker(worker, originSundayDate, { includeReason: true });
          saved += 1;
        } catch (error) {
          failures.push(`${worker.workerName}: ${error.message || 'No fue posible guardar.'}`);
        }
      }

      qs('#restOriginBatchDialog')?.close();
      qs('#restAssignmentDialog')?.close();
      const parts = [];
      if (saved) parts.push(`${saved} descanso${saved !== 1 ? 's asignados' : ' asignado'}`);
      if (failures.length) parts.push(`${failures.length} no guardado${failures.length !== 1 ? 's' : ''}: ${failures.join(' · ')}`);
      const url = buildBoardUrl({
        date: currentDateFilter(),
        serviceRequestId: qs('#selectedRequestSummary')?.dataset.serviceRequestId || null,
        allDates: !currentDateFilter()
      });
      await loadBoard(url, { date: currentDateFilter(), updateHistory: false });
      showToast(parts.join('. ') || 'No fue posible guardar los descansos.');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Asignar descansos';
      }
      if (cancelButton) cancelButton.disabled = false;
    }
  }

  function bindRestPanel() {
    const restDrop = qs('#restDropZone');
    if (restDrop) {
      restDrop.addEventListener('dragover', (event) => {
        event.preventDefault();
        restDrop.classList.add('drag-over');
      });
      restDrop.addEventListener('dragleave', () => restDrop.classList.remove('drag-over'));
      restDrop.addEventListener('drop', (event) => {
        event.preventDefault();
        restDrop.classList.remove('drag-over');
        const ids = event.dataTransfer.getData('text/plain').split(',').map((item) => item.trim()).filter(Boolean);
        openRestDialog(ids);
      });
    }

    qsa('[data-rest-justification]').forEach((button) => {
      button.addEventListener('click', () => openRestJustificationDialog(button));
    });

    qs('#cancelRestConflict')?.addEventListener('click', () => qs('#restConflictDialog')?.close());
    qs('#confirmAssignedRest')?.addEventListener('click', () => {
      const conflictDialog = qs('#restConflictDialog');
      if (conflictDialog?.open) conflictDialog.close();
      const allowAssignedRestInput = qs('#allowAssignedRestInput');
      if (allowAssignedRestInput) allowAssignedRestInput.value = 'true';
      assignRestBatchWithoutJustification().catch((error) => {
        console.error(error);
        showToast(error.message || 'No fue posible asignar los descansos.');
      });
    });
    qs('#restReasonInput')?.addEventListener('change', syncRestFields);
    qs('#cancelRestDialog')?.addEventListener('click', () => qs('#restAssignmentDialog')?.close());
    qs('#cancelRestOriginBatch')?.addEventListener('click', () => {
      qs('#restOriginBatchDialog')?.close();
      qs('#restAssignmentDialog')?.showModal();
    });
    qs('#restOriginBatchForm')?.addEventListener('submit', submitRestBatchWithOrigins);
    qs('#restAssignmentForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const restDateValue = qs('#restDateValue')?.value || '';
      let policy;
      try {
        policy = await refreshRestDatePolicy(restDateValue);
        if (!policy.valid) {
          showToast('La fecha operativa seleccionada no es válida.');
          return;
        }
      } catch (error) {
        console.error(error);
        showToast(error.message || 'No fue posible validar la fecha de descanso.');
        return;
      }

      const worker = restBatchWorkers[0];
      if (!worker || worker.contractType !== 'DIRECTO') {
        showToast('La justificación solo aplica a auxiliares Directos.');
        return;
      }

      const reason = qs('#restReasonInput')?.value || '';
      let origin = '';
      if (reason === 'COMPENSATORIO' && !restDatePolicy.isNaturalRestDay) {
        origin = qs('#originSundayDateInput')?.value || '';
        const originDate = /^\d{4}-\d{2}-\d{2}$/.test(String(origin || ''))
          ? new Date(`${origin}T12:00:00.000Z`)
          : null;
        if (!originDate || originDate.getUTCDay() !== 0) {
          showToast('Selecciona un domingo válido para asociar al compensatorio.');
          return;
        }
      }

      try {
        await postRestWorker(worker, origin, { includeReason: true });
        qs('#restAssignmentDialog')?.close();
        const url = buildBoardUrl({
          date: currentDateFilter(),
          serviceRequestId: qs('#selectedRequestSummary')?.dataset.serviceRequestId || null,
          allDates: !currentDateFilter()
        });
        await loadBoard(url, { date: currentDateFilter(), updateHistory: false });
        showToast(reason ? 'Justificación guardada.' : 'Descanso guardado sin justificación.');
      } catch (error) {
        console.error(error);
        showToast(error.message || 'No fue posible guardar la justificación.');
      }
    });
    syncRestFields();
  }

  function bindWorkerCards() {
    qsa('.worker-card[draggable="true"]').forEach((card) => {
      card.addEventListener('dragstart', (event) => {
        const workerId = card.dataset.workerId;
        if (!selectedWorkerIds.has(workerId)) {
          clearWorkerSelection();
          setWorkerSelection(workerId, true);
        }
        const ids = getSelectedWorkerIds();
        qsa('.worker-card.selected').forEach((selectedCard) => selectedCard.classList.add('drag-batch'));
        event.dataTransfer.setData('text/plain', ids.join(','));
        event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        qsa('.worker-card.drag-batch').forEach((item) => item.classList.remove('drag-batch'));
      });

      const checkbox = card.querySelector('.worker-select');
      checkbox?.addEventListener('change', () => setWorkerSelection(card.dataset.workerId, checkbox.checked));
      card.addEventListener('click', (event) => {
        if (event.target.closest('input,button,a,select,textarea')) return;
        setWorkerSelection(card.dataset.workerId, !selectedWorkerIds.has(card.dataset.workerId));
      });
    });
  }

  function bindAssignmentPanel() {
    const drop = qs('#assignmentDropZone');
    if (drop) {
      drop.addEventListener('dragover', (event) => {
        if (drop.dataset.disabled === 'true') return;
        event.preventDefault();
        drop.classList.add('drag-over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('drag-over');
        if (drop.dataset.disabled === 'true') {
          showToast('No puedes asignar aquí en este momento.');
          return;
        }
        const ids = event.dataTransfer.getData('text/plain').split(',').map((item) => item.trim()).filter(Boolean);
        assignWorkers(ids).catch((error) => {
          console.error(error);
          showToast(error.message || 'No fue posible asignar.');
        });
      });
    }

    qsa('form[data-async-assignment-action]').forEach((form) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const action = form.dataset.asyncAssignmentAction;
        if (action === 'unassign' && !confirm('¿Quitar este auxiliar de la solicitud?')) return;
        const message = action === 'confirmar'
          ? 'Confirmación registrada.'
          : action === 'no-confirmado'
            ? 'Auxiliar marcado como no confirmado.'
            : 'Auxiliar retirado de la solicitud.';
        postFormWithoutRefresh(form, message).catch((error) => {
          console.error(error);
          showToast(error.message || 'No fue posible completar la acción.');
        });
      });
    });

    qs('#sendAllWhatsapp')?.addEventListener('click', async () => {
      refreshLinks();
      const buttons = qsa('.whatsapp-link');
      if (!buttons.length) {
        showToast('No hay asignaciones con WhatsApp disponibles para enviar.');
        return;
      }
      for (const button of buttons) await sendDispatchWhatsapp(button);
    });
  }

  function bindDynamicBoard() {
    applyAutomaticCityFilter();
    refreshSelectionUi();
    refreshLinks();
    bindWorkerCards();
    bindAssignmentPanel();
    bindRestPanel();
  }

  function bindStaticBoard() {
    ensureSelectAllControl();

    qs('#assignmentDateFilter')?.addEventListener('change', (event) => {
      const previousValue = currentDateFilter();
      const value = event.target.value;
      changeOperationalDate(value).catch((error) => {
        console.error(error);
        event.target.value = previousValue;
        showToast(error.message || 'No fue posible filtrar por fecha.');
      });
    });

    qs('#clearAssignmentDateFilter')?.addEventListener('click', () => {
      showAllDates().catch((error) => {
        console.error(error);
        showToast(error.message || 'No fue posible mostrar todas las fechas.');
      });
    });

    qs('#requestList')?.addEventListener('click', (event) => {
      const link = event.target.closest('.select-request-link');
      if (!link) return;
      event.preventDefault();
      selectRequest(link).catch((error) => {
        console.error(error);
        showToast(error.message || 'No fue posible seleccionar la solicitud.');
      });
    });

    qs('#workerFilterForm')?.addEventListener('submit', syncDateProxy);
    qs('#clearSelectedWorkers')?.addEventListener('click', clearWorkerSelection);
    qs('#restSelectedWorkers')?.addEventListener('click', () => openRestDialog(getSelectedWorkerIds()));
    qs('#assignSelectedWorkers')?.addEventListener('click', () => {
      assignWorkers(getSelectedWorkerIds()).catch((error) => {
        console.error(error);
        showToast(error.message || 'No fue posible asignar.');
      });
    });
  }

  bindStaticBoard();
  bindDynamicBoard();
  syncDateProxy();
  syncRestDateUi();
})();