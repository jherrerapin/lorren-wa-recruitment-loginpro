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
