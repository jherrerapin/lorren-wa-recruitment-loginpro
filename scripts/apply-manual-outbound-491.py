from pathlib import Path
import json
import textwrap


def replace_once(source, old, new, label):
    if old not in source:
        raise SystemExit(f'{label} not found')
    return source.replace(old, new, 1)


admin = Path('src/routes/admin.js')
source = admin.read_text()
source = replace_once(
    source,
    "import {\n  deleteConversationMessagesForCandidate,\n  persistOutboundConversationMessage\n} from '../services/conversationMessageRepository.js';",
    "import { deleteConversationMessagesForCandidate } from '../services/conversationMessageRepository.js';",
    'admin message repository import'
)
source = replace_once(
    source,
    "import { buildManualInterventionCandidateUpdate } from '../services/adminOutboundPolicy.js';\n",
    '',
    'admin outbound policy import'
)
marker = "import { sendTextMessage } from '../services/whatsapp.js';\n"
source = replace_once(
    source,
    marker,
    marker + "import {\n  deliverManualOutboundText,\n  getManualOutboundUserMessage\n} from '../services/manualOutboundDeliveryService.js';\n",
    'admin whatsapp import'
)
helper_start = source.index('async function sendAdminOutboundMessage')
helper_end = source.index('\nfunction buildManualInterviewReminderText', helper_start)
new_helper = textwrap.dedent('''
async function sendAdminOutboundMessage(prisma, candidate, body, rawPayload = {}) {
  const preserveExactBody = rawPayload?.preserveExactBody === true;
  const originalBody = String(body || '');
  const safety = preserveExactBody
    ? { reply: originalBody, blocked: false, blockedClaims: [], reason: null }
    : sanitizeOutboundReply({
      reply: originalBody || buildSafeFallbackReply(),
      vacancy: candidate?.vacancy || null,
      candidate,
      source: rawPayload?.source || 'admin_outbound'
    });
  const finalBody = preserveExactBody ? originalBody : (safety.reply || buildSafeFallbackReply());
  const authorizedPayload = {
    ...rawPayload,
    actor: rawPayload?.actor === 'ADMIN' ? 'ADMIN' : 'RECRUITER',
    sourceCategory: 'MANUAL_AUTHORIZED',
    manualIntervention: true
  };
  const deliveryPayload = safety.blocked
    ? {
      ...authorizedPayload,
      replySafety: {
        blocked: true,
        blockedClaims: safety.blockedClaims,
        reason: safety.reason
      }
    }
    : authorizedPayload;

  return deliverManualOutboundText(prisma, {
    candidateId: candidate.id,
    phone: candidate.phone,
    body: finalBody,
    actor: rawPayload?.sentBy || 'dashboard',
    reason: rawPayload?.pauseReason || 'Conversacion tomada manualmente desde dashboard',
    rawPayload: deliveryPayload
  }, {
    sendText: sendTextMessage
  });
}
''').strip()
source = source[:helper_start] + new_helper + source[helper_end:]
for old, new in {
    "return res.redirect(withFlashMessage(returnTo, 'error', 'No fue posible enviar el recordatorio manual.'));":
        "return res.redirect(withFlashMessage(returnTo, 'error', getManualOutboundUserMessage(err, 'No fue posible enviar el recordatorio manual.')));",
    "return res.redirect(withFlashMessage(returnTo, 'error', 'No fue posible enviar la información de la vacante.'));":
        "return res.redirect(withFlashMessage(returnTo, 'error', getManualOutboundUserMessage(error, 'No fue posible enviar la información de la vacante.')));",
    "res.redirect(`/admin/candidates/${id}?outboundError=` + encodeURIComponent('Error al enviar el mensaje.'));":
        "res.redirect(`/admin/candidates/${id}?outboundError=` + encodeURIComponent(getManualOutboundUserMessage(err, 'Error al enviar el mensaje.')));",
    "res.redirect(withFlashMessage(returnTo, 'error', 'Error al enviar la solicitud de HV.'));":
        "res.redirect(withFlashMessage(returnTo, 'error', getManualOutboundUserMessage(err, 'Error al enviar la solicitud de HV.')));"
}.items():
    source = replace_once(source, old, new, 'admin error mapping')
admin.write_text(source)

repository = Path('src/services/conversationMessageRepository.js')
repository_source = repository.read_text()
repository_source = replace_once(
    repository_source,
    "  const body = requireNonEmptyString(input.body, 'outbound_delivery_body');",
    "  const body = String(input.body ?? '');\n  if (!body.trim()) throw new Error('outbound_delivery_body_required');",
    'exact outbound body validation'
)
repository.write_text(repository_source)

