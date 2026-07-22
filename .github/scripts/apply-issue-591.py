from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, content):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(content, encoding='utf-8')


def replace_once(path, old, new):
    content = read(path)
    if new in content and old not in content:
        return
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'{path}: se esperaba 1 coincidencia exacta y se encontraron {count}')
    write(path, content.replace(old, new, 1))


def sub_once(path, pattern, replacement, flags=0):
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: se esperaba 1 coincidencia regex y se encontraron {count}: {pattern}')
    write(path, updated)


# 1. Prisma schema: marca persistente para perfiles de prueba.
schema_path = 'prisma/schema.prisma'
replace_once(
    schema_path,
    '  contractType      DispatchContractType    @default(DIRECTO)\n',
    '  contractType      DispatchContractType    @default(DIRECTO)\n  isTestProfile    Boolean                 @default(false)\n'
)

# 2. Migración aditiva: marca Jhon Herrera y corrige solicitudes ya afectadas.
migration_path = 'prisma/migrations/20260722180500_exclude_dispatch_test_worker/migration.sql'
write(migration_path, '''ALTER TABLE "DispatchWorker"\nADD COLUMN "isTestProfile" BOOLEAN NOT NULL DEFAULT false;\n\nUPDATE "DispatchWorker"\nSET "isTestProfile" = true\nWHERE regexp_replace(lower(trim("fullName")), '\\s+', ' ', 'g') = 'jhon herrera';\n\nWITH "OperationalCoverage" AS (\n  SELECT\n    request."id" AS "serviceRequestId",\n    request."requiredWorkers" AS "requiredWorkers",\n    COUNT(assignment."id") FILTER (\n      WHERE assignment."status" IN ('ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED')\n        AND COALESCE(worker."isTestProfile", false) = false\n    )::int AS "activeCount",\n    COUNT(assignment."id") FILTER (\n      WHERE assignment."status" = 'CONFIRMED'\n        AND COALESCE(worker."isTestProfile", false) = false\n    )::int AS "confirmedCount"\n  FROM "DispatchServiceRequest" request\n  LEFT JOIN "DispatchAssignment" assignment\n    ON assignment."serviceRequestId" = request."id"\n  LEFT JOIN "DispatchWorker" worker\n    ON worker."id" = assignment."workerId"\n  WHERE EXISTS (\n    SELECT 1\n    FROM "DispatchAssignment" test_assignment\n    JOIN "DispatchWorker" test_worker\n      ON test_worker."id" = test_assignment."workerId"\n    WHERE test_assignment."serviceRequestId" = request."id"\n      AND test_worker."isTestProfile" = true\n  )\n  GROUP BY request."id", request."requiredWorkers"\n)\nUPDATE "DispatchServiceRequest" request\nSET "status" = CASE\n  WHEN coverage."confirmedCount" >= coverage."requiredWorkers" THEN 'ASSIGNMENT_COMPLETE'\n  WHEN coverage."activeCount" >= coverage."requiredWorkers" THEN 'PENDING_CONFIRMATION'\n  WHEN coverage."activeCount" > 0 THEN 'ASSIGNMENT_PARTIAL'\n  ELSE 'PENDING_ASSIGNMENT'\nEND\nFROM "OperationalCoverage" coverage\nWHERE request."id" = coverage."serviceRequestId";\n''')

