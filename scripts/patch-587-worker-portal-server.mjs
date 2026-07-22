import fs from 'node:fs';

const serverPath = 'src/server.js';
let source = fs.readFileSync(serverPath, 'utf8');

function replaceOnce(current, expected, replacement, label) {
  const first = current.indexOf(expected);
  if (first < 0) throw new Error(`patch_587_missing_${label}`);
  if (current.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`patch_587_duplicate_${label}`);
  }
  return current.replace(expected, replacement);
}

source = replaceOnce(
  source,
  "import { publicDispatchClientRouter } from './routes/publicDispatchClient.js';\n",
  "import { publicDispatchClientRouter } from './routes/publicDispatchClient.js';\nimport { workerPortalRouter } from './routes/workerPortal.js';\n",
  'worker_portal_import'
);

source = replaceOnce(
  source,
  "app.use('/operaciones', wrapAsyncRouter(publicDispatchClientRouter()));\n",
  "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));\napp.use('/operaciones', wrapAsyncRouter(publicDispatchClientRouter()));\n",
  'worker_portal_mount'
);

if ((source.match(/workerPortalRouter/g) || []).length !== 2) {
  throw new Error('patch_587_worker_portal_reference_count_invalid');
}

fs.writeFileSync(serverPath, source);
