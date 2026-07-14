import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const REMOVED_MODULE = path.resolve('src/services/responsePolicy.js');

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  }));
  return nested.flat();
}

test('responsePolicy fue eliminado y el runtime no vuelve a importarlo', async () => {
  await assert.rejects(access(REMOVED_MODULE));

  const runtimeFiles = await listJavaScriptFiles(path.resolve('src'));
  const references = [];

  for (const file of runtimeFiles) {
    const source = await readFile(file, 'utf8');
    if (/responsePolicy\.js/.test(source)) references.push(path.relative(process.cwd(), file));
  }

  assert.deepEqual(references, []);
});
