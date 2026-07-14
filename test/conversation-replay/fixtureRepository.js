import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FIXTURES_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));

function collectJsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectJsonFiles(fullPath);
      return entry.name.endsWith('.json') ? [fullPath] : [];
    })
    .sort();
}

export function loadConversationFixtures() {
  return collectJsonFiles(FIXTURES_ROOT).map((filePath) => {
    const relativePath = path.relative(FIXTURES_ROOT, filePath);
    try {
      return {
        filePath,
        relativePath,
        fixture: JSON.parse(readFileSync(filePath, 'utf8'))
      };
    } catch (error) {
      throw new Error(`Error al parsear JSON en ${relativePath}: ${error.message}`, { cause: error });
    }
  });
}
