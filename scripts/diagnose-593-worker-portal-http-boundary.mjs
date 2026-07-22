import { mkdirSync, writeFileSync } from 'node:fs';

try {
  await import('./apply-593-worker-portal-http-boundary.mjs');
  mkdirSync('diagnostics', { recursive: true });
  writeFileSync('diagnostics/593-apply-result.txt', 'success\n', 'utf8');
} catch (error) {
  mkdirSync('diagnostics', { recursive: true });
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  writeFileSync('diagnostics/593-apply-result.txt', `${message}\n`, 'utf8');
  console.error(message);
}
