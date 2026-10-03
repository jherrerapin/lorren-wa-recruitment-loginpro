import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountChargeHtml } from '../src/services/lorrenBillingPdf.js';

test('cuenta de cobro alinea los datos bancarios y usa la nota corregida', () => {
  const html = buildAccountChargeHtml({
    generatedAt: '2026-10-03T18:00:00.000Z',
    total: 1_400_000,
    accountHeading: 'LOGINPRO - SERVICE',
    items: [{ name: 'Servicios', value: 1_400_000 }]
  });

  assert.match(html, /FAVOR CONSIGNAR EN LA CUENTA No\.<\/div><div class="line">3052982551<\/div>/);
  assert.match(html, /TIPO DE CUENTA:<\/div><div class="line">Billetera Virtual<\/div>/);
  assert.match(html, /DEL BANCO<\/div><div class="line">Nequi<\/div>/);
  assert.match(html, /profesional prestador de servicios sin vínculo laboral/);
  assert.match(html, /decreto 2231 del 22 de diciembre de 2023/);
  assert.doesNotMatch(html, /profesional prestadora/);
  assert.doesNotMatch(html, /2231 dl 23 de diciembre/);
});
