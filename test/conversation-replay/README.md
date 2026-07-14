# Corpus y replay determinístico de Lórren

Este directorio contiene conversaciones sanitizadas y versionadas para caracterizar el comportamiento de Lórren antes de retirar parsers, gates, políticas o motores heredados.

## Propósito

Cada fixture describe un turno reproducible con:

- `TenantContext` y canal de entrada;
- versiones de política y configuración efectivas;
- estado inicial del candidato, la vacante y la conversación;
- historial mínimo necesario;
- mensaje recibido;
- respuesta estructurada simulada del proveedor de IA;
- interpretación esperada;
- plan con acciones estructuradas y escrituras permitidas/prohibidas;
- transición esperada;
- hechos obligatorios, texto verificable y afirmaciones prohibidas en la respuesta;
- estado final esperado.

Los fixtures no contienen números de documento, teléfonos, correos ni nombres reales. Los valores sensibles estructurados deben utilizar el prefijo `TEST-` y todo identificador debe ser inequívocamente sintético.

## Límite del corpus

Este corpus comienza después de que la entrada haya resuelto tenant, canal e identidad del evento.

El replay integral reclama el `messageId` antes de interpretar. Una reentrega exacta no vuelve a interpretar, planificar ni escribir estado. Cuando la salida ya fue entregada, el duplicado es un no-op total. Cuando existe una salida persistida pero no entregada, el duplicado recupera exclusivamente esa entrega desde el outbox. La validación del webhook y la resolución productiva del tenant permanecen fuera de este corpus.

## Etapas

1. **Contrato de fixtures:** valida estructura, datos sintéticos, proveedores simulados e identidades únicas.
2. **Replay de interpretación:** ejecuta el arbitraje vigente, `conversationUnderstanding`, sanitización de campos y política de consentimiento con respuestas de proveedor simuladas.
3. **Replay de planificación:** ejecuta las autoridades vigentes de consentimiento, respuesta contextual y política de campos; produce acciones, escrituras y transiciones sobre estado en memoria.
4. **Replay integral:** ejecuta inbox, acciones, candidato, estado conversacional, outbox, entrega y auditoría mediante adaptadores en memoria sin WhatsApp, OpenAI ni base de datos reales.
5. **Replay de recuperación:** inyecta un fallo después de persistir el outbox y prueba que el reintento entrega lo pendiente sin repetir interpretación, planificación ni escrituras.
6. **Gate de CI:** impide retirar una autoridad heredada cuando cambia un comportamiento protegido.

## Autoridades usadas por la planificación

- `evaluateConsentBoundary()` y `buildConsentPendingMode()` para proteger datos antes de autorización.
- `evaluateContextualResponseGate()` y `buildVacancyQuestionReply()` para responder preguntas sustentadas sin perder el campo pendiente.
- `applyFieldPolicy()` para autorizar únicamente correcciones con evidencia suficiente.

El adaptador de replay no sustituye estas autoridades ni se usa en producción; traduce sus resultados al contrato canónico del corpus para detectar divergencias.

## Adaptadores integrales

- candidato aislado mediante `tenantId` y `candidateId`;
- inbox idempotente mediante tenant, canal y `messageId`;
- outbox y entrega idempotentes mediante una clave derivada del mensaje entrante;
- versiones de política conservadas en mensajes entrantes y salientes;
- auditoría de entrada, cambios del candidato, salida persistida, fallo de entrega y entrega exitosa;
- contador de intentos de entrega;
- rechazo de un `TenantContext` distinto al del fixture.

La salida se persiste antes de entregarse. El ejecutor aplica las acciones desde el estado inicial y no reutiliza el estado final de la planificación como sustituto de la ejecución. Un reintento de entrega usa el cuerpo ya persistido y no recalcula la respuesta.

## Reglas

- No usar Internet durante el replay.
- No llamar a un modelo real ni depender de respuestas no determinísticas.
- Las respuestas simuladas del proveedor son entradas versionadas, no resultados esperados ocultos.
- No guardar información personal real.
- Declarar explícitamente `tenantContext` y las versiones de política.
- Usar la forma vigente del runtime como punto de partida, sin impedir la evolución hacia varias intenciones.
- Separar `allowedWrites` y `forbiddenWrites`.
- Incluir la persistencia del mensaje saliente cuando se espera una respuesta.
- Distinguir hechos que la respuesta debe contener de afirmaciones que no puede realizar.
- Un cambio intencional de comportamiento requiere actualizar el fixture y justificarlo en el PR.

## Estado actual

El contrato, la interpretación, la planificación, la ejecución integral y la recuperación de entrega desde outbox son reproducibles y bloqueantes en CI. El replay todavía no ejecuta el middleware o webhook productivo, Prisma real, Meta WhatsApp ni proveedores externos.
