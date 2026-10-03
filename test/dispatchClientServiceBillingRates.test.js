import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('DispatchClientService expone billingRates como Json en el esquema', async () => {
  const schema = await fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /model DispatchClientService[\s\S]*billingRates\s+Json\?/);
});

