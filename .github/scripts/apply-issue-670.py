from pathlib import Path

route_path = Path('src/routes/dispatchOpsExtras.js')
route = route_path.read_text(encoding='utf-8')

import_anchor = "import { recalculateDispatchServiceRequestStatus } from '../services/dispatchOperationalCoverage.js';\n"
import_replacement = import_anchor + "import {\n  DISPATCH_WORKER_EXCEL_COLUMNS,\n  buildDispatchWorkerImportTemplate,\n  importDispatchWorkerExcelWorkbook\n} from '../services/dispatchWorkerExcelImport.js';\n"
if import_anchor not in route:
    raise SystemExit('No se encontró el ancla de imports en dispatchOpsExtras.js')
route = route.replace(import_anchor, import_replacement, 1)

upload_anchor = "const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });"
upload_replacement = """const MAX_EXCEL_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream'
]);
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EXCEL_SIZE_BYTES },
  fileFilter(_req, file, callback) {
    const originalName = String(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!originalName.endsWith('.xlsx')) return callback(new Error('El archivo debe estar en formato .xlsx.'));
    if (mimeType && !ALLOWED_EXCEL_MIME_TYPES.has(mimeType)) return callback(new Error('El tipo de archivo no corresponde a un Excel .xlsx.'));
    return callback(null, true);
  }
});"""
if upload_anchor not in route:
    raise SystemExit('No se encontró la configuración actual de excelUpload')
route = route.replace(upload_anchor, upload_replacement, 1)

cv_parser_anchor = """function parseWorkerCvUpload(req, res, next) {
  workerCvUpload.single('cvFile')(req, res, (error) => {
    if (error) req.workerCvUploadError = error.code === 'LIMIT_FILE_SIZE' ? 'La hoja de vida no puede superar 5 MB.' : error.message || 'No fue posible procesar la hoja de vida.';
    return next();
  });
}
"""
excel_parser = cv_parser_anchor + """function parseDispatchWorkerExcelUpload(req, res, next) {
  excelUpload.single('excelFile')(req, res, (error) => {
    if (error) {
      req.dispatchWorkerExcelUploadError = error.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo Excel no puede superar 5 MB.'
        : error.message || 'No fue posible recibir el archivo Excel.';
    }
    return next();
  });
}
"""
if cv_parser_anchor not in route:
    raise SystemExit('No se encontró parseWorkerCvUpload')
route = route.replace(cv_parser_anchor, excel_parser, 1)

start_marker = "  router.get('/personal/importar-excel', requireOps,"
end_marker = "  router.get('/personal/nuevo', requireOps,"
start = route.find(start_marker)
end = route.find(end_marker)
if start < 0 or end < 0 or end <= start:
    raise SystemExit('No se encontró el bloque de rutas de importación Excel')

new_block = """  router.get('/personal/importar-excel', requireOps, async (req, res) => {
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
    return res.render('operacionesPersonalImportar', {
      role: req.session?.userRole || req.userRole,
      message: normalizeString(req.query.message),
      error: normalizeString(req.query.error),
      columns: DISPATCH_WORKER_EXCEL_COLUMNS,
      cities,
      vacancies
    });
  });

  router.get('/personal/importar-excel/plantilla', requireOps, async (_req, res) => {
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
    const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-importacion-auxiliares.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  });

  router.post('/personal/importar-excel', requireOps, parseDispatchWorkerExcelUpload, async (req, res) => {
    if (req.dispatchWorkerExcelUploadError) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(req.dispatchWorkerExcelUploadError));
    }
    if (!req.file) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent('Debes seleccionar un archivo Excel .xlsx.'));
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const [cities, vacancies] = await loadWorkerFormLists(prisma);
      const result = await importDispatchWorkerExcelWorkbook({ prisma, workbook, cities, vacancies });
      const parts = [];
      if (result.created) parts.push(`${result.created} auxiliar${result.created !== 1 ? 'es creados' : ' creado'}`);
      if (result.updated) parts.push(`${result.updated} auxiliar${result.updated !== 1 ? 'es actualizados' : ' actualizado'}`);
      if (result.skipped) parts.push(`${result.skipped} omitido${result.skipped !== 1 ? 's' : ''} por documento ya activo`);
      const summary = parts.length ? parts.join(', ') : 'Sin cambios';
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent(`Importación completada: ${summary}.`));
    } catch (error) {
      console.error('[Dispatch worker Excel import]', error);
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'Error al procesar el archivo.'));
    }
  });

"""
route = route[:start] + new_block + route[end:]
route_path.write_text(route, encoding='utf-8')
