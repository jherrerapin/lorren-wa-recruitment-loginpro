# Inventario de estado de Candidate

## Propósito

`Candidate` es actualmente el agregado con mayor fragmentación del repositorio. Este documento separa sus campos por responsabilidad para evitar convertir `CandidateStateService` en una actualización genérica o en un archivo gigante.

La consolidación será incremental. Cada consumidor conserva la decisión especializada de su dominio, pero la persistencia de una transición concreta debe pasar por un contrato estrecho y probado.

## Estado actual

El manifiesto registra dieciséis archivos que escriben directamente `Candidate`. Entre ellos existen rutas HTTP, webhook, motores conversacionales, consentimiento, atribución, CV, recordatorios, supervisor e integraciones.

`Candidate` permanece en `migrationStage: fragmented` hasta que todas las escrituras rastreadas hayan migrado. La aparición de `CandidateStateService` no vuelve canónico al agregado; únicamente inicia la autoridad objetivo.

## Grupos de campos

### 1. Progreso conversacional

- `currentStep`
- `multilineWindowUntil`
- `multilineBatchVersion`

Responsabilidad objetivo: casos de uso de conversación que validen el paso leído y el destino permitido.

### 2. Pausa y reanudación de automatización

- `botPaused`
- `botPausedAt`
- `botPausedBy`
- `botPauseReason`
- `botResumeMode`

Responsabilidad objetivo: `CandidateStateService` con contratos explícitos de pausa, reanudación manual y reanudación por mensaje entrante.

### 3. Estado de selección y descarte

- `status`
- `rejectionReason`
- `rejectionDetails`
- `interviewNotes`

Responsabilidad objetivo: casos de uso de reclutamiento y acciones administrativas auditadas.

### 4. Consentimiento

- `dataConsentStatus`
- `dataConsentVersion`
- `dataConsentText`
- `dataConsentSource`
- `dataConsentAcceptedAt`
- `dataConsentRevokedAt`
- `dataConsentRecordedBy`

La persistencia de este grupo ya está protegida por `ConsentStateService`. No debe duplicarse dentro de un método genérico de `CandidateStateService`.

### 5. Atribución, procedencia y vacante

- `vacancyId`
- `campaignId`
- `sourceType`
- `campaignCodeRaw`
- `referrerName`
- `referrerPhone`
- `metaCtwaClid`
- `metaAdId`
- `metaCampaignId`
- `metaCampaignName`

Responsabilidad objetivo: atribución aporta hechos; un caso de uso controla la asignación o corrección de vacante y procedencia.

### 6. Perfil del candidato

- `fullName`
- `documentType`
- `documentNumber`
- `age`
- `gender`
- `neighborhood`
- `locality`
- `zoneViable`
- `experienceInfo`
- `experienceTime`
- `medicalRestrictions`
- `transportMode`
- `zone`
- `experienceSummary`
- `availability`

Responsabilidad objetivo: captura posterior al consentimiento, normalización y correcciones explícitas. La modernización no modifica la lógica existente relacionada con género.

### 7. Hoja de vida

- `cvOriginalName`
- `cvMimeType`
- `cvStorageKey`
- `cvData`

Responsabilidad objetivo: frontera documental. La autoridad de Candidate no debe aceptar bytes ni metadatos de CV mediante un patch arbitrario.

### 8. Recordatorios y actividad

- `lastInboundAt`
- `lastOutboundAt`
- `devLastSeenAt`
- `lastReminderAt`
- `reminderScheduledFor`
- `reminderState`

Responsabilidad objetivo: contratos separados para actividad, programación y cancelación. Las transiciones que también cambien pausa deben ejecutarse mediante un caso de uso explícito.

### 9. Duplicados y notas operativas

- `potentialDuplicate`
- `potentialDuplicateAt`
- `potentialDuplicateNote`

Responsabilidad objetivo: detección y revisión administrativa, con evidencia y auditoría.

## Primera frontera: reanudación por inbound

`botAutomationPolicy.js` ya contiene dos decisiones puras:

- `shouldResumeAutomationOnInbound(candidate)` determina si la pausa puede levantarse;
- `buildInboundResumeUpdate(now)` define los campos resultantes.

