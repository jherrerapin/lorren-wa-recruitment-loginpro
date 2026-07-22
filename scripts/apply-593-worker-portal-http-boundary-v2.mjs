import { readFileSync, writeFileSync } from 'node:fs';

const generator = new URL('./apply-593-worker-portal-http-boundary.mjs', import.meta.url);
let content = readFileSync(generator, 'utf8');
content = content.replace(
  'globales. `POST /activar` aplica su propio límite',
  'globales. \\`POST /activar\\` aplica su propio límite'
);
writeFileSync(generator, content, 'utf8');
await import(`${generator.href}?v=2`);
