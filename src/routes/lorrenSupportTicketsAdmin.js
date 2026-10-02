import express from 'express';
import {
  LORREN_SUPPORT_PRIORITIES,
  LORREN_SUPPORT_STATUSES,
  createLorrenSupportTicket,
  loadLorrenSupportAuthorizedPhones,
  loadLorrenSupportConfig,
  loadLorrenSupportTicket,
  loadLorrenSupportTickets,
  saveLorrenSupportConfig,
  updateLorrenSupportTicket
} from '../services/lorrenSupportTickets.js';
import { dispatchLorrenSupportDevelopment } from '../services/lorrenSupportDevelopmentDispatch.js';
import { normalizeDispatchWhatsappPhone } from '../services/dispatchWhatsappCloudConfig.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function role(req) { return String(req.session?.userRole || req.userRole || '').toLowerCase(); }
function operationalRole(req) { return String(req.session?.operationalRole || req.operationalRole || '').toUpperCase(); }
function isDev(req) { return role(req) === 'dev'; }
function isSupervisor(req) { return role(req) === 'admin' && operationalRole(req) === 'SUPERVISOR'; }
function requireAccess(req, res, next) {
  if (!isDev(req) && !isSupervisor(req)) return res.status(403).send('No tienes acceso a tickets internos.');
  return next();
}
function requireDev(req, res, next) {
  if (!isDev(req)) return res.status(403).send('Esta acción solo está disponible para DEV.');
  return next();
}
function actor(req, source = 'lorren-support-admin') {
  return {
    actorUserId: req.session?.userId || req.userId || null,
    actorUsername: req.session?.username || req.username || null,
    actorRole: req.session?.userRole || req.userRole || null,
    actorSource: source,
    ipAddress: req.ip || null,
    userAgent: req.get?.('user-agent') || null
  };
}
function array(value) { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
function normalizeString(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function statusLabel(value) {
  return ({
    RECIBIDO: 'Recibido',
    EN_REVISION: 'En revisión',
    APROBADO: 'Aprobado para desarrollo',
    EN_PROCESO: 'En proceso',
    EN_VALIDACION: 'En validación',
    REALIZADO: 'Realizado',
    RECHAZADO: 'Rechazado',
    CANCELADO: 'Cancelado'
  }[value] || value || 'Sin estado');
}
function priorityLabel(value) { return ({ BAJA: 'Baja', NORMAL: 'Normal', ALTA: 'Alta', URGENTE: 'Urgente' }[value] || value || 'Normal'); }
function dateTime(value) {
  const date = new Date(value || Number.NaN);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}

async function supervisorIdentity(prisma, req) {
  const userId = req.session?.userId || req.userId || null;
  if (!userId || !prisma?.appUser?.findUnique) return { userId, phones: [] };
  const user = await prisma.appUser.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, recoveryPhone: true, dispatchAlertPhone: true }
  });
  const phones = [user?.dispatchAlertPhone, user?.recoveryPhone]
    .map((value) => normalizeDispatchWhatsappPhone(value))
    .filter(Boolean);
  return { userId, username: user?.username || null, displayName: user?.displayName || null, phones: [...new Set(phones)] };
}

function ticketVisibleToSupervisor(ticket, identity) {
  if (!ticket || !identity) return false;
  if (ticket.createdByUserId && ticket.createdByUserId === identity.userId) return true;
  return Boolean(ticket.createdByPhone && identity.phones.includes(ticket.createdByPhone));
}

