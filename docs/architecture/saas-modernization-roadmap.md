# Hoja de ruta canónica de modernización SaaS de Lórren

Relacionado con: #421, #415, #420, #422, #423 y #424.

## 1. Propósito

Evolucionar el repositorio actual hacia un monolito modular, mantenible y multitenant, preparado para ofrecer Lórren como SaaS sin una reescritura total ni una interrupción del servicio.

La modernización debe:

- eliminar responsabilidades y autoridades duplicadas;
- conservar el comportamiento útil mediante pruebas reproducibles;
- separar negocio, persistencia, canales y proveedores externos;
- permitir incorporar tenants y vacantes mediante configuración;
- impedir efectos duplicados, estados incompatibles y accesos cruzados;
- mantener a GitHub y a la base de datos propia como fuentes canónicas.

## 2. Premisa funcional

Lórren debe comportarse como una reclutadora humana, sensible y experimentada. No es un formulario ni un bot regido por una secuencia rígida de palabras o respuestas prefabricadas.

Debe:

- comprender el turno completo y el contexto acumulado;
- reconocer preguntas, correcciones, respuestas parciales y varias intenciones;
- responder una interrupción antes de retomar el pendiente;
- conservar datos ya confirmados y evitar preguntas repetidas;
- solicitar únicamente lo exigido por la configuración de la vacante;
- redactar de forma natural a partir de hechos validados;
- mantener controles determinísticos para consentimiento, seguridad, persistencia, archivos, agenda y transiciones críticas.

## 3. Fuera de alcance

Esta iniciativa no modifica, elimina ni amplía la lógica existente relacionada con género.

Tampoco autoriza:

- una reescritura masiva;
- microservicios prematuros;
- mover carpetas sin cambiar límites reales de responsabilidad;
- eliminar código sin pruebas de reemplazo o evidencia de que no tiene consumidores;
- desplegar automáticamente cambios de modernización;
- usar un GPT, un proveedor de IA o ChatGPT como fuente de verdad del runtime.

## 4. Estado actual de la línea base

- #419 ya fue fusionado en `main` y retiró la matriz de frases prefabricadas.
- #425 ya fue fusionado en `main` y estableció el contrato inicial del corpus conversacional.
- #420 permanece en borrador, desactualizado respecto a `main` y con regresiones de consentimiento pendientes. No está listo para merge.
- Este PR consolida la hoja de ruta y su validación técnica.
- #424 reserva la creación posterior del GPT interno de arquitectura y QA.

## 5. Capacidades que deben preservarse o alcanzar

### 5.1 Atribución y confirmación de vacante

- Conservar los metadatos originales de Meta Ads de forma inmutable.
- Resolver tenant, canal, campaña, anuncio, operación y vacante por identificadores objetivos.
- Clasificar la atribución como `EXACT`, `CONFIRMED` o `UNKNOWN`.
- Confirmar ciudad y vacante con el candidato antes de asignarlas definitivamente.
- Preguntar sin inventar cuando los metadatos falten o sean ambiguos.

### 5.2 Información, interés y consentimiento

- Responder preguntas de la vacante en cualquier momento con información registrada.
- Solicitar consentimiento después de que el candidato manifieste interés.
- Distinguir interés, aceptación de una oferta y autorización de tratamiento de datos.
- Antes de la autorización, limitar el tratamiento a los identificadores técnicos mínimos necesarios para recibir el mensaje, resolver tenant/canal, conservar la atribución y solicitar el consentimiento; no extraer ni persistir campos de perfil, descargar archivos ni procesar una HV.
- Si una HV llegó antes de autorizar, pedir que se reenvíe después de la aceptación.

Este límite es el nuevo invariante de seguridad de #420. Debe caracterizarse frente al comportamiento legado y documentar propósito, acceso y retención de los metadatos técnicos mínimos. No implica borrar retroactivamente archivos existentes sin una política y migración separadas.

