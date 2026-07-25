from pathlib import Path

ROOT = Path('.')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'No se encontró el bloque esperado: {label}')
    return text.replace(old, new, 1)


service_path = ROOT / 'src/services/dispatchWorkerExcelImport.js'
service = service_path.read_text(encoding='utf-8')
service = replace_once(
    service,
    "aliases: ['nombre', 'nombre y apellidos', 'auxiliar', 'nombre auxiliar']",
    "aliases: ['nombre y apellidos', 'auxiliar', 'nombre auxiliar']",
    'aliases legacy de nombre completo'
)
service = replace_once(
    service,
    "aliases: ['nombres del auxiliar', 'primer nombre', 'segundo nombre']",
    "aliases: ['nombre', 'nombres del auxiliar', 'primer nombre', 'segundo nombre']",
    'alias singular de nombres'
)
service = replace_once(
    service,
    """export function buildDispatchWorkerFullName(row = {}) {
  const legacyFullName = normalizeNamePart(row.fullName);
  if (legacyFullName) return legacyFullName;
  const firstNames = normalizeNamePart(row.firstNames);
  const lastNames = normalizeNamePart(row.lastNames);
  if (!firstNames || !lastNames) return null;
  return `${firstNames} ${lastNames}`;
}
""",
    """export function buildDispatchWorkerFullName(row = {}) {
  const firstNames = normalizeNamePart(row.firstNames);
  const lastNames = normalizeNamePart(row.lastNames);
  if (firstNames || lastNames) {
    if (!firstNames || !lastNames) return null;
    return `${firstNames} ${lastNames}`;
  }
  return normalizeNamePart(row.fullName);
}
""",
    'prioridad de nombres separados'
)
service = replace_once(
    service,
    """    const row = worksheet.getRow(rowNumber);
    const values = {};
    for (const column of PARSABLE_EXCEL_COLUMNS) {
      values[column.field] = headerMap.has(column.field)
        ? readCellText(row.getCell(headerMap.get(column.field)))
        : null;
    }
    if (!Object.values(values).some(Boolean)) continue;
    rows.push({ rowNumber, ...values });
""",
    """    const row = worksheet.getRow(rowNumber);
    const values = {};
    const providedFields = [];
    for (const column of PARSABLE_EXCEL_COLUMNS) {
      const value = headerMap.has(column.field)
        ? readCellText(row.getCell(headerMap.get(column.field)))
        : null;
      values[column.field] = value;
      if (headerMap.has(column.field) && normalizeString(value)) providedFields.push(column.field);
    }
    if (!Object.values(values).some(Boolean)) continue;
    rows.push({ rowNumber, providedFields, ...values });
""",
    'campos informados por fila'
)
service = replace_once(
    service,
    """    prepared.push({
      rowNumber: row.rowNumber,
      workerData: {
        fullName,
        phone: normalizeString(row.phone),
        documentType: normalizeString(row.documentType)?.toUpperCase(),
        documentNumber,
        residenceCity: residenceCity?.name || normalizeString(row.residenceCity),
        residenceLocality: normalizeString(row.residenceLocality),
        transportMode,
        contractType,
        operationalStatus,
        notes: normalizeString(row.notes),
        source: 'EXCEL_IMPORT'
      },
      cityIds,
      vacancyIds
    });
""",
    """    const providedFields = new Set(row.providedFields || []);
    const providedWorkerFields = new Set([
      'fullName',
      'phone',
      'documentType',
      'documentNumber',
      'residenceCity',
      'residenceLocality',
      'contractType'
    ]);
    for (const field of ['transportMode', 'operationalStatus', 'notes']) {
      if (providedFields.has(field)) providedWorkerFields.add(field);
    }

    prepared.push({
      rowNumber: row.rowNumber,
      workerData: {
        fullName,
        phone: normalizeString(row.phone),
        documentType: normalizeString(row.documentType)?.toUpperCase(),
        documentNumber,
        residenceCity: residenceCity?.name || normalizeString(row.residenceCity),
        residenceLocality: normalizeString(row.residenceLocality),
        transportMode,
        contractType,
        operationalStatus,
        notes: normalizeString(row.notes)
      },
      providedWorkerFields: [...providedWorkerFields],
      relationsProvided: {
        cities: providedFields.has('operationalCities'),
        vacancies: providedFields.has('vacancies')
      },
      cityIds,
      cityLabels: operationalCities.map((city) => city.name),
      vacancyIds,
      vacancyLabels: vacancies.map(vacancyLabel)
    });
""",
    'propuesta normalizada y campos informados'
)

