import express from 'express';
import ExcelJS from 'exceljs';
import {
  buildPayrollExportRows,
  loadPayrollPolicies,
  loadPayrollReport,
  savePayrollCompensation,
  savePayrollPolicy
} from '../modules/dispatch-payroll/application/payrollReport.js';
import {
  DEFAULT_PAYROLL_POLICY,
  PAYROLL_CONCEPT_CODES,
  formatPayrollMinutes
} from '../modules/dispatch-payroll/domain/payrollConceptEngine.js';
import {
  resolvePayrollFeatureAccess,
  setPayrollFeatureAccess
} from '../services/payrollFeatureAccess.js';
import { resolveTestWorkspaceFeatureAccess } from '../services/testWorkspaceFeatureAccess.js';

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function actor(req) {
  return {
    actorUsername: normalizeString(req.session?.username || req.username, 160),
    actorRole: normalizeString(req.session?.userRole || req.userRole, 80),
    ipAddress: normalizeString(req.ip, 120),
    userAgent: normalizeString(req.get?.('user-agent'), 500)
  };
}

function roleFromRequest(req) {
  return normalizeString(req.session?.userRole || req.userRole, 80)?.toLowerCase();
}

function requestedTestData(source = {}) {
  return String(source?.includeTest || '').toLowerCase() === 'true';
}

function allowTestData(req) {
  return roleFromRequest(req) === 'dev' || req.canAccessTestWorkspace === true;
}