### 5.3 Recolección dinámica por vacante

Cada vacante define campos requeridos, opcionales, documentos, experiencia y modalidad de cierre.

Reglas iniciales del cliente:

- Bogotá: solicitar localidad.
- Otras ciudades: solicitar barrio o sector.
- Soacha: registrar la residencia según la regla operativa configurada.
- Experiencia: guardar si tiene, cuánto tiempo y en qué cargo, área o actividad.

Un mensaje que contiene varios datos debe completar todos los campos válidos sin convertir el proceso en un cuestionario repetitivo.

### 5.4 Viabilidad geográfica

La viabilidad pertenece a la relación entre vacante, operación, residencia y transporte; no se deduce solo por ciudad.

La configuración deberá permitir:

- ciudades, municipios, localidades, barrios y sectores incluidos o excluidos;
- alias territoriales;
- corredores logísticos;
- polígonos, radios o coordenadas;
- distancia o tiempo aproximado;
- medio de transporte;
- excepciones versionadas y con vigencia.

Se preservarán las excepciones configuradas para vacantes de Bogotá, Soacha y la operación de Siberia. Toda decisión deberá registrar reglas, versión y evidencia.

### 5.5 Modalidades de cierre

`APPLICATION_ONLY`:

- completar los datos y documentos configurados;
- informar que el registro quedó completo;
- comunicar que un reclutador revisará la información;
- no prometer aprobación, contratación ni entrevista.

`AUTO_INTERVIEW`:

- validar requisitos, datos, documentos y disponibilidad;
- ofrecer horarios reales con anticipación mínima configurable, inicialmente seis horas;
- respetar el horizonte de agenda configurado;
- reprogramar únicamente si la vacante lo permite.

**Corrección planificada:** el runtime actual puede marcar una reserva como `RESCHEDULED` antes de crear la nueva. El estado objetivo es conservar la reserva anterior en un estado de solicitud o cancelación y marcar `RESCHEDULED` solo cuando la nueva reserva exista.

### 5.6 Recordatorios

Postulación incompleta:

- programar dos horas después del último mensaje saliente que solicitó una acción;
- enviar solo si no existe un mensaje entrante posterior y el proceso continúa pendiente;
- mencionar el dato o acción exactos;
- deduplicar por tenant, candidato, proceso y pendiente.

Entrevista:

- requisito objetivo: enviar una hora antes de la reserva;
- interpretar confirmación, cancelación o solicitud de cambio;
- registrar `NO_RESPONSE` cuando falten cinco minutos sin respuesta;
- conservar respuestas tardías y aplicar la política configurada.

El runtime y documentación heredada todavía usan cuarenta minutos en algunos puntos. Esa diferencia es deuda explícita: deberá migrarse junto con pruebas y configuración, no ocultarse como comportamiento ya vigente.

## 6. Estrategia arquitectónica

### 6.1 Monolito modular primero

La aplicación continuará desplegándose como una unidad durante la primera etapa. Los límites se crearán por dominio, API pública y contratos internos. Los microservicios solo se considerarán cuando exista una necesidad demostrada de escalado, aislamiento, despliegue o propiedad operativa independiente.

### 6.2 Sustitución progresiva

1. Caracterizar el comportamiento y sus invariantes.
2. Introducir una fachada o contrato nuevo.
3. Migrar casos de uso de forma gradual.
4. Comparar resultados y efectos.
5. Retirar la implementación anterior cuando quede sin consumidores.

### 6.3 Dominios objetivo

```text
src/
  modules/
    tenancy/
    channels/
    attribution/
    conversation/
    recruitment/
    vacancies/
    geography/
    consent/
    documents/
    interviews/
    notifications/
    audit/
  shared/
    config/
    errors/
    logging/
    persistence/
    security/
    time/
```

Esta estructura representa límites, no una orden inmediata de mover archivos.

## 7. Contratos canónicos

