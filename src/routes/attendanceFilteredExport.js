import express from 'express';
import { buildAttendanceFilteredExport } from '../modules/dispatch-attendance/application/attendanceFilteredExport.js';
import {
  hasOperationalCapability,
  OPERATIONAL_CAPABILITY
} from '../services/operationalAccess.js';

function roleFromRequest(req) {
  return req.session?.userRole || req.userRole || null;
}

function canExportTime(req) {
  return roleFromRequest(req) === 'dev'
    || hasOperationalCapability(req, OPERATIONAL_CAPABILITY.TIME_EXPORT);
}

function contentDispositionFilename(from, to) {
  const safeFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : 'inicio';
  const safeTo = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : 'fin';
  return `asistencia-filtrada-${safeFrom}-${safeTo}.xlsx`;
}

export function attendanceFilteredExportRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '64kb' });

  router.get('/capabilities', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, canExport: canExportTime(req) });
  });

  router.post('/filtrado.xlsx', formParser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!canExportTime(req)) {
      return res.status(403).send('No tienes permiso para exportar reportes de Gestión de Tiempo.');
    }

    try {
      const result = await buildAttendanceFilteredExport(prisma, req.body || {}, {
        allowTestData: roleFromRequest(req) === 'dev'
      });
      const buffer = await result.workbook.xlsx.writeBuffer();
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${contentDispositionFilename(result.range.from, result.range.to)}"`);
      return res.send(Buffer.from(buffer));
    } catch (error) {
      const code = typeof error?.message === 'string' ? error.message : 'attendance_filtered_export_failed';
      console.error('[ATTENDANCE_FILTERED_EXPORT_FAILED]', { code });
      if (code === 'payroll_period_too_long') {
        return res.status(400).send('El rango para calcular y exportar conceptos de tiempo no puede superar 62 días.');
      }
      return res.status(500).send('No fue posible generar el Excel de la asistencia filtrada.');
    }
  });

  return router;
}
