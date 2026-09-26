import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhookSource = fs.readFileSync('src/routes/webhook.js', 'utf8');
const shellSource = fs.readFileSync('src/core/shell/executeConversationDecision.js', 'utf8');

test('webhook no conserva autoridad directa sobre InterviewBooking', () => {
  assert.doesNotMatch(webhookSource, /applyActiveInterviewResponse/);
  assert.doesNotMatch(
    webhookSource,
    /prisma\.interviewBooking\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/
  );
});

test('shell delega creación y cancelación de reservas a la autoridad compartida', () => {
  assert.match(shellSource, /createScheduledInterviewBooking/);
  assert.match(shellSource, /cancelActiveInterviewBookings/);
  assert.match(shellSource, /currentStep:\s*ConversationStep\.SCHEDULED/);
  assert.match(shellSource, /BOOKING_CONFIRMED_REPLY/);
});