### `TenantContext`

Identifica tenant, canal, credenciales autorizadas, permisos y configuración aplicable. Debe resolverse antes de construir claves durables de idempotencia o acceder a datos de negocio.

### `TurnUnderstanding`

Interpretación estructurada única del turno:

- intenciones y preguntas;
- datos y correcciones;
- referencias a contexto previo;
- ciudad, cargo y vacante;
- consentimiento;
- acciones de entrevista;
- evidencia y confianza.

### `TurnPlan`

Plan validado único:

- hechos a responder;
- escrituras permitidas y prohibidas;
- acciones de dominio;
- transición propuesta;
- pendiente a retomar;
- revisión humana;
- requisitos de la respuesta.

### Políticas de dominio

- `VacancyPolicy` versionada.
- `CandidateReadiness` único.
- `GeographicEligibility` explicable.
- `InterviewPolicy` versionada.

## 8. Ciclo objetivo de un turno

1. Resolver `TenantContext` y deduplicar el evento.
2. Cargar estado canónico y configuración efectiva.
3. Producir `TurnUnderstanding`.
4. Validar evidencia, permisos e invariantes.
5. Producir `TurnPlan`.
6. Ejecutar cálculos y preparar resultados de dominio sin efectos externos.
7. Redactar y verificar una respuesta factual segura.
8. Persistir en una sola transacción el estado, auditoría y mensaje de outbox.
9. Un worker ejecuta el efecto externo y registra el resultado.

Ningún mensaje, archivo, reserva o notificación externa se ejecuta antes de estar representado de forma idempotente en el outbox.

## 9. Aislamiento multitenant

Antes de habilitar un segundo tenant deberán cumplirse simultáneamente:

### Aplicación

- `TenantContext` obligatorio en casos de uso, repositorios, rutas, jobs, caché y almacenamiento.
- Prohibición de consultas globales desde módulos de negocio.
- Validación de pertenencia en referencias y acciones administrativas.

### Base de datos

- `tenantId` en todas las entidades compartidas de negocio.
- Unicidad compuesta por tenant; por ejemplo, el teléfono de un candidato no puede continuar como identificador global entre clientes.
- Protección de relaciones cruzadas mediante claves o validaciones compuestas cuando sea viable.
- RLS como defensa adicional, no como única barrera.
- Roles de mínimo privilegio para API, workers y administración.
- Pruebas negativas de lectura, escritura, asociación y procesamiento cruzados.

## 10. Corpus y evaluación

Cada fixture deberá incluir:

- `TenantContext`;
- versiones de conversación, vacante, consentimiento y políticas relevantes;
- estado inicial;
- historial mínimo;
- mensaje o lote entrante;
- comprensión y plan esperados;
- escrituras permitidas y prohibidas;
- transición y estado final;
- hechos obligatorios y afirmaciones prohibidas;
- expectativa de envío, silencio o revisión.

Las regresiones determinísticas serán gates de CI **antes** de retirar una capa heredada. Las evaluaciones con modelo real se utilizarán para comparar prompts o modelos, pero no sustituirán el gate reproducible.

## 11. Observabilidad

La correlación mínima comienza desde la estabilización y la entrada confiable. Debe relacionar:

- tenant y canal;
- webhook e inbox;
- conversación y turno;
- candidato y postulación;
- reserva;
- job y recordatorio;
- outbox y mensaje saliente.

Los logs deben evitar contenido sensible y conservar razones, estados, versiones y errores saneados.

## 12. Fases canónicas de ejecución

### Fase 0 — Seguridad y línea base

- Actualizar #420 contra el `main` que ya contiene #419 y #425.
- Resolver sus cuatro bloqueadores y devolver CI a verde.
- Corregir la persistencia de `AttachmentAnalysis` contra Prisma.
- Unificar el contrato de HV en PDF/DOCX y rechazar `.doc`.
- Inventariar deuda y añadir correlación mínima.

