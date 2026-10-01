import express from 'express';
import { saveCybionixBillingConfig, cybionixBillingReadiness } from '../services/cybionixBillingConfig.js';
import { getCybionixWhatsappConfig } from '../services/cybionixWhatsappClient.js';
import { loadCybionixBillingDashboard } from '../services/cybionixBillingWorkflow.js';
import { buildAccountChargePdfBuffer, buildAttendanceInvoicePdfBuffer } from '../services/cybionixBillingPdf.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isDev(req) {
  return (req.session?.userRole || req.userRole) === 'dev';
}

function requireDev(req, res, next) {
  if (!isDev(req)) return res.status(403).send('Esta configuración solo está disponible para DEV.');
  return next();
}

function money(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function statusLabel(status) {
  return ({ UNSENT: 'Pendiente de envío', PENDING: 'Esperando aprobación', APPROVED: 'Aprobada', REJECTED: 'No aprobada' }[status] || status || 'Sin estado');
}

function renderPage({ dashboard, channel, readiness, message, error }) {
  const config = dashboard.config;
  const modules = config.modules?.length ? config.modules : [
    { name: 'Bot de reclutamiento', value: 1000000, active: true },
    { name: 'Módulo Operaciones / Despacho', value: 400000, active: true }
  ];
  const recipients = config.recipients?.length ? config.recipients : [{ name: '', phone: '' }];
  const moduleRows = modules.map((item, index) => `<div class="row module-row"><input name="moduleName" value="${escapeHtml(item.name)}" placeholder="Nombre del módulo" required><input name="moduleValue" inputmode="numeric" value="${escapeHtml(item.value)}" placeholder="Valor COP" required><label class="check"><input type="checkbox" name="moduleActive" value="${index}" ${item.active !== false ? 'checked' : ''}> Activo</label><button type="button" class="remove">Quitar</button></div>`).join('');
  const recipientRows = recipients.map((item) => `<div class="row recipient-row"><input name="recipientName" value="${escapeHtml(item.name)}" placeholder="Nombre de la persona" required><input name="recipientPhone" value="${escapeHtml(item.phone)}" placeholder="3001234567" required><button type="button" class="remove">Quitar</button></div>`).join('');
  const history = dashboard.rows.length ? dashboard.rows.map(({ invoice, approval, account }) => `<tr class="${approval.status === 'REJECTED' ? 'rejected' : ''}"><td>${escapeHtml(invoice.invoiceNumber)}</td><td>${escapeHtml(invoice.cycleStart)} → ${escapeHtml(invoice.cycleEnd)}</td><td>${invoice.count}</td><td>${money(invoice.total)}</td><td><strong>${escapeHtml(statusLabel(approval.status))}</strong>${approval.status === 'REJECTED' ? '<div class="danger">Requiere revisión DEV</div>' : ''}</td><td>${account ? `${escapeHtml(account.accountNumber)} · ${money(account.total)}` : '—'}</td><td><a href="/admin/cybionix-billing/invoices/${encodeURIComponent(invoice.invoiceNumber)}.pdf">Factura</a>${account ? ` · <a href="/admin/cybionix-billing/accounts/${encodeURIComponent(invoice.invoiceNumber)}.pdf">Cuenta</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="7">Todavía no hay cierres mensuales.</td></tr>';
  const missingText = readiness.ready ? 'Canal listo para operar.' : `Pendiente: ${readiness.missing.join(', ')}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Facturación Cybionix — DEV</title><link rel="stylesheet" href="/public/operaciones-ui.css"><style>
  body{background:#f5f7fa}.page{max-width:1180px;margin:auto;padding:24px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:center}.card{background:white;border:1px solid #dfe6ec;border-radius:16px;padding:18px;margin-top:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.row{display:grid;grid-template-columns:minmax(180px,1fr) 180px auto auto;gap:8px;align-items:center;margin:8px 0}.recipient-row{grid-template-columns:1fr 220px auto}.row input{padding:10px;border:1px solid #cbd5e1;border-radius:9px}.check{white-space:nowrap}.remove{border:0;background:#fee2e2;color:#991b1b;padding:9px;border-radius:8px}.add{margin-top:8px}.status{padding:12px;border-radius:10px;background:${readiness.ready ? '#ecfdf5' : '#fff7ed'};color:${readiness.ready ? '#166534' : '#9a3412'};font-weight:700}.notice{padding:12px;border-radius:10px;margin-top:12px}.ok{background:#ecfdf5;color:#166534}.bad{background:#fef2f2;color:#991b1b}.field{display:grid;gap:5px;margin:9px 0}.field input{padding:10px;border:1px solid #cbd5e1;border-radius:9px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e2e8f0;font-size:12px}.rejected{background:#fff1f2}.danger{color:#b91c1c;font-size:11px;margin-top:3px}@media(max-width:760px){.grid{grid-template-columns:1fr}.row,.recipient-row{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}}</style></head><body><main class="page">
  <section class="hero"><div><div class="eyebrow">DEV · Cybionix</div><h1>Facturación y cuentas de cobro</h1><p>Configuración financiera independiente de las líneas operativas de LoginPro.</p></div><a class="btn" href="/admin">Volver al panel</a></section>
  ${message ? `<div class="notice ok">${escapeHtml(message)}</div>` : ''}${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
  <section class="card"><h2>Canal WhatsApp Cybionix</h2><div class="status">${escapeHtml(missingText)}</div><p>La SIM/WABA puede configurarse después. Mientras falten credenciales o plantillas, el worker no enviará facturas ni cuentas de cobro.</p><div class="grid"><div><strong>Phone Number ID</strong><div>${channel.phoneNumberId ? 'Configurado' : 'Pendiente'}</div></div><div><strong>Plantilla aprobación</strong><div>${escapeHtml(channel.approvalTemplateName || 'Pendiente')}</div></div><div><strong>Plantilla cuenta de cobro</strong><div>${escapeHtml(channel.accountTemplateName || 'Pendiente')}</div></div><div><strong>Plantilla alerta DEV</strong><div>${escapeHtml(channel.alertTemplateName || 'Opcional / pendiente')}</div></div></div></section>
  <form id="cybionixBillingConfigForm" class="card" method="post" action="/admin/cybionix-billing/config"><h2>Configuración mensual</h2><label class="check"><input type="checkbox" name="enabled" value="true" ${config.enabled ? 'checked' : ''}> Habilitar flujo automático cuando el canal esté listo</label><div class="grid"><div><div class="field"><label>Supervisor aprobador</label><input name="supervisorName" value="${escapeHtml(config.supervisor?.name || '')}" placeholder="Nombre"></div><div class="field"><label>WhatsApp supervisor</label><input name="supervisorPhone" value="${escapeHtml(config.supervisor?.phone || '')}" placeholder="3001234567"></div></div><div><div class="field"><label>WhatsApp DEV para alertas</label><input name="devAlertPhone" value="${escapeHtml(config.devAlertPhone || '')}" placeholder="3001234567"></div><div class="field"><label>Encabezado cuenta de cobro</label><input name="accountHeading" value="${escapeHtml(config.accountHeading || '')}" placeholder="Ej. MILTON PEREZ"></div></div></div>
  <h3>Módulos de valor fijo</h3><p>Asistencia no se agrega aquí: su valor se toma automáticamente de la factura aprobada.</p><div id="modules">${moduleRows}</div><button class="btn add" type="button" id="addModule">+ Agregar módulo</button>
  <h3>Destinatarios de la cuenta de cobro</h3><div id="recipients">${recipientRows}</div><button class="btn add" type="button" id="addRecipient">+ Agregar destinatario</button><div style="margin-top:16px"><button class="btn btn-primary" type="submit">Guardar configuración</button></div></form>
  <section class="card"><h2>Historial y aprobaciones</h2><table><thead><tr><th>Factura</th><th>Periodo</th><th>Aux.</th><th>Asistencia</th><th>Aprobación</th><th>Cuenta de cobro</th><th>PDF</th></tr></thead><tbody>${history}</tbody></table></section>
  </main><script>
  function reindexModules(){document.querySelectorAll('#modules .module-row').forEach(function(row,index){var checkbox=row.querySelector('[name="moduleActive"]');if(checkbox)checkbox.value=String(index);});}
  function bindRemove(root){root.querySelectorAll('.remove').forEach(function(button){button.onclick=function(){var rows=root.querySelectorAll('.row');if(rows.length>1){button.closest('.row').remove();reindexModules();}};});}
  var modules=document.getElementById('modules');var recipients=document.getElementById('recipients');bindRemove(modules);bindRemove(recipients);reindexModules();
  document.getElementById('addModule').onclick=function(){var i=modules.querySelectorAll('.row').length;modules.insertAdjacentHTML('beforeend','<div class="row module-row"><input name="moduleName" placeholder="Nombre del módulo" required><input name="moduleValue" inputmode="numeric" placeholder="Valor COP" required><label class="check"><input type="checkbox" name="moduleActive" value="'+i+'" checked> Activo</label><button type="button" class="remove">Quitar</button></div>');bindRemove(modules);reindexModules();};
  document.getElementById('addRecipient').onclick=function(){recipients.insertAdjacentHTML('beforeend','<div class="row recipient-row"><input name="recipientName" placeholder="Nombre de la persona" required><input name="recipientPhone" placeholder="3001234567" required><button type="button" class="remove">Quitar</button></div>');bindRemove(recipients);};
  document.getElementById('cybionixBillingConfigForm').addEventListener('submit',reindexModules);
  </script></body></html>`;
}

export function cybionixBillingAdminRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: true, limit: '32kb' });
  router.use(requireDev);

  router.get('/', async (req, res) => {
    const dashboard = await loadCybionixBillingDashboard(prisma);
    const channel = getCybionixWhatsappConfig();
    const readiness = cybionixBillingReadiness(dashboard.config, channel);
    res.send(renderPage({ dashboard, channel, readiness, message: req.query.message, error: req.query.error }));
  });

  router.get('/status', async (_req, res) => {
    const dashboard = await loadCybionixBillingDashboard(prisma);
    const rejected = dashboard.rows.filter((row) => row.approval.status === 'REJECTED').length;
    res.json({ ok: true, rejected, pending: dashboard.rows.filter((row) => row.approval.status === 'PENDING').length });
  });

  router.post('/config', formParser, async (req, res) => {
    try {
      await saveCybionixBillingConfig(prisma, {
        ...req.body,
        actorUsername: req.session?.username || req.username || null,
        actorRole: req.session?.userRole || req.userRole || null,
        ipAddress: req.ip || null,
        userAgent: req.get('user-agent') || null
      });
      return res.redirect('/admin/cybionix-billing?message=' + encodeURIComponent('Configuración guardada.'));
    } catch (err) {
      return res.redirect('/admin/cybionix-billing?error=' + encodeURIComponent(err?.message || 'No fue posible guardar.'));
    }
  });

  router.get('/invoices/:invoiceNumber.pdf', async (req, res) => {
    const dashboard = await loadCybionixBillingDashboard(prisma);
    const row = dashboard.rows.find((item) => item.invoice.invoiceNumber === req.params.invoiceNumber);
    if (!row) return res.status(404).send('Factura no encontrada.');
    const buffer = await buildAttendanceInvoicePdfBuffer(row.invoice);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${row.invoice.invoiceNumber}.pdf"`).send(buffer);
  });

  router.get('/accounts/:invoiceNumber.pdf', async (req, res) => {
    const dashboard = await loadCybionixBillingDashboard(prisma);
    const row = dashboard.rows.find((item) => item.invoice.invoiceNumber === req.params.invoiceNumber);
    if (!row?.account) return res.status(404).send('Cuenta de cobro no encontrada.');
    const buffer = await buildAccountChargePdfBuffer(row.account);
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${row.account.accountNumber}.pdf"`).send(buffer);
  });

  return router;
}
