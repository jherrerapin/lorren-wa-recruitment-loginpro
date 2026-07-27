import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const debugTracePath = 'src/services/debugTrace.js';
let debugTrace = fs.readFileSync(debugTracePath, 'utf8');

debugTrace = replaceOnce(
  debugTrace,
  `    engine_actions: [],\n    persisted_fields: [],`,
  `    engine_actions: [],\n    engine_preview_eligible: false,\n    engine_preview_executed: false,\n    engine_preview_used: false,\n    engine_preview_fallback: false,\n    engine_preview_field_count: 0,\n    engine_preview_effective_field_count: 0,\n    engine_preview_decision_available: false,\n    engine_preview_plan_reused: false,\n    engine_preview_consumption: 'none',\n    persisted_fields: [],`,
  'campos iniciales de preview'
);

debugTrace = replaceOnce(
  debugTrace,
  `}\n\nexport function summarizeError(error) {`,
  `}\n\nexport function buildEnginePreviewTrace({ eligible = false, preview = {}, turnInterpretation = {} } = {}) {\n  const previewFields = preview?.fields && typeof preview.fields === 'object'\n    ? Object.keys(preview.fields).filter(Boolean)\n    : [];\n  const interpretationFields = turnInterpretation?.fields && typeof turnInterpretation.fields === 'object'\n    ? turnInterpretation.fields\n    : {};\n  const sourceByField = turnInterpretation?.sourceByField && typeof turnInterpretation.sourceByField === 'object'\n    ? turnInterpretation.sourceByField\n    : {};\n  const effectiveFieldCount = previewFields.filter((field) => (\n    Object.hasOwn(interpretationFields, field)\n    && ['engine', 'merged'].includes(sourceByField[field])\n  )).length;\n  const executed = Boolean(eligible);\n  const fallback = executed && Boolean(preview?.fallback);\n\n  return {\n    engine_preview_eligible: Boolean(eligible),\n    engine_preview_executed: executed,\n    engine_preview_used: executed && Boolean(preview?.used),\n    engine_preview_fallback: fallback,\n    engine_preview_field_count: executed ? previewFields.length : 0,\n    engine_preview_effective_field_count: effectiveFieldCount,\n    engine_preview_decision_available: executed && !fallback && Boolean(preview?.decision),\n    engine_preview_plan_reused: false,\n    engine_preview_consumption: effectiveFieldCount > 0 ? 'fields' : 'none'\n  };\n}\n\nexport function applyEnginePreviewPlanReuse(debugTrace = {}, decisionReused = false) {\n  const planReused = Boolean(decisionReused && debugTrace.engine_preview_decision_available);\n  debugTrace.engine_preview_plan_reused = planReused;\n  if (planReused) {\n    debugTrace.engine_preview_consumption = Number(debugTrace.engine_preview_effective_field_count || 0) > 0\n      ? 'fields_and_plan'\n      : 'plan_reused';\n  }\n  return debugTrace;\n}\n\nexport function summarizeError(error) {`,
  'helpers de trazabilidad del preview'
);

fs.writeFileSync(debugTracePath, debugTrace);

const webhookPath = 'src/routes/webhook.js';
let webhook = fs.readFileSync(webhookPath, 'utf8');

webhook = replaceOnce(
  webhook,
  `import { createDebugTrace, inferIntent, sanitizeForRawPayload, splitFieldDecisions, summarizeError } from '../services/debugTrace.js';`,
  `import {\n  applyEnginePreviewPlanReuse,\n  buildEnginePreviewTrace,\n  createDebugTrace,\n  inferIntent,\n  sanitizeForRawPayload,\n  splitFieldDecisions,\n  summarizeError\n} from '../services/debugTrace.js';`,
  'import de trazabilidad del preview'
);

webhook = replaceOnce(
  webhook,
  `  if (preview?.fallback) {\n    return { fields: {}, usage, decision: null, used: false };\n  }`,
  `  if (preview?.fallback) {\n    return { fields: {}, usage, decision: null, used: false, fallback: true };\n  }`,
  'resultado fallback del preview'
);

