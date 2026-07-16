from pathlib import Path


def replace_once(source, old, new, label):
    if old not in source:
        raise SystemExit(f'{label} not found')
    return source.replace(old, new, 1)


admin = Path('src/routes/admin.js')
source = admin.read_text()
source = replace_once(
    source,
    "import {\n  deliverManualOutboundText,\n  getManualOutboundUserMessage\n} from '../services/manualOutboundDeliveryService.js';",
    "import {\n  deliverManualOutboundText,\n  getManualOutboundCompletionNotice,\n  getManualOutboundUserMessage\n} from '../services/manualOutboundDeliveryService.js';",
    'manual outbound import'
)
source = replace_once(
    source,
    """      await sendAdminOutboundMessage(prisma, booking.candidate, body, {
        source: 'admin_manual_interview_reminder',
        interviewBookingId: booking.id
      });
      await logCandidateAdminEvent(prisma, {""",
    """      const delivery = await sendAdminOutboundMessage(prisma, booking.candidate, body, {
        source: 'admin_manual_interview_reminder',
        interviewBookingId: booking.id
      });
      const notice = getManualOutboundCompletionNotice(
        delivery,
        'Recordatorio manual enviado correctamente.'
      );
      await logCandidateAdminEvent(prisma, {""",
    'manual reminder delivery capture'
)
source = replace_once(
    source,
    "return res.redirect(withFlashMessage(returnTo, 'success', 'Recordatorio manual enviado correctamente.'));",
    "return res.redirect(withFlashMessage(returnTo, notice.type, notice.message));",
    'manual reminder notice'
)
source = replace_once(
    source,
    """      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_manual_vacancy_info',
        actor: 'RECRUITER',
        action: 'send_vacancy_info',
        vacancyId: candidate.vacancy.id
      });
      return res.redirect(withFlashMessage(returnTo, 'success', 'Información de la vacante enviada correctamente.'));""",
    """      const delivery = await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_manual_vacancy_info',
        actor: 'RECRUITER',
        action: 'send_vacancy_info',
        vacancyId: candidate.vacancy.id
      });
      const notice = getManualOutboundCompletionNotice(
        delivery,
        'Información de la vacante enviada correctamente.'
      );
      return res.redirect(withFlashMessage(returnTo, notice.type, notice.message));""",
    'vacancy info notice'
)
source = replace_once(
    source,
    """      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_outbound',
        action: action || 'free_text',
        preserveExactBody: action === 'free_text'
      });
      res.redirect(`/admin/candidates/${id}?outboundSuccess=` + encodeURIComponent('Mensaje enviado correctamente.'));""",
    """      const delivery = await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_outbound',
        action: action || 'free_text',
        preserveExactBody: action === 'free_text'
      });
      const notice = getManualOutboundCompletionNotice(delivery, 'Mensaje enviado correctamente.');
      const noticeParam = notice.type === 'success' ? 'outboundSuccess' : 'outboundError';
      res.redirect(`/admin/candidates/${id}?${noticeParam}=` + encodeURIComponent(notice.message));""",
    'free outbound notice'
)
source = replace_once(
    source,
    """      await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_request_hv',
        action: 'request_hv'
      });
      res.redirect(withFlashMessage(returnTo, 'success', 'Solicitud de HV enviada correctamente.'));""",
    """      const delivery = await sendAdminOutboundMessage(prisma, candidate, body, {
        source: 'admin_request_hv',
        action: 'request_hv'
      });
      const notice = getManualOutboundCompletionNotice(
        delivery,
        'Solicitud de HV enviada correctamente.'
      );
      res.redirect(withFlashMessage(returnTo, notice.type, notice.message));""",
    'request hv notice'
)
admin.write_text(source)