# 3. Autoridad central para contar solo auxiliares operativos reales.
coverage_path = 'src/services/dispatchOperationalCoverage.js'
write(coverage_path, '''export const ACTIVE_DISPATCH_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];\nexport const CONFIRMED_DISPATCH_ASSIGNMENT_STATUS = 'CONFIRMED';\n\nexport function isOperationalDispatchWorker(worker) {\n  return !Boolean(worker?.isTestProfile);\n}\n\nexport function operationalAssignments(request = {}) {\n  return (request.assignments || []).filter((assignment) => (\n    ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment?.status)\n    && isOperationalDispatchWorker(assignment?.worker)\n  ));\n}\n\nexport function confirmedOperationalAssignments(request = {}) {\n  return (request.assignments || []).filter((assignment) => (\n    assignment?.status === CONFIRMED_DISPATCH_ASSIGNMENT_STATUS\n    && isOperationalDispatchWorker(assignment?.worker)\n  ));\n}\n\nexport function deriveDispatchRequestOperationalState(request = {}) {\n  const requiredWorkers = Math.max(0, Number(request.requiredWorkers || 0));\n  const activeCount = operationalAssignments(request).length;\n  const confirmedCount = confirmedOperationalAssignments(request).length;\n  let status = 'PENDING_ASSIGNMENT';\n  if (confirmedCount >= requiredWorkers && requiredWorkers > 0) status = 'ASSIGNMENT_COMPLETE';\n  else if (activeCount >= requiredWorkers && requiredWorkers > 0) status = 'PENDING_CONFIRMATION';\n  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';\n  return { status, activeCount, confirmedCount, requiredWorkers };\n}\n\nexport async function recalculateDispatchServiceRequestStatus(prisma, serviceRequestId) {\n  const request = await prisma.dispatchServiceRequest.findUnique({\n    where: { id: serviceRequestId },\n    select: {\n      id: true,\n      requiredWorkers: true,\n      assignments: {\n        where: { status: { in: ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } },\n        select: {\n          status: true,\n          worker: { select: { isTestProfile: true } }\n        }\n      }\n    }\n  });\n  if (!request) return null;\n  const state = deriveDispatchRequestOperationalState(request);\n  await prisma.dispatchServiceRequest.update({\n    where: { id: serviceRequestId },\n    data: { status: state.status }\n  });\n  return state;\n}\n''')

# 4. Autoasignación: no rankea ni consume cupos con perfiles de prueba.
auto_path = 'src/services/dispatchAutoAssignment.js'
replace_once(
    auto_path,
    "} from './dispatchDate.js';\n",
    "} from './dispatchDate.js';\nimport { operationalAssignments, recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';\n"
)
replace_once(
    auto_path,
    "    if (!workerId || !worker || worker.operationalStatus !== 'CONTRATADO') continue;\n",
    "    if (!workerId || !worker || worker.operationalStatus !== 'CONTRATADO' || worker.isTestProfile) continue;\n"
)
sub_once(
    auto_path,
    r"async function recalculateRequestStatus\(prisma, serviceRequestId\) \{.*?\n\}\n\nexport async function autoAssignServiceRequest",
    "async function recalculateRequestStatus(prisma, serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);\n}\n\nexport async function autoAssignServiceRequest",
    re.S
)
replace_once(
    auto_path,
    "        select: { workerId: true, status: true }\n",
    "        select: {\n          workerId: true,\n          status: true,\n          worker: { select: { isTestProfile: true } }\n        }\n"
)
replace_once(
    auto_path,
    "    Number(request.requiredWorkers || 0) - (request.assignments || []).length,\n",
    "    Number(request.requiredWorkers || 0) - operationalAssignments(request).length,\n"
)
replace_once(
    auto_path,
    "      worker: { operationalStatus: 'CONTRATADO' }\n",
    "      worker: { operationalStatus: 'CONTRATADO', isTestProfile: false }\n"
)
replace_once(
    auto_path,
    "          operationalStatus: true,\n",
    "          operationalStatus: true,\n          isTestProfile: true,\n"
)

