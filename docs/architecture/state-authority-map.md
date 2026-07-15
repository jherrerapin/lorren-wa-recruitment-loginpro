# Mapa de autoridades y escrituras de estado

## Objetivo

Este documento registra dónde se modifica actualmente el estado conversacional y de reclutamiento de Lórren antes de extraer módulos o retirar rutas heredadas.

El inventario verificable está en `state-authority-manifest.json`. El gate `test/stateAuthorityManifest.test.js` inspecciona el código fuente y falla cuando:

- aparece un escritor nuevo no declarado;
- un escritor declarado deja de existir o de escribir el modelo;
- se declara más de una autoridad canónica para el mismo agregado;
- el manifiesto contiene contratos incompletos.

El manifiesto no autoriza que la dispersión continúe indefinidamente. Describe la línea base que debe reducirse progresivamente.

## Estado actual

| Agregado o modelo | Escritores declarados | Riesgo | Estado de migración | Autoridad objetivo |
| --- | ---: | --- | --- | --- |
| `Candidate` | 15 | Crítico | Fragmentado | `CandidateStateService` |
| `InterviewBooking` | 4 | Crítico | En consolidación | `InterviewBookingStateService` |
| `Message` | 1 | Alto | Canónico | `ConversationMessageRepository` |
| `CandidateDataConsentEvent` | 1 | Crítico | Canónico | `ConsentStateService` |
| `AttachmentAnalysis` | 2 | Alto | En consolidación | `AttachmentAnalysisRepository` |
| `JobQueue` | 1 | Alto | En consolidación | `JobQueueService` |
| `CandidateAdminEvent` | 1 | Medio | En consolidación | `CandidateAdminAuditService` |
| `InterviewSlot` | 1 | Alto | Fragmentado | `InterviewAvailabilityService` |

## Progreso de consolidación

### Consentimiento canónico

La ruta `src/routes/lorenV2DataConsents.js` y el gate de WhatsApp `src/services/dataConsentGate.js` delegan la decisión versionada en `ConsentStateService`.

La autoridad aplica conjuntamente:

- estado, versión, texto y fuente del consentimiento;
- fechas mutuamente excluyentes de aceptación o revocatoria;
- actor que registró la decisión;
- evento versionado con IP, agente de usuario y nota opcional;
- transiciones adicionales permitidas del candidato, como reanudación de flujo o vacante.

La autoridad puede recibir el cliente Prisma principal —abriendo una única transacción— o un cliente `tx` existente, reutilizando la unidad atómica del caso de uso sin intentar anidarla.

`CandidateDataConsentEvent` tiene ahora un único escritor: `ConsentStateService`. El scanner de CI impide que una ruta, gate o integración vuelva a crear eventos directamente.

### Mensajes canónicos

`dataConsentGate.js` ya no escribe `Message` directamente. La evidencia entrante y las respuestas salientes del gate pasan por `ConversationMessageRepository`.

`adminSupervisor.js` delega la entrada idempotente, los avisos internos, las respuestas al candidato y la resolución del requerimiento pendiente. Conserva la interpretación de la instrucción, el envío por WhatsApp, la selección de documentos, el conocimiento validado y las pausas o reanudaciones del candidato.

`reminder.js` delega la persistencia de sus mensajes y conserva programación, reclamación, ventana de WhatsApp, reservas, estados del candidato y jobs.

La mensajería manual autorizada de `admin.js`, encapsulada en `sendAdminOutboundMessage()`, delega su creación saliente y conserva el orden actual —envío al proveedor, actualización del candidato y persistencia—, el cuerpo exacto o saneado y el payload de intervención manual.

`webhook.js` ya no crea ni actualiza `Message` directamente. Sus cinco fronteras de escritura delegan en el repositorio compartido:

