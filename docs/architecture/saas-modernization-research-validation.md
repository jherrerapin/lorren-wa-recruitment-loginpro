# Validación técnica de la modernización SaaS de Lórren

Relacionado con: #421, #422, #423 y #424.

## 1. Conclusión

La estrategia aprobada es correcta si se ejecuta en este orden:

1. estabilizar seguridad y línea base;
2. caracterizar el comportamiento y convertirlo en gates;
3. resolver un tenant y una configuración mínima en la frontera;
4. introducir inbox, outbox y trazabilidad;
5. consolidar contratos y autoridades únicas;
6. completar el aislamiento multitenant;
7. trasladar y administrar todas las reglas mediante configuración versionada;
8. consolidar el núcleo conversacional y sus estados;
9. configurar geografía, agenda y notificaciones;
10. completar la operación SaaS y retirar el legado.

No se recomienda una reescritura total ni una migración temprana a microservicios.

## 2. Decisiones obligatorias

### 2.1 Estado canónico propio

La base de datos de Lórren es la fuente de verdad para:

- tenant y configuración efectiva;
- candidato, conversación y postulación;
- atribución original y vacante confirmada;
- consentimiento y evidencia;
- metadatos, relaciones, clasificación, claves y estado de los documentos;
- reservas, recordatorios y estados;
- decisiones, transiciones y auditoría.

Cuando se utilice R2, S3 u otro almacenamiento de objetos, ese almacenamiento es la fuente de verdad de los bytes del archivo. La base de datos conserva la clave, el hash, el tipo, el tamaño, el propietario, el tenant, la autorización, el estado y la relación empresarial, pero no sustituye el contenido binario.

Consecuencias:

1. backups, restauraciones, migraciones, retención y borrado deben coordinar base de datos y almacenamiento;
2. una referencia de base de datos sin objeto, o un objeto sin referencia autorizada, se considera una inconsistencia auditable;
3. las claves de almacenamiento incorporan tenant y no se construyen únicamente con datos aportados por el usuario;
4. el acceso al archivo valida tenant, autorización y relación antes de generar una descarga;
5. la memoria de un proveedor de IA puede ser una optimización, nunca la única memoria ni autoridad empresarial.

### 2.2 Comprensión estructurada y efectos controlados

La IA puede comprender lenguaje y redactar, pero no debe escribir directamente en Prisma ni ejecutar efectos externos sin validación.

El ciclo validado es:

1. resolver tenant y deduplicar;
2. cargar estado y política versionada;
3. obtener `TurnUnderstanding` con esquema estricto;
4. validar evidencia, permisos e invariantes;
5. construir `TurnPlan`;
6. ejecutar cálculos de dominio sin efectos externos;
7. generar y verificar la respuesta segura;
8. persistir estado y outbox en una transacción;
9. ejecutar el efecto mediante un worker idempotente.

Esta secuencia evita confirmar un cambio de negocio sin disponer de un mensaje seguro y reintentable para comunicarlo.

### 2.3 Evaluación antes de eliminación

Antes de retirar cualquier parser, gate, redactor o rama de flujo se requiere cobertura determinística en la capa correspondiente.

Los fixtures conversacionales contienen:

- `TenantContext`;
- canal y proveedor ya resueltos;
- versión de conversación, vacante, consentimiento y políticas aplicables;
- estado inicial;
- historial relevante;
- mensaje o lote admitido por la entrada;
- comprensión esperada;
- plan esperado;
- escrituras permitidas y prohibidas;
- transición y estado final;
- hechos obligatorios y afirmaciones prohibidas;
- expectativa de envío, silencio o revisión.

Los fixtures de entrada e idempotencia contienen:

- tenant, proveedor y canal;
- identificador externo y clave de idempotencia;
- primera entrega y reentregas;
- estado inicial del inbox y outbox;
- conteos esperados de escrituras, mensajes, reservas, documentos y jobs;
- resultado final y evidencia de deduplicación.

