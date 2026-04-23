# Hardening P0 Delta

Este delta refina componentes existentes sin rehacer arquitectura:

- **Extractor estructurado**: se amplió el schema con conflictos estructurados, `replyIntent` tipado y evidencia por campo consistente para policy.
- **Policy layer**: endurece bloqueo de saludo como nombre, bloqueo de dirección como edad y protección anti-autodescarte para campos críticos con evidencia débil.
- **Response policy**: ahora usa variantes por intención, control de repetición semántica y salida con `text + intent`.
- **Attachment analyzer**: pipeline híbrida PDF/DOCX + fallback multimodal con Responses API, sin tratar automáticamente toda imagen como HV en foto.
- **Webhook**: integra `responsePolicy` para respuestas de adjuntos y evita pausar automáticamente el bot por recepción de media.
- **Reminder**: recordatorio operativo ajustado a una hora y encolado con JobQueue (cuando `FF_POSTGRES_JOB_QUEUE=true`).
- **Tests**: se agregan casos delta para adjuntos, policy de respuesta y encolamiento del reminder.

## Feature flags relevantes (fallback false)

- `FF_RESPONSES_EXTRACTOR`
- `FF_POLICY_LAYER`
- `FF_POSTGRES_JOB_QUEUE`
- `FF_ATTACHMENT_ANALYZER`
- `FF_STOP_KEEPALIVE_AFTER_INTERVIEW`
- `FF_SEMANTIC_SHORT_MEMORY`
- `FF_ASYNC_ADMIN_MEDIA_FORWARD`