### Fase 1 — Caracterización y gates

- Ampliar el corpus sanitizado ya iniciado.
- Implementar replay determinístico.
- Cubrir consentimiento, vacantes, datos, preguntas fuera de orden, agenda, recordatorios y errores.
- Convertir los escenarios en gates obligatorios.

### Fase 2 — Tenant mínimo en la frontera

- Resolver tenant y canal antes de cualquier clave durable.
- Introducir `TenantContext` mínimo sin migrar aún todo el esquema.
- Probar que eventos de canales distintos no colisionan.

### Fase 3 — Entrada y salida confiables

- Inbox idempotente.
- Outbox transaccional.
- Envío centralizado.
- Jobs reintentables y deduplicados.
- Correlación de trazas.

### Fase 4 — Contratos y autoridades únicas

- Introducir `TurnUnderstanding`, `TurnPlan` y políticas de dominio.
- Crear adaptadores desde el flujo actual.
- Centralizar readiness y transiciones.
- Retirar autoridades paralelas solo después de migrar sus escenarios.

### Fase 5 — Multitenencia completa

- Migrar `tenantId`, índices y restricciones.
- Crear repositorios tenant-aware.
- Añadir RLS y roles mínimos.
- Aprobar pruebas de aislamiento antes de habilitar un segundo tenant.

### Fase 6 — Configuración de negocio

- Versionar políticas por tenant, operación y vacante.
- Retirar condiciones específicas del cliente del webhook.
- Separar contenido empresarial de lógica de aplicación.

### Fase 7 — Núcleo conversacional y estados

- Interpretar una vez y planear una vez.
- Responder interrupciones y retomar pendientes.
- Centralizar estados e invariantes.
- Reducir el webhook a adaptador de entrada.

### Fase 8 — Geografía, agenda y notificaciones

- Implementar políticas territoriales explicables.
- Corregir reprogramación y ventanas de recordatorio.
- Consolidar workers y recordatorios idempotentes.

### Fase 9 — Operación SaaS y retiro de legado

- Métricas, costos, límites y auditoría por tenant.
- Gestión segura de credenciales.
- Eliminación de adaptadores, flags y código sin consumidores.
- Mantener como bloqueante toda la suite estable.

## 13. GPT interno de arquitectura y QA

La activación del GPT de #424 se rige por `gpt-auditor-readiness.md`. Antes de crearlo deben estar estables, fusionados y versionados, como mínimo:

- esta hoja de ruta y la validación técnica;
- corpus y replay;
- contratos iniciales de `TenantContext`, `TurnUnderstanding` y `TurnPlan`;
- convenciones de código y revisión;
- ADR principales;
- política de actualización y versionado del conocimiento;
- propietario, acceso privado y pruebas de aceptación.

Será una herramienta privada de mantenimiento y supervisión. No modificará producción, no fusionará código y no reemplazará a GitHub como fuente de verdad.

## 14. Reglas para cada PR

- Un objetivo técnico coherente.
- Alcance pequeño y reversible.
- Pruebas de caracterización o regresión.
- Estado actual, comportamiento objetivo y deuda claramente diferenciados.
- Sin cambiar expectativas solo para obtener CI verde.
- Sin eliminar código antes de demostrar reemplazo o falta de consumidores.
- Riesgo, aceptación y rollback documentados.
- Revisión de tenant, idempotencia y privacidad cuando corresponda.

## 15. Criterios de éxito

- Un nuevo cliente se incorpora mediante configuración y credenciales.
- Ningún tenant puede acceder a recursos de otro.
- Cada turno tiene una interpretación y un plan únicos.
- Las preguntas fuera de orden se responden sin perder progreso.
- Los efectos externos son idempotentes y auditables.
- Las políticas provienen de configuración versionada.
- El webhook deja de ser el motor completo.
- La reducción de redundancia disminuye complejidad sin perder comportamiento protegido.
