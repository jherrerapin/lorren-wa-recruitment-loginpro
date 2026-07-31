import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureGlobalFavicon, GLOBAL_FAVICON_HREF } from '../src/services/htmlFavicon.js';

test('inyecta el favicon global en una vista HTML que no lo tiene', () => {
  const html = '<!doctype html><html><head><title>Vista</title></head><body></body></html>';
  const output = ensureGlobalFavicon(html);

  assert.match(output, new RegExp(GLOBAL_FAVICON_HREF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((output.match(/rel="icon"/g) || []).length, 1);
});

test('reemplaza un favicon anterior sin duplicarlo', () => {
  const html = '<html><head><link rel="shortcut icon" href="/anterior.ico"><title>Vista</title></head><body></body></html>';
  const output = ensureGlobalFavicon(html);

  assert.doesNotMatch(output, /anterior\.ico/);
  assert.equal((output.match(/rel="icon"/g) || []).length, 1);
  assert.match(output, /favicon-loginpro\.svg\?v=20260731/);
});

test('conserva iconos que no son el favicon del navegador', () => {
  const html = '<html><head><link rel="apple-touch-icon" href="/apple.png"><title>Vista</title></head><body></body></html>';
  const output = ensureGlobalFavicon(html);

  assert.match(output, /apple-touch-icon/);
  assert.match(output, /favicon-loginpro\.svg\?v=20260731/);
});

test('no modifica respuestas que no son documentos HTML completos', () => {
  assert.equal(ensureGlobalFavicon('{"ok":true}'), '{"ok":true}');
  assert.equal(ensureGlobalFavicon('texto plano'), 'texto plano');
});
