import { readFileSync, writeFileSync } from 'node:fs';

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`Missing ${label}.`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Found ${label} more than once.`);
  }
  return source.replace(before, after);
}

const webhookFile = 'src/routes/webhook.js';
let source = readFileSync(webhookFile, 'utf8');

source = replaceExactlyOnce(
  source,
  `  pauseCandidateAutomationForManualReview,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';`,
  `  pauseCandidateAutomationForManualReview,
  reflectCandidateInterviewCancellationReminder,
  reflectCandidateInterviewRescheduleProgress,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';`,
  'candidate state service import'
);

source = replaceExactlyOnce(
  source,
  `      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';`,
  `      const reminderTransition = await reflectCandidateInterviewCancellationReminder(prisma, {
        candidateId: candidate.id,
        expected: {
          reminderScheduledFor: candidate.reminderScheduledFor ?? null,
          reminderState: candidate.reminderState
        }
      });
      if (reminderTransition.count !== 1) {
        const observedCandidate = reminderTransition.candidate || candidate;
        console.warn('[STALE_CANDIDATE_CANCELLATION_REMINDER]', JSON.stringify({
          candidateId: candidate.id,
          bookingId: activeBooking.id,
          expectedReminderState: candidate.reminderState || null,
          observedReminderState: observedCandidate?.reminderState || null
        }));
      }
      const body = 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.';`,
  'webhook cancellation reminder update'
);

source = replaceExactlyOnce(
  source,
  `      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.SCHEDULING,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);`,
  `      const progressTransition = await reflectCandidateInterviewRescheduleProgress(prisma, {
        candidateId: candidate.id,
        expected: {
          currentStep: candidate.currentStep,
          reminderScheduledFor: candidate.reminderScheduledFor ?? null,
          reminderState: candidate.reminderState
        }
      });
      if (progressTransition.count !== 1) {
        const observedCandidate = progressTransition.candidate || candidate;
        console.warn('[STALE_CANDIDATE_RESCHEDULE_PROGRESS]', JSON.stringify({
          candidateId: candidate.id,
          bookingId: activeBooking?.id || null,
          expectedStep: candidate.currentStep,
          observedStep: observedCandidate?.currentStep || null,
          expectedReminderState: candidate.reminderState || null,
          observedReminderState: observedCandidate?.reminderState || null
        }));
        await recordIntentionalSilence(prisma, observedCandidate, cleanText, {
          reason: 'STALE_CANDIDATE_RESCHEDULE_PROGRESS',
          gate: 'candidate_state_authority',
          action: 'reschedule_interview',
          vacancyId: currentVacancy?.id || candidate.vacancyId || null
        });
        return;
      }
      candidate = progressTransition.candidate || candidate;

      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);`,
  'webhook reschedule candidate update'
);

if ((source.match(/reflectCandidateInterviewCancellationReminder/g) || []).length !== 2) {
  throw new Error('Unexpected cancellation authority reference count.');
}
if ((source.match(/reflectCandidateInterviewRescheduleProgress/g) || []).length !== 2) {
  throw new Error('Unexpected reschedule authority reference count.');
}

writeFileSync(webhookFile, source, 'utf8');
console.log('Candidate interview CAS patch applied for #699.');