start = service.index('async function replaceWorkerRelations')
end = service.index('function styleHeader', start)
review_block = r'''export const DISPATCH_WORKER_IMPORT_FIELD_LABELS = {
  fullName: 'Nombre completo',
  phone: 'Teléfono',
  documentType: 'Tipo de documento',
  residenceCity: 'Ciudad de residencia',
  residenceLocality: 'Localidad / barrio',
  transportMode: 'Medio de transporte',
  contractType: 'Tipo de contrato',
  operationalStatus: 'Estado operativo',
  notes: 'Notas operativas',
  cities: 'Ciudades operativas',
  vacancies: 'Vacantes / perfiles'
};

function comparableScalar(value) {
  return normalizeString(value) || '';
}

function comparableList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)).filter(Boolean))].sort();
}

function valuesEqual(currentValue, incomingValue) {
  if (Array.isArray(currentValue) || Array.isArray(incomingValue)) {
    return JSON.stringify(comparableList(currentValue)) === JSON.stringify(comparableList(incomingValue));
  }
  return comparableScalar(currentValue) === comparableScalar(incomingValue);
}

function visibleValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Sin información';
  return normalizeString(value) || 'Sin información';
}

function existingWorkerSnapshot(worker) {
  return {
    fullName: worker.fullName,
    phone: worker.phone,
    documentType: worker.documentType,
    documentNumber: worker.documentNumber,
    residenceCity: worker.residenceCity,
    residenceLocality: worker.residenceLocality,
    transportMode: worker.transportMode,
    contractType: worker.contractType,
    operationalStatus: worker.operationalStatus,
    notes: worker.notes,
    cities: (worker.cities || []).map((row) => row.city?.name).filter(Boolean),
    vacancies: (worker.vacancies || []).map((row) => vacancyLabel(row.vacancy || {})).filter(Boolean)
  };
}

function incomingWorkerSnapshot(row) {
  return {
    ...row.workerData,
    cities: row.cityLabels,
    vacancies: row.vacancyLabels
  };
}

function buildReviewChanges(row, existing = null) {
  const incoming = incomingWorkerSnapshot(row);
  const current = existing ? existingWorkerSnapshot(existing) : {};
  const changes = [];
  const scalarFields = row.providedWorkerFields.filter((field) => field !== 'documentNumber');
  for (const field of scalarFields) {
    if (existing && valuesEqual(current[field], incoming[field])) continue;
    changes.push({
      field,
      label: DISPATCH_WORKER_IMPORT_FIELD_LABELS[field] || field,
      currentValue: existing ? visibleValue(current[field]) : 'No existe',
      incomingValue: visibleValue(incoming[field])
    });
  }
  if (row.relationsProvided.cities && (!existing || !valuesEqual(current.cities, incoming.cities))) {
    changes.push({
      field: 'cities',
      label: DISPATCH_WORKER_IMPORT_FIELD_LABELS.cities,
      currentValue: existing ? visibleValue(current.cities) : 'No existe',
      incomingValue: visibleValue(incoming.cities)
    });
  }
  if (row.relationsProvided.vacancies && (!existing || !valuesEqual(current.vacancies, incoming.vacancies))) {
    changes.push({
      field: 'vacancies',
      label: DISPATCH_WORKER_IMPORT_FIELD_LABELS.vacancies,
      currentValue: existing ? visibleValue(current.vacancies) : 'No existe',
      incomingValue: visibleValue(incoming.vacancies)
    });
  }
  return changes;
}

function normalizeDocumentKey(value) {
  return normalizeString(value)?.toUpperCase() || '';
}

export async function buildDispatchWorkerImportReview({ prisma, workbook, cities = [], vacancies = [] } = {}) {
  const parsedRows = parseDispatchWorkerExcelWorksheet(workbook?.worksheets?.[0]);
  const preparedRows = prepareDispatchWorkerExcelRows(parsedRows, { cities, vacancies });
  const documentNumbers = [...new Set(preparedRows.map((row) => row.workerData.documentNumber).filter(Boolean))];
  const existingWorkers = documentNumbers.length
    ? await prisma.dispatchWorker.findMany({
      where: { documentNumber: { in: documentNumbers } },
      include: {
        cities: { include: { city: true } },
        vacancies: { include: { vacancy: true } }
      }
    })
    : [];
  const byDocument = new Map();
  for (const worker of existingWorkers) {
    const key = normalizeDocumentKey(worker.documentNumber);
    const rows = byDocument.get(key) || [];
    rows.push(worker);
    byDocument.set(key, rows);
  }

  const items = preparedRows.map((row) => {
    const matches = byDocument.get(normalizeDocumentKey(row.workerData.documentNumber)) || [];
    if (matches.length > 1) {
      return {
        id: `row-${row.rowNumber}`,
        rowNumber: row.rowNumber,
        type: 'CONFLICT',
        actionable: false,
        displayName: row.workerData.fullName,
        documentNumber: row.workerData.documentNumber,
        reason: 'Existen varios auxiliares con el mismo número de documento. Debe corregirse manualmente antes de importar.',
        changes: [],
        incoming: row
      };
    }
    const existing = matches[0] || null;
    const changes = buildReviewChanges(row, existing);
    const type = !existing ? 'NEW' : (changes.length ? 'UPDATE' : 'UNCHANGED');
    return {
      id: `row-${row.rowNumber}`,
      rowNumber: row.rowNumber,
      type,
      actionable: type === 'NEW' || type === 'UPDATE',
      displayName: row.workerData.fullName,
      documentNumber: row.workerData.documentNumber,
      workerId: existing?.id || null,
      workerUpdatedAt: existing?.updatedAt ? new Date(existing.updatedAt).toISOString() : null,
      reason: type === 'UNCHANGED' ? 'El archivo coincide con la información actual.' : null,
      changes,
      incoming: row
    };
  });

  const summary = {
    total: items.length,
    newCount: items.filter((item) => item.type === 'NEW').length,
    updateCount: items.filter((item) => item.type === 'UPDATE').length,
    unchangedCount: items.filter((item) => item.type === 'UNCHANGED').length,
    conflictCount: items.filter((item) => item.type === 'CONFLICT').length,
    actionableCount: items.filter((item) => item.actionable).length
  };
  return { items, summary };
}

async function replaceWorkerRelations(prisma, workerId, cityIds, vacancyIds, relationsProvided = { cities: true, vacancies: true }) {
  if (relationsProvided.cities) {
    await prisma.dispatchWorkerCity.deleteMany({ where: { workerId } });
    if (cityIds.length) {
      await prisma.dispatchWorkerCity.createMany({
        data: cityIds.map((cityId) => ({ workerId, cityId })),
        skipDuplicates: true
      });
    }
  }
  if (relationsProvided.vacancies) {
    await prisma.dispatchWorkerVacancy.deleteMany({ where: { workerId } });
    if (vacancyIds.length) {
      await prisma.dispatchWorkerVacancy.createMany({
        data: vacancyIds.map((vacancyId) => ({ workerId, vacancyId })),
        skipDuplicates: true
      });
    }
  }
}

function selectedReviewItems(items, selectedItemIds, applyAll) {
  const selected = new Set((selectedItemIds || []).map(String));
  return items.filter((item) => item?.actionable && (applyAll || selected.has(String(item.id))));
}

export async function applyDispatchWorkerImportBatch({
  prisma,
  batchId,
  ownerKey,
  selectedItemIds = [],
  applyAll = false,
  now = new Date()
} = {}) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.dispatchWorkerImportBatch.findFirst({
      where: { id: batchId, createdByUsername: ownerKey, status: 'PENDING' }
    });
    if (!batch) throw new DispatchWorkerExcelValidationError(['La revisión no existe, ya fue aplicada o pertenece a otro usuario.']);
    if (new Date(batch.expiresAt).getTime() <= now.getTime()) {
      await tx.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
      throw new DispatchWorkerExcelValidationError(['La revisión expiró. Vuelve a subir el archivo.']);
    }

    const items = Array.isArray(batch.items) ? batch.items : [];
    const targets = selectedReviewItems(items, selectedItemIds, applyAll);
    if (!targets.length) throw new DispatchWorkerExcelValidationError(['Selecciona al menos un auxiliar nuevo o un cambio para aprobar.']);

    const result = { created: 0, updated: 0, conflicts: 0, selected: targets.length };
    for (const item of targets) {
      const incoming = item.incoming || {};
      const workerData = incoming.workerData || {};
      if (item.type === 'NEW') {
        const existing = await tx.dispatchWorker.findFirst({
          where: { documentNumber: workerData.documentNumber },
          select: { id: true }
        });
        if (existing) {
          result.conflicts += 1;
          continue;
        }
        const worker = await tx.dispatchWorker.create({
          data: { ...workerData, source: 'EXCEL_IMPORT' }
        });
        await replaceWorkerRelations(tx, worker.id, incoming.cityIds || [], incoming.vacancyIds || [], { cities: true, vacancies: true });
        result.created += 1;
        continue;
      }

      if (item.type !== 'UPDATE' || !item.workerId) continue;
      const current = await tx.dispatchWorker.findUnique({
        where: { id: item.workerId },
        select: { id: true, updatedAt: true }
      });
      if (!current || new Date(current.updatedAt).toISOString() !== item.workerUpdatedAt) {
        result.conflicts += 1;
        continue;
      }

      const updateData = {};
      for (const field of incoming.providedWorkerFields || []) {
        if (field === 'documentNumber' || field === 'source') continue;
        updateData[field] = workerData[field] ?? null;
      }
      if (Object.keys(updateData).length) {
        await tx.dispatchWorker.update({ where: { id: current.id }, data: updateData });
      }
      await replaceWorkerRelations(
        tx,
        current.id,
        incoming.cityIds || [],
        incoming.vacancyIds || [],
        incoming.relationsProvided || { cities: false, vacancies: false }
      );
      result.updated += 1;
    }

    await tx.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
    return result;
  });
}

'''
service = service[:start] + review_block + service[end:]
service_path.write_text(service, encoding='utf-8')

