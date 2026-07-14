# Corpus y replay determinístico de Lórren

Este directorio contiene conversaciones sanitizadas y versionadas para caracterizar el comportamiento de Lórren antes de retirar parsers, gates, políticas o motores heredados.

## Propósito

Cada fixture describe un turno reproducible con:

- `TenantContext` y canal de entrada;
- versiones de política y configuración efectivas;
- estado inicial del candidato, la vacante y la conversación;
- historial mínimo necesario;
- mensaje recibido;
- comprensión esperada;
- plan y escrituras permitidas;
- transición esperada;
- hechos obligatorios y afirmaciones prohibidas en la respuesta;
- estado final esperado.

Los fixtures no contienen números de documento, teléfonos ni nombres reales. Todo identificador debe ser sintético y reconocible como dato de prueba.

## Etapas

1. **Contrato de fixtures:** validación estructural y detección de IDs duplicados.
2. **Replay de comprensión:** ejecutar `TurnUnderstanding` con proveedores simulados.
3. **Replay de planificación:** validar `TurnPlan`, permisos y transiciones.
4. **Replay integral:** ejecutar adaptadores en memoria sin WhatsApp, OpenAI ni base de datos reales.
5. **Gate de CI:** impedir retirar una autoridad heredada cuando cambie un comportamiento protegido.

## Reglas

- No usar Internet durante el replay.
- No depender de respuestas no determinísticas de un modelo.
- No guardar información personal real.
- Declarar explícitamente `tenantContext` y las versiones de política.
- Separar `allowedWrites` y `forbiddenWrites`.
- Distinguir hechos que la respuesta debe contener de afirmaciones que no puede realizar.
- Un cambio intencional de comportamiento requiere actualizar el fixture y justificarlo en el PR.

## Estado inicial

La primera fase únicamente valida el contrato de los fixtures. Todavía no sustituye el runtime ni ejecuta el webhook productivo.