webhook = replaceOnce(
  webhook,
  `    decision: preview,\n    used: true\n  };`,
  `    decision: preview,\n    used: true,\n    fallback: false\n  };`,
  'resultado exitoso del preview'
);

webhook = replaceOnce(
  webhook,
  `  const rawEnginePreview = shouldUseEngineFieldPreview(candidate, cleanText, localParsedData, aiFields, sanitizerContext.pendingFields)\n    ? await previewEngineCandidateFields(prisma, candidate, cleanText, currentVacancy)\n    : { fields: {}, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };`,
  `  const enginePreviewEligible = shouldUseEngineFieldPreview(\n    candidate,\n    cleanText,\n    localParsedData,\n    aiFields,\n    sanitizerContext.pendingFields\n  );\n  const rawEnginePreview = enginePreviewEligible\n    ? await previewEngineCandidateFields(prisma, candidate, cleanText, currentVacancy)\n    : {\n      fields: {},\n      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },\n      decision: null,\n      used: false,\n      fallback: false\n    };`,
  'evaluación única de elegibilidad del preview'
);

webhook = replaceOnce(
  webhook,
  `  const turnInterpretation = understanding.turnInterpretation;\n  if (!turnInterpretation) throw new Error('Missing runtime turn interpretation.');\n  let normalizedData = turnInterpretation.fields;`,
  `  const turnInterpretation = understanding.turnInterpretation;\n  if (!turnInterpretation) throw new Error('Missing runtime turn interpretation.');\n  Object.assign(debugTrace, buildEnginePreviewTrace({\n    eligible: enginePreviewEligible,\n    preview: rawEnginePreview,\n    turnInterpretation\n  }));\n  let normalizedData = turnInterpretation.fields;`,
  'registro del resultado efectivo del preview'
);

webhook = replaceOnce(
  webhook,
  `    options.debugTrace.engine_plan_reused = Boolean(engineResult.decisionReused);\n    options.debugTrace.engine_actions = (engineResult.actions || []).map((action) => action?.type).filter(Boolean);`,
  `    options.debugTrace.engine_plan_reused = Boolean(engineResult.decisionReused);\n    applyEnginePreviewPlanReuse(options.debugTrace, engineResult.decisionReused);\n    options.debugTrace.engine_actions = (engineResult.actions || []).map((action) => action?.type).filter(Boolean);`,
  'consumo del plan reutilizado'
);

fs.writeFileSync(webhookPath, webhook);

