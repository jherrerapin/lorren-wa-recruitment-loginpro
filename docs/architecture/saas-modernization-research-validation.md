# Validación técnica de la modernización SaaS de Lórren

Relacionado con: #421, #422 y #415.

## 1. Resultado de la validación

La dirección general de la hoja de ruta es correcta:

- evolución incremental, sin reescritura total;
- monolito modular antes de considerar microservicios;
- una sola interpretación estructurada por turno;
- una sola política que produce el plan del turno;
- reglas de negocio configurables por tenant y vacante;
- límites determinísticos para consentimiento, persistencia, archivos, agenda y seguridad;
- servicios de dominio separados de WhatsApp, OpenAI y Prisma;
- retiro de legado únicamente después de caracterizar y reemplazar su comportamiento.

La investigación técnica obliga a incorporar los ajustes siguientes antes de iniciar una extracción estructural grande.

## 2. Estado canónico bajo control de Lórren

La base de datos de Lórren será la fuente de verdad para:

- tenant y configuración efectiva;
- identidad del candidato;
- conversación y mensajes relevantes;
- vacante solicitada, sugerida, confirmada y asignada;
- consentimiento y evidencia;
- postulación, datos y documentos;
- reservas, recordatorios y estados;
- decisiones, transiciones y auditoría.

La memoria ofrecida por un proveedor de IA podrá utilizarse como optimización temporal, pero nunca como autoridad empresarial ni como única memoria del proceso.

Consecuencias:

1. cada turno se reconstruye desde estado propio y hechos persistidos;
2. las referencias externas de IA se almacenan solo como metadatos auxiliares;
3. debe poder cambiarse el modelo o proveedor sin perder una postulación;
4. los datos sensibles no se conservan externamente más allá de la política aprobada;
5. toda decisión crítica puede reproducirse con información propia.

## 3. Evaluación antes de eliminación

Antes de retirar parsers, gates, redactores o ramas de flujo se creará un banco de conversaciones sanitizadas.

Cada escenario deberá contener:

- estado inicial del candidato y la vacante;
- historial relevante;
- mensaje o lote entrante;
- `TurnUnderstanding` esperado;
- `TurnPlan` esperado;
- escrituras permitidas y prohibidas;
- transición esperada;
- hechos que deben aparecer en la respuesta;
- afirmaciones que no deben aparecer;
- expectativa de envío, silencio o revisión humana.

La evaluación tendrá dos niveles:

### Determinístico

- modelos simulados mediante respuestas estructuradas reproducibles;
- validación de invariantes, persistencia, transiciones y herramientas;
- ejecución obligatoria en CI.

### Conversacional

- corpus de regresión en español colombiano;
- preguntas fuera de orden, correcciones, mensajes parciales, varias intenciones y errores ortográficos;
- métricas de comprensión, continuidad, exactitud factual, repetición y comportamiento robotizado;
- comparación controlada al cambiar prompts o modelos.

No se eliminará una capa antigua hasta que los escenarios que protegía estén cubiertos por la autoridad nueva.

## 4. Inbox, outbox e idempotencia

La recepción y el envío se separarán del procesamiento conversacional.

### Inbox de eventos

Cada evento recibido del proveedor debe registrarse con:

- tenant;
- proveedor y canal;
- identificador externo del evento o mensaje;
- hash o identidad de respaldo;
- fecha de recepción;
- estado de procesamiento;
- intentos y último error saneado.

El identificador externo debe impedir que una reentrega produzca dos respuestas, dos documentos, dos reservas o dos cambios de estado.

### Outbox transaccional

Las acciones externas se registrarán en la misma transacción que el cambio de negocio:

- mensaje de WhatsApp pendiente;
- recordatorio;
- notificación al reclutador;
- almacenamiento o análisis asíncrono autorizado;
- evento de auditoría o integración.

Un worker enviará o ejecutará la acción, registrará el resultado y podrá reintentar sin duplicarla.

Las claves de idempotencia incluirán tenant y entidad. El identificador del job de la cola no será la única protección contra duplicados.

## 5. Aislamiento multitenant en dos capas

El aislamiento se aplicará simultáneamente en aplicación y base de datos.

### Aplicación

- `TenantContext` obligatorio antes de ejecutar un caso de uso;
- repositorios que exigen `tenantId` en toda operación de negocio;
- referencias compuestas o comprobaciones explícitas de pertenencia;
- rutas, jobs, archivos, cachés y métricas con tenant obligatorio;
- prohibición de consultas globales desde módulos de negocio salvo casos administrativos autorizados.

### Base de datos

- `tenantId` en entidades compartidas;
- índices y restricciones únicas compuestas con tenant;
- claves foráneas que impidan relaciones cruzadas cuando sea viable;
- Row Level Security como defensa adicional;
- políticas de mínimo privilegio para conexiones y workers;
- pruebas que intenten leer, actualizar, asociar y procesar recursos de otro tenant.

RLS no será la única barrera, porque conexiones privilegiadas o roles de servicio pueden omitirla.

## 6. Atribución con niveles de certeza

No se prometerá exactitud absoluta cuando el proveedor no entregue metadatos suficientes.

Cada primer contacto conservará el evento de atribución original e inmutable y se clasificará como:

