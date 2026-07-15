import fs from 'node:fs';

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`${label}_not_found`);
  if (content.indexOf(search, first + search.length) >= 0) throw new Error(`${label}_not_unique`);
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

const webhookPath = 'src/routes/webhook.js';
let webhook = fs.readFileSync(webhookPath, 'utf8').replaceAll('\r\n', '\n');
const oldBranch = `    if (interviewIntent === 'reschedule_interview' || isSchedulingRescheduleIntent(cleanText)) {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'reschedule_interview');
      if (!transition) return;

      if (!nextSlot?.slot) {`;
const newBranch = `    if (interviewIntent === 'reschedule_interview' || isSchedulingRescheduleIntent(cleanText)) {
      if (activeBooking?.id && activeBooking?.status) {
        const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'reschedule_interview');
        if (!transition) return;
      } else if (interviewIntent === 'reschedule_interview') {
        await recordIntentionalSilence(prisma, candidate, cleanText, {
          reason: 'interview_booking_missing_for_response',
          gate: 'interview_booking_authority',
          action: 'reschedule_interview'
        });
        return;
      }

      if (!nextSlot?.slot) {`;
webhook = replaceOnce(webhook, oldBranch, newBranch, 'reschedule_pending_offer');
fs.writeFileSync(webhookPath, webhook, 'utf8');

const testPath = 'test/webhookInterviewBookingAuthority.test.js';
let testSource = fs.readFileSync(testPath, 'utf8').replaceAll('\r\n', '\n');
const oldAssertions = `test('reprogramación conserva reserva activa y registra solicitud antes de pausa u oferta', () => {
  const authorityIndex = rescheduleBranch.indexOf('applyActiveInterviewResponse');
  const pauseIndex = rescheduleBranch.indexOf('pauseInterviewFlow');
  const candidateIndex = rescheduleBranch.indexOf('prisma.candidate.update');
  assert.ok(authorityIndex >= 0);
  assert.ok(pauseIndex > authorityIndex);
  assert.ok(candidateIndex > authorityIndex);
  assert.doesNotMatch(rescheduleBranch, /RESCHEDULED/);
  assert.match(rescheduleBranch, /En este momento no tengo un siguiente horario válido para ofrecerte\\. El equipo te contactará para ayudarte con la reprogramación\\./);
  assert.match(rescheduleBranch, /buildInterviewReplyPayload\\(body, ['"]interview_reschedule['"]/);
});`;
const newAssertions = `test('reprogramación distingue reserva activa de una oferta pendiente', () => {
  const activeGuardIndex = rescheduleBranch.indexOf('if (activeBooking?.id && activeBooking?.status)');
  const authorityIndex = rescheduleBranch.indexOf('applyActiveInterviewResponse');
  const missingBookingIndex = rescheduleBranch.indexOf("else if (interviewIntent === 'reschedule_interview')");
  const silenceIndex = rescheduleBranch.indexOf('recordIntentionalSilence', missingBookingIndex);
  const noSlotIndex = rescheduleBranch.indexOf('if (!nextSlot?.slot)');
  const pauseIndex = rescheduleBranch.indexOf('pauseInterviewFlow');
  const candidateIndex = rescheduleBranch.indexOf('prisma.candidate.update');

  assert.ok(activeGuardIndex >= 0 && authorityIndex > activeGuardIndex);
  assert.ok(missingBookingIndex > authorityIndex && silenceIndex > missingBookingIndex);
  assert.ok(noSlotIndex > silenceIndex, 'La oferta pendiente debe continuar hacia la resolución del siguiente slot.');
  assert.ok(pauseIndex > authorityIndex);
  assert.ok(candidateIndex > authorityIndex);
  assert.doesNotMatch(rescheduleBranch, /RESCHEDULED/);
  assert.match(rescheduleBranch, /En este momento no tengo un siguiente horario válido para ofrecerte\\. El equipo te contactará para ayudarte con la reprogramación\\./);
  assert.match(rescheduleBranch, /buildInterviewReplyPayload\\(body, ['"]interview_reschedule['"]/);
});`;
testSource = replaceOnce(testSource, oldAssertions, newAssertions, 'reschedule_regression');
fs.writeFileSync(testPath, testSource, 'utf8');

fs.rmSync('scripts/fix-webhook-reschedule-authority.mjs', { force: true });