function renderTicketCard(ticket, devView) {
  const i = ticket.interpretation || {};
  const developmentButton = ticket.status === 'EN_PROCESO'
    ? '<button class="btn btn-primary" type="button" disabled>Desarrollo iniciado</button>'
    : `<form method="post" action="/admin/lorren-tickets/${encodeURIComponent(ticket.id)}/approve-development"><button class="btn btn-primary" type="submit">Aprobar para desarrollo</button></form>`;
  const controls = devView ? `<form method="post" action="/admin/lorren-tickets/${encodeURIComponent(ticket.id)}/update" class="ticket-controls">
    <label>Estado<select name="status">${LORREN_SUPPORT_STATUSES.map((item) => `<option value="${item}" ${ticket.status === item ? 'selected' : ''}>${escapeHtml(statusLabel(item))}</option>`).join('')}</select></label>
    <label>Prioridad<select name="priority">${LORREN_SUPPORT_PRIORITIES.map((item) => `<option value="${item}" ${ticket.priority === item ? 'selected' : ''}>${escapeHtml(priorityLabel(item))}</option>`).join('')}</select></label>
    <button class="btn" type="submit">Guardar estado</button>
  </form>
  ${developmentButton}` : '';
  return `<article class="ticket-card" data-ticket-id="${escapeHtml(ticket.id)}">
    <div class="ticket-head"><div><span class="code">${escapeHtml(ticket.publicCode)}</span><h2>${escapeHtml(i.title || ticket.originalText?.slice(0, 120) || 'Ticket')}</h2></div><div class="badges"><span>${escapeHtml(statusLabel(ticket.status))}</span><span>${escapeHtml(priorityLabel(ticket.priority))}</span></div></div>
    <div class="meta">${escapeHtml(ticket.source || '—')} · ${escapeHtml(ticket.createdByName || ticket.createdByUsername || ticket.createdByPhone || 'Sin autor')} · ${escapeHtml(dateTime(ticket.createdAt))}</div>
    <div class="grid"><section><h3>Interpretación IA</h3><p><strong>Módulo:</strong> ${escapeHtml(i.module || 'OTRO')} · <strong>Tipo:</strong> ${escapeHtml(i.type || 'SOLICITUD')} · <strong>Confianza:</strong> ${escapeHtml(i.confidence || 'BAJA')}</p><p>${escapeHtml(i.summary || '')}</p>${i.currentBehavior ? `<p><strong>Actual:</strong> ${escapeHtml(i.currentBehavior)}</p>` : ''}${i.expectedBehavior ? `<p><strong>Esperado:</strong> ${escapeHtml(i.expectedBehavior)}</p>` : ''}${i.suggestedScope ? `<p><strong>Alcance sugerido:</strong> ${escapeHtml(i.suggestedScope)}</p>` : ''}<small>IA: ${escapeHtml(i.aiStatus || '—')}</small></section><section><h3>Mensaje original</h3><pre>${escapeHtml(ticket.originalText || '')}</pre></section></div>${controls}
  </article>`;
}

