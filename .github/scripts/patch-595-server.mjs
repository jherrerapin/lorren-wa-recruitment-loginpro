import fs from 'node:fs';

const path = 'src/server.js';
const mount = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
const globalParser = "app.use(express.json({ limit: '2mb' }));";

let source = fs.readFileSync(path, 'utf8');
const mountOccurrences = source.split(mount).length - 1;
if (mountOccurrences !== 1) {
  throw new Error(`expected one worker portal mount, found ${mountOccurrences}`);
}
if (!source.includes(globalParser)) {
  throw new Error('global JSON parser anchor not found');
}

source = source.replace(`${mount}\n`, '');
source = source.replace(globalParser, `${mount}\n${globalParser}`);

if (source.indexOf(mount) < 0 || source.indexOf(mount) > source.indexOf(globalParser)) {
  throw new Error('worker portal must be mounted before global JSON parser');
}
if ((source.split(mount).length - 1) !== 1) {
  throw new Error('worker portal mount must remain unique');
}

fs.writeFileSync(path, source);
