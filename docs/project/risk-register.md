# Registro inicial de riesgos de Lórren

**Estado:** Abierto  
**Fecha de revisión inicial:** 2026-07-10  
**Issue principal:** #380

## Escala

- **Probabilidad:** Baja, Media, Alta.
- **Impacto:** Bajo, Medio, Alto, Crítico.
- **Prioridad:** P0 inmediata, P1 alta, P2 planificada, P3 mejora.

## Riesgos

| ID | Riesgo | Evidencia inicial | Probabilidad | Impacto | Prioridad | Tratamiento | Estado |
|---|---|---|---|---|---|---|---|
| R-001 | Diferencia entre `schema.prisma`, migraciones y código | Modelos críticos usan nombres y estructuras incompatibles | Alta | Crítico | P0 | Reconciliar sobre copia restaurada; no ejecutar migraciones destructivas | Abierto |
| R-002 | Múltiples runtimes de WhatsApp Web compiten por la misma sesión | Existen implementaciones V2–V6/Stable y rutas que importan cadenas distintas | Alta | Crítico | P0 | Identificar runtime activo, introducir interfaz única y migrar con feature flag | Abierto |
| R-003 | Webhook procesa trabajo pesado antes de responder y no tiene firma HMAC verificada | Procesamiento síncrono de IA, archivos y base de datos | Alta | Crítico | P0 | Verificar firma, responder rápido y delegar a cola durable | Abierto |
| R-004 | Cola puede marcar trabajos como completados sin ejecutar la operación | Rama de trabajo pendiente/no-op | Media | Crítico | P0 | Pruebas de integración, reintentos, lease, dead-letter queue e idempotencia | Abierto |
| R-005 | Controles insuficientes en autenticación y recuperación | Fallbacks, rate limiting/CSRF no consolidados | Alta | Alto | P0 | Endurecer sesiones, contraseñas, recuperación, CSRF y límites | Abierto |
| R-006 | Decisiones o pausas basadas en género inferido | Flujo especial para candidatas y evidencia inferida | Alta | Crítico | P0 | Suspender decisiones automáticas diferenciales y revisar política con negocio/legal | Abierto |
| R-007 | Exceso de datos personales enviados o almacenados | Perfil, documento, edad, género, salud y conversaciones pueden llegar a IA/logs | Alta | Crítico | P0 | Minimización, redacción, retención, consentimiento y controles de acceso | Abierto |
| R-008 | Formulario público de despacho expuesto a abuso | Token en URL, sin expiración/cuotas suficientes | Media | Alto | P1 | Expiración, hash, límites, validación y auditoría segura | Abierto |
| R-009 | Validación de CV inconsistente | Rutas aplican reglas diferentes y algunas guardan binarios en DB | Alta | Alto | P1 | Servicio único de archivos, firmas, malware, almacenamiento y retención | Abierto |
| R-010 | Archivos centrales demasiado grandes y acoplados | `server`, `webhook`, `admin` y motor conversacional concentran responsabilidades | Alta | Alto | P1 | Extraer módulos gradualmente después de crear pruebas | Abierto |
| R-011 | Pruebas validan texto fuente y no comportamiento real | Varias pruebas buscan imports o expresiones regulares | Alta | Alto | P1 | Sustituir por pruebas unitarias, integración y contrato | Abierto |
| R-012 | Despliegue depende de migración durante el arranque | `start` combina `prisma migrate deploy` y servidor | Media | Alto | P1 | Separar release job, servidor y worker | Abierto |
| R-013 | Cambios directos o pequeños errores llegan a producción | Historial reciente incluye correcciones posteriores de sintaxis | Alta | Alto | P0 | Proteger `main`, CI obligatorio y staging | En tratamiento |
| R-014 | Falta de aislamiento para una futura operación SaaS | Datos y configuración no están asociados de forma uniforme a tenant | Alta | Crítico | P2 | Diseñar tenant solo después de estabilización; migración expandir–migrar–contraer | Abierto |
| R-015 | Dependencia operativa de una sola persona | Conocimiento, despliegue y decisiones están concentrados | Alta | Alto | P1 | Runbooks, ADR, documentación, revisión independiente y automatización | Abierto |

## Reglas de cierre

Un riesgo solo puede cerrarse cuando:

- existe un cambio o control implementado;
- existen pruebas asociadas;
- fue validado en staging;
- se documentó el rollback;
- se observó el resultado después del despliegue;
- se adjuntó evidencia al issue correspondiente.

## Revisión

Este registro debe revisarse:

- al inicio de cada semana;
- antes de aprobar un cambio de riesgo alto o crítico;
- después de un incidente;
- antes de cada fase del programa;
- antes de incorporar un segundo cliente.