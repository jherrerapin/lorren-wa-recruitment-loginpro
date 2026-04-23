# Hardening P0 Delta

Este delta refina componentes existentes sin rehacer arquitectura:

- **Extractor estructurado**: se amplió el schema con conflictos estructurados, `replyIntent` tipado y evidencia por campo consistente para policy.
- **Extractor estructurado**: se reforzó el prompt de extracción para evitar `fullName` falsos (saludos), evitar edad desde direcciones (ej. "calle 80") y exigir evidencia/coherencia por campo con salida strict JSON Schema.
- **Policy layer**: endurece bloqueo de saludo como nombre, bloqueo de dirección como edad y protección anti-autodescarte para campos críticos con evidencia débil.
- **Policy layer**: la inferencia de género débil pasa a revisión (`weak_gender_inference`) y no se persiste para decisiones duras.
- **AI-first contextual replies**: se agrega `contextualReply` como capa principal de redacción por situación (`replySituation`) usando `gpt-5.4-mini-2026-03-17`.
- **Response policy**: queda relegada a fallback defensivo cuando el modelo falla, responde vacío o repite semánticamente outbound reciente.
- **Attachment analyzer**: pipeline híbrida PDF/DOCX + fallback multimodal con Responses API, sin tratar automáticamente toda imagen como HV en foto.
- **Attachment analyzer**: se fija política explícita para `.doc` legacy: no se procesa con `mammoth`, se clasifica como `OTHER` (`unsupported_doc_format`) y se solicita reenviar HV en PDF o DOCX para evitar falsos `CV_VALID`.
- **Webhook**: enruta adjuntos y continuidad de faltantes por `contextualReply` como vía principal; mantiene decisiones de negocio deterministas (guardar/no guardar HV, update de estado y booking).
- **Webhook**: reduce mensajes hardcodeados en adjuntos/follow-up y usa `responsePolicy` solo como respaldo técnico.
- **Reminder/keepalive**: recordatorio operativo ajustado a una hora y encolado con JobQueue (cuando `FF_POSTGRES_JOB_QUEUE=true`); keepalive se corta como política permanente al detectar entrevista vencida, reminder ya intentado o booking inactivo (sin depender de rollout adicional).
- **Job worker**: el job `INTERVIEW_REMINDER` procesa por `candidateId` (payload) para evitar ejecuciones amplias no deterministas.
- **JobQueue**: se agrega `completedAt` para trazabilidad de finalización en jobs `DONE` y `FAILED` terminales.
- **Tests**: se amplían casos delta para saludo/nombre, calle 80/edad, género explícito vs ambiguo, no repetición fuerte, reminder + corte keepalive y clasificación de adjuntos.

## Alcance real PR 64 (quirúrgico post PR 63)

- Corregir soporte de adjuntos para bloquear `.doc` legacy y guiar a PDF/DOCX.
- Formalizar que keepalive no debe ejecutarse después de entrevista vencida ni en bookings cerrados/intentados.
- Cubrir explícitamente con tests: `.doc` no válido como HV, anti-repetición con contexto de pregunta+adjunto, dispatcher por `candidateId`, y guardas de keepalive.
- Sin cambios de `ConversationStep`, sin cambios SaaS/tenant/RLS, sin rehacer webhook/conversationEngine ni extractor estructurado.

## Cierre P0: AI-first replies y adjuntos

- **Situación conversacional explícita**: cada respuesta se redacta desde una situación (`attachment_resume_photo`, `attachment_id_doc`, `attachment_other_doc`, `attachment_unreadable`, `request_missing_data`, etc.), no desde plantillas quemadas.
- **Attachment understanding vs attachment classification**:
  - `attachmentAnalyzer` sigue clasificando.
  - La clasificación alimenta la decisión determinista y la situación conversacional.
  - La redacción final sale del modelo contextual.
