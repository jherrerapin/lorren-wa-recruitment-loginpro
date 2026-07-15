import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateInterviewBookingTransition,
  InterviewBookingStatus,
  InterviewBookingTransitionAction,
  isActiveInterviewBookingStatus,
  isInterviewBookingAutomationClosedStatus
} from '../src/modules/interviews/domain/interviewBookingTransitionPolicy.js';

function evaluate(action, currentStatus, extra = {}) {
  return evaluateInterviewBookingTransition({ action, currentStatus, ...extra });
}

test('clasifica únicamente SCHEDULED y CONFIRMED como reservas activas', () => {
  assert.equal(isActiveInterviewBookingStatus(InterviewBookingStatus.SCHEDULED), true);
  assert.equal(isActiveInterviewBookingStatus(InterviewBookingStatus.CONFIRMED), true);
  for (const status of [
    InterviewBookingStatus.ATTENDED,
    InterviewBookingStatus.NO_RESPONSE,
    InterviewBookingStatus.RESCHEDULED,
    InterviewBookingStatus.NO_SHOW,
    InterviewBookingStatus.CANCELLED
  ]) {
    assert.equal(isActiveInterviewBookingStatus(status), false, `${status} no debe ser activo`);
    assert.equal(isInterviewBookingAutomationClosedStatus(status), true, `${status} debe cerrar automatización`);
  }
});

test('crea una reserva inicial únicamente cuando todavía no existe estado', () => {
  for (const emptyStatus of [null, undefined, '', '   ']) {
    const created = evaluate(InterviewBookingTransitionAction.CREATE_INITIAL, emptyStatus);
    assert.deepEqual(created, {
      allowed: true,
      action: InterviewBookingTransitionAction.CREATE_INITIAL,
      currentStatus: null,
      nextStatus: InterviewBookingStatus.SCHEDULED,
      statusChanged: true,
      reason: 'initial_booking_created',
      metadata: {}
    });
  }

  const duplicate = evaluate(
    InterviewBookingTransitionAction.CREATE_INITIAL,
    InterviewBookingStatus.SCHEDULED
  );
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, 'booking_already_exists');
});

test('confirma asistencia solo desde SCHEDULED y es idempotente en CONFIRMED', () => {
  const confirmed = evaluate(
    InterviewBookingTransitionAction.CONFIRM_ATTENDANCE,
    InterviewBookingStatus.SCHEDULED
  );
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.nextStatus, InterviewBookingStatus.CONFIRMED);
  assert.equal(confirmed.statusChanged, true);

  const repeated = evaluate(
    InterviewBookingTransitionAction.CONFIRM_ATTENDANCE,
    InterviewBookingStatus.CONFIRMED
  );
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.statusChanged, false);
  assert.match(repeated.reason, /idempotent/);

  for (const status of [
    InterviewBookingStatus.NO_RESPONSE,
    InterviewBookingStatus.CANCELLED,
    InterviewBookingStatus.RESCHEDULED,
    InterviewBookingStatus.ATTENDED,
    InterviewBookingStatus.NO_SHOW
  ]) {
    const rejected = evaluate(InterviewBookingTransitionAction.CONFIRM_ATTENDANCE, status);
    assert.equal(rejected.allowed, false, `No debe confirmar desde ${status}`);
  }
});

test('solicitar reprogramación no cierra ni cambia el estado activo', () => {
  for (const status of [InterviewBookingStatus.SCHEDULED, InterviewBookingStatus.CONFIRMED]) {
    const result = evaluate(InterviewBookingTransitionAction.REQUEST_RESCHEDULE, status);
    assert.equal(result.allowed, true);
    assert.equal(result.nextStatus, status);
    assert.equal(result.statusChanged, false);
    assert.equal(result.metadata.requiresReplacement, true);
  }

  const rejected = evaluate(
    InterviewBookingTransitionAction.REQUEST_RESCHEDULE,
    InterviewBookingStatus.RESCHEDULED
  );
  assert.equal(rejected.allowed, false);
});

test('completa la reprogramación solo desde un origen válido y con reemplazo identificado', () => {
  assert.throws(
    () => evaluate(
      InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
      InterviewBookingStatus.SCHEDULED
    ),
    /replacement_booking_id_required/
  );

  const result = evaluate(
    InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
    InterviewBookingStatus.SCHEDULED,
    { replacementBookingId: 'booking-new-1' }
  );
  assert.equal(result.allowed, true);
  assert.equal(result.nextStatus, InterviewBookingStatus.RESCHEDULED);
  assert.equal(result.metadata.replacementBookingId, 'booking-new-1');

  const invalidOriginWithoutReplacement = evaluate(
    InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
    InterviewBookingStatus.CANCELLED
  );
  assert.equal(invalidOriginWithoutReplacement.allowed, false);
  assert.equal(invalidOriginWithoutReplacement.reason, 'transition_origin_not_allowed');

  const repeated = evaluate(
    InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
    InterviewBookingStatus.RESCHEDULED,
    { replacementBookingId: 'booking-new-1' }
  );
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.statusChanged, false);
  assert.equal(repeated.reason, 'booking_rescheduled_idempotent');
});

