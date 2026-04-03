import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildVacancyGreeting, DEFAULT_VACANCY_SEED, detectVacancyAndCity, getActiveVacancyCatalog } from '../src/services/vacancyCatalog.js';

const active = getActiveVacancyCatalog(DEFAULT_VACANCY_SEED);

test('carga solo vacantes activas y respeta orden', () => {
  const catalog = getActiveVacancyCatalog([
    { key: 'x', isActive: false, displayOrder: 0, aliases: [] },
    { key: 'b', isActive: true, displayOrder: 2, aliases: [] },
    { key: 'a', isActive: true, displayOrder: 1, aliases: [] }
  ]);
  assert.deepEqual(catalog.map((v) => v.key), ['a', 'b']);
});

test('detecta auxiliar + ibague', () => {
  const result = detectVacancyAndCity({ text: 'Hola, vi la vacante de auxiliar de cargue en ibague', activeVacancies: active });
  assert.equal(result.vacancyDetection.vacancyKey, 'auxiliar_cargue_descargue_ibague');
  assert.ok(result.vacancyDetection.confidence >= 0.6);
  assert.equal(result.cityDetection.cityKey, 'ibague');
});

test('detecta coordinador + ibague', () => {
  const result = detectVacancyAndCity({ text: 'Estoy interesado en coordinador para Ibagué', activeVacancies: active });
  assert.equal(result.vacancyDetection.vacancyKey, 'coordinador_ibague');
  assert.ok(result.vacancyDetection.confidence >= 0.6);
});

test('si es ambiguo sugiere ask_which_vacancy', () => {
  const result = detectVacancyAndCity({ text: 'hola vengo por el anuncio en ibague', activeVacancies: active });
  assert.equal(result.suggestedNextAction, 'ask_which_vacancy');
  assert.equal(result.vacancyDetection.detected, false);
});

test('si está clara usa vacante activa y evita inactiva', () => {
  const result = detectVacancyAndCity({
    text: 'coordinador ibague',
    activeVacancies: getActiveVacancyCatalog([
      ...DEFAULT_VACANCY_SEED,
      { key: 'coordinador_ibague_inactiva', title: 'Coordinador', city: 'Ibagué', aliases: ['coordinador'], isActive: false, displayOrder: 0 }
    ])
  });
  assert.equal(result.vacancyDetection.vacancyKey, 'coordinador_ibague');
});

test('si ya hay vacante asignada y no hay corrección explícita, conserva contexto', () => {
  const result = detectVacancyAndCity({
    text: 'quiero continuar con el proceso',
    activeVacancies: active,
    currentVacancyKey: 'auxiliar_cargue_descargue_ibague'
  });
  assert.equal(result.vacancyDetection.vacancyKey, 'auxiliar_cargue_descargue_ibague');
  assert.equal(result.vacancyDetection.source, 'context');
});

test('adTextHints influye en la clasificación semántica', () => {
  const catalog = getActiveVacancyCatalog([
    {
      key: 'auxiliar_cargue_descargue_ibague',
      title: 'Auxiliar de Cargue y Descargue',
      city: 'Ibagué',
      aliases: ['auxiliar'],
      adTextHints: 'zona aeropuerto cargue equipaje operacion logistico',
      isActive: true,
      displayOrder: 1
    },
    {
      key: 'coordinador_ibague',
      title: 'Coordinador',
      city: 'Ibagué',
      aliases: ['coordinador'],
      adTextHints: 'lider equipo supervision',
      isActive: true,
      displayOrder: 2
    }
  ]);
  const result = detectVacancyAndCity({
    text: 'vi el anuncio de aeropuerto y cargue de equipaje en ibague',
    activeVacancies: catalog
  });
  assert.equal(result.vacancyDetection.vacancyKey, 'auxiliar_cargue_descargue_ibague');
  assert.ok(result.vacancyDetection.confidence >= 0.7);
});

test('saludo dinámico usa datos de vacante', () => {
  const greeting = buildVacancyGreeting(active[0]);
  assert.match(greeting, /Auxiliar de Cargue y Descargue/);
  assert.match(greeting, /Ibagué/);
  assert.match(greeting, /Requisitos clave:/);
});

test('webhook ya no depende de saludo fijo quemado', async () => {
  const webhookFile = await fs.readFile(path.resolve(process.cwd(), 'src/routes/webhook.js'), 'utf8');
  assert.doesNotMatch(webhookFile, /\\*Vacante: Auxiliar de Cargue y Descargue\\*/);
  assert.match(webhookFile, /NEUTRAL_VACANCY_PROMPT/);
});