const testPath = 'test/enginePreviewTrace.test.js';
fs.writeFileSync(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport {\n  applyEnginePreviewPlanReuse,\n  buildEnginePreviewTrace,\n  createDebugTrace\n} from '../src/services/debugTrace.js';\n\ntest('preview no elegible queda clasificado sin ejecución ni consumo', () => {\n  const trace = buildEnginePreviewTrace({ eligible: false });\n  assert.deepEqual(trace, {\n    engine_preview_eligible: false,\n    engine_preview_executed: false,\n    engine_preview_used: false,\n    engine_preview_fallback: false,\n    engine_preview_field_count: 0,\n    engine_preview_effective_field_count: 0,\n    engine_preview_decision_available: false,\n    engine_preview_plan_reused: false,\n    engine_preview_consumption: 'none'\n  });\n});\n\ntest('preview ejecutado con fallback conserva medición sin marcar decisión disponible', () => {\n  const trace = buildEnginePreviewTrace({\n    eligible: true,\n    preview: { used: false, fallback: true, fields: {}, decision: null }\n  });\n  assert.equal(trace.engine_preview_executed, true);\n  assert.equal(trace.engine_preview_fallback, true);\n  assert.equal(trace.engine_preview_used, false);\n  assert.equal(trace.engine_preview_decision_available, false);\n  assert.equal(trace.engine_preview_consumption, 'none');\n});\n\ntest('cuenta solo campos del preview que sobreviven en la interpretación del turno', () => {\n  const trace = buildEnginePreviewTrace({\n    eligible: true,\n    preview: {\n      used: true,\n      fallback: false,\n      fields: { transportMode: 'Moto', age: 28, fullName: 'Dato descartado' },\n      decision: { actions: [{ type: 'nothing' }] }\n    },\n    turnInterpretation: {\n      fields: { transportMode: 'Moto', age: 28 },\n      sourceByField: { transportMode: 'engine', age: 'merged' }\n    }\n  });\n  assert.equal(trace.engine_preview_field_count, 3);\n  assert.equal(trace.engine_preview_effective_field_count, 2);\n  assert.equal(trace.engine_preview_decision_available, true);\n  assert.equal(trace.engine_preview_consumption, 'fields');\n});\n\ntest('clasifica plan reutilizado y combinación de campos con plan', () => {\n  const onlyPlan = buildEnginePreviewTrace({\n    eligible: true,\n    preview: { used: true, fallback: false, fields: {}, decision: { actions: [] } }\n  });\n  applyEnginePreviewPlanReuse(onlyPlan, true);\n  assert.equal(onlyPlan.engine_preview_plan_reused, true);\n  assert.equal(onlyPlan.engine_preview_consumption, 'plan_reused');\n\n  const fieldsAndPlan = buildEnginePreviewTrace({\n    eligible: true,\n    preview: { used: true, fallback: false, fields: { age: 30 }, decision: { actions: [] } },\n    turnInterpretation: { fields: { age: 30 }, sourceByField: { age: 'engine' } }\n  });\n  applyEnginePreviewPlanReuse(fieldsAndPlan, true);\n  assert.equal(fieldsAndPlan.engine_preview_consumption, 'fields_and_plan');\n});\n\ntest('una decisión no disponible no puede marcarse como reutilizada', () => {\n  const trace = buildEnginePreviewTrace({\n    eligible: true,\n    preview: { used: false, fallback: true, fields: {}, decision: null }\n  });\n  applyEnginePreviewPlanReuse(trace, true);\n  assert.equal(trace.engine_preview_plan_reused, false);\n  assert.equal(trace.engine_preview_consumption, 'none');\n});\n\ntest('la traza del preview no guarda texto, teléfono ni valores de campos', () => {\n  const sensitiveText = 'Mi nombre es Persona Sensible y mi documento es 123456789';\n  const sensitivePhone = '573001112233';\n  const trace = {\n    ...createDebugTrace({ phone: null, currentStepBefore: 'COLLECTING_DATA' }),\n    ...buildEnginePreviewTrace({\n      eligible: true,\n      preview: {\n        used: true,\n        fallback: false,\n        fields: { fullName: sensitiveText, documentNumber: '123456789' },\n        decision: { actions: [] }\n      },\n      turnInterpretation: {\n        fields: { fullName: sensitiveText },\n        sourceByField: { fullName: 'engine' }\n      }\n    })\n  };\n  const serializedPreview = JSON.stringify(Object.fromEntries(\n    Object.entries(trace).filter(([key]) => key.startsWith('engine_preview_'))\n  ));\n  assert.equal(serializedPreview.includes(sensitiveText), false);\n  assert.equal(serializedPreview.includes(sensitivePhone), false);\n  assert.equal(serializedPreview.includes('123456789'), false);\n});\n\ntest('webhook conecta elegibilidad, resultado efectivo y reutilización del plan', () => {\n  const source = fs.readFileSync('src/routes/webhook.js', 'utf8');\n  assert.match(source, /const enginePreviewEligible = shouldUseEngineFieldPreview/);\n  assert.match(source, /buildEnginePreviewTrace\\(\\{/);\n  assert.match(source, /applyEnginePreviewPlanReuse\\(options\\.debugTrace, engineResult\\.decisionReused\\)/);\n  assert.equal((source.match(/shouldUseEngineFieldPreview\\(/g) || []).length, 2);\n});\n`);

console.log('Issue #756 aplicado correctamente.');
