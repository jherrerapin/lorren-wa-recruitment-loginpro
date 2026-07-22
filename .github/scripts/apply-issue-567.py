from pathlib import Path
import re


def replace_once(path, old, new):
    file_path = Path(path)
    content = file_path.read_text(encoding='utf-8')
    if new in content and old not in content:
        return
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'{path}: se esperaba una coincidencia y se encontraron {count}')
    file_path.write_text(content.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/views/operacionesDashboard.ejs',
    '<a class="btn" href="/admin/operaciones/solicitudes">Solicitudes de servicio</a>',
    '<a class="btn" href="/admin/operaciones/solicitudes">Crear solicitud</a>'
)
replace_once(
    'src/views/operacionesDashboard.ejs',
    '<small>Consulta solicitudes creadas por clientes o internas.</small>',
    '<small>Abre el formulario para registrar una nueva solicitud operativa.</small>'
)
replace_once(
    'src/views/operacionesClientes.ejs',
    '<a class="btn btn-primary" href="/admin/operaciones/solicitudes">Solicitudes de servicio</a>',
    '<a class="btn btn-primary" href="/admin/operaciones/solicitudes">Crear solicitud</a>'
)
replace_once(
    'src/views/operacionesAsignacionesConfirmacion.ejs',
    'href="/admin/operaciones/solicitudes">Solicitudes de servicio</a>',
    'href="/admin/operaciones/solicitudes">Crear solicitud</a>'
)
replace_once(
    'src/views/operacionesAsignaciones.ejs',
    '<a class="btn" href="/admin/operaciones/solicitudes">Solicitudes de servicio</a>',
    '<a class="btn" href="/admin/operaciones/solicitudes">Crear solicitud</a>'
)
replace_once(
    'src/views/operacionesClienteOperaciones.ejs',
    '<a class="btn btn-primary" href="/admin/operaciones/asignaciones">Solicitudes de servicio</a>',
    '<a class="btn btn-primary" href="/admin/operaciones/asignaciones">Ir a asignación</a>'
)

status_path = Path('src/views/operacionesWhatsappEstado.ejs')
status_view = status_path.read_text(encoding='utf-8')
if '<% if (role === \'dev\') { %><div class="storage-box ' not in status_view:
    pattern = re.compile(r'(?m)^(\s*)(<div class="storage-box .*?</div>)$')
    status_view, count = pattern.subn(r"\1<% if (role === 'dev') { %>\2<% } %>", status_view, count=1)
    if count != 1:
        raise SystemExit(f'operacionesWhatsappEstado.ejs: se esperaba un bloque storage-box y se encontraron {count}')
    status_path.write_text(status_view, encoding='utf-8')

clients_test_path = Path('test/dispatchClientsOperationsContracts.test.js')
clients_test = clients_test_path.read_text(encoding='utf-8')
old_contract = "['worker-list', 'max-height', 'request-list', 'Clientes', 'Solicitudes de servicio', 'Crear solicitud interna']"
new_contract = "['worker-list', 'max-height', 'request-list', 'Clientes', 'Crear solicitud', 'Crear solicitud interna']"
if old_contract in clients_test:
    clients_test = clients_test.replace(old_contract, new_contract, 1)
elif new_contract not in clients_test:
    raise SystemExit('No se encontró el contrato histórico de navegación de despacho.')

marker = "test('dispatch action labels describe their actual destinations'"
if marker not in clients_test:
    clients_test += """

test('dispatch action labels describe their actual destinations', () => {
  const dashboard = fs.readFileSync('src/views/operacionesDashboard.ejs', 'utf8');
  const clients = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const assignment = fs.readFileSync('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8');
  const legacyAssignment = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');
  const clientOperations = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
  const creationLink = /href=\"\\/admin\\/operaciones\\/solicitudes\">Crear solicitud<\\/a>/;

  [dashboard, clients, assignment, legacyAssignment].forEach((view) => {
    assert.match(view, creationLink);
    assert.doesNotMatch(view, /href=\"\\/admin\\/operaciones\\/solicitudes\">Solicitudes de servicio<\\/a>/);
  });
  assert.match(dashboard, /Abre el formulario para registrar una nueva solicitud operativa\./);
  assert.match(clientOperations, /href=\"\\/admin\\/operaciones\\/asignaciones\">Ir a asignación<\\/a>/);
});
"""
clients_test_path.write_text(clients_test, encoding='utf-8')

runtime_test_path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
runtime_test = runtime_test_path.read_text(encoding='utf-8')
old_block = """test('WhatsApp status screen visibly reports persistent or ephemeral LocalAuth storage', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.match(view, /id=\"storageBox\"/);
  assert.match(view, /Sesión persistente/);
  assert.match(view, /Sesión en almacenamiento efímero/);
  assert.match(view, /renderStorageStatus\(data\)/);
});"""
new_block = """test('WhatsApp storage diagnostics remain restricted to DEV', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.match(view, /<% if \(role === 'dev'\) \{ %><div class=\"storage-box/);
  assert.match(view, /id=\"storageBox\"/);
  assert.match(view, /Sesión persistente/);
  assert.match(view, /Sesión en almacenamiento efímero/);
  assert.match(view, /renderStorageStatus\(data\)/);
});"""
if old_block in runtime_test:
    runtime_test = runtime_test.replace(old_block, new_block, 1)
elif new_block not in runtime_test:
    raise SystemExit('No se encontró el contrato de visibilidad de persistencia WhatsApp.')
runtime_test_path.write_text(runtime_test, encoding='utf-8')
