# Mapa de autoridades y escrituras de estado

## Objetivo

Este documento registra dónde se modifica actualmente el estado conversacional y de reclutamiento de Lórren antes de extraer módulos o retirar rutas heredadas.

El inventario verificable está en `state-authority-manifest.json`. El gate `test/stateAuthorityManifest.test.js` inspecciona el código fuente y falla cuando:

- aparece un escritor nuevo no declarado;
- un escritor declarado deja de existir o de escribir el modelo;
- se declara más de una autoridad canónica para el mismo agregado;
- el manifiesto contiene contratos incompletos.

El manifiesto no autoriza que la dispersión continúe indefinidamente. Describe la línea base que debe reducirse progresivamente.

## Resultado de la auditoría inicial

| Agregado o modelo | Escritores declarados | Riesgo | Estado de migración | Autoridad objetivo |
| --- | ---: | --- | --- | --- |
| `Candidate` | 15 | Crítico | Fragmentado | `CandidateStateService` |
| `InterviewBooking` | 5 | Crítico | Fragmentado | `InterviewBookingStateService` |
| `Message` | 5 | Alto | Fragmentado | `ConversationMessageRepository` |
| `CandidateDataConsentEvent` | 2 | Crítico | En consolidación | `ConsentStateService` |
| `AttachmentAnalysis` | 2 | Alto | En consolidación | `AttachmentAnalysisRepository` |
| `JobQueue` | 1 | Alto | En consolidación | `JobQueueService` |
| `CandidateAdminEvent` | 1 | Medio | En consolidación | `CandidateAdminAuditService` |
| `InterviewSlot` | 1 | Alto | Fragmentado | `InterviewAvailabilityService` |

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

### 2. Las reservas tienen varias autoridades de transición

`InterviewBooking` se modifica desde agenda, webhook, recordatorios, administración y un motor conversacional alternativo. Antes de extraer agenda deben centralizarse invariantes como:

- no marcar `RESCHEDULED` sin una nueva reserva;
- no confirmar una reserva cancelada;
- no emitir recordatorios para reservas cerradas;
- no crear dos reservas activas para el mismo candidato y vacante.

### 3. Los mensajes todavía se persisten desde fronteras distintas

La persistencia de `Message` está repartida entre webhook, consentimiento, supervisor, recordatorios y administración. La autoridad objetivo debe distinguir:

- mensaje entrante reclamado de forma idempotente;
- mensaje saliente comprometido en outbox;
- entrega del proveedor;
- mensaje manual autorizado;
- evidencia de consentimiento.

### 4. Consentimiento y jobs muestran una ruta de consolidación más clara

`CandidateDataConsentEvent` tiene dos escritores conocidos y `JobQueue` uno. Son buenos candidatos para convertirse primero en autoridades canónicas, porque sus contratos ya están protegidos por replay e idempotencia.

## Clasificación de escritores

- `canonical`: única autoridad permitida cuando la migración finaliza.
- `boundary`: frontera especializada que todavía escribe directamente.
- `legacy`: ruta heredada que debe migrarse y retirarse.
- `admin`: operación humana explícita que debe pasar por un caso de uso auditado.
- `integration`: sincronización externa que no debe decidir transiciones conversacionales.
- `operational`: jobs, recordatorios o tareas internas.

## Reglas para nuevos cambios

1. Un archivo nuevo no puede escribir un modelo rastreado sin modificar el manifiesto y justificarlo en el PR.
2. Añadir un escritor no constituye por sí mismo una solución; debe explicarse por qué no puede usar la autoridad objetivo.
3. La eliminación de una escritura exige retirar también su entrada del manifiesto.
4. Un modelo marcado `canonical` debe tener exactamente un escritor con rol `canonical`.
5. Las rutas, webhooks y adaptadores no deben convertirse en autoridades canónicas.
6. Las integraciones pueden aportar hechos, pero no decidir por sí solas transiciones de candidato o reserva.
7. Los cambios de consentimiento deben producir evento versionado y actualización del candidato dentro de la misma unidad atómica.
8. La persistencia de salida debe preceder a la entrega y conservar una clave de idempotencia.

## Orden recomendado de consolidación

1. `CandidateDataConsentEvent` y campos de consentimiento del candidato.
2. `Message`, inbox y outbox.
3. `InterviewBooking` y sus transiciones.
4. Campos conversacionales de `Candidate`.
5. Atribución, CV, recordatorios y operaciones administrativas del candidato.
6. Disponibilidad de entrevista y configuración de slots.

## Criterio de finalización

Un agregado pasa a `canonical` cuando:

- existe un servicio o repositorio único para sus escrituras;
- las rutas y adaptadores solo invocan casos de uso;
- las invariantes están cubiertas por pruebas;
- el manifiesto contiene un único escritor canónico;
- el replay demuestra que la consolidación no altera el comportamiento protegido.
