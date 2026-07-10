(() => {
  const STYLE_ID = 'dispatch-assignment-direct-ui-fixes';

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .assignment-page .template-card .template-actions {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
        align-items: center !important;
      }

      .assignment-page .template-card .template-actions [data-dispatch-duplicate-bulk-wa="true"] {
        display: none !important;
      }

      .assignment-page .assigned-card .dispatch-wa-official {
        width: 32px !important;
        height: 32px !important;
        min-width: 32px !important;
        min-height: 32px !important;
        padding: 0 !important;
        border-radius: 999px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 0 !important;
        line-height: 1 !important;
        overflow: hidden !important;
      }

      .assignment-page .assigned-card .dispatch-wa-official svg {
        width: 20px !important;
        height: 20px !important;
        display: block !important;
        flex: 0 0 20px !important;
      }

      .assignment-page .assigned-card.assignment-finalized {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 6px 8px !important;
        min-height: auto !important;
      }

      .assignment-page .assigned-card.assignment-finalized .assigned-main {
        min-width: 0 !important;
        width: 100% !important;
      }

      .assignment-page .assigned-card.assignment-finalized strong {
        font-size: 12px !important;
        line-height: 1.08 !important;
        margin: 0 0 1px 0 !important;
      }

      .assignment-page .assigned-card.assignment-finalized .meta {
        font-size: 10px !important;
        line-height: 1.08 !important;
        gap: 0 !important;
        margin: 0 !important;
      }

      .assignment-page .assigned-card.assignment-finalized .assignment-message,
      .assignment-page .assigned-card.assignment-finalized .variable-row,
      .assignment-page .assigned-card.assignment-finalized .dispatch-wa-button,
      .assignment-page .assigned-card.assignment-finalized .whatsapp-link,
      .assignment-page .assigned-card.assignment-finalized .icon-whatsapp,
      .assignment-page .assigned-card.assignment-finalized details.incident-card,
      .assignment-page .assigned-card.assignment-finalized form[data-async-assignment-action="confirmar"],
      .assignment-page .assigned-card.assignment-finalized form[data-async-assignment-action="no-confirmado"] {
        display: none !important;
      }

      .assignment-page .assigned-card.assignment-finalized .assigned-actions {
        display: flex !important;
        justify-content: flex-end !important;
        align-items: center !important;
        gap: 4px !important;
        margin: 0 !important;
        width: auto !important;
        min-width: 0 !important;
      }

      .assignment-page .assigned-card.assignment-finalized form[data-async-assignment-action="unassign"] {
        display: flex !important;
        margin: 0 !important;
        width: auto !important;
      }

      .assignment-page .assigned-card.assignment-finalized .icon-remove-btn {
        width: 28px !important;
        height: 28px !important;
        min-width: 28px !important;
        min-height: 28px !important;
        padding: 0 !important;
        font-size: 18px !important;
      }

      @media (max-width: 760px) {
        .assignment-page .assigned-card.assignment-finalized {
          grid-template-columns: minmax(0, 1fr) auto !important;
          padding: 6px 8px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function whatsappIconSvg() {
    return `
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path fill="#25D366" d="M16.01 3.2c-7.07 0-12.8 5.73-12.8 12.8 0 2.25.59 4.45 1.7 6.39L3.2 28.8l6.58-1.68a12.74 12.74 0 0 0 6.22 1.61h.01c7.06 0 12.79-5.73 12.79-12.8 0-3.43-1.34-6.65-3.76-9.08A12.7 12.7 0 0 0 16.01 3.2z"/>
        <path fill="#fff" d="M16.01 5.38c2.83 0 5.49 1.1 7.49 3.1a10.52 10.52 0 0 1 3.1 7.49c0 5.85-4.76 10.61-10.59 10.61h-.01a10.6 10.6 0 0 1-5.4-1.48l-.39-.23-3.9 1 1.04-3.8-.25-.39A10.6 10.6 0 0 1 16.01 5.38z"/>
        <path fill="#25D366" d="M19.11 17.23c-.28-.14-1.65-.81-1.91-.9-.25-.09-.44-.14-.62.14-.18.28-.71.9-.87 1.08-.16.18-.32.21-.6.07-.28-.14-1.16-.43-2.2-1.38-.81-.72-1.35-1.61-1.51-1.88-.16-.28-.02-.42.12-.56.13-.13.28-.32.42-.48.14-.16.18-.28.28-.46.09-.18.05-.35-.02-.49-.07-.14-.62-1.5-.85-2.05-.22-.53-.45-.46-.62-.46h-.53c-.18 0-.46.07-.69.32-.23.25-.9.88-.9 2.15 0 1.27.92 2.49 1.04 2.67.12.18 1.8 2.75 4.36 3.86.61.26 1.08.42 1.45.54.61.2 1.16.17 1.59.1.49-.07 1.51-.62 1.72-1.22.21-.6.21-1.11.14-1.22-.07-.11-.25-.18-.53-.32z"/>
      </svg>
    `;
  }

  function dedupeBulkWhatsappButtons() {
    const buttons = [...document.querySelectorAll('.template-card button, .template-card a')]
      .filter((element) => /enviar\s+whatsapp\s+a\s+todos/i.test((element.textContent || '').trim()));

    let firstVisibleButton = null;
    buttons.forEach((button) => {
      if (!firstVisibleButton) {
        firstVisibleButton = button;
        button.dataset.dispatchDuplicateBulkWa = 'false';
        button.hidden = false;
        return;
      }
      button.dataset.dispatchDuplicateBulkWa = 'true';
      button.hidden = true;
    });
  }

  function enhanceWhatsappButtons() {
    document.querySelectorAll('.assigned-card .icon-whatsapp, .assigned-card .whatsapp-link, .assigned-card .dispatch-wa-button').forEach((button) => {
      if (button.dataset.dispatchOfficialWaApplied === 'true') return;
      button.classList.add('dispatch-wa-official');
      button.innerHTML = whatsappIconSvg();
      button.title = button.title || 'Enviar WhatsApp';
      button.setAttribute('aria-label', button.getAttribute('aria-label') || 'Enviar WhatsApp');
      button.dataset.dispatchOfficialWaApplied = 'true';
    });
  }

  function isFinalizedAssignedCard(card) {
    const statusLine = card.querySelector('.assignment-status-line')?.textContent || '';
    const normalized = statusLine.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (normalized.includes('estado: confirmado')) return true;
    if (normalized.includes('estado: no confirmo') || normalized.includes('estado: no confirmado')) return true;
    return !card.querySelector('form[data-async-assignment-action="confirmar"]')
      && !card.querySelector('form[data-async-assignment-action="no-confirmado"]')
      && Boolean(card.querySelector('form[data-async-assignment-action="unassign"]'));
  }

  function compactFinalizedAssignedCards() {
    document.querySelectorAll('.assigned-card').forEach((card) => {
      card.classList.toggle('assignment-finalized', isFinalizedAssignedCard(card));
    });
  }

  function applyUiFixes() {
    installStyle();
    dedupeBulkWhatsappButtons();
    enhanceWhatsappButtons();
    compactFinalizedAssignedCards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyUiFixes);
  } else {
    applyUiFixes();
  }

  new MutationObserver(applyUiFixes).observe(document.documentElement, { childList: true, subtree: true });
})();