route_path = ROOT / 'src/routes/dispatchOpsExtras.js'
route = route_path.read_text(encoding='utf-8')
route = replace_once(
    route,
    """import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  buildDispatchWorkerImportTemplate,
  importDispatchWorkerExcelWorkbook
} from '../services/dispatchWorkerExcelImport.js';
""",
    """import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  applyDispatchWorkerImportBatch,
  buildDispatchWorkerImportReview,
  buildDispatchWorkerImportTemplate
} from '../services/dispatchWorkerExcelImport.js';
""",
    'imports del flujo Excel'
)
route = replace_once(
    route,
    "const MAX_EXCEL_SIZE_BYTES = 5 * 1024 * 1024;",
    "const MAX_EXCEL_SIZE_BYTES = 5 * 1024 * 1024;\nconst DISPATCH_WORKER_IMPORT_REVIEW_TTL_MS = 2 * 60 * 60 * 1000;",
    'TTL de revisión'
)
route = replace_once(
    route,
    "function normalizeString(value) { if (typeof value !== 'string') return null; const trimmed = value.trim(); return trimmed.length ? trimmed : null; }",
    """function normalizeString(value) { if (typeof value !== 'string') return null; const trimmed = value.trim(); return trimmed.length ? trimmed : null; }
function dispatchWorkerImportOwnerKey(req) { return normalizeString(req.session?.username || req.username) || String(req.sessionID || 'anonymous-session'); }
""",
    'propietario de revisión'
)
route_start = route.index("  router.post('/personal/importar-excel', requireOps, parseDispatchWorkerExcelUpload")
route_end = route.index("  router.get('/personal/nuevo'", route_start)
new_routes = r'''  router.post('/personal/importar-excel', requireOps, parseDispatchWorkerExcelUpload, async (req, res) => {
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
      const review = await buildDispatchWorkerImportReview({ prisma, workbook, cities, vacancies });
      const now = new Date();
      await prisma.dispatchWorkerImportBatch.deleteMany({ where: { expiresAt: { lt: now } } });
      const batch = await prisma.dispatchWorkerImportBatch.create({
        data: {
          createdByUsername: dispatchWorkerImportOwnerKey(req),
          originalFileName: normalizeString(req.file.originalname),
          status: 'PENDING',
          items: review.items,
          summary: review.summary,
          expiresAt: new Date(now.getTime() + DISPATCH_WORKER_IMPORT_REVIEW_TTL_MS)
        }
      });
      return res.redirect(`/admin/operaciones/personal/importar-excel/${batch.id}/revision`);
    } catch (error) {
      console.error('[Dispatch worker Excel review]', {
        name: error?.name || 'Error',
        statusCode: error?.statusCode || null,
        errorCount: Array.isArray(error?.errors) ? error.errors.length : null
      });
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'Error al analizar el archivo.'));
    }
  });

  router.get('/personal/importar-excel/:batchId/revision', requireOps, async (req, res) => {
    const ownerKey = dispatchWorkerImportOwnerKey(req);
    const batch = await prisma.dispatchWorkerImportBatch.findFirst({
      where: { id: req.params.batchId, createdByUsername: ownerKey, status: 'PENDING' }
    });
    if (!batch || new Date(batch.expiresAt).getTime() <= Date.now()) {
      if (batch) await prisma.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent('La revisión no existe o expiró. Vuelve a subir el archivo.'));
    }
    return res.render('operacionesPersonalImportarRevision', {
      role: req.session?.userRole || req.userRole,
      batchId: batch.id,
      fileName: batch.originalFileName,
      expiresAt: batch.expiresAt,
      items: Array.isArray(batch.items) ? batch.items : [],
      summary: batch.summary || {}
    });
  });

  router.post('/personal/importar-excel/:batchId/aplicar', requireOps, async (req, res) => {
    try {
      const selectedItemIds = normalizeStringList(req.body.selectedItemIds);
      const result = await applyDispatchWorkerImportBatch({
        prisma,
        batchId: req.params.batchId,
        ownerKey: dispatchWorkerImportOwnerKey(req),
        selectedItemIds,
        applyAll: normalizeString(req.body.applyMode) === 'all'
      });
      const parts = [];
      if (result.created) parts.push(`${result.created} auxiliar${result.created !== 1 ? 'es creados' : ' creado'}`);
      if (result.updated) parts.push(`${result.updated} auxiliar${result.updated !== 1 ? 'es actualizados' : ' actualizado'}`);
      if (result.conflicts) parts.push(`${result.conflicts} omitido${result.conflicts !== 1 ? 's' : ''} porque cambió después de la revisión`);
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent(`Importación aplicada: ${parts.join(', ') || 'sin cambios'}.`));
    } catch (error) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'No fue posible aplicar la revisión.'));
    }
  });

  router.post('/personal/importar-excel/:batchId/cancelar', requireOps, async (req, res) => {
    await prisma.dispatchWorkerImportBatch.deleteMany({
      where: { id: req.params.batchId, createdByUsername: dispatchWorkerImportOwnerKey(req), status: 'PENDING' }
    });
    return res.redirect('/admin/operaciones/personal/importar-excel?message=' + encodeURIComponent('Revisión cancelada. No se aplicó ningún cambio.'));
  });

'''
route = route[:route_start] + new_routes + route[route_end:]
route_path.write_text(route, encoding='utf-8')