- `saveInboundMessage()` usa `persistInboundConversationMessage()` y conserva `waMessageId`, sanitización del payload, fallback `MessageType.UNKNOWN`, detección de duplicados, actualización de `Candidate.lastInboundAt` y resolución del ID creado;
- `saveOutboundMessage()` usa `persistOutboundConversationMessage()` y conserva la actualización posterior de `Candidate.lastOutboundAt`;
- `recordIntentionalSilence()` usa la persistencia saliente para su traza interna, preservando `visibility=internal`, `neverSendToCandidate=true` y manejo tolerante de errores;
- `attachDebugTrace()` usa `mergeConversationMessagePayload()` y conserva la clave histórica `debugTrace` sin borrar metadatos previos;
- el cierre exitoso del lote multilinea usa `markConversationMessagesResponded()` con los mismos IDs y una fecha validada, en el mismo punto anterior al `catch` y al `finally`.

La eliminación administrativa del candidato también delega ahora en `deleteConversationMessagesForCandidate(tx, ...)`. La ruta conserva la misma transacción y el mismo orden:

1. eliminar los mensajes del candidato;
2. eliminar sus reservas de entrevista;
3. eliminar el candidato;
4. limpiar el CV almacenado después de cerrar la transacción.

La operación recibe el mismo cliente transaccional `tx`; no abre una transacción adicional ni modifica reservas, candidato, permisos o almacenamiento.

`ConversationMessageRepository` es el único escritor directo de `Message`. El scanner de CI bloquea que una ruta, adaptador o servicio vuelva a ejecutar `create`, `update`, `updateMany` o `deleteMany` directamente sobre el modelo.

El repositorio distingue actualmente seis contratos:

- entrada idempotente mediante `waMessageId`, `createMany` y `skipDuplicates`;
- salida con dirección controlada por la autoridad, sin permitir que el consumidor la cambie;
- reemplazo restringido exclusivamente a `rawPayload` sobre un mensaje identificado;
- fusión de un patch en `rawPayload` sin borrar metadatos previos;
- marcado por lote de `respondedAt` con IDs deduplicados y fecha validada;
- eliminación de mensajes por candidato sobre el cliente Prisma o transaccional recibido.

La autoridad de persistencia de `Message` ya es canónica. Esto no significa que exista un outbox productivo: los consumidores migrados continúan enviando al proveedor antes de persistir para preservar el comportamiento actual. El outbox, los estados de entrega y la idempotencia de salida siguen siendo una evolución separada.

### Reservas de entrevista en consolidación

`InterviewBookingStateService` establece la primera frontera compartida del agregado. `interviewScheduler.js` conserva la resolución de fechas, cupos, anticipación mínima, ventana de WhatsApp y selección del siguiente slot, pero deja de escribir `InterviewBooking` directamente.

Las funciones públicas del scheduler mantienen su firma y retorno:

- `createBooking()` delega en `createScheduledInterviewBooking()`;
- `cancelCandidateBookings()` delega en `cancelActiveInterviewBookings()` y conserva el resultado `{ count }` de Prisma.

La nueva autoridad protege las invariantes vigentes sin introducir una transacción o cambiar estados:

- una reserva activa idéntica se reutiliza;
- antes de crear otra reserva se cierran las activas del candidato con el `replacementStatus` recibido;
- la nueva reserva continúa naciendo como `SCHEDULED` por defecto de Prisma;
- si la creación falla por una carrera, se recupera la reserva activa más próxima;
- la cancelación solo afecta estados `SCHEDULED` o `CONFIRMED` y cierra la ventana de recordatorio.

`reminder.js` delega ahora cierre de ventana, reclamación idempotente, `NO_RESPONSE` y respuestas interpretadas. La solicitud de reprogramación conserva la reserva activa hasta crear un reemplazo válido. El número de escritores baja a cuatro: administración, webhook, `chatEngine` y la autoridad canónica.

## Hallazgos

### 1. `Candidate` funciona como agregado compartido por demasiados módulos