- `EXACT`: identificadores objetivos enlazados de manera única a tenant, campaña, anuncio y vacante configurada;
- `CONFIRMED`: la asociación fue propuesta por metadatos parciales y confirmada expresamente por el candidato;
- `UNKNOWN`: no existe evidencia suficiente y Lórren debe preguntar sin inventar.

Reglas:

1. nunca reemplazar el evento original con una interpretación posterior;
2. no usar similitud textual cuando haya identificadores objetivos;
3. no asignar definitivamente una vacante antes de confirmarla con el candidato;
4. registrar evidencia, método, versión de la configuración y fecha de la decisión;
5. separar campaña atribuida, vacante sugerida y vacante finalmente confirmada.

## 7. Comprensión estructurada y herramientas tipadas

La IA comprenderá y redactará, pero no escribirá directamente en Prisma ni ejecutará efectos externos sin validación.

El ciclo objetivo será:

1. cargar estado canónico y configuración efectiva;
2. producir un `TurnUnderstanding` con esquema estricto;
3. validar evidencia, confianza y campos permitidos;
4. producir un `TurnPlan` único;
5. ejecutar herramientas o casos de uso tipados;
6. persistir transiciones y outbox de forma atómica;
7. redactar desde hechos confirmados;
8. aplicar seguridad factual antes del envío.

Las herramientas se agruparán por dominio y tendrán entradas y resultados validados. Por ejemplo:

- consultar información de vacante;
- confirmar o cambiar vacante;
- registrar consentimiento;
- actualizar datos autorizados;
- evaluar readiness y geografía;
- consultar disponibilidad;
- reservar, cancelar o solicitar reprogramación;
- programar o cancelar recordatorios.

## 8. Geografía basada en datos espaciales

El modelo no decidirá viabilidad territorial mediante una lista libre de nombres o una búsqueda web durante cada conversación.

La solución combinará:

1. catálogo canónico de país, departamento, municipio, ciudad, localidad, barrio, sector y alias;
2. coordenadas o geometrías cuando estén disponibles;
3. zonas de inclusión y exclusión por operación o vacante;
4. reglas de radio o contención espacial;
5. medio de transporte y restricciones configuradas;
6. proveedor opcional de distancia o tiempo de ruta para casos que lo requieran;
7. resultado versionado y explicable.

La IA solo convertirá la expresión del candidato en candidatos de lugar. El backend resolverá la entidad geográfica y calculará la política.

## 9. Observabilidad desde el inicio

La observabilidad no se pospone hasta el final.

Desde las primeras fases se propagará un contexto de trazabilidad por:

- tenant;
- evento de webhook;
- conversación y turno;
- candidato y postulación;
- reserva;
- job o recordatorio;
- mensaje saliente.

Las tareas asíncronas conservarán correlación con el turno que las originó. Los logs evitarán contenido sensible y expondrán decisiones, estados, razones y errores saneados.

## 10. Configuración versionada

Las decisiones relevantes conservarán una referencia o copia de la configuración efectiva utilizada:

- campos requeridos;
- política de experiencia;
- modalidad de cierre;
- geografía;
- agenda y anticipación mínima;
- reprogramación;
- documentos;
- recordatorios;
- contenido oficial de la vacante.

Modificar una vacante mañana no debe cambiar retroactivamente la explicación de una decisión tomada hoy.

## 11. Orden de ejecución ajustado

### Fase 0 — Seguridad y línea base

1. resolver todos los bloqueadores funcionales de #420;
2. integrar #420 y revalidar #419;
3. corregir persistencia de análisis de adjuntos;
4. unificar el contrato de formatos de hoja de vida;
5. añadir trazabilidad mínima e inventario de deuda.

### Fase 1 — Caracterización y evaluación

1. crear corpus sanitizado de conversaciones críticas;
2. implementar replay determinístico;
3. fijar invariantes de consentimiento, datos, vacantes, agenda y recordatorios;
4. convertir esas regresiones en gates de CI.

### Fase 2 — Entrada confiable

1. introducir inbox idempotente para eventos del canal;
2. definir outbox transaccional para mensajes y jobs;
3. centralizar el envío y registro de mensajes;
4. propagar correlación de trazas.

### Fase 3 — Contratos internos y autoridades únicas

1. introducir `TenantContext`, `TurnUnderstanding` y `TurnPlan`;
2. crear adaptadores desde el flujo existente;
3. centralizar readiness y transiciones;
4. retirar autoridades paralelas solo después de migrar sus escenarios.

### Fase 4 — Base multitenant

1. diseñar migración de `tenantId` y restricciones compuestas;
2. crear repositorios tenant-aware;
3. añadir RLS como defensa adicional;
4. probar acceso cruzado antes de habilitar un segundo tenant.

### Fases posteriores

Continuar con configuración versionada de vacantes, atribución, geografía, agenda, recordatorios, operación SaaS y retiro de legado conforme a la hoja de ruta principal.

## 12. Decisión final

Se mantiene la estrategia de modernización incremental y monolito modular. No se recomienda una reescritura ni una migración temprana a microservicios.

El primer trabajo de runtime continúa siendo estabilizar la frontera de consentimiento de #420. Ninguna extracción arquitectónica grande debe comenzar mientras esa base siga con observaciones funcionales abiertas.