view_path = ROOT / 'src/views/operacionesPersonalImportar.ejs'
view = view_path.read_text(encoding='utf-8')
view = replace_once(
    view,
    'El sistema valida todas las filas antes de crear o actualizar auxiliares.',
    'El sistema analiza todas las filas y muestra una revisión antes de crear o actualizar cualquier auxiliar.',
    'descripción de análisis previo'
)
view = replace_once(view, '>Validar e importar<', '>Analizar archivo<', 'botón de análisis')
view = replace_once(
    view,
    '<strong>Documentos duplicados</strong>\n            <p>Un documento ya activo se omite. Un auxiliar desactivado se actualiza con los datos del Excel.</p>',
    '<strong>Auxiliares existentes</strong>\n            <p>Un documento existente no se rechaza ni se modifica automáticamente. Verás sus diferencias y podrás aprobarlas individualmente o en grupo.</p>',
    'explicación de existentes'
)
view_path.write_text(view, encoding='utf-8')

review_view = r'''<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Revisar importación — LoginPro</title>
  <link rel="icon" type="image/png" href="/public/favicon-loginpro.svg" />
  <style>
    * { box-sizing: border-box; }
    :root { --bg:#f4f5f7; --surface:#fff; --border:#dbe1e8; --text:#172033; --muted:#667085; --navy:#1e2d3d; --teal:#0d7a6b; --green:#166534; --amber:#92400e; --red:#991b1b; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); }
    .navbar { min-height:52px; padding:0 24px; background:var(--navy); display:flex; align-items:center; gap:18px; }
    .navbar a { color:#d8e0e8; text-decoration:none; font-size:13px; font-weight:700; }
    .navbar .brand img { height:28px; display:block; }
    .navbar .spacer { flex:1; }
    .logout { color:#fff; background:transparent; border:1px solid rgba(255,255,255,.28); border-radius:8px; padding:7px 12px; }
    main { max-width:1180px; margin:0 auto; padding:30px 18px 60px; display:grid; gap:18px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:22px; box-shadow:0 8px 24px rgba(15,23,42,.06); }
    h1,h2 { margin:0 0 8px; color:var(--navy); }
    .sub { margin:0; color:var(--muted); line-height:1.55; }
    .summary { display:grid; grid-template-columns:repeat(5,minmax(120px,1fr)); gap:12px; }
    .metric { background:#f8fafc; border:1px solid var(--border); border-radius:12px; padding:14px; }
    .metric strong { display:block; font-size:24px; color:var(--navy); }
    .metric span { color:var(--muted); font-size:12px; font-weight:700; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .buttons { display:flex; gap:9px; flex-wrap:wrap; }
    button,.button { min-height:40px; border-radius:9px; padding:9px 15px; border:1px solid var(--border); background:#fff; color:var(--navy); font-weight:800; cursor:pointer; text-decoration:none; }
    .primary { background:var(--teal); border-color:var(--teal); color:#fff; }
    .danger { color:var(--red); }
    .item { border:1px solid var(--border); border-radius:12px; margin-top:12px; overflow:hidden; }
    .item-head { display:flex; align-items:flex-start; gap:12px; padding:14px; background:#f8fafc; }
    .item-head input { margin-top:5px; width:18px; height:18px; }
    .grow { flex:1; min-width:0; }
    .name { font-size:15px; font-weight:900; color:var(--navy); }
    .doc { color:var(--muted); font-size:12px; margin-top:3px; }
    .badge { display:inline-flex; border-radius:999px; padding:4px 9px; font-size:10px; font-weight:900; }
    .badge-new { background:#dcfce7; color:var(--green); }
    .badge-update { background:#fef3c7; color:var(--amber); }
    .badge-unchanged { background:#e2e8f0; color:#475569; }
    .badge-conflict { background:#fee2e2; color:var(--red); }
    .changes { width:100%; border-collapse:collapse; font-size:12px; }
    .changes th,.changes td { padding:10px 12px; border-top:1px solid var(--border); text-align:left; vertical-align:top; }
    .changes th { color:var(--muted); background:#fcfcfd; }
    .current { color:#667085; }
    .incoming { color:#0f766e; font-weight:800; }
    .reason { padding:12px 14px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
    @media(max-width:780px){ .summary{grid-template-columns:repeat(2,1fr)} .changes thead{display:none} .changes tr{display:grid} .changes td{display:block} }
  </style>
</head>
<body>
  <nav class="navbar">
    <a class="brand" href="/admin"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <a href="/admin/operaciones">Operaciones / Despacho</a>
    <span class="spacer"></span>
    <form method="post" action="/logout"><button class="logout" type="submit">Cerrar sesión</button></form>
  </nav>
  <main>
    <section class="card">
      <h1>Revisar cambios del Excel</h1>
      <p class="sub">Archivo: <strong><%= fileName || 'archivo.xlsx' %></strong>. Todavía no se ha creado ni modificado ningún auxiliar. Selecciona lo que deseas aprobar.</p>
    </section>

    <section class="summary">
      <div class="metric"><strong><%= summary.total || 0 %></strong><span>Filas analizadas</span></div>
      <div class="metric"><strong><%= summary.newCount || 0 %></strong><span>Nuevos</span></div>
      <div class="metric"><strong><%= summary.updateCount || 0 %></strong><span>Con cambios</span></div>
      <div class="metric"><strong><%= summary.unchangedCount || 0 %></strong><span>Sin cambios</span></div>
      <div class="metric"><strong><%= summary.conflictCount || 0 %></strong><span>Conflictos</span></div>
    </section>

    <form class="card" method="post" action="/admin/operaciones/personal/importar-excel/<%= batchId %>/aplicar" id="reviewForm">
      <div class="toolbar">
        <label><input type="checkbox" id="selectAll" /> Seleccionar todos los aplicables</label>
        <div class="buttons">
          <button type="submit" name="applyMode" value="selected" class="primary">Aplicar seleccionados</button>
          <button type="submit" name="applyMode" value="all">Aplicar todos</button>
        </div>
      </div>

      <% items.forEach((item) => { %>
        <article class="item">
          <div class="item-head">
            <% if (item.actionable) { %><input class="item-check" type="checkbox" name="selectedItemIds" value="<%= item.id %>" checked /><% } %>
            <div class="grow">
              <div class="name"><%= item.displayName %></div>
              <div class="doc">Documento: <%= item.documentNumber %> · Fila <%= item.rowNumber %></div>
            </div>
            <span class="badge badge-<%= item.type.toLowerCase() %>"><%= item.type === 'NEW' ? 'Nuevo' : item.type === 'UPDATE' ? 'Cambios' : item.type === 'UNCHANGED' ? 'Sin cambios' : 'Conflicto' %></span>
          </div>
          <% if (item.changes && item.changes.length) { %>
            <table class="changes">
              <thead><tr><th>Campo</th><th>Actual</th><th>Excel</th></tr></thead>
              <tbody>
                <% item.changes.forEach((change) => { %>
                  <tr><td><strong><%= change.label %></strong></td><td class="current"><%= change.currentValue %></td><td class="incoming"><%= change.incomingValue %></td></tr>
                <% }) %>
              </tbody>
            </table>
          <% } %>
          <% if (item.reason) { %><div class="reason"><%= item.reason %></div><% } %>
        </article>
      <% }) %>
    </form>

    <form class="card" method="post" action="/admin/operaciones/personal/importar-excel/<%= batchId %>/cancelar">
      <div class="toolbar">
        <p class="sub">La revisión expira automáticamente. Cancelarla elimina la propuesta y no modifica ningún auxiliar.</p>
        <button type="submit" class="danger">Cancelar importación</button>
      </div>
    </form>
  </main>
  <script>
    const selectAll = document.getElementById('selectAll');
    const checks = () => Array.from(document.querySelectorAll('.item-check'));
    if (selectAll) {
      selectAll.checked = checks().length > 0 && checks().every((item) => item.checked);
      selectAll.addEventListener('change', () => checks().forEach((item) => { item.checked = selectAll.checked; }));
      checks().forEach((item) => item.addEventListener('change', () => { selectAll.checked = checks().every((current) => current.checked); }));
    }
  </script>
</body>
</html>
'''
(ROOT / 'src/views/operacionesPersonalImportarRevision.ejs').write_text(review_view, encoding='utf-8')

