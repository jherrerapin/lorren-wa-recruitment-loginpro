'use strict';

(() => {
  const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
  const STATE_ENDPOINT = '/admin/operaciones/portal-activaciones/service-state';

  function addStyles() {
    if (document.getElementById('attendance-portal-control-styles')) return;
    const style = document.createElement('style');
    style.id = 'attendance-portal-control-styles';
    style.textContent = `
      .attendance-portal-control { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 16px; background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow-sm); }
      .attendance-portal-control-copy { min-width:0; }
      .attendance-portal-control-copy strong { display:block; color:var(--navy); font-size:13px; }
      .attendance-portal-control-status { display:flex; align-items:center; gap:7px; margin-top:4px; color:var(--muted); font-size:11px; font-weight:800; }
      .attendance-portal-control-dot { width:9px; height:9px; border-radius:999px; background:#15803d; box-shadow:0 0 0 3px #dcfce7; }
      .attendance-portal-control[data-enabled="false"] .attendance-portal-control-dot { background:#b91c1c; box-shadow:0 0 0 3px #fee2e2; }
      .attendance-portal-control button { flex:0 0 auto; }
      .attendance-portal-control-error { margin-top:5px; color:#991b1b; font-size:10px; font-weight:800; }
      @media (max-width:620px) { .attendance-portal-control { align-items:stretch; flex-direction:column; } .attendance-portal-control button { width:100%; } }
    `;
    document.head.appendChild(style);
  }

  function renderControl(state) {
    if (document.querySelector('[data-attendance-portal-control]')) return;
    const hero = document.querySelector('.attendance-page .hero');
    if (!hero) return;

    addStyles();
    const section = document.createElement('section');
    section.className = 'attendance-portal-control';
    section.dataset.attendancePortalControl = 'true';

    const copy = document.createElement('div');
    copy.className = 'attendance-portal-control-copy';
    const title = document.createElement('strong');
    title.textContent = 'Portal del Auxiliar';
    const status = document.createElement('div');
    status.className = 'attendance-portal-control-status';
    const dot = document.createElement('span');
    dot.className = 'attendance-portal-control-dot';
    dot.setAttribute('aria-hidden', 'true');
    const statusText = document.createElement('span');
    status.append(dot, statusText);
    const error = document.createElement('div');
    error.className = 'attendance-portal-control-error';
    error.hidden = true;
    copy.append(title, status, error);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';

    function apply(enabled) {
      section.dataset.enabled = enabled ? 'true' : 'false';
      statusText.textContent = enabled ? 'Activo para auxiliares' : 'Desactivado para auxiliares';
      button.textContent = enabled ? 'Desactivar portal' : 'Activar portal';
      button.className = enabled ? 'btn btn-danger' : 'btn btn-primary';
      button.dataset.nextEnabled = enabled ? 'false' : 'true';
    }

    apply(state.enabled === true);

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      error.hidden = true;
      const nextEnabled = button.dataset.nextEnabled === 'true';
      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = nextEnabled ? 'Activando…' : 'Desactivando…';
      try {
        const response = await fetch(STATE_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'attendance-admin'
          },
          body: JSON.stringify({ enabled: nextEnabled })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) throw new Error('portal_state_update_failed');
        apply(payload.enabled === true);
      } catch {
        button.textContent = originalText;
        error.textContent = 'No fue posible cambiar el estado del portal.';
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

    section.append(copy, button);
    hero.insertAdjacentElement('afterend', section);
  }

  async function init() {
    if (window.location.pathname !== ATTENDANCE_PATH) return;
    try {
      const response = await fetch(STATE_ENDPOINT, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null);
      if (!payload || payload.ok !== true || typeof payload.enabled !== 'boolean') return;
      renderControl(payload);
    } catch {
      // El control no se muestra si no se puede comprobar autorización DEV.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