test('marca NO_RESPONSE únicamente desde SCHEDULED y admite repetición idempotente', () => {
  const result = evaluate(
    InterviewBookingTransitionAction.MARK_NO_RESPONSE,
    InterviewBookingStatus.SCHEDULED
  );
  assert.equal(result.allowed, true);
  assert.equal(result.nextStatus, InterviewBookingStatus.NO_RESPONSE);

  const repeated = evaluate(
    InterviewBookingTransitionAction.MARK_NO_RESPONSE,
    InterviewBookingStatus.NO_RESPONSE
  );
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.statusChanged, false);
  assert.match(repeated.reason, /idempotent/);

  for (const status of [
    InterviewBookingStatus.CONFIRMED,
    InterviewBookingStatus.CANCELLED,
    InterviewBookingStatus.RESCHEDULED,
    InterviewBookingStatus.ATTENDED,
    InterviewBookingStatus.NO_SHOW
  ]) {
    const rejected = evaluate(InterviewBookingTransitionAction.MARK_NO_RESPONSE, status);
    assert.equal(rejected.allowed, false, `No debe marcar NO_RESPONSE desde ${status}`);
  }
});

test('permite cerrar asistencia real desde NO_RESPONSE sin perder la corrección operativa', () => {
  const attended = evaluate(
    InterviewBookingTransitionAction.MARK_ATTENDED,
    InterviewBookingStatus.NO_RESPONSE
  );
  assert.equal(attended.allowed, true);
  assert.equal(attended.nextStatus, InterviewBookingStatus.ATTENDED);

  const noShow = evaluate(
    InterviewBookingTransitionAction.MARK_NO_SHOW,
    InterviewBookingStatus.NO_RESPONSE
  );
  assert.equal(noShow.allowed, true);
  assert.equal(noShow.nextStatus, InterviewBookingStatus.NO_SHOW);
});

test('registra respuesta tardía sin cambiar implícitamente NO_RESPONSE', () => {
  const respondedAt = new Date('2026-07-15T14:55:00.000Z');
  const result = evaluate(
    InterviewBookingTransitionAction.RECORD_LATE_RESPONSE,
    InterviewBookingStatus.NO_RESPONSE,
    { respondedAt }
  );

  assert.equal(result.allowed, true);
  assert.equal(result.nextStatus, InterviewBookingStatus.NO_RESPONSE);
  assert.equal(result.statusChanged, false);
  assert.notEqual(result.metadata.respondedAt, respondedAt);
  assert.equal(result.metadata.respondedAt.toISOString(), respondedAt.toISOString());

  for (const invalid of [null, undefined, false, true, 'fecha-inválida']) {
    assert.throws(
      () => evaluate(
        InterviewBookingTransitionAction.RECORD_LATE_RESPONSE,
        InterviewBookingStatus.NO_RESPONSE,
        { respondedAt: invalid }
      ),
      /responded_at_invalid/
    );
  }

  const invalidOrigin = evaluate(
    InterviewBookingTransitionAction.RECORD_LATE_RESPONSE,
    InterviewBookingStatus.SCHEDULED,
    { respondedAt }
  );
  assert.equal(invalidOrigin.allowed, false);
});

test('cancela reservas operativamente abiertas o pendientes de respuesta tardía', () => {
  for (const status of [
    InterviewBookingStatus.SCHEDULED,
    InterviewBookingStatus.CONFIRMED,
    InterviewBookingStatus.NO_RESPONSE
  ]) {
    const result = evaluate(InterviewBookingTransitionAction.CANCEL, status);
    assert.equal(result.allowed, true);
    assert.equal(result.nextStatus, InterviewBookingStatus.CANCELLED);
  }

  const repeated = evaluate(
    InterviewBookingTransitionAction.CANCEL,
    InterviewBookingStatus.CANCELLED
  );
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.statusChanged, false);
});

test('rechaza entradas, estados y acciones inválidos con errores de dominio', () => {
  for (const invalidInput of [null, false, 'texto', []]) {
    assert.throws(
      () => evaluateInterviewBookingTransition(invalidInput),
      /interview_booking_transition_input_invalid/
    );
  }
  assert.throws(
    () => evaluateInterviewBookingTransition({ action: 'UPDATE_ANYTHING', currentStatus: 'SCHEDULED' }),
    /interview_booking_transition_action_invalid/
  );
  assert.throws(
    () => evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.CANCEL,
      currentStatus: 'ACTIVE'
    }),
    /interview_booking_status_invalid/
  );
  assert.throws(
    () => isActiveInterviewBookingStatus(null),
    /interview_booking_status_invalid/
  );
});