schema_path = ROOT / 'prisma/schema.prisma'
schema = schema_path.read_text(encoding='utf-8')
schema_anchor = 'model DispatchWorkerCity {'
batch_model = r'''model DispatchWorkerImportBatch {
  id                String   @id @default(cuid())
  createdByUsername String
  originalFileName  String?
  status            String   @default("PENDING")
  items             Json
  summary           Json
  expiresAt         DateTime
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([createdByUsername, status, expiresAt])
  @@index([expiresAt])
}

'''
if schema_anchor not in schema:
    raise SystemExit('No se encontró el punto de inserción del lote Excel')
schema = schema.replace(schema_anchor, batch_model + schema_anchor, 1)
schema_path.write_text(schema, encoding='utf-8')

migration_path = ROOT / 'prisma/migrations/20260725043000_dispatch_worker_import_review/migration.sql'
migration_path.parent.mkdir(parents=True, exist_ok=True)
migration_path.write_text(r'''CREATE TABLE "DispatchWorkerImportBatch" (
  "id" TEXT NOT NULL,
  "createdByUsername" TEXT NOT NULL,
  "originalFileName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "items" JSONB NOT NULL,
  "summary" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchWorkerImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispatchWorkerImportBatch_createdByUsername_status_expiresAt_idx"
  ON "DispatchWorkerImportBatch"("createdByUsername", "status", "expiresAt");

CREATE INDEX "DispatchWorkerImportBatch_expiresAt_idx"
  ON "DispatchWorkerImportBatch"("expiresAt");
''', encoding='utf-8')