# 5-9. Todos los caminos que recalculan solicitudes usan la misma autoridad.
recalc_targets = [
    ('src/routes/dispatchOpsExtras.js', "import { normalizeTransportMode } from '../services/transportMode.js';\n", "import { normalizeTransportMode } from '../services/transportMode.js';\nimport { recalculateDispatchServiceRequestStatus } from '../services/dispatchOperationalCoverage.js';\n", 'prisma'),
    ('src/services/dispatchWhatsappWebServiceV6.js', "import { prisma } from '../lib/prisma.js';\n", "import { prisma } from '../lib/prisma.js';\nimport { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';\n", None),
    ('src/services/dispatchWorkerDeactivationAnalytics.js', "import { PrismaClient } from '@prisma/client';\n", "import { PrismaClient } from '@prisma/client';\nimport { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';\n", 'prismaClient'),
    ('src/services/dispatchWorkerToggleAnySource.js', "import { PrismaClient } from '@prisma/client';\n", "import { PrismaClient } from '@prisma/client';\nimport { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';\n", 'prismaClient'),
    ('src/services/dispatchWorkerExitReasons.js', "import { PrismaClient } from '@prisma/client';\n", "import { PrismaClient } from '@prisma/client';\nimport { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';\n", 'prismaClient')
]
for path, old_import, new_import, client_name in recalc_targets:
    replace_once(path, old_import, new_import)
    content = read(path)
    if path.endswith('dispatchWhatsappWebServiceV6.js'):
        pattern = r"async function recalculateServiceRequestStatus\(serviceRequestId\) \{.*?\n\}"
        replacement = "async function recalculateServiceRequestStatus(serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);\n}"
    elif path.endswith('dispatchOpsExtras.js'):
        pattern = r"async function recalculateServiceRequestStatus\(prisma, serviceRequestId\) \{.*?\n\}"
        replacement = "async function recalculateServiceRequestStatus(prisma, serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);\n}"
    elif path.endswith('dispatchWorkerDeactivationAnalytics.js'):
        pattern = r"async function recalculateServiceRequestStatus\(prismaClient, serviceRequestId\) \{.*?\n\}"
        replacement = "async function recalculateServiceRequestStatus(prismaClient, serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prismaClient, serviceRequestId);\n}"
    else:
        pattern = r"async function recalculateRequest\(prismaClient, serviceRequestId\) \{.*?\n\}"
        replacement = "async function recalculateRequest(prismaClient, serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prismaClient, serviceRequestId);\n}"
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: no se pudo centralizar el recálculo')
    write(path, updated)

# 10. PDF/WhatsApp de programación: omite el perfil de pruebas y usa estado efectivo.
pdf_path = 'src/services/dispatchProgrammingPdfService.js'
replace_once(
    pdf_path,
    "} from './dispatchDate.js';\n",
    "} from './dispatchDate.js';\nimport { deriveDispatchRequestOperationalState, operationalAssignments } from './dispatchOperationalCoverage.js';\n"
)
replace_once(
    pdf_path,
    "function activeAssignments(request) {\n  return (request.assignments || []).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status));\n}\n",
    "function activeAssignments(request) {\n  return operationalAssignments(request);\n}\n\nfunction effectiveRequestStatus(request) {\n  return deriveDispatchRequestOperationalState(request).status;\n}\n"
)
replace_once(
    pdf_path,
    "  const completedRequests = requests.filter((request) => request.status === COMPLETE_REQUEST_STATUS).length;\n",
    "  const completedRequests = requests.filter((request) => effectiveRequestStatus(request) === COMPLETE_REQUEST_STATUS).length;\n"
)
replace_once(
    pdf_path,
    "  return requests.filter((request) => request.status === COMPLETE_REQUEST_STATUS);\n",
    "  return requests.filter((request) => effectiveRequestStatus(request) === COMPLETE_REQUEST_STATUS);\n"
)
replace_once(
    pdf_path,
    "            <span class=\"request-status ${requestStatusClass(request.status)}\">${escapeHtml(requestStatusLabel(request.status))}</span>\n",
    "            <span class=\"request-status ${requestStatusClass(effectiveRequestStatus(request))}\">${escapeHtml(requestStatusLabel(effectiveRequestStatus(request)))}</span>\n"
)

# 11. Dashboard, pendientes y Excel: cobertura y estado efectivos.
dash_path = 'src/routes/dispatchDashboardMetrics.js'
replace_once(
    dash_path,
    "} from '../services/dispatchDate.js';\n",
    "} from '../services/dispatchDate.js';\nimport { confirmedOperationalAssignments, deriveDispatchRequestOperationalState, operationalAssignments } from '../services/dispatchOperationalCoverage.js';\n"
)
replace_once(
    dash_path,
    "function activeAssignments(request) {\n  return (request.assignments || []).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status));\n}\n\nfunction confirmedAssignments(request) {\n  return (request.assignments || []).filter((assignment) => assignment.status === CONFIRMED_ASSIGNMENT_STATUS);\n}\n",
    "function activeAssignments(request) {\n  return operationalAssignments(request);\n}\n\nfunction confirmedAssignments(request) {\n  return confirmedOperationalAssignments(request);\n}\n"
)
replace_once(
    dash_path,
    "  return filterDispatchServiceRequestsByDate(requests, selectedDate);\n",
    "  return filterDispatchServiceRequestsByDate(requests, selectedDate).map((request) => ({\n    ...request,\n    status: deriveDispatchRequestOperationalState(request).status\n  }));\n"
)

