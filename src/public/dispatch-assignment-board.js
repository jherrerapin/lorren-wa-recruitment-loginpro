(() => {
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let selectedWorkerIds = new Set();
  let restBatchHasDirect = false;
  let restBatchWorkers = [];
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

  function refreshSelectionUi() {
    qsa('.worker-card').forEach((card) => {
      const selected = selectedWorkerIds.has(card.dataset.workerId);
      card.classList.toggle('selected', selected);
      const checkbox = card.querySelector('.worker-select');
      if (checkbox) checkbox.checked = selected;
    });
    const count = qs('#selectedWorkersCount');
    if (count) count.textContent = String(selectedWorkerIds.size);
  }

  function setWorkerSelection(workerId, selected) {
    if (!workerId) return;
    if (selected) selectedWorkerIds.add(workerId);
    else selectedWorkerIds.delete(workerId);
    refreshSelectionUi();
  }

  function clearWorkerSelection() {
    selectedWorkerIds.clear();
    refreshSelectionUi();
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

  function syncRestFields() {
    const direct = restBatchHasDirect;
    const directWorkers = restBatchWorkers.filter((worker) => worker.contractType === 'DIRECTO');
    const reasonField = qs('#restReasonField');
    const reasonInput = qs('#restReasonInput');
    const rule = qs('#restContractRule');

    if (reasonField) reasonField.hidden = !direct;
    if (reasonInput) {
      reasonInput.disabled = !direct;
      reasonInput.required = direct;
      if (!direct) reasonInput.value = '';
    }
    if (rule) {
      rule.textContent = direct
        ? 'Incluye contrato Directo: selecciona el motivo del descanso.'
        : 'Solo Contratistas: el descanso requiere únicamente la fecha.';
    }

    const remunerado = direct && reasonInput?.value === 'REMUNERADO';
    const bulkRemunerado = remunerado && restBatchWorkers.length > 1;
    const field = qs('#originSundayField');
    const origin = qs('#originSundayDateInput');
    if (field) field.hidden = !remunerado || bulkRemunerado;
    if (origin) {
      origin.required = remunerado && !bulkRemunerado;
      origin.disabled = !remunerado || bulkRemunerado;
      if (!remunerado || bulkRemunerado) origin.value = '';
    }
    if (rule && bulkRemunerado) {
      rule.textContent = `${directWorkers.length} Directo${directWorkers.length !== 1 ? 's' : ''}: al continuar asignarás el domingo correspondiente a cada uno.`;
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

    const dialog = qs('#restAssignmentDialog');
    const workerInput = qs('#restWorkerId');
    const workerName = qs('#restWorkerName');
    const reasonInput = qs('#restReasonInput');
    const originInput = qs('#originSundayDateInput');
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
    if (workerName) {
      const names = restBatchWorkers.map((worker) => worker.workerName);
      workerName.textContent = names.length === 1
        ? names[0]
        : `${names.length} auxiliares: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
    }
    if (reasonInput) reasonInput.value = '';
    if (originInput) originInput.value = '';
    if (restDate) restDate.value = currentDateFilter() || todayDateInColombia();
    if (allowAssignedRestInput) allowAssignedRestInput.value = 'false';
    syncRestFields();

    const assignedWorkers = restBatchWorkers.filter((worker) => worker.sameDayAssignment);
    if (assignedWorkers.length) {
      const conflictMessage = qs('#restConflictMessage');
      const names = assignedWorkers.map((worker) => worker.workerName).join(', ');
      if (conflictMessage) {
        conflictMessage.textContent = `${names} ${assignedWorkers.length === 1 ? 'ya está asignado a una solicitud activa' : 'ya están asignados a solicitudes activas'} en la fecha mostrada. Si deseas continuar, pulsa “Dar descanso”; después podrás elegir la fecha y el motivo cuando corresponda.`;
      }
      qs('#restConflictDialog')?.showModal();
      return;
    }

    dialog?.showModal();
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
      contract.textContent = 'Contrato Directo · selecciona el domingo que generó este descanso';
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

  async function postRestWorker(worker, originSundayDate) {
    const form = qs('#restAssignmentForm');
    if (!form) throw new Error('No se encontró el formulario de descanso.');

    const payload = new URLSearchParams();
    payload.set('workerId', worker.workerId);
    payload.set('restDate', qs('#restDateValue')?.value || '');
    if (qs('#allowAssignedRestInput')?.value === 'true') payload.set('allowAssignedRest', 'true');
    const serviceRequestId = form.querySelector('input[name="serviceRequestId"]')?.value;
    if (serviceRequestId) payload.set('serviceRequestId', serviceRequestId);
    if (worker.contractType === 'DIRECTO') {
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
          await postRestWorker(worker, originSundayDate);
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

    qs('#cancelRestConflict')?.addEventListener('click', () => qs('#restConflictDialog')?.close());
    qs('#confirmAssignedRest')?.addEventListener('click', () => {
      const conflictDialog = qs('#restConflictDialog');
      if (conflictDialog?.open) conflictDialog.close();
      const allowAssignedRestInput = qs('#allowAssignedRestInput');
      if (allowAssignedRestInput) allowAssignedRestInput.value = 'true';
      qs('#restAssignmentDialog')?.showModal();
    });
    qs('#restReasonInput')?.addEventListener('change', syncRestFields);
    qs('#cancelRestDialog')?.addEventListener('click', () => qs('#restAssignmentDialog')?.close());
    qs('#cancelRestOriginBatch')?.addEventListener('click', () => {
      qs('#restOriginBatchDialog')?.close();
      qs('#restAssignmentDialog')?.showModal();
    });
    qs('#restOriginBatchForm')?.addEventListener('submit', submitRestBatchWithOrigins);
    qs('#restAssignmentForm')?.addEventListener('submit', (event) => {
      const restDateValue = qs('#restDateValue')?.value;
      const restDate = /^\d{4}-\d{2}-\d{2}$/.test(String(restDateValue || ''))
        ? new Date(`${restDateValue}T12:00:00.000Z`)
        : null;
      if (!restDate || restDate.getUTCDay() === 0) {
        event.preventDefault();
        showToast('Selecciona una fecha de descanso válida que no sea domingo.');
        return;
      }
      const remunerado = restBatchHasDirect && qs('#restReasonInput')?.value === 'REMUNERADO';
      if (remunerado && restBatchWorkers.length > 1) {
        event.preventDefault();
        renderRestOriginBatchDialog();
        return;
      }
      if (!remunerado) return;
      const origin = qs('#originSundayDateInput')?.value;
      const originDate = /^\d{4}-\d{2}-\d{2}$/.test(String(origin || ''))
        ? new Date(`${origin}T12:00:00.000Z`)
        : null;
      if (!originDate || originDate.getUTCDay() !== 0) {
        event.preventDefault();
        showToast('Selecciona un domingo válido para asociar al descanso remunerado.');
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