test_path = ROOT / 'test/dispatchWorkerExcelImport.test.js'
test_path.write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  DispatchWorkerExcelValidationError,
  applyDispatchWorkerImportBatch,
  buildDispatchWorkerFullName,
  buildDispatchWorkerImportReview,
  buildDispatchWorkerImportTemplate,
  parseDispatchWorkerExcelWorksheet,
  prepareDispatchWorkerExcelRows
} from '../src/services/dispatchWorkerExcelImport.js';

const cities = [
  { id: 'city-bogota', name: 'Bogotá' },
  { id: 'city-siberia', name: 'Siberia' }
];
const vacancies = [
  { id: 'vac-bogota', title: 'Auxiliar de cargue y descargue', city: 'Bogotá' }
];

function workbookWithRows(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auxiliares');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook;
}

function minimalHeaders() {
  return ['Nombres', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'];
}

function minimalRow(overrides = {}) {
  const values = {
    firstNames: 'Ana María', lastNames: 'Pérez Gómez', phone: '3001234567', documentType: 'CC',
    documentNumber: '1020304050', residenceCity: 'Bogotá', residenceLocality: 'Suba', contractType: 'DIRECTO',
    ...overrides
  };
  return [values.firstNames, values.lastNames, values.phone, values.documentType, values.documentNumber, values.residenceCity, values.residenceLocality, values.contractType];
}

function existingWorker(overrides = {}) {
  return {
    id: 'worker-1', fullName: 'Ana María', phone: '3001234567', documentType: 'CC', documentNumber: '1020304050',
    residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: 'Moto', contractType: 'DIRECTO',
    operationalStatus: 'INACTIVE', notes: 'Conservar', updatedAt: new Date('2026-07-25T03:00:00.000Z'),
    cities: [{ city: { id: 'city-bogota', name: 'Bogotá' } }], vacancies: [], ...overrides
  };
}

test('Nombre singular y Apellidos se unen como nombre completo', () => {
  const workbook = workbookWithRows(
    ['Nombre', 'Apellidos', 'Teléfono', 'Tipo de documento', 'Número de documento', 'Ciudad de residencia', 'Localidad / barrio', 'Tipo de contrato'],
    [['Juan Carlos', 'Pérez Gómez', '3001234567', 'CC', '123', 'Bogotá', 'Suba', 'DIRECTO']]
  );
  const prepared = prepareDispatchWorkerExcelRows(parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]), { cities, vacancies });
  assert.equal(prepared[0].workerData.fullName, 'Juan Carlos Pérez Gómez');
});