Los fixtures determinísticos se ejecutan en CI antes de retirar legado o habilitar inbox/outbox. Las pruebas con modelo real sirven para comparar calidad, pero no reemplazan un gate reproducible.

## 3. Tenant y política mínima antes de idempotencia durable

Un proveedor o número puede compartir formatos de identificadores entre clientes. Por eso tenant y canal se resuelven antes de construir la clave durable del inbox.

La identidad primaria recomendada es una restricción única compuesta, no una concatenación libre:

```text
UNIQUE (tenantId, provider, channelId, externalMessageId)
```

Cuando sea necesario producir una única cadena o hash para una cola, caché o proveedor externo, se utilizará una serialización canónica no ambigua, por ejemplo:

```text
idempotencyKey = sha256(JSON.stringify([
  tenantId,
  provider,
  channelId,
  externalMessageId
]))
```

También es válido un formato con longitudes explícitas. No se permite concatenar valores sin delimitación y escape canónicos, porque tuplas distintas podrían producir la misma cadena.

Además, un segundo tenant no puede habilitarse mientras la recolección, geografía, consentimiento, documentos, agenda y recordatorios dependan implícitamente de reglas de LoginPro o Bogotá. La frontera debe resolver una política mínima versionada por tenant antes de procesar la conversación.

No debe existir un inbox global cuya identidad se migre después, ni un segundo cliente operando con políticas heredadas por defecto. Ambos escenarios producirían colisiones, decisiones incorrectas o fugas de configuración.

## 4. Inbox y outbox

### Inbox

Cada evento entrante registra:

- tenant y canal;
- proveedor;
- ID externo o identidad de respaldo;
- hash del contenido necesario para deduplicación;
- fechas de recepción y procesamiento;
- estado, intentos y error saneado.

Una reentrega no puede producir una segunda respuesta, reserva, carga de archivo o transición. La deduplicación ocurre antes de `TurnUnderstanding`; un duplicado no se convierte en intención conversacional.

### Outbox

En la misma transacción del cambio de negocio se registra:

- cuerpo final del mensaje saliente;
- destinatario y canal;
- recordatorio o job;
- evento de auditoría o integración;
- clave de idempotencia;
- contexto de trazabilidad.

El worker ejecuta el efecto, registra el resultado y reintenta sin duplicar. El ID interno de la cola no será la única protección.

## 5. Aislamiento multitenant en dos capas

### Aplicación

- `TenantContext` obligatorio en casos de uso y repositorios.
- Toda consulta de negocio exige `tenantId`.
- Jobs, archivos, caché, métricas y credenciales conservan tenant.
- Las referencias se validan antes de actualizar o asociar recursos.
- Las políticas mínimas se resuelven por tenant y versión antes de habilitar un segundo cliente.
- Las consultas globales quedan reservadas a casos administrativos explícitos.

### Base de datos y almacenamiento

- `tenantId` en entidades compartidas.
- Unicidad compuesta por tenant.
- Relaciones cruzadas protegidas mediante claves o validaciones compuestas.
- RLS como defensa adicional.
- Roles de mínimo privilegio.
- Claves y permisos de almacenamiento segregados por tenant.
- Pruebas negativas de lectura, escritura, asociación, descarga y ejecución cruzadas.

RLS no es suficiente por sí sola porque roles privilegiados pueden omitirla. Tampoco es suficiente prefijar objetos si la aplicación no comprueba la pertenencia antes de entregar una URL.

## 6. Atribución con certeza explícita

El sistema no promete exactitud absoluta cuando Meta no entrega información suficiente.

- `EXACT`: IDs objetivos resuelven una asociación única a una vacante vigente. Puede establecerse inmediatamente el contexto técnico y conservarse la evidencia original.
- `CONFIRMED`: la asociación sugerida por evidencia parcial fue confirmada por el candidato antes de convertirse en vacante final.
- `UNKNOWN`: la evidencia es insuficiente y Lórren pregunta sin inventar.

