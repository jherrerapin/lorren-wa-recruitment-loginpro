# Inventario de estado de Candidate

## Propósito

`Candidate` continúa siendo el agregado más fragmentado del repositorio. La consolidación es incremental: cada dominio conserva sus decisiones, pero la persistencia compartida debe pasar por contratos estrechos y probados. No existe ni se permite `updateCandidate(data)`.

`Candidate` permanece en `migrationStage: fragmented`; solo los slices expresamente migrados se consideran canónicos. La matriz del progreso conversacional vive en `config/candidate-progress-authority.json`.

## Grupos de responsabilidad

### Progreso conversacional

- `currentStep`
- `multilineWindowUntil`
- `multilineBatchVersion`

### Pausa y reanudación

- `botPaused`
- `botPausedAt`
- `botPausedBy`
- `botPauseReason`
- `botResumeMode`

### Selección y descarte

- `status`
- `rejectionReason`
- `rejectionDetails`
- `interviewNotes`

### Consentimiento

Los campos `dataConsent*` permanecen bajo `ConsentStateService`; no deben duplicarse en una autoridad genérica.

### Perfil, atribución, vacante y CV

Estos grupos conservarán fronteras especializadas. La autoridad de `Candidate` no acepta bytes de CV ni patches arbitrarios. La modernización no modifica la lógica existente relacionada con género.

### Actividad, recordatorios y duplicados

`lastInboundAt`, `lastOutboundAt`, recordatorios y señales de duplicado se migrarán mediante contratos independientes.

## Fronteras ya migradas

`CandidateStateService` ya controla:

- reanudación por inbound con snapshot completo de pausa;
- pausa y reanudación administrativa;
- apertura manual de WhatsApp;
- ciclo durable de entrega manual saliente;
- resolución posterior a una respuesta del supervisor.

Todas estas operaciones devuelven `count=0` ante carrera y no abren transacciones anidadas.

## Fase 1: caracterización del progreso conversacional

La caracterización distingue:

1. **Productor de decisión:** calcula un destino o `candidateUpdates` sin persistir.
2. **Escritor efectivo:** ejecuta la mutación de `Candidate`.
3. **Contexto de decisión:** expone `currentStep` sin mutarlo.
4. **Proyección de solo lectura:** usa el paso en respuestas, estadísticas o recordatorios.

Los únicos pasos válidos son los del enum Prisma `ConversationStep`:

- `MENU`
- `GREETING_SENT`
- `COLLECTING_DATA`
- `CONFIRMING_DATA`
- `ASK_CV`
- `DONE`
- `SCHEDULING`
- `SCHEDULED`

La matriz documenta resolución de vacante, captura silenciosa, consentimiento, vacante pausada, reprogramación, reducción del engine, progresión legacy y correcciones administrativas.

## Fase 2: autoridad multilinea migrada

La primera frontera runtime del grupo quedó centralizada sin cambiar tiempos, consolidación, mensajes ni orden del webhook.

### `scheduleCandidateMultilineWindow()`

Recibe `candidateId`, `windowMs` y `now`. Calcula `multilineWindowUntil`, incrementa atómicamente `multilineBatchVersion` y devuelve:

- `windowMs`;
- `windowUntil`;
- `batchVersion`.

Cada inbound crea una versión nueva e invalida propietarios anteriores. Esta operación no es idempotente por diseño.

### `acquireCandidateMultilineBatch()`

Recibe `candidateId`, la versión esperada y `now`. Ejecuta un `updateMany` condicionado por:

- ID exacto;
- `multilineBatchVersion` exacta;
- `multilineWindowUntil <= now`.

Solo cuando `count === 1` limpia la ventana e incrementa nuevamente la versión. Una versión obsoleta, una ventana no vencida o una segunda adquisición devuelven `count=0`.

### Validaciones

Los contratos rechazan antes de escribir:

- IDs vacíos;
- duraciones negativas, no finitas, vacías, booleanas, arreglos u objetos;
- versiones negativas, no enteras, vacías, booleanas, arreglos u objetos;
- fechas nulas, booleanas o inválidas;
- clientes Prisma sin `update` o `updateMany` según corresponda.

Las duraciones y versiones aceptan exclusivamente valores de tipo `number` o `string` no vacío; no dependen de coerciones implícitas de estructuras complejas.

Aceptan el cliente Prisma raíz o un `tx` existente y no crean transacciones anidadas.

### Responsabilidades después de la migración

- `webhook.js` conserva `getMultilineWindowMs()`, el mismo `sleep()` y la consolidación del lote.
- `CandidateStateService` es el único escritor de `multilineWindowUntil` y `multilineBatchVersion`.
- El webhook procesa el lote únicamente cuando la autoridad devuelve `count === 1`.
- Persistencia de mensajes, `respondedAt`, replays y textos permanecen iguales.

## Protección en CI

`test/candidateMultilineStateService.test.js` cubre programación, invalidación de versiones, adquisición única, carreras, ventana no vencida, validaciones de tipo y ausencia de transacciones anidadas.

`test/candidateProgressAuthority.test.js` bloquea:

- divergencia con el enum Prisma;
- fuentes sin clasificar;
- orígenes o destinos desconocidos;
- pérdida del compare-and-set;
- escrituras multilinea directas en los wrappers del webhook;
- productores puros convertidos en escritores;
- APIs arbitrarias de patch.

