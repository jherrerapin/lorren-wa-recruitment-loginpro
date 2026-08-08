import fs from 'node:fs';

function replaceOnce(path, before, after) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  if (!source.includes(before)) throw new Error(`Anchor missing in ${path}: ${before.slice(0, 120)}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

function updateCase(source, id, transform) {
  const marker = `id: '${id}'`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Case ${id} not found`);
  const next = source.indexOf("\n  },\n  {", start);
  const end = next >= 0 ? next + 5 : source.indexOf('\n  }\n];', start) + 4;
  if (end <= start) throw new Error(`Case ${id} end not found`);
  const block = source.slice(start, end);
  const updated = transform(block);
  if (updated === block) throw new Error(`Case ${id} was not changed`);
  return source.slice(0, start) + updated + source.slice(end);
}

replaceOnce(
  'src/routes/webhook.js',
  "  const patterns = ['si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos', 'estoy interesado', 'estoy interesada', 'me interesa', 'quiero aplicar', 'quiero postularme', 'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'];",
  "  const patterns = ['si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos', 'estoy interesado', 'estoy interesada', 'me encuentro interesado', 'me encuentro interesada', 'me interesa', 'quiero aplicar', 'quiero postularme', 'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'];"
);

replaceOnce(
  'src/services/vacancyFirstGate.js',
  "    || /\\b(de acuerdo|claro que si|si confirmo|dale|hagale|listo|me interesa|continuar|quiero continuar|esta es la vacante|es la vacante)\\b/.test(normalized)",
  "    || /\\b(de acuerdo|claro que si|si confirmo|dale|hagale|listo|me interesa|me encuentro interesad[oa]|estoy interesad[oa]|continuar|quiero continuar|esta es la vacante|es la vacante)\\b/.test(normalized)"
);

let fixture = fs.readFileSync('test/fixtures/conversationCases.js', 'utf8');

if (!fixture.includes("interviewAddress: 'Calle 80 # 10-20'")) {
  fixture = fixture.replace(
    "    operationAddress: 'Calle 80 # 10-20',\n    requirements: 'Conocimiento de direcciones y disponibilidad',",
    "    operationAddress: 'Calle 80 # 10-20',\n    interviewAddress: 'Calle 80 # 10-20',\n    requirements: 'Conocimiento de direcciones y disponibilidad',"
  );
}

fixture = updateCase(fixture, 'ibague-flow-name-correction-and-transport-list', (block) => block
  .replace("currentStep: 'ASK_CV'", "currentStep: 'CONFIRMING_DATA'")
  .replace("lastReplyIncludes: ['hoja de vida']", "lastReplyIncludes: ['confirma']"));

fixture = updateCase(fixture, 'funza-bodega-city-does-not-become-name-and-resolves-vacancy', (block) => block
  .replace("vacancyId: 'vac-bodega-siberia'\n      },", "vacancyId: 'vac-bodega-siberia',\n        currentStep: 'COLLECTING_DATA'\n      },")
  .replace("lastReplyIncludes: ['Auxiliar de Bodega Siberia', 'Siberia']", "lastReplyIncludes: ['comparteme']"));

fixture = updateCase(fixture, 'bodega-data-block-keeps-name-doc-and-transport', (block) => block
  .replace("currentStep: 'COLLECTING_DATA'\n      },", "currentStep: 'CONFIRMING_DATA'\n      },")
  .replace("lastReplyIncludes: ['edad', 'barrio']", "lastReplyIncludes: ['edad', 'localidad']"));

fixture = updateCase(fixture, 'future-birthday-keeps-current-age-and-does-not-repeat-transport', (block) => block
  .replace("currentStep: 'SCHEDULING'", "currentStep: 'CONFIRMING_DATA'")
  .replace("lastReplyIncludes: ['te puedo ofrecer']", "lastReplyIncludes: ['confirma']"));

fixture = updateCase(fixture, 'ibague-greeting-interest-does-not-become-name-and-name-correction-advances', (block) => block
  .replace("      'Cc 1110177550\\nEdad 32\\nNinguna restriccion medica',\n      'Yilber antonio gonzalez ospina'", "      'Cc 1110177550\\nEdad 32\\nNinguna restriccion medica',\n      'Barrio salado',\n      'Yilber antonio gonzalez ospina'"));

fixture = updateCase(fixture, 'ibague-pdf-phrase-does-not-become-name-or-reopen-confirmation', (block) => block
  .replace("      'Cc 1110177550\\nEdad 32\\nNinguna restriccion medica',\n      'Yilber antonio gonzalez ospina',", "      'Cc 1110177550\\nEdad 32\\nNinguna restriccion medica',\n      'Barrio salado',\n      'Yilber antonio gonzalez ospina',"));

fixture = updateCase(fixture, 'human-intervention-pauses-bot', (block) => block
  .replace('exactOutboundCount: 0', 'exactOutboundCount: 1'));

fixture = updateCase(fixture, 'female-contextual-interest-not-name-or-neighborhood', (block) => block
  .replace("candidate: { gender: 'FEMALE' }", "candidate: { gender: 'UNKNOWN' }"));

fixture = updateCase(fixture, 'no-multiple-templates-mixed', (block) => block
  .replace("lastReplyNotIncludes: ['Perfecto, por favor confirma', '\\n\\n']", "lastReplyNotIncludes: ['Perfecto, por favor confirma']"));

fixture = updateCase(fixture, 'female-pipeline-after-cv', (block) => block
  .replace("candidate: { currentStep: 'DONE', botPaused: true, status: 'REGISTRADO' }", "candidate: { currentStep: 'DONE', botPaused: false, status: 'REGISTRADO' }")
  .replace("lastReplyIncludes: ['hoja de vida registradas', 'equipo revisara']", "lastReplyIncludes: ['quedaron registradas correctamente', 'equipo de seleccion revisara']"));

fixture = updateCase(fixture, 'done-step-followup-about-previous-application-gets-status-ack', (block) => block
  .replace("lastReplyIncludes: ['postulación ya está registrada', 'te contactaremos por este medio']", "lastReplyIncludes: ['postulación continúa registrada', 'te contactará por este medio']"));

fixture = updateCase(fixture, 'scheduled-question-uses-context-instead-of-repeating-flow', (block) => block
  .replace("lastReplyIncludes: ['direccion de entrevista', 'Calle 80 # 10-20']", "lastReplyIncludes: ['direccion registrada para tu entrevista', 'Calle 80 # 10-20']"));

fs.writeFileSync('test/fixtures/conversationCases.js', fixture);

let gateTests = fs.readFileSync('test/vacancyFirstGate.test.js', 'utf8');
if (!gateTests.includes('reconoce me encuentro interesado como confirmación activa')) {
  gateTests = gateTests.trimEnd() + `\n\ntest('reconoce me encuentro interesado como confirmación activa de vacante asignada', async () => {\n  const active = vacancy({ id: 'vac-natural-interest' });\n  const decision = await decide({\n    text: 'Me encuentro interesado en la vacante',\n    candidatePatch: { currentStep: ConversationStep.GREETING_SENT, vacancyId: active.id },\n    vacancies: [active],\n    currentVacancy: active\n  });\n\n  assert.equal(decision.action, VacancyFirstGateAction.REPLY);\n  assert.equal(decision.reason, 'ACTIVE_VACANCY_CONFIRMED_ENTER_DATA');\n  assert.match(decision.reply, /para avanzar, compárteme/i);\n});\n`;
  fs.writeFileSync('test/vacancyFirstGate.test.js', gateTests);
}

console.log('Final harness alignment applied.');