La deuda estaba en `prepareCandidateForInboundAutomation()` de `webhook.js`, que ejecutaba un `candidate.update({ id })` sin comparar el snapshot de pausa leído.

El primer contrato de `CandidateStateService`:

- recibe el cliente Prisma raíz o un cliente `tx`;
- exige el ID y el snapshot exacto de pausa;
- compara `id`, `botPaused`, `botPausedAt`, `botPausedBy`, `botPauseReason` y `botResumeMode` mediante `updateMany`;
- usa exclusivamente `buildInboundResumeUpdate(now)` como datos;
- recupera el candidato actual después de la comparación;
- no abre una transacción anidada;
- no informa éxito cuando otra operación cambió la pausa.

Esta operación es una única escritura condicional. No necesita una transacción interactiva; las futuras operaciones que combinen varias escrituras deberán ser cortas, atómicas y reutilizar un `tx` existente cuando corresponda.

## Fronteras adicionales migradas

### Pausa y reanudación administrativa

Los botones explícitos del panel delegan en `pauseCandidateAutomationFromAdmin()` y `resumeCandidateAutomationFromAdmin()`. Ambos comparan el snapshot completo de pausa y solo registran eventos administrativos cuando `count === 1`.

### Apertura manual de WhatsApp

`recordManualWhatsAppOpen()` compara pausa y, según el rol, también `status` o `devLastSeenAt`. Una carrera no abre WhatsApp ni registra una auditoría falsa.

### Entrega manual saliente

El ciclo `claimManualOutboundDelivery()` → proveedor → `finalizeManualOutboundDelivery()` diferencia `SENDING`, `SENT`, `FAILED` y `UNKNOWN`. La evidencia del mensaje existe antes del efecto externo y una entrega incierta no puede reanudarse automáticamente.

### Resolución de revisión manual del supervisor

`completeSupervisorReviewAfterDelivery()` protege la limpieza posterior a una respuesta del supervisor:

- exige una pausa activa;
- compara pausa completa y `lastOutboundAt` mediante `updateMany`;
- tolera la precisión de PostgreSQL comparando timestamps en una ventana de un milisegundo;
- limpia la pausa y registra `sentAt` solo cuando el snapshot coincide;
- no levanta los modos `manual_outbound_sending` ni `manual_outbound_delivery_unknown`;
- devuelve el candidato vigente cuando existe conflicto;
- no abre una transacción anidada.

`adminSupervisor.js` conserva el orden proveedor → evidencia de `Message` → transición condicional de `Candidate` → resolución trazable de la solicitud. Cuando `count === 0`, el mensaje no se reenvía: la solicitud queda resuelta con `candidateStateApplied: false` y el estado observado para conciliación.

El candidato técnico del supervisor continúa fuera de esta frontera. Su `upsert`, `lastInboundAt` y el `lastOutboundAt` del keepalive permanecen como escritores directos explícitos para una fase posterior.

## Fase 1: caracterización del progreso conversacional

La matriz canónica de esta fase vive en `config/candidate-progress-authority.json`. Es deliberadamente descriptiva: no cambia el comportamiento runtime ni mueve escrituras todavía.

La caracterización separa cuatro responsabilidades que antes podían parecer una sola:

1. **Productor de decisión:** calcula un destino o un objeto `candidateUpdates`, pero no persiste `Candidate`. Ejemplos: `vacancyFirstGate.js`, `silentProfileCapture.js` y `cvFlow.js`.
2. **Escritor efectivo:** ejecuta `candidate.update` o `candidate.updateMany`. Ejemplos: `conversationEngine.js`, `chatEngine.js`, `webhook.js`, `dataConsentGate.js`, `consentStateService.js` y `admin.js`.
3. **Esquema o contexto de decisión:** expone `currentStep` a extracción, prompts o políticas sin mutarlo.
4. **Proyección de solo lectura:** usa el paso en estadísticas, respuestas o recordatorios.

### Enum canónico

Los únicos destinos válidos son los declarados en `ConversationStep` de Prisma:

- `MENU`
- `GREETING_SENT`
- `COLLECTING_DATA`
- `CONFIRMING_DATA`
- `ASK_CV`
- `DONE`
- `SCHEDULING`
- `SCHEDULED`