test('las columnas separadas tienen prioridad sobre Nombre completo', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: 'Solo nombres', firstNames: 'Juan', lastNames: 'Pérez' }), 'Juan Pérez');
});

test('Nombre completo continúa funcionando cuando no hay columnas separadas', () => {
  assert.equal(buildDispatchWorkerFullName({ fullName: '  Ana   Pérez  ' }), 'Ana Pérez');
});

test('la revisión clasifica un auxiliar activo con apellido nuevo como UPDATE', async () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow()]);
  const prisma = { dispatchWorker: { findMany: async () => [existingWorker()] } };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook, cities, vacancies });
  assert.equal(review.summary.updateCount, 1);
  assert.equal(review.items[0].type, 'UPDATE');
  assert.equal(review.items[0].changes.find((change) => change.field === 'fullName').incomingValue, 'Ana María Pérez Gómez');
});

test('campos opcionales vacíos conservan valores existentes y no aparecen como cambios', async () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow({ lastNames: '' })]);
  assert.throws(() => parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]) && prepareDispatchWorkerExcelRows(parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]), { cities, vacancies }), /Nombres y Apellidos/);

  const validWorkbook = workbookWithRows(minimalHeaders(), [minimalRow()]);
  const current = existingWorker({ fullName: 'Ana María Pérez Gómez' });
  const prisma = { dispatchWorker: { findMany: async () => [current] } };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook: validWorkbook, cities, vacancies });
  const changedFields = review.items[0].changes.map((change) => change.field);
  assert.doesNotMatch(changedFields.join(','), /transportMode|operationalStatus|notes|cities|vacancies/);
  assert.equal(review.items[0].type, 'UNCHANGED');
});

