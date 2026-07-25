from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'No se encontró el bloque esperado: {label}')
    return text.replace(old, new, 1)

service_path = Path('src/services/dispatchWorkerExcelImport.js')
service = service_path.read_text(encoding='utf-8')
service = service.replace("const DISABLED_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];\n", '', 1)
service = service.replace("const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT', 'CANDIDATE'];\n", '', 1)
service = replace_once(
    service,
    """    if (new Date(batch.expiresAt).getTime() <= now.getTime()) {
      await tx.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
      throw new DispatchWorkerExcelValidationError(['La revisión expiró. Vuelve a subir el archivo.']);
    }
""",
    """    if (new Date(batch.expiresAt).getTime() <= now.getTime()) {
      throw new DispatchWorkerExcelValidationError(['La revisión expiró. Vuelve a subir el archivo.']);
    }
""",
    'revisión expirada dentro de transacción'
)
service = replace_once(
    service,
    """      const current = await tx.dispatchWorker.findUnique({
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
""",
    """      const updateData = {};
      for (const field of incoming.providedWorkerFields || []) {
        if (field === 'documentNumber' || field === 'source') continue;
        updateData[field] = workerData[field] ?? null;
      }
      const expectedUpdatedAt = new Date(item.workerUpdatedAt || Number.NaN);
      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        result.conflicts += 1;
        continue;
      }
      const updated = await tx.dispatchWorker.updateMany({
        where: { id: item.workerId, updatedAt: expectedUpdatedAt },
        data: Object.keys(updateData).length ? updateData : { updatedAt: now }
      });
      if (!updated.count) {
        result.conflicts += 1;
        continue;
      }
      await replaceWorkerRelations(
        tx,
        item.workerId,
""",
    'actualización optimista atómica'
)
service_path.write_text(service, encoding='utf-8')

route_path = Path('src/routes/dispatchOpsExtras.js')
route = route_path.read_text(encoding='utf-8')
route = replace_once(
    route,
    """  router.get('/personal/importar-excel', requireOps, async (req, res) => {
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
""",
    """  router.get('/personal/importar-excel', requireOps, async (req, res) => {
    await prisma.dispatchWorkerImportBatch.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
""",
    'limpieza de revisiones expiradas'
)
route_path.write_text(route, encoding='utf-8')

view_path = Path('src/views/operacionesPersonalImportar.ejs')
view = view_path.read_text(encoding='utf-8')
view = replace_once(
    view,
    "    <% if (error) { %><div class=\"alert-error\">⚠ <%= error %></div><% } %>\n",
    """    <% if (error) { %><div class=\"alert-error\">⚠ <%= error %></div><% } %>
    <% if (message) { %><div class=\"warning-box\" style=\"background:#ecfdf5;border-color:#86efac;color:#166534;\"><%= message %></div><% } %>
""",
    'mensaje de cancelación'
)
view = replace_once(
    view,
    '<p>Estado operativo es opcional. Si la columna no existe o la celda está vacía, el auxiliar se guarda como <strong>Contratado</strong>.</p>',
    '<p>En auxiliares nuevos, una celda vacía se guarda como <strong>Contratado</strong>. En auxiliares existentes, una celda vacía conserva el estado actual.</p>',
    'explicación de estado por tipo de registro'
)
view_path.write_text(view, encoding='utf-8')

test_path = Path('test/dispatchWorkerExcelImport.test.js')
test = test_path.read_text(encoding='utf-8')
test = replace_once(
    test,
    """    dispatchWorker: {
      findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:00:00.000Z') }),
      update: async ({ data }) => { updates.push(data); }
    },
""",
    """    dispatchWorker: {
      updateMany: async ({ where, data }) => {
        assert.equal(where.id, 'worker-1');
        assert.equal(new Date(where.updatedAt).toISOString(), '2026-07-25T03:00:00.000Z');
        updates.push(data);
        return { count: 1 };
      }
    },
""",
    'prueba de actualización seleccionada'
)
test = replace_once(
    test,
    """    dispatchWorker: { findUnique: async () => ({ id: 'worker-1', updatedAt: new Date('2026-07-25T03:30:00.000Z') }), update: async () => { updateCalls += 1; } },
""",
    """    dispatchWorker: { updateMany: async () => { updateCalls += 1; return { count: 0 }; } },
""",
    'prueba de conflicto concurrente'
)
test = replace_once(
    test,
    """  assert.equal(result.conflicts, 1);
  assert.equal(updateCalls, 0);
});
""",
    """  assert.equal(result.conflicts, 1);
  assert.equal(updateCalls, 1);
});
""",
    'resultado de control optimista'
)
test += """

test('la pantalla aclara que el estado vacío conserva auxiliares existentes', () => {
  const view = fs.readFileSync('src/views/operacionesPersonalImportar.ejs', 'utf8');
  const route = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  assert.match(view, /En auxiliares existentes, una celda vacía conserva el estado actual/);
  assert.match(route, /dispatchWorkerImportBatch\.deleteMany\(\{ where: \{ expiresAt/);
});
"""
test_path.write_text(test, encoding='utf-8')