# 12. Regresiones enfocadas.
test_path = 'test/dispatchTestWorkerExclusion.test.js'
write(test_path, '''import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\nimport {\n  confirmedOperationalAssignments,\n  deriveDispatchRequestOperationalState,\n  operationalAssignments\n} from '../src/services/dispatchOperationalCoverage.js';\n\nfunction source(path) {\n  return fs.readFileSync(path, 'utf8');\n}\n\ntest('perfil de pruebas no cuenta como asignado ni confirmado', () => {\n  const request = {\n    requiredWorkers: 1,\n    assignments: [{ status: 'CONFIRMED', worker: { fullName: 'Jhon Herrera', isTestProfile: true } }]\n  };\n  assert.equal(operationalAssignments(request).length, 0);\n  assert.equal(confirmedOperationalAssignments(request).length, 0);\n  assert.deepEqual(deriveDispatchRequestOperationalState(request), {\n    status: 'PENDING_ASSIGNMENT',\n    activeCount: 0,\n    confirmedCount: 0,\n    requiredWorkers: 1\n  });\n});\n\ntest('auxiliar real sigue determinando pendiente o completa', () => {\n  const pending = {\n    requiredWorkers: 1,\n    assignments: [\n      { status: 'CONFIRMED', worker: { isTestProfile: true } },\n      { status: 'CONFIRMATION_PENDING', worker: { isTestProfile: false } }\n    ]\n  };\n  assert.equal(deriveDispatchRequestOperationalState(pending).status, 'PENDING_CONFIRMATION');\n  pending.assignments[1].status = 'CONFIRMED';\n  assert.equal(deriveDispatchRequestOperationalState(pending).status, 'ASSIGNMENT_COMPLETE');\n});\n\ntest('migración marca Jhon Herrera y recalcula solicitudes afectadas', () => {\n  const schema = source('prisma/schema.prisma');\n  const migration = source('prisma/migrations/20260722180500_exclude_dispatch_test_worker/migration.sql');\n  assert.match(schema, /isTestProfile\s+Boolean\s+@default\(false\)/);\n  assert.match(migration, /jhon herrera/);\n  assert.match(migration, /OperationalCoverage/);\n  assert.match(migration, /COALESCE\(worker\.\"isTestProfile\", false\) = false/);\n});\n\ntest('autoasignación excluye perfiles de prueba y no les reserva cupos', () => {\n  const auto = source('src/services/dispatchAutoAssignment.js');\n  assert.match(auto, /worker\.isTestProfile/);\n  assert.match(auto, /isTestProfile: false/);\n  assert.match(auto, /operationalAssignments\(request\)\.length/);\n});\n\ntest('reportes y tablero comparten la cobertura operativa', () => {\n  const pdf = source('src/services/dispatchProgrammingPdfService.js');\n  const dashboard = source('src/routes/dispatchDashboardMetrics.js');\n  assert.match(pdf, /operationalAssignments/);\n  assert.match(pdf, /effectiveRequestStatus/);\n  assert.match(dashboard, /confirmedOperationalAssignments/);\n  assert.match(dashboard, /deriveDispatchRequestOperationalState/);\n});\n\ntest('todos los recalculadores principales usan la autoridad central', () => {\n  for (const path of [\n    'src/routes/dispatchOpsExtras.js',\n    'src/services/dispatchWhatsappWebServiceV6.js',\n    'src/services/dispatchWorkerDeactivationAnalytics.js',\n    'src/services/dispatchWorkerToggleAnySource.js',\n    'src/services/dispatchWorkerExitReasons.js'\n  ]) {\n    const content = source(path);\n    assert.match(content, /recalculateDispatchServiceRequestStatus/);\n    assert.doesNotMatch(content, /dispatchAssignment\.count\(\{ where: \{ serviceRequestId/);\n  }\n});\n''')

print('Issue #591 aplicado correctamente.')
