import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isAllowedAdImageFile, normalizeAdTextHints } from '../src/services/vacancyAdmin.js';

test('normaliza adTextHints para guardar contexto semántico', () => {
  assert.equal(normalizeAdTextHints('  anuncio ibague auxiliar  '), 'anuncio ibague auxiliar');
  assert.equal(normalizeAdTextHints('   '), null);
});

test('valida tipos permitidos de imagen publicitaria', () => {
  assert.equal(isAllowedAdImageFile({ mimetype: 'image/jpeg', originalname: 'pieza.jpg' }), true);
  assert.equal(isAllowedAdImageFile({ mimetype: 'image/png', originalname: 'pieza.png' }), true);
  assert.equal(isAllowedAdImageFile({ mimetype: 'image/webp', originalname: 'pieza.webp' }), true);
  assert.equal(isAllowedAdImageFile({ mimetype: 'application/pdf', originalname: 'pieza.pdf' }), false);
});

test('vacancy form incluye preview y acciones de imagen publicitaria', async () => {
  const template = await fs.readFile(path.resolve(process.cwd(), 'src/views/vacancy-form.ejs'), 'utf8');
  assert.match(template, /\/ad-image/);
  assert.match(template, /Reemplazar imagen|Subir imagen/);
  assert.match(template, /Eliminar imagen/);
  assert.match(template, /adTextHints/);
});

test('vacancies listing muestra estado básico de imagen', async () => {
  const template = await fs.readFile(path.resolve(process.cwd(), 'src/views/vacancies.ejs'), 'utf8');
  assert.match(template, /Con imagen/);
  assert.match(template, /Sin imagen/);
});