En `EXACT`, Lórren comunica después del saludo la ciudad y vacante detectadas y permite corregirlas, pero no exige una respuesta redundante para conservar la atribución objetiva. Una corrección del candidato crea una decisión posterior auditable; nunca reescribe el evento original.

Se conservan por separado:

- evento original;
- campaña y anuncio atribuidos;
- vacante sugerida o resuelta por metadatos;
- vacante finalmente utilizada en la postulación;
- método, versión, fecha y evidencia de cada decisión.

## 7. Consentimiento y archivos

Antes de la autorización solo se tratan y conservan los identificadores técnicos mínimos necesarios para recibir el mensaje, resolver tenant/canal, preservar la atribución y solicitar el consentimiento. No se extraen ni persisten campos de perfil, no se descargan archivos y no se procesa una HV.

#420 debe:

- diferenciar interés, aceptación de vacante y autorización;
- preservar el contexto pendiente;
- rechazar de forma segura documentos anticipados;
- solicitar reenvío posterior;
- revalidar una vacante alternativa antes de asignarla;
- fallar de forma cerrada.

El comportamiento legado que almacenaba archivos anticipados debe quedar caracterizado. La modernización no autoriza borrar retroactivamente esos archivos sin una política de retención y una migración separadas.

## 8. Adjuntos

La Fase 0 incluye dos deudas confirmadas:

1. alinear `AttachmentAnalysis` con los campos reales de Prisma y evitar fallos silenciosos;
2. unificar el contrato de hoja de vida en PDF/DOCX.

Las hojas de vida de reclutamiento deben aceptarse únicamente como PDF o DOCX. Los archivos `.doc` heredados se rechazan y Lórren solicita el reenvío en un formato permitido; analizar su contenido no los convierte en válidos.

La persistencia de un documento debe mantener consistentes la fila de base de datos y el objeto almacenado. Los fallos parciales requieren compensación, estado explícito o reconciliación; no se debe presentar como disponible un archivo cuyo objeto no exista.

## 9. Agenda y recordatorios

### Reprogramación

El objetivo es marcar `RESCHEDULED` solo cuando existe una nueva reserva. El runtime vigente puede hacerlo antes; se registra como corrección planificada, no como comportamiento ya implementado.

### Recordatorio de entrevista

El requisito de producto es una hora antes. Los cuarenta minutos presentes en código o documentación heredada constituyen una migración pendiente que debe actualizar política y pruebas de manera coordinada.

### Recordatorio de abandono

El ancla será el último mensaje saliente que solicitó una acción, siempre que no exista un mensaje entrante posterior. Esto evita recordar dos horas después de una respuesta del candidato o usar una referencia temporal ambigua.

## 10. Geografía basada en datos

La IA no decide por una lista libre de nombres ni consulta Internet durante cada conversación.

La solución combinará:

- catálogo territorial y alias;
- geometrías o coordenadas;
- zonas de inclusión y exclusión;
- radios, contención o corredores;
- medio de transporte;
- distancia o duración opcional;
- política versionada y resultado explicable.

La IA propone lugares candidatos; el backend resuelve la entidad y calcula la viabilidad.

## 11. Observabilidad desde la línea base

La correlación debe comenzar antes de la extracción modular y relacionar:

- tenant y canal;
- evento e inbox;
- conversación y turno;
- candidato y postulación;
- reserva;
- job y recordatorio;
- outbox y mensaje saliente;
- clave y operación de almacenamiento de documentos.

Los logs no expondrán tokens, cabeceras, archivos ni contenido sensible innecesario. Sí conservarán estado, razón, versión y error saneado.

## 12. Configuración versionada

Cada decisión relevante conserva la configuración efectiva utilizada:

