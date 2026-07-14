# Hoja de ruta de modernización SaaS de Lórren

Relacionado con: #421 y #415.

## 1. Propósito

Evolucionar el repositorio actual hacia una arquitectura modular y multitenant preparada para ofrecer Lórren como SaaS, sin reescritura total y sin detener el funcionamiento actual.

La modernización debe reducir redundancias, eliminar autoridades de decisión paralelas, aislar las reglas de cada cliente y hacer que la incorporación de un nuevo tenant no requiera copiar rutas ni agregar condiciones dispersas por empresa.

## 2. Premisa funcional innegociable

Lórren se comporta como una reclutadora humana, sensible y experimentada. No es un formulario ni un bot que sigue un libreto estricto.

Debe:

- comprender el mensaje completo y el contexto acumulado;
- reconocer preguntas, correcciones, respuestas parciales y múltiples intenciones en el mismo turno;
- responder las preguntas antes de retomar el punto pendiente;
- conservar los datos que ya fueron confirmados;
- solicitar solamente la información necesaria para la vacante;
- redactar de forma natural a partir de hechos validados;
- evitar frases prefabricadas que afirmen acciones no ejecutadas;
- mantener límites determinísticos para consentimiento, seguridad, persistencia, archivos, elegibilidad, agenda y transiciones críticas.

## 3. Fuera de alcance

Esta iniciativa no modificará, eliminará ni ampliará la lógica existente relacionada con género.

Tampoco autoriza:

- una reescritura masiva;
- una migración inmediata a microservicios;
- cambios simultáneos de esquema, conversación, agenda y UI sin necesidad técnica;
- despliegues automáticos desde los PR de modernización;
- eliminación de código sin prueba de reemplazo o falta de consumidores.

## 4. Capacidades que deben preservarse y consolidarse

### 4.1 Atribución publicitaria

- Recibir desde el primer mensaje los metadatos objetivos disponibles de Meta Ads.
- Conservar identificadores de anuncio, conjunto, campaña y click-to-WhatsApp.
- Resolver tenant, campaña, operación y vacante por identificadores exactos o correspondencias inequívocas.
- No asociar por similitud textual cuando exista información objetiva.
- Saludar y confirmar ciudad y vacante antes de asignarlas definitivamente.
- Si los metadatos faltan, son ambiguos o no corresponden a una campaña configurada, preguntar ciudad y cargo sin inventar una asociación.

### 4.2 Información, interés y consentimiento

- Presentar información vigente almacenada en la vacante.
- Responder preguntas sobre cargo, requisitos, condiciones, zona, horario, salario o documentación en cualquier momento.
- Solicitar consentimiento únicamente después de que el candidato manifieste interés.
- Comprender aceptación, rechazo o duda usando el contexto, no una lista cerrada de frases.
- No descargar, procesar ni almacenar datos personales o archivos antes de autorización.

### 4.3 Recolección configurada por vacante

Cada vacante define sus campos obligatorios y opcionales.

Reglas actuales del cliente:

- Bogotá: solicitar y guardar localidad como lugar de residencia.
- Otras ciudades: solicitar y guardar barrio o sector.
- Soacha: registrar Soacha como residencia conforme a la regla operativa vigente.
- Cuando se requiere experiencia, guardar de forma separada:
  - si tiene experiencia;
  - tiempo de experiencia;
  - cargo, área o actividad en la que tiene experiencia.

Si el candidato entrega varios datos en lenguaje natural, Lórren debe aprovecharlos sin repetir preguntas respondidas.

### 4.4 Viabilidad geográfica

La viabilidad pertenece a la relación entre vacante, operación y residencia; no se deduce únicamente por ciudad.

La configuración deberá permitir:

- ciudades y municipios incluidos o excluidos;
- localidades, barrios y sectores;
- corredores logísticos;
- polígonos o radios cuando se incorporen coordenadas;
- medio de transporte;
- límites aproximados de distancia o tiempo;
- excepciones con vigencia.

Reglas que deben preservarse:

- determinadas vacantes de Bogotá pueden recibir residentes de Soacha;
- la operación de Siberia puede admitir zonas occidentales de Bogotá y municipios como Funza, Mosquera o Madrid cuando sean viables;
- una persona de Soacha no debe considerarse viable automáticamente para Siberia.

Toda decisión geográfica deberá registrar el resultado, las reglas aplicadas y la evidencia utilizada.

### 4.5 Modalidades de cierre

`APPLICATION_ONLY`:

- completar datos y documentos configurados;
- informar que el registro quedó completo;
- indicar que un reclutador revisará la información y contactará al candidato si el proceso continúa;
- no prometer aprobación, llamada, contratación ni entrevista.

`AUTO_INTERVIEW`:

- verificar requisitos, datos y documentos;
- ofrecer el siguiente horario realmente disponible;
- respetar una anticipación mínima inicial de seis horas, configurable por tenant o vacante;
- respetar el horizonte permitido: semana actual, semanas siguientes o rango personalizado;
- si el candidato no puede asistir, ofrecer el siguiente horario válido cuando la vacante permita reprogramación;
- no marcar la reserva como reprogramada hasta que exista una nueva reserva confirmada.