test('un auxiliar nuevo queda pendiente de aprobación y no se crea durante el análisis', async () => {
  let created = 0;
  const prisma = {
    dispatchWorker: {
      findMany: async () => [],
      create: async () => { created += 1; }
    }
  };
  const review = await buildDispatchWorkerImportReview({ prisma, workbook: workbookWithRows(minimalHeaders(), [minimalRow()]), cities, vacancies });
  assert.equal(review.items[0].type, 'NEW');
  assert.equal(review.items[0].actionable, true);
  assert.equal(created, 0);
});

test('aplica únicamente los cambios seleccionados y elimina el lote', async () => {
  const updates = [];
  let deletedBatch = false;
  const item = {
    id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z',
    incoming: {
      workerData: { fullName: 'Ana María Pérez Gómez', phone: '3001234567', documentType: 'CC', documentNumber: '1020304050', residenceCity: 'Bogotá', residenceLocality: 'Suba', transportMode: null, contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', notes: null },
      providedWorkerFields: ['fullName', 'phone', 'documentType', 'documentNumber', 'residenceCity', 'residenceLocality', 'contractType'],
      relationsProvided: { cities: false, vacancies: false }, cityIds: [], vacancyIds: []
    }
  };
  const tx = {
    dispatchWorkerImportBatch: {
      findFirst: async () => ({ id: 'batch-1', status: 'PENDING', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }),
      delete: async () => { deletedBatch = true; }
    },
    dispatchWorker: {
      findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:00:00.000Z') }),
      update: async ({ data }) => { updates.push(data); }
    },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null },
    dispatchWorkerVacancy: { deleteMany: async () => null, createMany: async () => null }
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const result = await applyDispatchWorkerImportBatch({ prisma, batchId: 'batch-1', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.updated, 1);
  assert.equal(updates[0].fullName, 'Ana María Pérez Gómez');
  assert.equal('operationalStatus' in updates[0], false);
  assert.equal(deletedBatch, true);
});

test('un cambio concurrente se omite y no sobrescribe el auxiliar', async () => {
  let updateCalls = 0;
  const item = { id: 'row-2', type: 'UPDATE', actionable: true, workerId: 'worker-1', workerUpdatedAt: '2026-07-25T03:00:00.000Z', incoming: { workerData: {}, providedWorkerFields: [], relationsProvided: { cities: false, vacancies: false }, cityIds: [], vacancyIds: [] } };
  const tx = {
    dispatchWorkerImportBatch: { findFirst: async () => ({ id: 'batch', expiresAt: new Date('2026-07-25T06:00:00.000Z'), items: [item] }), delete: async () => null },
    dispatchWorker: { findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:30:00.000Z') }), update: async () => { updateCalls += 1; } },
    dispatchWorkerCity: { deleteMany: async () => null, createMany: async () => null },
    dispatchWorkerVacancy: { deleteMany: async () => null, createMany: async () => null }
  };
  const result = await applyDispatchWorkerImportBatch({ prisma: { $transaction: async (callback) => callback(tx) }, batchId: 'batch', ownerKey: 'coord', selectedItemIds: ['row-2'], now: new Date('2026-07-25T04:00:00.000Z') });
  assert.equal(result.conflicts, 1);
  assert.equal(updateCalls, 0);
});

test('la plantilla conserva Nombres y Apellidos separados', () => {
  const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
  const sheet = workbook.getWorksheet('Auxiliares');
  assert.equal(sheet.getCell('A1').value, 'Nombres');
  assert.equal(sheet.getCell('B1').value, 'Apellidos');
});

test('las rutas usan revisión y aprobación en vez de importación inmediata', () => {
  const route = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const view = fs.readFileSync('src/views/operacionesPersonalImportarRevision.ejs', 'utf8');
  assert.match(route, /buildDispatchWorkerImportReview/);
  assert.match(route, /dispatchWorkerImportBatch\.create/);
  assert.match(route, /importar-excel\/:batchId\/aplicar/);
  assert.doesNotMatch(route, /importDispatchWorkerExcelWorkbook/);
  assert.match(view, /Aplicar seleccionados/);
  assert.match(view, /Aplicar todos/);
  assert.match(view, /selectAll/);
});

test('la migración crea almacenamiento temporal de revisión', () => {
  const migration = fs.readFileSync('prisma/migrations/20260725043000_dispatch_worker_import_review/migration.sql', 'utf8');
  assert.match(migration, /CREATE TABLE "DispatchWorkerImportBatch"/);
  assert.match(migration, /"items" JSONB NOT NULL/);
  assert.match(migration, /"expiresAt" TIMESTAMP/);
});

test('rechaza documentos repetidos dentro del mismo archivo', () => {
  const workbook = workbookWithRows(minimalHeaders(), [minimalRow(), minimalRow({ firstNames: 'Otra', lastNames: 'Persona' })]);
  const parsed = parseDispatchWorkerExcelWorksheet(workbook.worksheets[0]);
  assert.throws(() => prepareDispatchWorkerExcelRows(parsed, { cities, vacancies }), DispatchWorkerExcelValidationError);
});
''', encoding='utf-8')