function renderPage({ devView, tickets, config, authorizedPhones, message, error }) {
  const configRows = config.authorizedPhones.length ? config.authorizedPhones : [{ name: '', phone: '', active: true }];
  const phoneRows = configRows.map((item, index) => `<div class="phone-row"><input name="phoneName" value="${escapeHtml(item.name || '')}" placeholder="Nombre"><input name="phoneNumber" value="${escapeHtml(item.phone || '')}" placeholder="3001234567"><label><input type="checkbox" name="phoneActive" value="${index}" ${item.active !== false ? 'checked' : ''}> Activo</label><button type="button" class="remove-phone">Quitar</button></div>`).join('');
  const devConfig = devView ? `<section class="card"><h2>Números autorizados para crear tickets</h2><p>El Supervisor configurado en Facturación Lórren entra automáticamente. Aquí puedes agregar otros números. La línea permanece silenciosa: registrar un ticket nunca genera respuesta por WhatsApp.</p><div class="authorized"><strong>Autorizados efectivos:</strong> ${authorizedPhones.length ? authorizedPhones.map((item) => `${escapeHtml(item.name)} (${escapeHtml(item.phone)})`).join(' · ') : 'Ninguno'}</div><form method="post" action="/admin/lorren-tickets/config" id="phonesForm"><div id="phoneRows">${phoneRows}</div><button class="btn" type="button" id="addPhone">+ Agregar número</button><button class="btn btn-primary" type="submit">Guardar autorizaciones</button></form></section>
  <section class="card"><h2>Crear ticket manual DEV</h2><form method="post" action="/admin/lorren-tickets/create"><textarea name="originalText" rows="4" required placeholder="Describe el cambio o problema de forma natural..."></textarea><button class="btn btn-primary" type="submit">Crear ticket</button></form></section>` : '';
  const ticketHtml = tickets.length ? tickets.map((ticket) => renderTicketCard(ticket, devView)).join('') : '<section class="card"><p>No hay tickets para mostrar.</p></section>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tickets Lórren</title><link rel="stylesheet" href="/public/operaciones-ui.css"><style>body{background:#f5f7fa}.page{max-width:1180px;margin:auto;padding:24px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:center}.card,.ticket-card{background:white;border:1px solid #dfe6ec;border-radius:16px;padding:18px;margin-top:16px}.ticket-head{display:flex;justify-content:space-between;gap:14px}.ticket-head h2{margin:4px 0}.code{font-size:12px;color:#64748b}.badges{display:flex;gap:6px;flex-wrap:wrap;align-content:flex-start}.badges span{background:#eef2ff;border-radius:999px;padding:5px 8px;font-size:11px}.meta{color:#64748b;font-size:12px;margin:6px 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid section{border:1px solid #eef2f7;border-radius:12px;padding:12px}.grid pre{white-space:pre-wrap;font-family:inherit;margin:0}.ticket-controls,.phone-row{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:12px}.ticket-controls label{display:grid;gap:4px}.ticket-controls select,.phone-row input,textarea{padding:10px;border:1px solid #cbd5e1;border-radius:9px}.phone-row input{min-width:220px}.remove-phone{border:0;background:#fee2e2;color:#991b1b;padding:9px;border-radius:8px}.authorized{margin:10px 0;padding:10px;background:#f8fafc;border-radius:8px}.notice{padding:12px;border-radius:10px;margin-top:12px}.ok{background:#ecfdf5;color:#166534}.bad{background:#fef2f2;color:#991b1b}textarea{width:100%;box-sizing:border-box;margin-bottom:10px}@media(max-width:760px){.hero,.ticket-head{flex-direction:column;align-items:flex-start}.grid{grid-template-columns:1fr}.phone-row{display:grid}.phone-row input{min-width:0;width:100%}}</style></head><body><main class="page"><section class="hero"><div><div class="eyebrow">${devView ? 'DEV' : 'SUPERVISOR'} · Lórren</div><h1>Tickets internos</h1><p>${devView ? 'Recepción, interpretación y gestión de solicitudes internas.' : 'Seguimiento de los tickets que has generado.'}</p></div><a class="btn" href="/admin">Volver al panel</a></section>${message ? `<div class="notice ok">${escapeHtml(message)}</div>` : ''}${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}${devConfig}${ticketHtml}</main>${devView ? `<script>var rows=document.getElementById('phoneRows');function reindex(){rows.querySelectorAll('.phone-row').forEach(function(row,index){var cb=row.querySelector('[name="phoneActive"]');if(cb)cb.value=String(index);});}function bind(){rows.querySelectorAll('.remove-phone').forEach(function(btn){btn.onclick=function(){if(rows.querySelectorAll('.phone-row').length>1){btn.closest('.phone-row').remove();reindex();}};});}bind();reindex();document.getElementById('addPhone').onclick=function(){var i=rows.querySelectorAll('.phone-row').length;rows.insertAdjacentHTML('beforeend','<div class="phone-row"><input name="phoneName" placeholder="Nombre"><input name="phoneNumber" placeholder="3001234567"><label><input type="checkbox" name="phoneActive" value="'+i+'" checked> Activo</label><button type="button" class="remove-phone">Quitar</button></div>');bind();reindex();};document.getElementById('phonesForm').addEventListener('submit',reindex);</script>` : ''}</body></html>`;
}