mock = Path('test/helpers/mockPrisma.js')
mock_source = mock.read_text()
mock_source = replace_once(
    mock_source,
    "function matchesCondition(value, condition) {\n  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {",
    "function matchesCondition(value, condition) {\n  if (value instanceof Date || condition instanceof Date) {\n    if (value == null || condition == null) return value === condition;\n    return normalizeDate(value).getTime() === normalizeDate(condition).getTime();\n  }\n\n  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {",
    'mock date equality'
)
mock_source = replace_once(
    mock_source,
    "      const row = state.messages.find((message) => message.id === where?.id || message.waMessageId === where?.waMessageId) || null;",
    "      const row = state.messages.find((message) => (\n        (where?.id != null && message.id === where.id)\n        || (where?.waMessageId != null && message.waMessageId === where.waMessageId)\n      )) || null;",
    'mock message identity'
)
mock_source = replace_once(
    mock_source,
    "    candidates: clone(initialState.candidates || []),",
    textwrap.dedent('''
    candidates: clone(initialState.candidates || []).map((candidate) => ({
      botPaused: false,
      botPausedAt: null,
      botPausedBy: null,
      botPauseReason: null,
      botResumeMode: null,
      reminderScheduledFor: null,
      reminderState: 'NONE',
      lastOutboundAt: null,
      ...candidate
    })),
    ''').rstrip(),
    'mock candidate defaults'
)
old_return = textwrap.dedent('''
  return {
    state,
    candidate: candidateApi,
    message: messageApi,
    vacancy: vacancyApi,
    interviewBooking: bookingApi,
    interviewSlot: slotApi,
    botKnowledge: botKnowledgeApi
  };
}
''').strip()
new_return = textwrap.dedent('''
  const prisma = {
    state,
    candidate: candidateApi,
    message: messageApi,
    vacancy: vacancyApi,
    interviewBooking: bookingApi,
    interviewSlot: slotApi,
    botKnowledge: botKnowledgeApi
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return prisma;
}
''').strip()
mock.write_text(replace_once(mock_source, old_return, new_return, 'mock transaction contract'))

manifest_path = Path('docs/architecture/state-authority-manifest.json')
manifest = json.loads(manifest_path.read_text())
writer = next(
    item for item in manifest['models']['candidate']['writers']
    if item['path'] == 'src/services/candidateStateService.js'
)
writer['reason'] = 'Frontera de la autoridad objetivo para reanudación por inbound, pausas administrativas, apertura de WhatsApp y ciclo condicional de entrega manual saliente; Candidate continúa fragmentado'
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

map_path = Path('docs/architecture/state-authority-map.md')
map_source = map_path.read_text()
map_source = replace_once(
    map_source,
    '### Candidate: tres fronteras migradas',
    '### Candidate: cuatro fronteras migradas',
    'candidate progress heading'
)
progress = 'La primera frontera centralizada fue la reanudación por mensaje entrante después de una pausa manual. La segunda incorpora los botones explícitos de pausar y reanudar del panel administrativo. La tercera migra la intervención implícita al abrir WhatsApp: además del snapshot completo de pausa, compara `status` para reclutadores o `devLastSeenAt` para DEV antes de actualizar. Todos los casos usan `updateMany`; si otra operación cambió el estado, `count=0` evita sobrescribir una intervención concurrente, retroceder el estado de selección, reemplazar una marca DEV más reciente o registrar un evento administrativo falso.'
map_source = replace_once(
    map_source,
    progress,
    progress + '\n\nLa cuarta frontera incorpora la entrega manual saliente. Antes de contactar a Meta, una transacción reclama el snapshot exacto del candidato y crea una intención `Message` con estado `SENDING`. El éxito finaliza `lastOutboundAt` y registra `SENT`; un rechazo HTTP confirmado restaura condicionalmente el snapshot previo y registra `FAILED`; un timeout o resultado no confirmable queda `UNKNOWN`, mantiene el bot pausado y exige revisión humana. No existe reintento automático.',
    'candidate progress paragraph'
)
map_source = replace_once(
    map_source,
    'La mensajería manual autorizada de `admin.js`, encapsulada en `sendAdminOutboundMessage()`, delega su creación saliente y conserva el orden actual —envío al proveedor, actualización del candidato y persistencia—, el cuerpo exacto o saneado y el payload de intervención manual.',
    '`admin.js` ya no crea mensajes ni actualiza directamente `Candidate` durante la mensajería manual. `manualOutboundDeliveryService` coordina las autoridades compartidas: persiste primero la intención, ejecuta el efecto externo sin reintento automático y registra `SENT`, `FAILED` o `UNKNOWN` según el resultado, conservando el cuerpo exacto o saneado y el payload autorizado.',
    'manual message authority paragraph'
)
map_path.write_text(map_source)

ci = Path('.github/workflows/ci.yml')
ci_source = ci.read_text()
ci_source = replace_once(
    ci_source,
    'run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js test/candidateWhatsAppOpenStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminCandidatePauseAuthority.test.js test/adminCandidateWhatsAppOpenAuthority.test.js test/adminBotPause.test.js',
    'run: node --test test/candidateStateService.test.js test/candidateAdminPauseStateService.test.js test/candidateWhatsAppOpenStateService.test.js test/candidateManualOutboundStateService.test.js test/webhookCandidateStateAuthority.test.js test/adminCandidatePauseAuthority.test.js test/adminCandidateWhatsAppOpenAuthority.test.js test/adminBotPause.test.js',
    'candidate CI gate'
)
ci_source = replace_once(
    ci_source,
    'run: node --test test/adminManualOutbound.test.js',
    'run: node --test test/manualOutboundDeliveryService.test.js test/adminManualOutboundDeliveryAuthority.test.js test/adminManualOutbound.test.js',
    'admin outbound CI gate'
)
ci.write_text(ci_source)
