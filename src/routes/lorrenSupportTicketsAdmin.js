import express from 'express';
import {
  LORREN_SUPPORT_PRIORITIES,
  LORREN_SUPPORT_STATUSES,
  createLorrenSupportTicket,
  deleteLorrenSupportTicket,
  loadLorrenSupportAuthorizedPhones,
  loadLorrenSupportConfig,
  loadLorrenSupportTicket,
  loadLorrenSupportTickets,
  saveLorrenSupportConfig,
  updateLorrenSupportTicket
} from '../services/lorrenSupportTickets.js';
import { dispatchLorrenSupportDevelopment } from '../services/lorrenSupportDevelopmentDispatch.js';
import {
  loadLorrenAiUsageSummary,
  recordLorrenTicketDevelopmentUsage
} from '../services/lorrenAiUsageCounter.js';
import { normalizeDispatchWhatsappPhone } from '../services/dispatchWhatsappCloudConfig.js';
import { hasOperationalCapability, OPERATIONAL_CAPABILITY } from '../services/operationalAccess.js';
import { buildAdminModuleNavbar } from '../services/adminNavigation.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function role(req) { return String(req.session?.userRole || req.userRole || '').toLowerCase(); }
function isDev(req) { return role(req) === 'dev'; }
function canAccessTickets(req) { return hasOperationalCapability(req, OPERATIONAL_CAPABILITY.SUPPORT_TICKETS_ACCESS); }
function requireAccess(req, res, next) {
  if (!canAccessTickets(req)) return res.status(403).send('No tienes acceso a tickets internos.');
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
function statusClass(value) {
  return ({
    RECIBIDO: 'status-received',
    EN_REVISION: 'status-review',
    APROBADO: 'status-approved',
    EN_PROCESO: 'status-progress',
    EN_VALIDACION: 'status-validation',
    REALIZADO: 'status-done',
    RECHAZADO: 'status-rejected',
    CANCELADO: 'status-cancelled'
  }[value] || 'status-neutral');
}
function dateTime(value) {
  const date = new Date(value || Number.NaN);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}
function tokenNumber(value) {
  return new Intl.NumberFormat('es-CO').format(Math.max(0, Number(value || 0)));
}

async function ticketUserIdentity(prisma, req) {
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

function ticketVisibleToUser(ticket, identity) {
  if (!ticket || !identity) return false;
  if (ticket.createdByUserId && ticket.createdByUserId === identity.userId) return true;
  return Boolean(ticket.createdByPhone && identity.phones.includes(ticket.createdByPhone));
}

function renderTicketCard(ticket, devView) {
  const i = ticket.interpretation || {};
  const developmentButton = ticket.status === 'EN_PROCESO'
    ? '<button class="btn btn-primary" type="button" disabled>Desarrollo iniciado</button>'
    : `<form method="post" action="/admin/lorren-tickets/${encodeURIComponent(ticket.id)}/approve-development"><button class="btn btn-primary" type="submit">Aprobar para desarrollo</button></form>`;
  const deleteControl = `<form method="post" action="/admin/lorren-tickets/${encodeURIComponent(ticket.id)}/delete" class="ticket-delete">
    <label><input type="checkbox" name="confirmDelete" value="1" required> Confirmo que quiero eliminar este ticket</label>
    <button class="btn btn-danger" type="submit">Eliminar ticket</button>
  </form>`;
  const controls = devView ? `<form method="post" action="/admin/lorren-tickets/${encodeURIComponent(ticket.id)}/update" class="ticket-controls">
    <label>Estado<select name="status">${LORREN_SUPPORT_STATUSES.map((item) => `<option value="${item}" ${ticket.status === item ? 'selected' : ''}>${escapeHtml(statusLabel(item))}</option>`).join('')}</select></label>
    <label>Prioridad<select name="priority">${LORREN_SUPPORT_PRIORITIES.map((item) => `<option value="${item}" ${ticket.priority === item ? 'selected' : ''}>${escapeHtml(priorityLabel(item))}</option>`).join('')}</select></label>
    <button class="btn" type="submit">Guardar estado</button>
  </form>
  ${developmentButton}
  ${deleteControl}` : '';
  return `<article class="ticket-card ${statusClass(ticket.status)}" data-ticket-id="${escapeHtml(ticket.id)}" data-ticket-status="${escapeHtml(ticket.status || '')}">
    <div class="ticket-head"><div><span class="code">${escapeHtml(ticket.publicCode)}</span><h2>${escapeHtml(i.title || ticket.originalText?.slice(0, 120) || 'Ticket')}</h2></div><div class="badges"><span>${escapeHtml(statusLabel(ticket.status))}</span><span>${escapeHtml(priorityLabel(ticket.priority))}</span></div></div>
    <div class="meta">${escapeHtml(ticket.source || '—')} · ${escapeHtml(ticket.createdByName || ticket.createdByUsername || ticket.createdByPhone || 'Sin autor')} · ${escapeHtml(dateTime(ticket.createdAt))}</div>
    <div class="grid"><section><h3>Interpretación IA</h3><p><strong>Módulo:</strong> ${escapeHtml(i.module || 'OTRO')} · <strong>Tipo:</strong> ${escapeHtml(i.type || 'SOLICITUD')} · <strong>Confianza:</strong> ${escapeHtml(i.confidence || 'BAJA')}</p><p>${escapeHtml(i.summary || '')}</p>${i.currentBehavior ? `<p><strong>Actual:</strong> ${escapeHtml(i.currentBehavior)}</p>` : ''}${i.expectedBehavior ? `<p><strong>Esperado:</strong> ${escapeHtml(i.expectedBehavior)}</p>` : ''}${i.suggestedScope ? `<p><strong>Alcance sugerido:</strong> ${escapeHtml(i.suggestedScope)}</p>` : ''}<small>IA: ${escapeHtml(i.aiStatus || '—')}</small></section><section><h3>Mensaje original</h3><pre>${escapeHtml(ticket.originalText || '')}</pre></section></div>${controls}
  </article>`;
}

function renderAiUsage(aiUsage) {
  if (!aiUsage) return '<section class="card"><h2>Consumo IA · hoy</h2><p class="meta">No fue posible leer la telemetría en este momento. El panel de tickets sigue disponible.</p></section>';
  const categories = [
    ['Bot', aiUsage.bot, aiUsage.coverage?.bot],
    ['CV', aiUsage.cv, aiUsage.coverage?.cv],
    ['Desarrollo tickets', aiUsage.ticketDevelopment, aiUsage.coverage?.ticketDevelopment]
  ];
  const rows = categories.map(([label, usage, observable]) => `<div class="usage-item"><span>${escapeHtml(label)}</span><strong>${observable ? tokenNumber(usage?.totalTokens) : 'No observable'}</strong><small>${observable ? `${tokenNumber(usage?.events)} eventos medidos` : 'Sin autoridad de medición disponible'}</small></div>`).join('');
  const percent = aiUsage.dailyBudget > 0 ? Math.min(100, Math.round((aiUsage.totalTokens / aiUsage.dailyBudget) * 1000) / 10) : 0;
  return `<section class="card ai-usage"><div class="usage-head"><div><h2>Consumo IA · corte diario UTC</h2><p class="meta">Tokens reales reportados por las autoridades observables. No se estiman tokens por texto.</p></div><div class="usage-total"><span>Total</span><strong>${tokenNumber(aiUsage.totalTokens)}</strong><small>${percent}% de ${tokenNumber(aiUsage.dailyBudget)}</small></div></div><div class="usage-grid">${rows}<div class="usage-item remaining"><span>Restante estimado</span><strong>${tokenNumber(aiUsage.remainingTokens)}</strong><small>Respecto al presupuesto diario configurado</small></div></div></section>`;
}

function renderPage({ devView, tickets, config, authorizedPhones, aiUsage, message, error, navbar }) {
  const configRows = config.authorizedPhones.length ? config.authorizedPhones : [{ name: '', phone: '', active: true }];
  const phoneRows = configRows.map((item, index) => `<div class="phone-row"><input name="phoneName" value="${escapeHtml(item.name || '')}" placeholder="Nombre"><input name="phoneNumber" value="${escapeHtml(item.phone || '')}" placeholder="3001234567"><label><input type="checkbox" name="phoneActive" value="${index}" ${item.active !== false ? 'checked' : ''}> Activo</label><button type="button" class="remove-phone">Quitar</button></div>`).join('');
  const devConfig = devView ? `<section class="card"><h2>Números autorizados para crear tickets</h2><p>El Supervisor configurado en Facturación Lórren entra automáticamente. Aquí puedes agregar otros números. La línea permanece silenciosa: registrar un ticket nunca genera respuesta por WhatsApp.</p><div class="authorized"><strong>Autorizados efectivos:</strong> ${authorizedPhones.length ? authorizedPhones.map((item) => `${escapeHtml(item.name)} (${escapeHtml(item.phone)})`).join(' · ') : 'Ninguno'}</div><form method="post" action="/admin/lorren-tickets/config" id="phonesForm"><div id="phoneRows">${phoneRows}</div><button class="btn" type="button" id="addPhone">+ Agregar número</button><button class="btn btn-primary" type="submit">Guardar autorizaciones</button></form></section>` : '';
  const createCard = `<section class="card"><h2>Crear ticket</h2><p class="meta">Describe el cambio, problema o solicitud. Lórren conservará el autor y la trazabilidad del ticket.</p><form method="post" action="/admin/lorren-tickets/create"><textarea name="originalText" rows="4" required placeholder="Describe el cambio o problema de forma natural..."></textarea><button class="btn btn-primary" type="submit">Crear ticket</button></form></section>`;
  const ticketHtml = tickets.length ? tickets.map((ticket) => renderTicketCard(ticket, devView)).join('') : '<section class="card"><p>No hay tickets para mostrar.</p></section>';
  const usageHtml = devView ? renderAiUsage(aiUsage) : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tickets Lórren</title><link rel="stylesheet" href="/public/operaciones-ui.css"><link rel="stylesheet" href="/public/admin-module-navigation.css"><link rel="stylesheet" href="/public/admin-module-shell.css"><link rel="stylesheet" href="/public/admin-module-navigation-desktop.css" media="(min-width: 901px)"><style>body{background:#f5f7fa}.page{max-width:1180px;margin:auto;padding:24px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:center}.card,.ticket-card{background:white;border:1px solid #dfe6ec;border-radius:16px;padding:18px;margin-top:16px}.ticket-card{transition:background-color .18s ease,border-color .18s ease,box-shadow .18s ease}.ticket-card.status-received{background:#f5f9ff;border-color:#cfe0f5}.ticket-card.status-review{background:#fffaf0;border-color:#f2dfb3}.ticket-card.status-approved{background:#f7f6ff;border-color:#d9d4f7}.ticket-card.status-progress{background:#f1fbfc;border-color:#bfe5e8}.ticket-card.status-validation{background:#faf6ff;border-color:#dfcef5}.ticket-card.status-done{background:#f2fbf6;border-color:#bfe4cc}.ticket-card.status-rejected{background:#fff5f5;border-color:#f0c8c8}.ticket-card.status-cancelled{background:#f7f8fa;border-color:#d7dce2}.ticket-card.status-neutral{background:#fff;border-color:#dfe6ec}.ticket-head{display:flex;justify-content:space-between;gap:14px}.ticket-head h2{margin:4px 0}.code{font-size:12px;color:#64748b}.badges{display:flex;gap:6px;flex-wrap:wrap;align-content:flex-start}.badges span{background:#eef2ff;border-radius:999px;padding:5px 8px;font-size:11px}.meta{color:#64748b;font-size:12px;margin:6px 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid section{border:1px solid #eef2f7;border-radius:12px;padding:12px}.grid pre{white-space:pre-wrap;font-family:inherit;margin:0}.ticket-controls,.ticket-delete,.phone-row{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:12px}.ticket-controls label{display:grid;gap:4px}.ticket-controls select,.phone-row input,textarea{padding:10px;border:1px solid #cbd5e1;border-radius:9px}.ticket-delete{padding-top:10px;border-top:1px solid #fee2e2}.ticket-delete label{display:flex;align-items:center;gap:6px;color:#991b1b;font-size:12px}.btn-danger{background:#b91c1c;color:#fff;border-color:#b91c1c}.phone-row input{min-width:220px}.remove-phone{border:0;background:#fee2e2;color:#991b1b;padding:9px;border-radius:8px}.authorized{margin:10px 0;padding:10px;background:#f8fafc;border-radius:8px}.notice{padding:12px;border-radius:10px;margin-top:12px}.ok{background:#ecfdf5;color:#166534}.bad{background:#fef2f2;color:#991b1b}.ai-usage{border-color:#c7d2fe}.usage-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.usage-head h2{margin:0}.usage-total{text-align:right;display:grid;gap:2px}.usage-total strong{font-size:26px}.usage-total span,.usage-item span{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.04em}.usage-total small,.usage-item small{color:#64748b}.usage-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.usage-item{display:grid;gap:5px;padding:13px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc}.usage-item strong{font-size:21px}.usage-item.remaining{background:#eef2ff;border-color:#c7d2fe}textarea{width:100%;box-sizing:border-box;margin-bottom:10px}@media(max-width:760px){.hero,.ticket-head,.usage-head{flex-direction:column;align-items:flex-start}.grid,.usage-grid{grid-template-columns:1fr}.usage-total{text-align:left}.phone-row{display:grid}.phone-row input{min-width:0;width:100%}}</style></head><body>${navbar}<main class="page admin-module-page-shell"><section class="hero"><div><div class="eyebrow">${devView ? 'DEV' : 'USUARIO'} · Lórren</div><h1>Tickets internos</h1><p>${devView ? 'Recepción, interpretación y gestión de solicitudes internas.' : 'Crea y da seguimiento a los tickets que has generado.'}</p></div><a class="btn" href="/admin">Volver al panel</a></section>${message ? `<div class="notice ok">${escapeHtml(message)}</div>` : ''}${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}${usageHtml}${devConfig}${createCard}${ticketHtml}</main>${devView ? `<script>var rows=document.getElementById('phoneRows');function reindex(){rows.querySelectorAll('.phone-row').forEach(function(row,index){var cb=row.querySelector('[name="phoneActive"]');if(cb)cb.value=String(index);});}function bind(){rows.querySelectorAll('.remove-phone').forEach(function(btn){btn.onclick=function(){if(rows.querySelectorAll('.phone-row').length>1){btn.closest('.phone-row').remove();reindex();}};});}bind();reindex();document.getElementById('addPhone').onclick=function(){var i=rows.querySelectorAll('.phone-row').length;rows.insertAdjacentHTML('beforeend','<div class="phone-row"><input name="phoneName" placeholder="Nombre"><input name="phoneNumber" placeholder="3001234567"><label><input type="checkbox" name="phoneActive" value="'+i+'" checked> Activo</label><button type="button" class="remove-phone">Quitar</button></div>');bind();reindex();};document.getElementById('phonesForm').addEventListener('submit',reindex);</script>` : ''}</body></html>`;
}

export function lorrenSupportTicketsAdminRouter(prisma) {
  const router = express.Router();
  const form = express.urlencoded({ extended: true, limit: '64kb' });

  router.post('/internal/development-usage', async (req, res) => {
    try {
      await recordLorrenTicketDevelopmentUsage(prisma, {
        signature: req.get('x-lorren-usage-signature'),
        payload: req.body,
        env: process.env
      });
      return res.status(204).end();
    } catch {
      return res.status(401).end();
    }
  });

  router.use(requireAccess);

  router.get('/', async (req, res) => {
    const [allTickets, config, authorizedPhones] = await Promise.all([
      loadLorrenSupportTickets(prisma),
      loadLorrenSupportConfig(prisma),
      loadLorrenSupportAuthorizedPhones(prisma)
    ]);
    let tickets = allTickets;
    let aiUsage = null;
    if (isDev(req)) {
      aiUsage = await loadLorrenAiUsageSummary(prisma).catch(() => null);
    } else {
      const identity = await ticketUserIdentity(prisma, req);
      tickets = allTickets.filter((ticket) => ticketVisibleToUser(ticket, identity));
    }
    res.send(renderPage({ devView: isDev(req), tickets, config, authorizedPhones, aiUsage, message: req.query.message, error: req.query.error, navbar: buildAdminModuleNavbar(req) }));
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

  router.post('/create', form, async (req, res) => {
    try {
      await createLorrenSupportTicket(prisma, {
        source: isDev(req) ? 'DEV_PANEL' : 'USER_PANEL',
        originalText: req.body.originalText,
        createdByUserId: req.session?.userId || req.userId || null,
        createdByUsername: req.session?.username || req.username || null,
        actorRole: req.session?.userRole || req.userRole || null,
        actor: actor(req, isDev(req) ? 'lorren-support-dev-panel' : 'lorren-support-user-panel')
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

  router.post('/:ticketId/delete', requireDev, form, async (req, res) => {
    if (req.body.confirmDelete !== '1') {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent('Debes confirmar la eliminación del ticket.'));
    }
    try {
      await deleteLorrenSupportTicket(prisma, req.params.ticketId, actor(req, 'lorren-support-dev-delete'));
      return res.redirect('/admin/lorren-tickets?message=' + encodeURIComponent('Ticket eliminado.'));
    } catch (error) {
      return res.redirect('/admin/lorren-tickets?error=' + encodeURIComponent(error?.message || 'No fue posible eliminar el ticket.'));
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