## Fase 3: transiciones simples del engine

`transitionCandidateConversationStep()` controla las transiciones donde `currentStep` es el único campo pendiente. Compara `candidateId + currentStep` mediante `updateMany`, escribe exclusivamente el siguiente paso y recupera el candidato vigente.

`conversationEngine.act()` conserva la reducción de acciones, readiness y guardas. Solo delega cuando `pendingUpdate` contiene exclusivamente `currentStep`. Si otra operación cambió el paso, la autoridad devuelve `count=0`, `act()` conserva el paso observado y `chatEngine` suprime la respuesta con razón `stale_candidate_step`. No se reintenta ni se sobrescribe el estado más nuevo.

El cierre exacto por falta de interés deja de formar parte de esa deuda. El rechazo y el `pause_bot` explícito también tienen contratos propios; agenda y pausas implícitas permanecen temporalmente unidas en `act()`.

## Fase 4: cierre por falta de interés

`completeCandidateNoInterestTransition()` controla únicamente la combinación producida por `mark_no_interest` cuando `pendingUpdate` contiene exactamente:

- `currentStep: DONE`;
- `reminderScheduledFor: null`;
- `reminderState: SKIPPED`.

La autoridad compara el ID, el paso leído y el snapshot completo del recordatorio. Una carrera por cambio de paso, estado o fecha devuelve `count=0`, recupera el candidato vigente y activa la supresión `stale_candidate_step`. No reintenta, no crea reservas y no absorbe combinaciones con rechazo o pausa.

## Próxima frontera

1. ramas legacy del webhook;
2. correcciones administrativas con actor, motivo y origen esperado;
3. agenda y pausas implícitas por familias pequeñas.

## Reglas permanentes

1. Cada método nombra un caso de uso y controla sus campos.
2. Una carrera nunca se presenta como éxito.
3. Consentimiento, CV, atribución y recordatorios conservan autoridades especializadas.
4. `Candidate` solo será canónico cuando todos sus grupos tengan una autoridad única.
5. La modernización no modifica la lógica existente relacionada con género.

## Fase 5: rechazo por requisitos

La transición producida por `mark_rejected` delega en `completeCandidateRequirementRejection()` únicamente cuando `conversationEngine.act()` ha obtenido una decisión permitida de `buildRequirementRejectionDecision()` y el objeto pendiente contiene exactamente:

- `currentStep`;
- `status`;
- `rejectionReason`;
- `rejectionDetails`;
- `reminderScheduledFor`;
- `reminderState`.

La política de rechazo sigue siendo el **productor de decisión**. `CandidateStateService` es el **escritor efectivo** y no infiere motivos: compara el snapshot completo mediante `updateMany`, escribe `DONE / RECHAZADO / SKIPPED` y recupera el candidato vigente. Un conflicto devuelve `count=0` y `chatEngine` reutiliza `stale_candidate_step` para no enviar una respuesta construida sobre estado obsoleto.

Combinaciones con `pause_bot`, agenda, `mark_female_pipeline` u otros campos permanecen fuera del contrato de rechazo. La pausa conversacional explícita se migra en una fase separada, sin alterar ninguna lógica relacionada con género.

## Fase 6: pausa conversacional explícita

`pauseCandidateAutomationFromConversationEngine()` controla únicamente el `pause_bot` explícito cuando `pendingUpdate` contiene exactamente:

- `botPaused: true`;
- `botPausedAt`;
- `botPauseReason`;
- `reminderScheduledFor: null`;
- `reminderState: CANCELLED`.

La autoridad compara por `updateMany` el snapshot observado de `botPaused`, `botPausedAt`, `botPausedBy`, `botPauseReason`, `botResumeMode`, fecha y estado del recordatorio. No modifica `botPausedBy`, `botResumeMode`, `currentStep`, estado de selección ni agenda. Un candidato ya pausado produce no-op.

`conversationEngine.act()` delega solo la combinación exacta. Cambios de paso, rechazo, falta de interés, agenda, pausas implícitas por falta de slots y `mark_female_pipeline` permanecen fuera. Ante `count=0`, recupera el candidato vigente y `chatEngine` suprime la respuesta mediante `stale_candidate_step`.


## Fase 7: currentStep del consentimiento

`ConsentStateService` conserva la autoridad de los campos `dataConsent*` y de `CandidateDataConsentEvent`. Cuando el patch incluye `currentStep`, exige el paso observado y delega exclusivamente esa transición a `transitionCandidateConsentStep()` dentro de la misma transacción.

La autoridad acepta únicamente los destinos producidos por esta frontera: `GREETING_SENT`, `COLLECTING_DATA` o `DONE`. También permite verificar el mismo paso para registrar una nueva decisión de consentimiento sin inventar una transición distinta.

Si `updateMany` devuelve `count=0`, la transacción revierte los campos de consentimiento y el evento. `dataConsentGate` conserva la evidencia inbound ya registrada, pero no captura perfil ni envía respuesta obsoleta. Los registros administrativos que no cambian `currentStep` continúan usando `ConsentStateService` sin exigir snapshot.

Esta fase no modifica interpretación lingüística, textos legales, perfil, CV, agenda, Prisma, permisos, asistencia ni ninguna lógica relacionada con género.