- campos requeridos;
- experiencia;
- documentos;
- modalidad de cierre;
- geografía;
- agenda;
- reprogramación;
- recordatorios;
- información oficial de la vacante.

Una modificación futura no debe cambiar retroactivamente la explicación de una decisión anterior.

Antes del segundo tenant debe existir una versión mínima tenant-aware de estas políticas. La Fase 6 completa su administración, experiencia de configuración y eliminación de condiciones heredadas, pero no habilita un cliente nuevo sobre reglas globales.

## 13. Orden técnico validado

### Fase 0 — Línea base

- sincronizar #420 con el `main` vigente;
- corregir sus regresiones y devolver CI a verde;
- corregir `AttachmentAnalysis`;
- unificar PDF/DOCX y rechazar `.doc`;
- iniciar trazabilidad e inventario de deuda.

### Fase 1 — Corpus conversacional y gates

- ampliar el corpus ya fusionado mediante #425;
- implementar replay conversacional;
- cubrir recorridos críticos y errores;
- hacer los escenarios bloqueantes.

### Fase 2 — Tenant y política mínima

- resolver tenant/canal en la entrada;
- propagar `TenantContext` mínimo;
- resolver políticas mínimas por tenant y versión;
- probar aislamiento de eventos y configuración.

### Fase 3 — Fiabilidad transaccional

- inbox;
- outbox;
- fixtures de reentrega e idempotencia;
- envío centralizado;
- workers idempotentes;
- trazas correlacionadas.

### Fase 4 — Contratos y autoridades

- `TurnUnderstanding`;
- `TurnPlan`;
- readiness, geografía y agenda canónicos;
- adaptadores desde el legado;
- retiro progresivo de duplicaciones.

### Fase 5 — Multitenencia completa

- migraciones e índices compuestos;
- repositorios tenant-aware;
- RLS, roles mínimos y almacenamiento segregado;
- pruebas cruzadas y de configuración antes del segundo tenant.

### Fase 6 — Configuración de negocio

- completar y administrar políticas versionadas por tenant, operación y vacante;
- retirar condiciones específicas del cliente del webhook;
- separar contenido empresarial de lógica de aplicación.

### Fase 7 — Núcleo conversacional y estados

- interpretar una vez y planear una vez;
- responder interrupciones y retomar pendientes;
- centralizar estados e invariantes;
- reducir el webhook a adaptador de entrada.

### Fase 8 — Geografía, agenda y notificaciones

- implementar políticas territoriales explicables;
- corregir reprogramación y ventanas de recordatorio;
- consolidar workers y recordatorios idempotentes.

### Fase 9 — Operación SaaS y retiro de legado

- métricas, costos, límites y auditoría por tenant;
- gestión segura de credenciales;
- eliminación de adaptadores, flags y código sin consumidores;
- mantener como bloqueante toda la suite estable.

## 14. GPT interno

El GPT de #424 se crea únicamente cuando la documentación, corpus, contratos, ADR, convenciones y política de actualización/versionado estén estables conforme a `gpt-auditor-readiness.md`. Su función es mantenimiento, supervisión, QA y onboarding. No participa en el runtime ni sustituye a GitHub.

## 15. Referencias primarias

- OpenAI: Structured Outputs, function calling y evaluaciones.
- Microsoft Azure Architecture Center: multitenencia y patrón Strangler Fig.
- AWS Well-Architected SaaS Lens.
- PostgreSQL: Row Level Security.
- Supabase: RLS y gestión de acceso.
- OpenTelemetry: trazas y correlación.
- PostGIS: operaciones espaciales como `ST_DWithin`.
- BullMQ: jobs idempotentes y reintentos.
- Twelve-Factor App: configuración externa, procesos y logs.

## 16. Decisión final

La modernización continúa de forma incremental. Ninguna extracción grande se inicia hasta que la frontera de consentimiento esté estabilizada y los gates protejan tanto el comportamiento conversacional como la fiabilidad de entrada.
