import fs from 'node:fs';

const path = 'src/server.js';
const importAnchor = "import { workerPortalRouter } from './routes/workerPortal.js';";
const importStatement = "import { workerPortalCompatibilityRouter } from './routes/workerPortalCompatibility.js';";
const portalMount = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
const compatibilityMount = 'app.use(workerPortalCompatibilityRouter());';

let source = fs.readFileSync(path, 'utf8');

if (!source.includes(importAnchor)) throw new Error('worker portal import anchor not found');
if (!source.includes(portalMount)) throw new Error('worker portal mount anchor not found');
if (source.includes(importStatement) || source.includes(compatibilityMount)) {
  throw new Error('worker portal compatibility already mounted');
}

source = source.replace(importAnchor, `${importAnchor}\n${importStatement}`);
source = source.replace(portalMount, `${compatibilityMount}\n${portalMount}`);

if ((source.split(importStatement).length - 1) !== 1) throw new Error('compatibility import must be unique');
if ((source.split(compatibilityMount).length - 1) !== 1) throw new Error('compatibility mount must be unique');
if (source.indexOf(compatibilityMount) > source.indexOf(portalMount)) {
  throw new Error('compatibility mount must precede public portal');
}

fs.writeFileSync(path, source);