- **Reglas deterministas conservadas**:
  - `CV_VALID` guarda HV.
  - `CV_IMAGE_ONLY`, `ID_DOC`, `OTHER`, `UNREADABLE` no guardan HV final.
  - Ningún media pausa bot por defecto.
- **Fallback policy**:
  - Si Responses API falla, no responde, o repite semánticamente, se usa `responsePolicy`.
  - Se conserva continuidad operativa sin romper flujo.
- **Criterio de escalamiento humano**:
  - Escala solo cuando hay baja confianza real (`UNREADABLE/OTHER` con confianza muy baja), contradicción o pregunta imposible de resolver con reglas/contexto disponible.
  - En escalamiento se evita inventar respuestas; se usa la lógica existente de intervención humana.
- **Eliminación práctica de respuestas quemadas**:
  - Las plantillas dejan de ser mecanismo principal.
  - Outbound reciente se usa como guardrail anti-repetición.
  - Se prioriza respuesta natural contextual antes de retomar el paso del proceso.

## Feature flags relevantes (fallback false)

- `FF_RESPONSES_EXTRACTOR`
- `FF_POLICY_LAYER`
- `FF_POSTGRES_JOB_QUEUE`
- `FF_ATTACHMENT_ANALYZER`
- `FF_SEMANTIC_SHORT_MEMORY`
- `FF_ASYNC_ADMIN_MEDIA_FORWARD`

## Interview lifecycle hardening definitivo

- **SCHEDULED vs CONFIRMED**:
  - Aceptar un horario crea/actualiza booking en `SCHEDULED`.
  - `CONFIRMED` solo se permite como confirmación de asistencia cerca de entrevista.
  - Ventana explícita de confirmación: `INTERVIEW_CONFIRMATION_WINDOW_HOURS` (default `6` horas).
  - Si ya se envió reminder de entrevista (`reminderSentAt`), una confirmación afirmativa sí puede marcar `CONFIRMED`.
  - Un “confirmo” temprano, fuera de ventana y sin reminder enviado, **no** cambia estado.

- **Recordatorio real de entrevista**:
  - Se ejecuta a `scheduledAt - 1 hora`.
  - Marca `reminderSentAt` y cierra keepalive (`reminderWindowClosed=true`).
  - Solo envía si booking está activo (`SCHEDULED`/`CONFIRMED`), no vencido y sin reminder previo.
  - El copy es explícitamente de entrevista (no de faltantes/HV).

- **Intenciones de entrevista centralizadas**:
  - Se agregó servicio determinista reutilizable (`interviewLifecycle`) para detectar:
    - `confirm_attendance`
    - `cancel_interview`
    - `reschedule_interview`
    - `none`
  - La detección depende de texto + proximidad temporal + estado de reminder + existencia de booking activo.

- **Política de cancelación / reagendamiento**:
  - Cancelación explícita: `booking.status = CANCELLED` + `reminderResponse` con evidencia textual.
  - Reagendamiento explícito: `booking.status = RESCHEDULED` + `reminderResponse`, conservando oferta de nuevo slot cuando hay wiring.

- **Política NO_RESPONSE (10 minutos antes)**:
  - Configurable por `INTERVIEW_NO_RESPONSE_MINUTES_BEFORE` (default `10`).
  - Si reminder ya salió y no existe respuesta inbound del candidato, al entrar en umbral se marca `NO_RESPONSE`.
  - Luego de `NO_RESPONSE`, no se insiste con keepalive ni nuevos recordatorios automáticos para esa entrevista.

- **Keepalive y cero insistencia post-entrevista**:
  - Keepalive solo corre si existe booking activo real.
  - No se envía keepalive para candidatos en `SCHEDULING` sin booking.
  - Keepalive se corta cuando: reminder enviado/intento, booking cerrado/inactivo o entrevista vencida.
  - Después de `scheduledAt`: no keepalive, no reminder de entrevista, no insistencia automática por esa cita.

- **Canal WhatsApp**:
  - Se mantiene política sin templates de Meta para este flujo.