export function lorrenSupportTicketsAdminRouter(prisma) {
  const router = express.Router();
  const form = express.urlencoded({ extended: true, limit: '64kb' });
  router.use(requireAccess);

  router.get('/', async (req, res) => {
    const [allTickets, config, authorizedPhones] = await Promise.all([
      loadLorrenSupportTickets(prisma),
      loadLorrenSupportConfig(prisma),
      loadLorrenSupportAuthorizedPhones(prisma)
    ]);
    let tickets = allTickets;
    if (!isDev(req)) {
      const identity = await supervisorIdentity(prisma, req);
      tickets = allTickets.filter((ticket) => ticketVisibleToSupervisor(ticket, identity));
    }
    res.send(renderPage({ devView: isDev(req), tickets, config, authorizedPhones, message: req.query.message, error: req.query.error }));
  });

  router.post('/config', requireDev, form, async (req, res) => {
    const names = array(req.body.phoneName);
    const phones = array(req.body.phoneNumber);
    const activeIndexes = new Set(array(req.body.phoneActive).map(String));
    const authorizedPhones = phones.map((phone, index) => ({ name: normalizeString(names[index]), phone: normalizeString(phone), active: activeIndexes.has(String(index)) }));
    try {
      await saveLorrenSupportConfig(prisma, { authorizedPhones, ...actor(req) });
      return res.redirect('/admin/lorren-tickets?message=' + encodeURIComponent('Números autorizados actualizados.'));
    } catch (error) {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(error?.message || 'No fue posible guardar.'));
    }
  });

  router.post('/create', requireDev, form, async (req, res) => {
    try {
      await createLorrenSupportTicket(prisma, {
        source: 'DEV_PANEL',
        originalText: req.body.originalText,
        createdByUserId: req.session?.userId || req.userId || null,
        createdByUsername: req.session?.username || req.username || null,
        actorRole: req.session?.userRole || req.userRole || null,
        actor: actor(req)
      });
      return res.redirect('/admin/lorren-tickets?message=' + encodeURIComponent('Ticket creado.'));
    } catch (error) {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(error?.message || 'No fue posible crear el ticket.'));
    }
  });

  router.post('/:ticketId/update', requireDev, form, async (req, res) => {
    try {
      await updateLorrenSupportTicket(prisma, req.params.ticketId, { status: req.body.status, priority: req.body.priority }, actor(req));
      return res.redirect('/admin/lorren-tickets?message=' + encodeURIComponent('Ticket actualizado.'));
    } catch (error) {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(error?.message || 'No fue posible actualizar el ticket.'));
    }
  });

  router.post('/:ticketId/approve-development', requireDev, form, async (req, res) => {
    const approvalActor = actor(req, 'lorren-support-dev-approval');
    try {
      let ticket = await loadLorrenSupportTicket(prisma, req.params.ticketId);
      if (!ticket) throw new Error('lorren_support_ticket_not_found');
      if (!ticket.developmentRequestedAt) {
        ticket = await updateLorrenSupportTicket(prisma, req.params.ticketId, { requestDevelopment: true }, approvalActor);
      }

      const dispatch = await dispatchLorrenSupportDevelopment(prisma, ticket, {
        actor: actor(req, 'lorren-support-development-dispatch')
      });
      if (!dispatch.ok) {
        const pending = dispatch.reason === 'not_configured'
          ? `Ticket aprobado. Desarrollo automático pendiente de configurar: ${dispatch.missing.join(', ')}.`
          : 'Ticket aprobado, pero no fue posible iniciar el desarrollo automático.';
        return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(pending));
      }

      if (ticket.status !== 'EN_PROCESO') {
        await updateLorrenSupportTicket(prisma, req.params.ticketId, { status: 'EN_PROCESO' }, actor(req, 'lorren-support-development-started'));
      }
      const message = dispatch.duplicate
        ? 'El desarrollo de este ticket ya estaba iniciado. No se lanzó una ejecución duplicada.'
        : 'Desarrollo automático iniciado en una rama aislada. Se generará un PR draft; no habrá merge ni deploy automático.';
      return res.redirect('/admin/lorren-tickets?message=' + encodeURIComponent(message));
    } catch (error) {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(error?.message || 'No fue posible aprobar el ticket.'));
    }
  });

  return router;
}
