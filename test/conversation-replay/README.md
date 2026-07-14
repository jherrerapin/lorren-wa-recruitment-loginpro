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
- hechos obligatorios y afirmaciones prohibidas en la respuesta;
- estado final esperado.

Los fixtures no contienen números de documento, teléfonos, correos ni nombres reales. Los valores sensibles estructurados deben utilizar el prefijo `TEST-` y todo identificador debe ser inequívocamente sintético.

## Límite del corpus

Este corpus comienza después de que la entrada haya resuelto tenant, canal e identidad del evento.

La deduplicación de webhooks, validación de firmas, persistencia del inbox y rechazo de reentregas se probarán en la capa de entrada confiable. Un evento duplicado no debe convertirse en una intención conversacional ni llegar a `TurnUnderstanding`.

## Etapas

1. **Contrato de fixtures:** validación estructural, datos sintéticos, proveedores simulados e identidades únicas.
2. **Replay de interpretación:** ejecuta el arbitraje vigente, `conversationUnderstanding`, sanitización de campos y política de consentimiento con respuestas de proveedor simuladas.
3. **Replay de planificación:** validará acciones estructuradas, permisos y transiciones.
4. **Replay integral:** ejecutará adaptadores en memoria sin WhatsApp, OpenAI ni base de datos reales.
5. **Gate de CI:** impide retirar una autoridad heredada cuando cambia un comportamiento protegido.

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

El contrato y el replay de interpretación son ejecutables. El replay todavía no aplica planes, no persiste estado y no ejecuta el webhook productivo.