function sanitizedPayrollInput(req, source = {}) {
  const input = { ...(source || {}) };
  const requested = requestedTestData(input);
  if (!allowTestData(req)) delete input.includeTest;
  else if (requested || (req.canAccessTestWorkspace && !req.canAccessPayroll)) input.includeTest = 'true';
  else delete input.includeTest;
  return input;
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function safeQuery(source = {}) {
  const params = new URLSearchParams();
  ['periodType', 'from', 'to', 'anchor', 'clientId', 'operationPointId', 'workerId', 'search', 'includeTest'].forEach((key) => {
    const value = normalizeString(source[key], 180);
    if (value) params.set(key, value);
  });
  return params;
}

function redirectToPayroll(res, source, { success = null, error = null } = {}) {
  const params = safeQuery(source);
  if (success) params.set('success', success);
  if (error) params.set('error', error);
  return res.redirect(`/admin/operaciones/asistencia/nomina?${params.toString()}`);
}

function publicError(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  const messages = {
    payroll_period_too_long: 'El periodo personalizado no puede superar 62 días.',
    payroll_range_invalid: 'Selecciona un rango de fechas válido.',
    payroll_policy_dev_required: 'Solo DEV puede modificar la política de jornada.',
    payroll_policy_client_required: 'Selecciona un cliente para guardar la política.',
    payroll_policy_client_not_found: 'El cliente seleccionado ya no existe.',
    payroll_compensation_invalid: 'Selecciona un estado de compensatorio válido.',
    payroll_compensation_worker_not_found: 'El auxiliar ya no existe.',
    payroll_access_dev_required: 'Solo DEV puede cambiar este permiso.',
    payroll_access_user_not_found: 'El usuario ya no existe.'
  };
  return messages[code] || 'No fue posible completar la operación de nómina.';
}

async function loadAccess(prisma, req) {
  const source = {
    userRole: roleFromRequest(req),
    userId: req.session?.userId || req.userId,
    username: req.session?.username || req.username
  };
  const [payroll, testWorkspace] = await Promise.all([
    resolvePayrollFeatureAccess(prisma, source),
    resolveTestWorkspaceFeatureAccess(prisma, source)
  ]);
  req.canAccessPayroll = payroll.allowed === true;
  req.canAccessTestWorkspace = testWorkspace.allowed === true;
  if (req.session) {
    req.session.canAccessPayroll = req.canAccessPayroll;
    req.session.canAccessTestWorkspace = req.canAccessTestWorkspace;
  }
  return { payroll, testWorkspace };
}

function requireDev(req, res, next) {
  if (roleFromRequest(req) !== 'dev') return res.status(403).json({ ok: false, error: 'dev_required' });
  return next();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function reportFilename(report, extension) {
  const prefix = report.filters?.includeTest ? 'nomina-pruebas' : 'nomina';
  return `${prefix}-${report.period.from}-${report.period.to}.${extension}`;
}

async function reportForRequest(prisma, req, source) {
  return loadPayrollReport(prisma, sanitizedPayrollInput(req, source), {
    allowTestData: allowTestData(req)
  });
}

export function dispatchPayrollRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '24kb' });
  const jsonParser = express.json({ limit: '8kb', strict: true });

  router.get('/api/users/:userId/access', requireDev, async (req, res) => {
    noStore(res);
    try {
      const access = await resolvePayrollFeatureAccess(prisma, {
        userRole: 'admin', userId: req.params.userId, username: null
      });
      return res.json({ ok: true, enabled: access.allowed, userId: access.userId });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.post('/api/users/:userId/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: req.params.userId,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.post('/api/users/by-username/:username/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    const username = normalizeString(req.params.username, 160);
    const user = username ? await prisma.appUser.findUnique({ where: { username }, select: { id: true } }) : null;
    if (!user) return res.status(404).json({ ok: false, error: 'payroll_access_user_not_found' });
    try {
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: user.id,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.use(async (req, res, next) => {
    noStore(res);
    try {
      const access = await loadAccess(prisma, req);
      if (!access.payroll.allowed && !access.testWorkspace.allowed) {
        return res.status(403).send('No tienes permiso para acceder a Nómina ni al entorno de pruebas.');
      }
      res.locals.canAccessPayroll = access.payroll.allowed;
      res.locals.canAccessTestWorkspace = access.testWorkspace.allowed;
      return next();
    } catch (error) {
      console.error('[PAYROLL_ACCESS_FAILED]', error);
      return res.status(503).send('No fue posible comprobar los permisos de Nómina.');
    }
  });

  router.get('/', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const selectedClientId = report.filters.clientId || report.clients[0]?.id || '';
      const selectedPolicies = await loadPayrollPolicies(prisma, selectedClientId ? [selectedClientId] : []);
      const selectedPolicy = selectedPolicies.get(selectedClientId) || DEFAULT_PAYROLL_POLICY;
      const testOnly = req.canAccessTestWorkspace && !req.canAccessPayroll;
      return res.render('operacionesNomina', {
        pageTitle: testOnly ? 'Nómina del entorno de pruebas' : 'Nómina y tiempo trabajado',
        role: roleFromRequest(req),
        testWorkspaceOnly: testOnly,
        report,
        selectedPolicy,
        conceptCodes: PAYROLL_CONCEPT_CODES,
        formatPayrollMinutes,
        success: normalizeString(req.query?.success, 300),
        error: normalizeString(req.query?.error, 300)
      });
    } catch (error) {
      console.error('[PAYROLL_REPORT_FAILED]', error);
      return res.status(500).render('operacionesNomina', {
        pageTitle: 'Nómina y tiempo trabajado',
        role: roleFromRequest(req),
        testWorkspaceOnly: req.canAccessTestWorkspace && !req.canAccessPayroll,
        report: {
          period: { periodType: 'WEEKLY', from: '', to: '', anchor: '' },
          filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: Boolean(req.canAccessTestWorkspace && !req.canAccessPayroll) },
          clients: [], workers: [], rows: [], conceptCodes: PAYROLL_CONCEPT_CODES,
          totals: { workers: 0, totalMinutes: 0, ordinaryMinutes: 0, overtimeMinutes: 0, unrecognizedOvertimeMinutes: 0, exportableWorkers: 0, workersWithNovelties: 0, conceptMinutes: {}, conceptHours: {} }
        },
        selectedPolicy: DEFAULT_PAYROLL_POLICY,
        conceptCodes: PAYROLL_CONCEPT_CODES,
        formatPayrollMinutes,
        success: null,
        error: publicError(error)
      });
    }
  });

  router.post('/policy', formParser, async (req, res) => {
    const input = sanitizedPayrollInput(req, req.body);
    if (roleFromRequest(req) !== 'dev') {
      return redirectToPayroll(res, input, { error: 'Solo DEV puede modificar la política de jornada.' });
    }
    try {
      await savePayrollPolicy(prisma, { ...req.body, recognizeEarlyArrival: req.body.recognizeEarlyArrival === 'true', ...actor(req) });
      return redirectToPayroll(res, input, { success: 'Política de jornada guardada con auditoría.' });
    } catch (error) {
      return redirectToPayroll(res, input, { error: publicError(error) });
    }
  });

  router.post('/compensation', formParser, async (req, res) => {
    const input = sanitizedPayrollInput(req, req.body);
    if (requestedTestData(input) || !req.canAccessPayroll) {
      return redirectToPayroll(res, input, {
        error: 'Los compensatorios no se modifican desde el entorno de pruebas para evitar afectar la nómina operativa.'
      });
    }
    try {
      await savePayrollCompensation(prisma, { ...req.body, ...actor(req) });
      return redirectToPayroll(res, input, { success: 'Estado del compensatorio actualizado.' });
    } catch (error) {
      return redirectToPayroll(res, input, { error: publicError(error) });
    }
  });

  router.get('/export.csv', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const rows = buildPayrollExportRows(report);
      const headers = rows.length ? Object.keys(rows[0]) : ['Documento', 'Nombre', 'FechaInicial', 'FechaFinal', ...PAYROLL_CONCEPT_CODES];
      const lines = [headers.join(';'), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(';'))];
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${reportFilename(report, 'csv')}"`);
      return res.send(`\uFEFF${lines.join('\r\n')}`);
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.query), { error: publicError(error) });
    }
  });

  router.get('/export.xlsx', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const rows = buildPayrollExportRows(report);
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Lórren · LoginPro';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Nómina');
      const headers = rows.length ? Object.keys(rows[0]) : ['Documento', 'Nombre', 'FechaInicial', 'FechaFinal', ...PAYROLL_CONCEPT_CODES];
      sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(12, Math.min(30, header.length + 3)) }));
      rows.forEach((row) => sheet.addRow(row));
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(headers.length).letter}1` };
      sheet.getRow(1).font = { bold: true };
      headers.forEach((header, index) => {
        if (header.startsWith('HE') || header.startsWith('RN') || header.startsWith('RD') || header === 'RNO' || header.includes('Horas') || header === 'TotalTrabajado') {
          sheet.getColumn(index + 1).numFmt = '0.0000';
        }
      });
      const buffer = await workbook.xlsx.writeBuffer();
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${reportFilename(report, 'xlsx')}"`);
      return res.send(Buffer.from(buffer));
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.query), { error: publicError(error) });
    }
  });

  return router;
}