Ningún contrato de progreso puede inventar un string adicional.

### Familias observadas

La matriz registra por separado:

- resolución inicial y alternativas de vacante;
- captura silenciosa de perfil sin vacante;
- aceptación, revocatoria y reanudación después del consentimiento;
- decisiones de vacante pausada;
- reprogramación directa de entrevista;
- reducción de acciones y `nextStep` en `conversationEngine.act()`;
- progresión determinística legacy del webhook;
- correcciones administrativas.

Cada familia documenta propietario de la decisión, escritor real, orígenes, destinos, campos permitidos, efectos externos, estado de concurrencia e idempotencia. La matriz no define una operación genérica de actualización.

### Multilinea

La primera frontera runtime del grupo ya pertenece a `CandidateStateService`:

1. `scheduleMultilineWindow()` conserva en el webhook el cálculo de `windowMs` y la fecha futura.
2. `scheduleCandidateMultilineWindow()` persiste únicamente `multilineWindowUntil` e incrementa `multilineBatchVersion`.
3. Cada nuevo inbound invalida al propietario anterior mediante otra versión.
4. `tryAcquireMultilineProcessing()` conserva la decisión de orquestación y delega la comparación.
5. `acquireCandidateMultilineBatch()` exige ID, versión exacta y ventana vencida.
6. La adquisición limpia la ventana e incrementa otra vez la versión.
7. Solo `count === 1` autoriza procesar el lote.

Este contrato no modifica `currentStep`, no abre transacciones y no cambia tiempos, consolidación ni mensajes.

### Protección en CI

`test/candidateProgressAuthority.test.js` bloquea:

- divergencia entre la matriz y el enum real de Prisma;
- archivos con literales de progreso sin clasificación;
- orígenes o destinos desconocidos;
- familias que intenten mutar campos fuera de su contrato;
- pérdida del compare-and-set multilinea;
- conversión de los productores puros en escritores directos;
- introducción de una API arbitraria de patch en esta fase.

### Siguiente orden de migración

1. Migrar la reducción final de `conversationEngine.act()` comparando el paso leído.
2. Migrar el reflejo de progreso del consentimiento sin absorber la autoridad del evento.
3. Dividir las ramas legacy de `webhook.js` por familias pequeñas.
4. Migrar correcciones administrativas con actor, motivo y origen esperado.

## Fase 2: autoridad de ventana multilinea

La persistencia de la ventana multilinea se extrajo sin mover la orquestación del webhook:

- `scheduleCandidateMultilineWindow()` valida candidato y fecha, escribe solo los dos campos permitidos y devuelve la versión persistida;
- `acquireCandidateMultilineBatch()` valida candidato, versión y fecha de adquisición, y conserva el compare-and-set mediante `updateMany`;
- una versión obsoleta o una ventana todavía abierta devuelve `count === 0`;
- los wrappers del webhook ya no ejecutan `candidate.update` ni `candidate.updateMany` directamente;
- no cambian `sleep`, consolidación, mensajes, replays ni la lógica relacionada con género.

`Candidate` continúa en estado `fragmented` porque `currentStep` y los demás grupos todavía tienen escritores distribuidos.

## Reglas para la autoridad

1. No existe `updateCandidate(data)`.
2. Cada método nombra un caso de uso y controla sus campos permitidos.
3. Las carreras se protegen comparando el estado leído cuando la acción depende de él.
4. Un `count=0` no se presenta como transición exitosa.
5. Consentimiento, CV, atribución y recordatorios conservan autoridades especializadas.
6. `Candidate` solo se marcará `canonical` cuando el manifiesto tenga un único escritor para las operaciones rastreadas.

## Orden inicial recomendado

1. Reanudación por mensaje entrante.
2. Pausa y reanudación administrativa.
3. Transiciones de `currentStep` y `status` del flujo conversacional.
4. Actividad y recordatorios.
5. Captura y corrección de perfil.
6. Atribución y vacante.
7. CV, duplicados y operaciones administrativas restantes.
8. Incorporación de `tenantId` y pruebas negativas de aislamiento cuando las autoridades estén estabilizadas.