### 4.6 Recordatorios

Seguimiento de postulación incompleta:

- programar dos horas después del último mensaje del candidato;
- enviar únicamente si el proceso sigue incompleto y esperando al candidato;
- mencionar el pendiente real;
- cancelar al recibir un nuevo mensaje o cerrar el proceso;
- evitar envíos duplicados mediante una clave idempotente.

Confirmación de entrevista:

- enviar una hora antes de la reserva;
- interpretar confirmación, cancelación o solicitud de reprogramación;
- actualizar la reserva correspondiente;
- cuando falten cinco minutos sin respuesta, registrar `NO_RESPONSE`;
- conservar y procesar una respuesta tardía según la política configurada.

## 5. Estrategia arquitectónica

### 5.1 Monolito modular primero

El sistema continuará como una aplicación desplegable única durante la primera etapa, pero se separará por dominios y contratos internos. Los módulos no deberán importar detalles internos de otros dominios ni acceder directamente a sus tablas sin un servicio o repositorio definido.

Los microservicios solo se considerarán cuando exista evidencia de necesidad independiente de escalado, aislamiento, despliegue o propiedad operativa.

### 5.2 Evolución incremental

La modernización seguirá un enfoque de sustitución progresiva:

1. caracterizar el comportamiento actual;
2. introducir un contrato o fachada nueva;
3. dirigir gradualmente casos de uso hacia la implementación nueva;
4. medir equivalencia y regresiones;
5. retirar el código anterior únicamente al quedar sin consumidores.

### 5.3 Dominios objetivo

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

Esta estructura representa límites de responsabilidad, no una orden de mover archivos de forma inmediata.

Cada módulo podrá evolucionar hacia:

```text
<module>/
  domain/
  application/
  infrastructure/
  presentation/
  index.js
```

- `domain`: entidades, valores, políticas puras e invariantes.
- `application`: casos de uso y orquestación.
- `infrastructure`: Prisma, Meta, WhatsApp, OpenAI, almacenamiento y colas.
- `presentation`: rutas, controladores y adaptadores de entrada.
- `index.js`: API pública del módulo.

## 6. Contratos canónicos previstos

### `TenantContext`

Identifica el tenant y los permisos/configuración aplicables al caso de uso. Debe estar disponible antes de consultar datos, archivos, campañas, reservas, colas o métricas.

### `TurnUnderstanding`

Resultado único de interpretar un mensaje. Debe representar simultáneamente:

- intención o intenciones;
- preguntas;
- datos entregados;
- correcciones;
- referencias a mensajes previos;
- ciudad, cargo y vacante mencionados;
- decisiones de consentimiento;
- acciones sobre entrevista;
- evidencia y nivel de confianza.

### `TurnPlan`

Plan único validado para el turno:

- hechos que deben responderse;
- datos que pueden persistirse;
- acciones de dominio autorizadas;
- transición propuesta;
- siguiente pendiente;
- necesidad de revisión humana;
- respuesta a redactar.

### `VacancyPolicy`

Configuración efectiva y versionada de la vacante:

- campos requeridos;
- requisitos de experiencia;
- documentos;
- modalidad de cierre;
- política de agenda;
- política geográfica;
- reglas de recordatorios;
- mensajes o contenido empresarial verificable.

### `CandidateReadiness`

Evaluación única de datos, documentos, elegibilidad y siguiente acción permitida.

### `GeographicEligibility`

Resultado explicable de viabilidad territorial, con reglas y evidencia aplicadas.

### `InterviewPolicy`

Anticipación mínima, horizonte, disponibilidad, confirmación, cancelación y reprogramación.

## 7. Aislamiento multitenant

La futura plataforma debe asumir que un tenant es una organización cliente y no un usuario individual.

El aislamiento deberá cubrir:

- datos de candidatos y postulaciones;
- vacantes, operaciones y zonas;
- campañas y metadatos de Meta;
- credenciales de WhatsApp y Meta;
- archivos y claves de almacenamiento;
- reservas y horarios;
- trabajos en cola y claves de deduplicación;
- usuarios y permisos;
- conocimiento y configuración del bot;
- logs, trazas, métricas y costos.

Reglas mínimas:

1. ninguna consulta de negocio se ejecuta sin tenant resuelto;
2. las claves únicas relevantes incluyen tenant cuando corresponda;
3. las rutas administrativas validan pertenencia al tenant;
4. los jobs conservan `tenantId` y validan la entidad antes de ejecutarse;
5. los objetos de almacenamiento se prefijan o separan por tenant;
6. las pruebas incluyen intentos explícitos de acceso cruzado;
7. la observabilidad permite filtrar por tenant sin exponer contenido sensible.

## 8. Autoridades únicas

La arquitectura final debe tener:

