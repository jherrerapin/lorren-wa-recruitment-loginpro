import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyEnginePreviewPlanReuse,
  buildEnginePreviewTrace,
  createDebugTrace
} from '../src/services/debugTrace.js';

test('preview no elegible queda clasificado sin ejecución ni consumo', () => {
  const trace = buildEnginePreviewTrace({ eligible: false });
  assert.deepEqual(trace, {
    engine_preview_eligible: false,
    engine_preview_executed: false,
    engine_preview_used: false,
    engine_preview_fallback: false,
    engine_preview_field_count: 0,
    engine_preview_effective_field_count: 0,
    engine_preview_decision_available: false,
    engine_preview_plan_reused: false,
    engine_preview_consumption: 'none'
  });
});

test('preview ejecutado con fallback conserva medición sin marcar decisión disponible', () => {
  const trace = buildEnginePreviewTrace({
    eligible: true,
    preview: { used: false, fallback: true, fields: {}, decision: null }
  });
  assert.equal(trace.engine_preview_executed, true);
  assert.equal(trace.engine_preview_fallback, true);
  assert.equal(trace.engine_preview_used, false);
  assert.equal(trace.engine_preview_decision_available, false);
  assert.equal(trace.engine_preview_consumption, 'none');
});

test('cuenta solo campos del preview que sobreviven en la interpretación del turno', () => {
  const trace = buildEnginePreviewTrace({
    eligible: true,
    preview: {
      used: true,
      fallback: false,
      fields: { transportMode: 'Moto', age: 28, fullName: 'Dato descartado' },
      decision: { actions: [{ type: 'nothing' }] }
    },
    turnInterpretation: {
      fields: { transportMode: 'Moto', age: 28 },
      sourceByField: { transportMode: 'engine', age: 'merged' }
    }
  });
  assert.equal(trace.engine_preview_field_count, 3);
  assert.equal(trace.engine_preview_effective_field_count, 2);
  assert.equal(trace.engine_preview_decision_available, true);
  assert.equal(trace.engine_preview_consumption, 'fields');
});

test('clasifica plan reutilizado y combinación de campos con plan', () => {
  const onlyPlan = buildEnginePreviewTrace({
    eligible: true,
    preview: { used: true, fallback: false, fields: {}, decision: { actions: [] } }
  });
  applyEnginePreviewPlanReuse(onlyPlan, true);
  assert.equal(onlyPlan.engine_preview_plan_reused, true);
  assert.equal(onlyPlan.engine_preview_consumption, 'plan_reused');

  const fieldsAndPlan = buildEnginePreviewTrace({
    eligible: true,
    preview: { used: true, fallback: false, fields: { age: 30 }, decision: { actions: [] } },
    turnInterpretation: { fields: { age: 30 }, sourceByField: { age: 'engine' } }
  });
  applyEnginePreviewPlanReuse(fieldsAndPlan, true);
  assert.equal(fieldsAndPlan.engine_preview_consumption, 'fields_and_plan');
});

test('una decisión no disponible no puede marcarse como reutilizada', () => {
  const trace = buildEnginePreviewTrace({
    eligible: true,
    preview: { used: false, fallback: true, fields: {}, decision: null }
  });
  applyEnginePreviewPlanReuse(trace, true);
  assert.equal(trace.engine_preview_plan_reused, false);
  assert.equal(trace.engine_preview_consumption, 'none');
});

test('la traza del preview no guarda texto, teléfono ni valores de campos', () => {
  const sensitiveText = 'Mi nombre es Persona Sensible y mi documento es 123456789';
  const sensitivePhone = '573001112233';
  const trace = {
    ...createDebugTrace({ phone: null, currentStepBefore: 'COLLECTING_DATA' }),
    ...buildEnginePreviewTrace({
      eligible: true,
      preview: {
        used: true,
        fallback: false,
        fields: { fullName: sensitiveText, documentNumber: '123456789' },
        decision: { actions: [] }
      },
      turnInterpretation: {
        fields: { fullName: sensitiveText },
        sourceByField: { fullName: 'engine' }
      }
    })
  };
  const serializedPreview = JSON.stringify(Object.fromEntries(
    Object.entries(trace).filter(([key]) => key.startsWith('engine_preview_'))
  ));
  assert.equal(serializedPreview.includes(sensitiveText), false);
  assert.equal(serializedPreview.includes(sensitivePhone), false);
  assert.equal(serializedPreview.includes('123456789'), false);
});

test('webhook conecta elegibilidad, resultado efectivo y reutilización del plan', () => {
  const source = fs.readFileSync('src/routes/webhook.js', 'utf8');
  assert.match(source, /const enginePreviewEligible = shouldUseEngineFieldPreview/);
  assert.match(source, /buildEnginePreviewTrace\(\{/);
  assert.match(source, /applyEnginePreviewPlanReuse\(options\.debugTrace, engineResult\.decisionReused\)/);
  assert.equal((source.match(/shouldUseEngineFieldPreview\(/g) || []).length, 2);
});