structural = Path('test/adminManualOutboundDeliveryAuthority.test.js')
structural_source = structural.read_text()
structural_source = replace_once(
    structural_source,
    "/import \\{\\s*deliverManualOutboundText,\\s*getManualOutboundUserMessage\\s*\\} from '\\.\\.\\/services\\/manualOutboundDeliveryService\\.js';/",
    "/import \\{\\s*deliverManualOutboundText,\\s*getManualOutboundCompletionNotice,\\s*getManualOutboundUserMessage\\s*\\} from '\\.\\.\\/services\\/manualOutboundDeliveryService\\.js';/",
    'structural import regex'
)
structural_source += """

test('los cuatro consumidores convierten reconciliación pendiente en advertencia visible', () => {
  for (const [name, route] of [
    ['recordatorio de entrevista', interviewReminderRoute],
    ['información de vacante', vacancyInfoRoute],
    ['mensaje saliente', outboundRoute],
    ['solicitud de HV', requestHvRoute]
  ]) {
    assert.match(route, /const delivery = await sendAdminOutboundMessage\(/, `${name} no captura el resultado`);
    assert.match(route, /getManualOutboundCompletionNotice\(/, `${name} no convierte el resultado en aviso`);
  }
  assert.match(outboundRoute, /notice\.type === 'success' \? 'outboundSuccess' : 'outboundError'/);
});
"""
structural.write_text(structural_source)

service_test = Path('test/manualOutboundDeliveryService.test.js')
test_source = service_test.read_text()
test_source = replace_once(
    test_source,
    """import {
  deliverManualOutboundText,
  getManualOutboundUserMessage
} from '../src/services/manualOutboundDeliveryService.js';""",
    """import {
  deliverManualOutboundText,
  getManualOutboundCompletionNotice,
  getManualOutboundUserMessage
} from '../src/services/manualOutboundDeliveryService.js';""",
    'service test import'
)
test_source += """

test('count cero después de Meta queda SENT pero pendiente de reconciliación', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  const originalUpdateMany = harness.prisma.candidate.updateMany;
  let updateAttempt = 0;
  harness.prisma.candidate.updateMany = async (args) => {
    updateAttempt += 1;
    if (updateAttempt === 2) return { count: 0 };
    return originalUpdateMany(args);
  };

  const result = await deliverManualOutboundText(harness.prisma, input, {
    sendText: harness.sendText,
    now: createClock('2026-07-16T01:35:00.000Z', '2026-07-16T01:35:01.000Z')
  });

  assert.equal(result.sent, true);
  assert.equal(result.deliveryState, 'SENT');
  assert.equal(result.candidateStateCount, 0);
  assert.equal(result.persistencePending, true);
  assert.equal(harness.state.messages[0].rawPayload.delivery.state, 'SENT');
  assert.equal(harness.state.messages[0].rawPayload.delivery.candidateStateCount, 0);

  const notice = getManualOutboundCompletionNotice(result, 'Mensaje enviado correctamente.');
  assert.equal(notice.type, 'error');
  assert.match(notice.message, /WhatsApp confirmó el envío/i);
  assert.match(notice.message, /No reenvíes/i);
});

test('éxito reconciliado conserva el aviso normal', () => {
  const notice = getManualOutboundCompletionNotice(
    { sent: true, persistencePending: false },
    'Mensaje enviado correctamente.'
  );
  assert.deepEqual(notice, {
    type: 'success',
    message: 'Mensaje enviado correctamente.'
  });
});

test('el error persistido del proveedor elimina tokens y credenciales', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  const rejection = new Error('falló access_token=secreto Bearer token-supersecreto');
  rejection.response = { status: 400 };

  await assert.rejects(
    () => deliverManualOutboundText(harness.prisma, input, {
      sendText: async () => { throw rejection; },
      now: createClock('2026-07-16T01:40:00.000Z', '2026-07-16T01:40:01.000Z')
    }),
    /manual_outbound_provider_rejected/
  );

  const lastError = harness.state.messages[0].rawPayload.delivery.lastError;
  assert.match(lastError, /access_token=\[REDACTED\]/);
  assert.match(lastError, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(lastError, /secreto|token-supersecreto/);
});
"""
service_test.write_text(test_source)