- una sola interpretación estructurada del turno;
- una sola política que prioriza respuesta, persistencia, acción y reanudación;
- una sola evaluación de readiness;
- una sola autoridad de transición;
- una sola política de atribución;
- una sola política geográfica;
- una sola política de agenda;
- una sola vía de envío y persistencia de mensajes salientes.

Los servicios de dominio no deben enviar mensajes directamente. Deben devolver hechos, decisiones o resultados al caso de uso que orquesta el turno.

## 9. Fases de ejecución

### Fase 0 — Estabilizar

- Resolver todas las observaciones funcionales abiertas de #420.
- Fusionar #420 mediante squash solo con CI y revisión limpios.
- Revalidar y fusionar #419 mediante squash.
- Mantener visible la deuda de pruebas y evitar nuevas regresiones.

### Fase 1 — Caracterizar y mapear

- Construir mapa de importaciones y dependencias.
- Inventariar todos los lugares que modifican `Candidate`, `InterviewBooking`, consentimiento, recordatorios y vacantes.
- Clasificar módulos en: canónico, duplicado, transitorio, legado activo, legado sin consumidor.
- Crear pruebas de caracterización de los recorridos críticos.

### Fase 2 — Contratos internos

- Introducir los contratos canónicos sin mover todavía toda la implementación.
- Crear adaptadores desde el flujo actual.
- Evitar que módulos nuevos importen directamente rutas o servicios heredados.

### Fase 3 — Tenant en los límites

- Introducir `TenantContext` en canal, autenticación y casos de uso.
- Preparar migración de esquema y estrategia de aislamiento.
- Añadir pruebas negativas de acceso cruzado antes de activar múltiples tenants.

### Fase 4 — Configuración de negocio

- Persistir políticas por tenant, operación y vacante.
- Retirar gradualmente condiciones específicas del cliente del webhook.
- Versionar la configuración usada en decisiones relevantes.

### Fase 5 — Núcleo conversacional

- Interpretar el turno una sola vez.
- Ejecutar una sola política de turno.
- Responder interrupciones y retomar el proceso.
- Eliminar parsers, gates y redactores redundantes después de migrar sus pruebas.

### Fase 6 — Casos de uso y estados

- Centralizar transiciones e invariantes.
- Separar persistencia y proveedores externos de las decisiones de dominio.
- Impedir estados incompatibles o reservas huérfanas.

### Fase 7 — Geografía, agenda y notificaciones

- Implementar políticas configurables y explicables.
- Consolidar jobs idempotentes.
- Separar seguimiento de postulación y confirmación de entrevista.

### Fase 8 — Operación SaaS

- Métricas y trazas por tenant.
- Límites de uso y costos.
- Gestión segura de credenciales.
- Estrategia de soporte, auditoría, recuperación y migraciones.

### Fase 9 — Retiro de legado

- Eliminar adaptadores y feature flags transitorios.
- Retirar código sin consumidores.
- Convertir toda la suite estable en gate bloqueante.

## 10. Primer bloque de trabajo

El orden inmediato es:

1. corregir las observaciones abiertas de #420;
2. integrar #420 y después #419;
3. corregir la persistencia inválida de `AttachmentAnalysis`;
4. unificar el contrato de formatos válidos de hoja de vida;
5. crear el mapa de autoridades de estado y efectos externos;
6. definir el primer contrato canónico sin reescribir el flujo completo.

No se iniciará una extracción grande de carpetas mientras la línea base de consentimiento y respuestas siga pendiente.

## 11. Reglas para cada PR

- Un objetivo técnico coherente.
- Alcance pequeño y reversible.
- Pruebas de regresión o caracterización.
- Sin actualizar expectativas solo para obtener CI verde.
- Sin eliminar código antes de probar que fue reemplazado o no tiene consumidores.
- Sin despliegue automático.
- Riesgo, aceptación y rollback documentados.
- Revisión de aislamiento cuando el cambio afecte datos, archivos, colas o cachés.

## 12. Criterios de éxito

La iniciativa estará logrando su propósito cuando:

- un nuevo cliente pueda incorporarse mediante configuración y credenciales, sin copiar el flujo;
- ningún tenant pueda leer o modificar recursos de otro;
- cada turno tenga una interpretación y un plan únicos;
- una pregunta fuera de orden sea respondida sin perder el progreso;
- las reglas de vacante, geografía, agenda y recordatorios provengan de configuración;
- el webhook sea un adaptador de entrada y no el motor completo;
- los estados sean válidos, auditables y reproducibles;
- la eliminación de redundancias reduzca complejidad sin perder comportamiento validado.

## 13. Referencias arquitectónicas

- Microsoft Azure Architecture Center: diseño de soluciones multitenant.
- Microsoft Azure Architecture Center: patrón Strangler Fig para modernización incremental.
- AWS Well-Architected SaaS Lens.
- The Twelve-Factor App: configuración externa, procesos sin estado y logs como flujos de eventos.
