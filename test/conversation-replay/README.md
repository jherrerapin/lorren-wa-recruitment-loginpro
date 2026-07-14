# Corpus y replay determinístico de Lórren

Este directorio contiene conversaciones sanitizadas y versionadas para caracterizar el comportamiento de Lórren antes de retirar parsers, gates, políticas o motores heredados.

## Propósito

Cada fixture describe un turno reproducible con:

- `TenantContext` y canal de entrada;
- versiones de política y configuración efectivas;
- estado inicial del candidato, la vacante y la conversación;
- historial mínimo necesario;
- mensaje o adjunto recibido;
- respuesta estructurada simulada del proveedor de IA;
- interpretación esperada;
- plan con acciones estructuradas y escrituras permitidas/prohibidas;
- transición esperada;
- hechos obligatorios, texto verificable y afirmaciones prohibidas en la respuesta;
- estado final esperado.

Los fixtures no contienen números de documento, teléfonos, correos ni nombres reales. Los valores sensibles estructurados deben utilizar el prefijo `TEST-` y todo identificador debe ser inequívocamente sintético.

## Límite del corpus

Este corpus comienza después de que la entrada haya resuelto tenant, canal e identidad del evento.

El replay integral reclama el `messageId` antes de interpretar. Los cambios del candidato, los eventos de consentimiento y la creación del outbox forman un commit atómico en memoria. Una reentrega exacta se comporta así:

- si existe inbox reclamado pero no outbox, reanuda el turno desde el estado revertido;
- si existe outbox pendiente, recupera únicamente su entrega;
- si la salida ya fue entregada, el duplicado es un no-op total.

La validación del webhook, la resolución productiva del tenant y la descarga física de archivos permanecen fuera de este corpus.

## Etapas

1. **Contrato de fixtures:** valida estructura, datos sintéticos, entradas textuales o adjuntas, proveedores simulados e identidades únicas.
2. **Replay de interpretación:** ejecuta el arbitraje vigente, `conversationUnderstanding`, sanitización de campos y decisiones reales de consentimiento.
3. **Replay de planificación:** ejecuta autoridades de consentimiento, protección de adjuntos, respuesta contextual y política de campos.
4. **Replay integral:** ejecuta inbox, acciones, candidato, eventos de consentimiento, estado conversacional, outbox, entrega y auditoría mediante adaptadores en memoria.
5. **Replay de recuperación:** inyecta fallos antes y después del outbox; prueba rollback, reanudación y entrega pendiente sin duplicar efectos.
6. **Gate de CI:** impide retirar una autoridad heredada cuando cambia un comportamiento protegido.

## Escenarios protegidos

- interés en continuar sin autorización;
- aceptación explícita del tratamiento de datos;
- rechazo explícito del tratamiento de datos;
- documento enviado antes de autorización;
- pregunta sobre la vacante durante recolección;
- corrección de un dato durante recolección.

La aceptación y el rechazo crean un único evento versionado y trazable. Un documento enviado antes de autorización conserva únicamente sus metadatos dentro del inbox; no genera `cvData`, `cvStorageKey`, descarga ni registro de archivo.

## Autoridades usadas por la planificación

- `shouldRecordConsentAcceptance()` y `shouldRecordConsentRejection()` para reconocer la decisión explícita;
- `evaluateConsentBoundary()`, `buildConsentPendingMode()` y `deriveConsentResumeUpdate()` para proteger datos y adjuntos;
- `evaluateContextualResponseGate()` y `buildVacancyQuestionReply()` para responder preguntas sustentadas sin perder el campo pendiente;
- `applyFieldPolicy()` para autorizar únicamente correcciones con evidencia suficiente.

El adaptador de replay no sustituye estas autoridades ni se usa en producción; traduce sus resultados al contrato canónico del corpus para detectar divergencias.

## Adaptadores integrales

- candidato aislado mediante `tenantId` y `candidateId`;
- inbox idempotente mediante tenant, canal y `messageId`;
- commit atómico de candidato, evento de consentimiento y outbox;
- outbox y entrega idempotentes mediante una clave derivada del mensaje entrante;
- versiones de política conservadas en mensajes entrantes y salientes;
- auditoría de entrada, consentimiento, cambios, persistencia, fallos y entrega;
- contador de intentos de entrega;
- repositorio de adjuntos vacío para demostrar que no se almacena contenido preconsentimiento;
- rechazo de un `TenantContext` distinto al del fixture.

La salida se persiste antes de entregarse. Si falla el commit, se revierten los cambios parciales y se conserva el inbox para reanudar. Si falla la entrega, el reintento usa exactamente el cuerpo persistido y no recalcula la respuesta.

## Reglas

- No usar Internet durante el replay.
- No llamar a un modelo real ni depender de respuestas no determinísticas.
- Las respuestas simuladas del proveedor son entradas versionadas, no resultados esperados ocultos.
- No guardar información personal real.
- Declarar explícitamente `tenantContext` y las versiones de política.
- Separar `allowedWrites` y `forbiddenWrites`.
- Incluir la persistencia del mensaje saliente cuando se espera una respuesta.
- Distinguir hechos que la respuesta debe contener de afirmaciones que no puede realizar.
- Un cambio intencional de comportamiento requiere actualizar el fixture y justificarlo en el PR.

## Estado actual

El contrato, la interpretación, la planificación, la ejecución integral, el rollback del commit, las decisiones de consentimiento, la protección de adjuntos y la recuperación desde outbox son reproducibles y bloqueantes en CI. El replay todavía no ejecuta el webhook productivo, Prisma real, Meta WhatsApp ni proveedores externos.