Lo modifican rutas HTTP, webhook, motores conversacionales, consentimiento, atribución, archivos, recordatorios, supervisor e integraciones. Esto permite que varios componentes decidan directamente sobre:

- paso conversacional;
- estado de selección;
- vacante y procedencia;
- consentimiento;
- datos de perfil;
- hoja de vida;
- pausas y reanudaciones;
- recordatorios.

La meta no es mover estas quince escrituras a un archivo gigante. La autoridad objetivo debe exponer casos de uso y validar transiciones, mientras cada dominio conserva su propia decisión especializada.

### 2. Las reservas conservan tres fronteras directas por migrar

Después de extraer scheduler y recordatorios, `InterviewBooking` todavía se modifica desde webhook, administración y un motor conversacional alternativo. Deben centralizarse gradualmente invariantes como:

- no marcar `RESCHEDULED` sin una nueva reserva;
- no confirmar una reserva cancelada;
- no emitir recordatorios para reservas cerradas;
- no crear dos reservas activas para el mismo candidato y vacante.

### 3. La persistencia de mensajes ya tiene una autoridad única

Todas las creaciones, actualizaciones y eliminaciones de `Message` pasan por `ConversationMessageRepository`. Las fronteras conservan sus decisiones y unidades transaccionales, pero no controlan directamente cómo se persiste el agregado.

La siguiente evolución del dominio debe distinguir explícitamente:

- mensaje saliente comprometido en outbox;
- intento de entrega al proveedor;
- confirmación o fallo de entrega;
- reintentos e idempotencia de salida.

### 4. Consentimiento demuestra el patrón de migración

La consolidación se completó sin mover las políticas de negocio del panel ni del gate. Cada consumidor conserva cuándo aceptar o revocar, pero una sola autoridad controla cómo persistir la decisión y el evento. El mismo patrón permitió completar `Message` sin reescribir las decisiones conversacionales.

## Clasificación de escritores

- `canonical`: autoridad única del agregado para las operaciones rastreadas;
- `boundary`: frontera especializada que todavía escribe directamente otro estado del modelo;
- `legacy`: ruta heredada que debe migrarse y retirarse;
- `admin`: operación humana explícita que debe pasar por un caso de uso auditado;
- `integration`: sincronización externa que no debe decidir transiciones conversacionales;
- `operational`: jobs, recordatorios o tareas internas.

## Reglas para nuevos cambios

1. Un archivo nuevo no puede escribir un modelo rastreado sin modificar el manifiesto y justificarlo en el PR.
2. Añadir un escritor no constituye por sí mismo una solución; debe explicarse por qué no puede usar la autoridad objetivo.
3. La eliminación de una escritura exige retirar también su entrada del manifiesto.
4. Un modelo marcado `canonical` debe tener exactamente un escritor con rol `canonical`.
5. Las rutas, webhooks y adaptadores no deben convertirse en autoridades canónicas.
6. Las integraciones pueden aportar hechos, pero no decidir por sí solas transiciones de candidato o reserva.
7. Los cambios de consentimiento deben producir evento versionado y actualización del candidato dentro de la misma unidad atómica.
8. La persistencia de salida debe preceder a la entrega cuando exista un contrato productivo de outbox e idempotencia.

## Orden recomendado de consolidación

1. Diseñar outbox y estados de entrega sobre la autoridad canónica de `Message`.
2. Completar `InterviewBooking` y sus transiciones.
3. Campos conversacionales de `Candidate`.
4. Atribución, CV, recordatorios y operaciones administrativas del candidato.
5. Disponibilidad de entrevista y configuración de slots.

## Criterio de finalización

Un agregado pasa a `canonical` cuando:

- existe un servicio o repositorio único para sus escrituras;
- las rutas y adaptadores solo invocan casos de uso;
- las invariantes están cubiertas por pruebas;
- el manifiesto contiene un único escritor canónico;
- el replay demuestra que la consolidación no altera el comportamiento protegido.
