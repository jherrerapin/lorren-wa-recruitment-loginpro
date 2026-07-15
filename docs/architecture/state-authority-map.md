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
| `Candidate` | 16 | Crítico | Fragmentado | `CandidateStateService` |
| `InterviewBooking` | 1 | Crítico | Canónico | `InterviewBookingStateService` |
| `Message` | 1 | Alto | Canónico | `ConversationMessageRepository` |
| `CandidateDataConsentEvent` | 1 | Crítico | Canónico | `ConsentStateService` |
| `AttachmentAnalysis` | 2 | Alto | En consolidación | `AttachmentAnalysisRepository` |
| `JobQueue` | 1 | Alto | En consolidación | `JobQueueService` |
| `CandidateAdminEvent` | 1 | Medio | En consolidación | `CandidateAdminAuditService` |
| `InterviewSlot` | 1 | Alto | Fragmentado | `InterviewAvailabilityService` |

## Progreso de consolidación

### Candidate: primera frontera migrada

`CandidateStateService` inicia como autoridad estrecha sin convertir todavía el agregado en canónico. En el manifiesto se declara como `boundary` transitorio porque `ConsentStateService` continúa siendo el escritor canónico del subgrupo de consentimiento mientras los demás consumidores todavía escriben otros campos de `Candidate`.

La primera operación centralizada es la reanudación por mensaje entrante después de una pausa manual. El webhook conserva la decisión mediante `shouldBlockAutomation()` y `shouldResumeAutomationOnInbound()`, pero la persistencia compara el snapshot completo de pausa —ID, marca temporal, actor, motivo y modo de reanudación— mediante `updateMany`. Si otra operación cambió la pausa, `count=0` evita sobrescribirla y el webhook devuelve el estado actual sin registrar una reanudación falsa.

La incorporación temporal de la nueva frontera aumenta el inventario a dieciséis escritores porque los quince consumidores heredados todavía modifican otros grupos de campos de `Candidate`. El agregado permanece `fragmented` hasta migrar cada frontera y resolver la autoridad final por composición de casos de uso.

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

### Reservas de entrevista canónicas

`InterviewBookingStateService` es el único escritor de `InterviewBooking`. Scheduler, recordatorios, panel, chat engine y webhook conservan sus decisiones especializadas, pero delegan la persistencia y las transiciones en la autoridad compartida.

La autoridad protege estas invariantes:

- una reserva activa exacta se reutiliza;
- el reemplazo respeta el índice único parcial de una reserva activa por candidato;
- el cierre anterior y la creación del reemplazo se confirman o revierten juntos dentro de una transacción serializable;
- los conflictos `P2034` se reintentan de forma acotada y una recuperación `P2002` solo acepta la reserva exacta;
- una solicitud de reprogramación conserva `SCHEDULED` o `CONFIRMED` hasta crear un reemplazo válido;
- confirmación y cancelación comparan ID y estado leído antes de informar éxito;
- el webhook registra como silencio intencional una reserva ausente o una carrera y no ejecuta efectos posteriores;
- la aceptación conversacional valida primero la oferta y delega una sola creación o sustitución atómica con el cliente Prisma raíz;
- recordatorios, acciones manuales y eliminaciones conservan sus filtros y contratos explícitos.

El scanner de CI bloquea cualquier nueva escritura directa fuera de la autoridad. Los textos, horarios, payloads, interpretación conversacional y efectos existentes sobre el candidato permanecen en sus fronteras.

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

### 2. Las reservas tienen autoridad canónica

La consolidación de `InterviewBooking` quedó completa: no existen escrituras directas desde rutas, webhooks, scheduler, recordatorios, panel o motores conversacionales. La evolución pendiente es separada y comprende historial inmutable, actor y motivo estructurados, retención y `tenantId`.

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
2. Diseñar historial, retención y `tenantId` sobre la autoridad canónica de `InterviewBooking`.
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
