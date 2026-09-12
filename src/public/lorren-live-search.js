'use strict';

(() => {
  const RUNTIME_FLAG = '__lorrenLiveSearchLoaded';
  const STYLE_ID = 'lorren-live-search-style';
  const MAX_RESULTS = 8;
  if (window[RUNTIME_FLAG]) return;
  window[RUNTIME_FLAG] = true;

  function fold(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('es-CO')
      .trim();
  }

  function digits(value) {
    return String(value || '').replace(/\D+/g, '');
  }

  function matchesQuery(value, query) {
    const normalizedQuery = fold(query);
    if (!normalizedQuery) return true;
    if (fold(value).includes(normalizedQuery)) return true;
    const queryDigits = digits(query);
    return queryDigits.length > 0 && digits(value).includes(queryDigits);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .lorren-live-search-list{position:absolute;z-index:1200;left:0;right:0;top:calc(100% + 5px);display:grid;gap:3px;max-height:320px;overflow:auto;padding:6px;border:1px solid #d7dee8;border-radius:10px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.16)}
      .lorren-live-search-list[hidden]{display:none!important}
      .lorren-live-search-option{appearance:none;width:100%;border:0;border-radius:8px;padding:9px 10px;background:#fff;color:#172033;text-align:left;font:inherit;cursor:pointer;display:grid;gap:2px}
      .lorren-live-search-option:hover,.lorren-live-search-option[aria-selected="true"]{background:#eef8f6;color:#0d5f54}
      .lorren-live-search-label{font-size:12px;font-weight:800;line-height:1.3;overflow-wrap:anywhere}
      .lorren-live-search-meta{font-size:10px;line-height:1.35;color:#64748b;overflow-wrap:anywhere}
      .lorren-live-search-empty{padding:9px 10px;color:#64748b;font-size:11px;line-height:1.35}
      .lorren-live-search-loading{padding:9px 10px;color:#475569;font-size:11px;line-height:1.35}
      @media(max-width:700px){.lorren-live-search-list{max-height:260px}.lorren-live-search-option{min-height:44px}}
    `;
    document.head.appendChild(style);
  }

  function ensureHost(input) {
    const host = input?.parentElement;
    if (!host) return null;
    const position = window.getComputedStyle?.(host)?.position;
    if (!position || position === 'static') host.style.position = 'relative';
    return host;
  }

  function buildFormUrl(form) {
    const url = new URL(form.getAttribute('action') || window.location.href, window.location.href);
    url.hash = '';
    url.search = '';
    const data = new FormData(form);
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string') url.searchParams.append(key, value);
    }
    return url;
  }

  async function fetchDocument(url, signal) {
    const response = await fetch(url.pathname + url.search, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      signal
    });
    if (!response.ok) throw new Error(`live_search_http_${response.status}`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function fetchFormDocument(form, signal) {
    return fetchDocument(buildFormUrl(form), signal);
  }

  function uniqueResults(items) {
    const seen = new Set();
    const results = [];
    for (const item of items || []) {
      const key = String(item?.key || item?.href || item?.value || `${item?.label || ''}|${item?.meta || ''}`).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
      if (results.length >= MAX_RESULTS) break;
    }
    return results;
  }

  function attachTypeahead(input, options) {
    if (!input || input.dataset.lorrenLiveSearch === 'true') return null;
    const host = ensureHost(input);
    if (!host) return null;
    input.dataset.lorrenLiveSearch = 'true';

    const list = document.createElement('div');
    const listId = `lorren-live-search-${Math.random().toString(36).slice(2, 10)}`;
    list.id = listId;
    list.className = 'lorren-live-search-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.appendChild(list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');

    let results = [];
    let activeIndex = -1;
    let debounceId = null;
    let blurId = null;
    let requestId = 0;
    let controller = null;

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    };

    const setActive = (index) => {
      if (!results.length) return;
      const bounded = (index + results.length) % results.length;
      activeIndex = bounded;
      [...list.querySelectorAll('[role="option"]')].forEach((option, optionIndex) => {
        const selected = optionIndex === activeIndex;
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) {
          input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView?.({ block: 'nearest' });
        }
      });
    };

    const select = (index) => {
      const item = results[index];
      if (!item) return;
      if (typeof options.onSelect === 'function') options.onSelect(item, input);
      else if (item.value != null) input.value = String(item.value);
      close();
    };

    const renderMessage = (message, className) => {
      results = [];
      activeIndex = -1;
      list.replaceChildren();
      const status = document.createElement('div');
      status.className = className;
      status.textContent = message;
      list.appendChild(status);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    const render = (items) => {
      results = uniqueResults(items);
      activeIndex = -1;
      list.replaceChildren();
      if (!results.length) {
        renderMessage(options.emptyMessage || 'No hay coincidencias.', 'lorren-live-search-empty');
        return;
      }

      results.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `${listId}-option-${index}`;
        button.className = 'lorren-live-search-option';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.tabIndex = -1;

        const label = document.createElement('span');
        label.className = 'lorren-live-search-label';
        label.textContent = String(item.label || item.value || 'Resultado');
        button.appendChild(label);
        if (item.meta) {
          const meta = document.createElement('span');
          meta.className = 'lorren-live-search-meta';
          meta.textContent = String(item.meta);
          button.appendChild(meta);
        }

        button.addEventListener('pointerdown', (event) => event.preventDefault());
        button.addEventListener('mouseenter', () => setActive(index));
        button.addEventListener('click', () => select(index));
        list.appendChild(button);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    const search = async () => {
      const query = input.value.trim();
      const minChars = Number.isInteger(options.minChars) ? options.minChars : 2;
      requestId += 1;
      const ownRequestId = requestId;
      controller?.abort();
      controller = null;
      if (query.length < minChars) {
        close();
        return;
      }

      controller = new AbortController();
      if (options.loadingMessage) renderMessage(options.loadingMessage, 'lorren-live-search-loading');
      try {
        const items = await options.source(query, { signal: controller.signal, input });
        if (ownRequestId !== requestId) return;
        render(items);
      } catch (error) {
        if (error?.name === 'AbortError' || ownRequestId !== requestId) return;
        close();
      }
    };

    const scheduleSearch = () => {
      window.clearTimeout(debounceId);
      const delay = Number.isInteger(options.debounceMs) ? options.debounceMs : 260;
      debounceId = window.setTimeout(search, delay);
    };

    input.addEventListener('input', scheduleSearch);
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= (Number.isInteger(options.minChars) ? options.minChars : 2)) scheduleSearch();
    });
    input.addEventListener('blur', () => {
      window.clearTimeout(blurId);
      blurId = window.setTimeout(close, 120);
    });
    input.addEventListener('keydown', (event) => {
      if (list.hidden || !results.length) {
        if (event.key === 'Escape') close();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(activeIndex <= 0 ? results.length - 1 : activeIndex - 1);
      } else if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        event.stopPropagation();
        select(activeIndex);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    return { search, close };
  }

  function candidateRowResult(container) {
    const link = container.querySelector('a.link-detail, a[href*="/candidate"], a[href*="/candidates/"]');
    const href = link?.getAttribute('href') || '';
    const cells = container.tagName === 'TR' ? [...container.children] : [];
    const name = container.querySelector('.candidate-name')?.textContent?.trim()
      || container.querySelector('.vacancy-title')?.textContent?.trim()
      || cells[1]?.querySelector('div,strong')?.textContent?.trim()
      || cells[1]?.textContent?.trim()
      || container.querySelector('strong')?.textContent?.trim()
      || 'Candidato';
    const documentText = container.querySelector('.candidate-doc')?.textContent?.trim()
      || cells[3]?.textContent?.trim()
      || '';
    const phoneText = container.querySelector('.candidate-phone')?.textContent?.trim()
      || cells[2]?.textContent?.trim()
      || '';
    const meta = [documentText, phoneText].filter(Boolean).join(' · ');
    return href ? {
      key: href,
      href,
      label: name,
      meta,
      documentText,
      documentDigits: digits(documentText)
    } : null;
  }

  function installLegacyRecruitmentSearch() {
    const input = document.querySelector('form input[name="searchText"]');
    const form = input?.form;
    if (!input || !form) return;
    attachTypeahead(input, {
      minChars: 2,
      debounceMs: 280,
      loadingMessage: 'Buscando candidatos…',
      async source(_query, { signal }) {
        const nextDocument = await fetchFormDocument(form, signal);
        return [...nextDocument.querySelectorAll('tbody tr')]
          .filter((row) => row.querySelector('a.link-detail, a[href*="/candidate"], a[href*="/candidates/"]'))
          .map(candidateRowResult)
          .filter(Boolean);
      },
      onSelect(item) {
        if (item.href) window.location.assign(item.href);
      }
    });
  }

  function vacancyPanelResults(panel) {
    if (!panel) return [];
    return uniqueResults([
      ...panel.querySelectorAll('.candidate-row'),
      ...panel.querySelectorAll('.bookings-table tbody tr')
    ].map(candidateRowResult).filter(Boolean));
  }

  function clearRetiredVacancyFilterParams() {
    const current = new URL(window.location.href);
    let changed = false;
    for (const key of [...current.searchParams.keys()]) {
      if (!key.startsWith('vf_')) continue;
      current.searchParams.delete(key);
      changed = true;
    }
    if (!changed) return false;
    window.location.replace(`${current.pathname}${current.search}${current.hash}`);
    return true;
  }

  function stripRetiredVacancyFilterInputs(root) {
    root?.querySelectorAll?.('input[name^="vf_"], select[name^="vf_"]').forEach((control) => control.remove());
  }

  function retireVacancyOperationalFilters(panel, searchForm) {
    if (!panel) return;
    stripRetiredVacancyFilterInputs(panel);
    panel.querySelectorAll('form.vacancy-filter-bar').forEach((form) => {
      const isSearchForm = form === searchForm
        || Boolean(form.querySelector('input[name^="vs_"][name$="_text"]'));
      if (!isSearchForm) form.remove();
    });
  }

  function setVacancySearchOptions(fieldSelect, vacancyId) {
    if (!fieldSelect) return;
    const page = new URL(window.location.href);
    const requested = String(page.searchParams.get(`vs_${vacancyId}_field`) || '').trim();
    const selectedField = requested === 'document' ? 'document' : 'name';

    const nameOption = document.createElement('option');
    nameOption.value = 'name';
    nameOption.textContent = 'Nombre';
    const documentOption = document.createElement('option');
    documentOption.value = 'document';
    documentOption.textContent = 'Documento';
    fieldSelect.replaceChildren(nameOption, documentOption);
    fieldSelect.value = selectedField;
  }

  function vacancyCandidateLookupUrl(vacancyId) {
    const current = new URL(window.location.href);
    const url = new URL('/admin', window.location.origin);
    url.searchParams.set('status', 'all');
    url.searchParams.set('vacancyId', vacancyId);
    const dateFrom = current.searchParams.get('dateFrom');
    const dateTo = current.searchParams.get('dateTo');
    if (dateFrom) url.searchParams.set('dateFrom', dateFrom);
    if (dateTo) url.searchParams.set('dateTo', dateTo);
    return url;
  }

  function filterVacancyCandidateResults(items, query, field) {
    if (field === 'document') {
      const queryDigits = digits(query);
      if (!queryDigits) return [];
      return items.filter((item) => item.documentDigits && item.documentDigits.includes(queryDigits));
    }
    const normalizedQuery = fold(query);
    if (!normalizedQuery) return [];
    return items.filter((item) => fold(item.label).includes(normalizedQuery));
  }

  function vacancyLegacyResults(nextDocument) {
    const table = nextDocument.querySelector('#legacy-candidates-table');
    if (!table) return [];
    return uniqueResults(
      [...table.querySelectorAll('tbody tr')]
        .map(candidateRowResult)
        .filter(Boolean)
    );
  }

  function installVacancyRecruitmentSearches() {
    document.querySelectorAll('input[name^="vs_"][name$="_text"]').forEach((input) => {
      const form = input.form;
      if (!form) return;
      const vacancyPanel = input.closest('[data-vacancy-panel]');
      const vacancyId = vacancyPanel?.getAttribute('data-vacancy-panel');
      if (!vacancyId) return;

      retireVacancyOperationalFilters(vacancyPanel, form);
      const fieldSelect = form.querySelector('select[name^="vs_"][name$="_field"]');
      setVacancySearchOptions(fieldSelect, vacancyId);

      const inputLabel = input.closest('.filter-field')?.querySelector('label');
      if (inputLabel) inputLabel.textContent = 'Nombre o documento';
      input.placeholder = 'Escribe nombre o documento';

      const liveSearch = attachTypeahead(input, {
        minChars: 2,
        debounceMs: 300,
        loadingMessage: 'Buscando coincidencias…',
        async source(query, { signal }) {
          const nextDocument = await fetchDocument(vacancyCandidateLookupUrl(vacancyId), signal);
          const candidates = vacancyLegacyResults(nextDocument);
          const field = fieldSelect?.value === 'document' ? 'document' : 'name';
          return filterVacancyCandidateResults(candidates, query, field);
        },
        onSelect(item) {
          if (item.href) window.location.assign(item.href);
        }
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        liveSearch?.search();
        input.focus();
      });
    });
  }

  function workerCardResult(card) {
    const workerId = String(card?.dataset?.workerId || '').trim();
    if (!workerId) return null;
    const name = card.querySelector('.worker-heading strong')?.textContent?.trim()
      || card.querySelector('strong')?.textContent?.trim()
      || 'Auxiliar';
    const meta = card.querySelector('.meta')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
    return { key: workerId, workerId, label: name, meta };
  }

  function installAssignmentWorkerSearch() {
    const form = document.getElementById('workerFilterForm');
    const input = form?.querySelector('input[name="q"]');
    if (!form || !input) return;
    attachTypeahead(input, {
      minChars: 2,
      debounceMs: 280,
      loadingMessage: 'Buscando auxiliares…',
      async source(_query, { signal }) {
        const nextDocument = await fetchFormDocument(form, signal);
        return [...nextDocument.querySelectorAll('.worker-card[data-worker-id]')]
          .map(workerCardResult)
          .filter(Boolean);
      },
      onSelect(item) {
        const card = document.querySelector(`.worker-card[data-worker-id="${CSS.escape(item.workerId)}"]`);
        if (card) {
          const checkbox = card.querySelector('.worker-select');
          if (checkbox && !checkbox.checked) checkbox.click();
          card.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          input.value = item.label;
          return;
        }
        input.value = item.label;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
    });
  }

  function payrollRowResult(row) {
    const firstCell = row.querySelector('td');
    const name = firstCell?.querySelector('strong')?.textContent?.trim() || '';
    const documentText = firstCell?.querySelector('small')?.textContent?.trim() || '';
    if (!name) return null;
    const documentValue = digits(documentText);
    return {
      key: documentValue || name,
      label: name,
      meta: documentText,
      value: documentValue || name
    };
  }

  function installPayrollSearch() {
    const form = document.getElementById('payroll-filters');
    const input = form?.querySelector('input[name="search"]');
    if (!form || !input) return;
    attachTypeahead(input, {
      minChars: 3,
      debounceMs: 400,
      loadingMessage: 'Buscando auxiliares…',
      async source(_query, { signal }) {
        const nextDocument = await fetchFormDocument(form, signal);
        const rows = nextDocument.querySelectorAll('.payroll-results-panel tbody tr');
        return [...rows].map(payrollRowResult).filter(Boolean);
      },
      onSelect(item) {
        input.value = String(item.value || item.label || '');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
    });
  }

  function whatsappLocalResults(query) {
    const results = [];
    document.querySelectorAll('#monitorRows tr[data-assignment-id]').forEach((row) => {
      const name = row.children[0]?.textContent?.trim() || 'Auxiliar';
      const phone = digits(row.children[1]?.textContent || '');
      const haystack = `${name} ${phone}`;
      if (!phone || !matchesQuery(haystack, query)) return;
      results.push({ key: phone, value: phone, label: name, meta: phone });
    });
    document.querySelectorAll('[data-conversation-phone]').forEach((button) => {
      const phone = digits(button.dataset.conversationPhone || '');
      const text = button.textContent?.replace(/\s+/g, ' ')?.trim() || phone;
      if (!phone || !matchesQuery(`${text} ${phone}`, query)) return;
      results.push({ key: phone, value: phone, label: text.split('·')[0]?.trim() || phone, meta: phone });
    });
    return uniqueResults(results);
  }

  function installWhatsappPhoneSearch() {
    const form = document.getElementById('phoneSearchForm');
    const input = document.getElementById('phoneSearchInput');
    if (!form || !input) return;
    attachTypeahead(input, {
      minChars: 2,
      debounceMs: 180,
      async source(query, { signal }) {
        const local = whatsappLocalResults(query);
        const queryDigits = digits(query);
        if (local.length || queryDigits.length < 7) return local;
        const url = new URL('/admin/operaciones/whatsapp/monitor/datos', window.location.origin);
        url.searchParams.set('phone', queryDigits);
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal
        });
        if (!response.ok) return local;
        const data = await response.json();
        const lookup = data?.phoneLookup;
        if (!lookup?.phone) return local;
        const phone = digits(lookup.phone);
        const names = Array.isArray(lookup.workerNames) ? lookup.workerNames.filter(Boolean) : [];
        return [{
          key: phone || lookup.phone,
          value: phone || lookup.phone,
          label: names.join(' / ') || lookup.phone,
          meta: lookup.phone
        }];
      },
      onSelect(item) {
        input.value = String(item.value || '');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
  }

  function installAddressAutoSearch() {
    document.querySelectorAll('.attendance-address-search').forEach((input) => {
      if (input.dataset.lorrenAddressLiveSearch === 'true') return;
      input.dataset.lorrenAddressLiveSearch = 'true';
      let timer = null;
      let lastRequested = '';
      const triggerLatest = () => {
        const query = input.value.trim();
        if (query.length < 3 || query === lastRequested) return;
        const button = input.closest('.attendance-map-form')?.querySelector('.attendance-search-button');
        if (!button) return;
        if (button.disabled) {
          timer = window.setTimeout(triggerLatest, 180);
          return;
        }
        lastRequested = query;
        button.click();
      };
      input.addEventListener('input', () => {
        lastRequested = '';
        window.clearTimeout(timer);
        if (input.value.trim().length < 3) return;
        timer = window.setTimeout(triggerLatest, 420);
      });
    });
  }

  function install() {
    injectStyles();
    if (window.location.pathname === '/admin' && clearRetiredVacancyFilterParams()) return;
    installLegacyRecruitmentSearch();
    installVacancyRecruitmentSearches();
    installAssignmentWorkerSearch();
    installPayrollSearch();
    installWhatsappPhoneSearch();
    installAddressAutoSearch();
  }

  install();
})();
