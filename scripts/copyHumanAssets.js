import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('@vladmandic/human/package.json'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'src', 'public', 'vendor', 'human');
const modelNames = ['blazeface.json', 'facemesh.json', 'iris.json', 'faceres.json', 'antispoof.json', 'liveness.json'];

async function copyModel(modelName) {
  const source = path.join(root, 'models', modelName);
  const target = path.join(destination, 'models', modelName);
  await cp(source, target);
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  const shards = new Set((manifest.weightsManifest || []).flatMap((group) => group.paths || []));
  for (const shard of shards) {
    await cp(path.join(root, 'models', shard), path.join(destination, 'models', shard));
  }
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, 'models'), { recursive: true });
await cp(path.join(root, 'dist', 'human.js'), path.join(destination, 'human.js'));
for (const modelName of modelNames) await copyModel(modelName);
console.log(`[worker-biometric] Human ${modelNames.length} modelos preparados en ${destination}`);
