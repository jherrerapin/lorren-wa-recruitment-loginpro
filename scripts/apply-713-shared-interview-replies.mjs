import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label} anchor count=${count}`);
  return source.replace(from, to);
}

function updateFile(path, transform) {
  const source = readFileSync(path, 'utf8');
  const updated = transform(source);
  if (updated === source) throw new Error(`${path} did not change`);
  writeFileSync(path, updated, 'utf8');
}

updateFile('src/services/naturalReply.js', (source) => {
  const anchor = [
    "export function buildInterviewDocumentsSentence(documents = '') {",
    "  const cleanDocuments = String(documents || '').trim();",
    "  return cleanDocuments ? `Para la entrevista, lleva ${cleanDocuments}.` : '';",
    '}'
  ].join('\n');
  const replacement = [
    anchor,
    '',
    'export function buildInterviewAttendanceConfirmedReply(formattedDate = null) {',
    "  const schedule = String(formattedDate || '').trim() || 'en el horario acordado';",
    '  return `Perfecto, gracias por confirmar asistencia. Te esperamos ${schedule}.`;',
    '}',
    '',
    'export function buildInterviewCancellationReply() {',
    "  return 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';",
    '}'
  ].join('\n');
  return replaceOnce(source, anchor, replacement, 'natural reply builders');
});

updateFile('src/services/chatEngine.js', (source) => {
  let updated = replaceOnce(
    source,
    "import { OPENAI_EXTRACTION_MODEL } from './openAiModelConfig.js';",
    [
      "import { OPENAI_EXTRACTION_MODEL } from './openAiModelConfig.js';",
      "import { buildInterviewAttendanceConfirmedReply, buildInterviewCancellationReply } from './naturalReply.js';"
    ].join('\n'),
    'chatEngine naturalReply import'
  );
  updated = replaceOnce(
    updated,
    '      reply: `Perfecto, gracias por confirmar asistencia. Te esperamos ${formatInterviewDate(new Date(booking.scheduledAt))}.`',
    '      reply: buildInterviewAttendanceConfirmedReply(formatInterviewDate(new Date(booking.scheduledAt)))',
    'chatEngine attendance reply'
  );
  updated = replaceOnce(
    updated,
    "        reply: 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.'",
    '        reply: buildInterviewCancellationReply()',
    'chatEngine cancellation reply'
  );
  return updated;
});

updateFile('src/routes/webhook.js', (source) => {
  let updated = replaceOnce(
    source,
    "import { buildInterviewDocumentsSentence, buildUnavailableVacancyInfoReply, buildVacancyOptionsReply, generateBookingConfirmation, generateInterviewOffer, sanitizeRequiredDocumentsForBot } from '../services/naturalReply.js';",
    [
      'import {',
      '  buildInterviewAttendanceConfirmedReply,',
      '  buildInterviewCancellationReply,',
      '  buildInterviewDocumentsSentence,',
      '  buildUnavailableVacancyInfoReply,',
      '  buildVacancyOptionsReply,',
      '  generateBookingConfirmation,',
      '  generateInterviewOffer,',
      '  sanitizeRequiredDocumentsForBot',
      "} from '../services/naturalReply.js';"
    ].join('\n'),
    'webhook naturalReply import'
  );
  updated = replaceOnce(
    updated,
    "      const body = 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';",
    '      const body = buildInterviewCancellationReply();',
    'webhook cancellation reply'
  );
  updated = replaceOnce(
    updated,
    "      const body = `Perfecto, gracias por confirmar asistencia. Te esperamos ${nextSlot?.formattedDate || 'en el horario acordado'}.`;",
    '      const body = buildInterviewAttendanceConfirmedReply(nextSlot?.formattedDate);',
    'webhook attendance reply'
  );
  return updated;
});

updateFile('test/chatEngineInterviewBookingAuthority.test.js', (source) => {
  let updated = replaceOnce(
    source,
    "import fs from 'node:fs';",
    [
      "import fs from 'node:fs';",
      '',
      'import {',
      '  buildInterviewAttendanceConfirmedReply,',
      '  buildInterviewCancellationReply',
      "} from '../src/services/naturalReply.js';"
    ].join('\n'),
    'chatEngine test imports'
  );

  const handlerAnchor = [
    'const handler = between(',
    "  'async function handleAppointmentIntentDirectly',",
    "  'async function analyzePausedVacancyConsent'",
    ');'
  ].join('\n');
  updated = replaceOnce(
    updated,
    handlerAnchor,
    [
      handlerAnchor,
      '',
      'const confirmStart = handler.indexOf("if (intent === \'confirm_attendance\')");',
      'const cancelStart = handler.indexOf("if (intent === \'cancel_interview\')");',
      'const rescheduleStart = handler.indexOf("if (intent === \'reschedule_interview\')");',
      'assert.ok(confirmStart >= 0 && cancelStart > confirmStart && rescheduleStart > cancelStart);',
      'const confirmBranch = handler.slice(confirmStart, cancelStart);',
      'const cancelBranch = handler.slice(cancelStart, rescheduleStart);'
    ].join('\n'),
    'chatEngine test branch markers'
  );

  const testAnchor = "test('chatEngine no escribe InterviewBooking directamente', () => {";
  const insertedTests = [
    "test('naturalReply conserva los textos determinísticos canónicos de entrevista', () => {",
    '  assert.equal(',
    "    buildInterviewAttendanceConfirmedReply('viernes a las 10:00'),",
    "    'Perfecto, gracias por confirmar asistencia. Te esperamos viernes a las 10:00.'",
    '  );',
    '  assert.equal(',
    '    buildInterviewAttendanceConfirmedReply(),',
    "    'Perfecto, gracias por confirmar asistencia. Te esperamos en el horario acordado.'",
    '  );',
    '  assert.equal(',
    '    buildInterviewCancellationReply(),',
    "    'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.'",
    '  );',
    '});',
    '',
    "test('chatEngine usa los builders compartidos para confirmación y cancelación', () => {",
    '  assert.match(',
    '    confirmBranch,',
    '    /buildInterviewAttendanceConfirmedReply\\(\\s*formatInterviewDate\\(new Date\\(booking\\.scheduledAt\\)\\)\\s*\\)/',
    '  );',
    '  assert.doesNotMatch(confirmBranch, /Perfecto, gracias por confirmar asistencia\\. Te esperamos/);',
    '  assert.match(cancelBranch, /reply:\\s*buildInterviewCancellationReply\\(\\)/);',
    '  assert.doesNotMatch(cancelBranch, /Listo, ya registré la cancelación de tu entrevista/);',
    '});',
    '',
    testAnchor
  ].join('\n');
  updated = replaceOnce(updated, testAnchor, insertedTests, 'chatEngine shared reply tests');

  updated = replaceOnce(
    updated,
    [
      '  const rescheduleStart = handler.indexOf("if (intent === \'reschedule_interview\')");',
      "  assert.ok(rescheduleStart >= 0, 'No se encontró la rama de reprogramación.');",
      '  const rescheduleBranch = handler.slice(rescheduleStart);'
    ].join('\n'),
    '  const rescheduleBranch = handler.slice(rescheduleStart);',
    'chatEngine reschedule branch reuse'
  );

  updated = replaceOnce(
    updated,
    [
      '  const cancelStart = handler.indexOf("if (intent === \'cancel_interview\')");',
      '  const rescheduleStart = handler.indexOf("if (intent === \'reschedule_interview\')");',
      "  assert.ok(cancelStart >= 0 && rescheduleStart > cancelStart, 'No se encontraron las ramas de cancelación y reprogramación.');",
      '  const cancelBranch = handler.slice(cancelStart, rescheduleStart);',
      ''
    ].join('\n'),
    '',
    'chatEngine cancel branch reuse'
  );

  updated = replaceOnce(
    updated,
    '  assert.match(cancelBranch, /Listo, ya registré la cancelación de tu entrevista/);',
    '  assert.match(cancelBranch, /buildInterviewCancellationReply\\(\\)/);',
    'chatEngine cancel builder assertion'
  );
  return updated;
});

updateFile('test/webhookInterviewBookingAuthority.test.js', (source) => {
  let updated = replaceOnce(
    source,
    "  assert.match(cancelBranch, /Listo, ya registré la cancelación de tu entrevista\\. Si más adelante deseas retomarla, me escribes por aquí\\./);",
    [
      '  assert.match(cancelBranch, /const body = buildInterviewCancellationReply\\(\\);/);',
      '  assert.doesNotMatch(cancelBranch, /Listo, ya registré la cancelación de tu entrevista/);'
    ].join('\n'),
    'webhook cancel builder assertion'
  );
  updated = replaceOnce(
    updated,
    '  assert.match(confirmBranch, /Perfecto, gracias por confirmar asistencia\\. Te esperamos/);',
    [
      '  assert.match(confirmBranch, /buildInterviewAttendanceConfirmedReply\\(nextSlot\\?\\.formattedDate\\)/);',
      '  assert.doesNotMatch(confirmBranch, /Perfecto, gracias por confirmar asistencia\\. Te esperamos/);'
    ].join('\n'),
    'webhook attendance builder assertion'
  );
  return updated;
});

console.log('Shared interview reply patch applied for #713.');
