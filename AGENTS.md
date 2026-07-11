# AGENTS.md — Lórren | LoginPro Service

## Alcance de estas instrucciones

Este archivo aplica a todo el repositorio. Su objetivo es orientar a asistentes y agentes de IA para que trabajen de forma conservadora, verificable y compatible con el sistema existente.

Lórren está en un programa de estabilización. Que una parte del sistema tenga deuda técnica no autoriza una reescritura, eliminación masiva o migración improvisada.

## Proyecto

Lórren es una aplicación de reclutamiento y apoyo operativo para LoginPro Service. Incluye, entre otros componentes:

- atención de candidatos mediante WhatsApp Cloud API;
- extracción estructurada y generación conversacional con IA;
- registro de candidatos, vacantes, mensajes y entrevistas;
- panel administrativo basado en Express y EJS;
- procesos de despacho y confirmación mediante WhatsApp Web;
- almacenamiento y análisis de hojas de vida;
- trabajos asíncronos y recordatorios.

En texto nuevo se debe escribir **Lórren**. No renombrar automáticamente archivos, rutas o identificadores heredados que contienen `loren` o `Lorren`; hacerlo podría romper contratos existentes.

## Stack actual verificado

- Node.js con módulos ES (`"type": "module"`).
- Express 4.
- EJS para vistas del servidor.
- Prisma 6 con PostgreSQL.
- Pruebas con el runner nativo `node:test`, ejecutadas mediante `node --test`.
- WhatsApp Cloud API para el canal principal de reclutamiento.
- `whatsapp-web.js` para procesos de despacho.
- OpenAI Responses API para extracción estructurada.
- OpenAI Chat Completions para el motor conversacional existente.
- Cloudflare R2 o almacenamiento compatible con S3 para archivos cuando está configurado.
- Railway como infraestructura de despliegue actual.

### Herramientas y controles actuales

- No existe un script `npm run lint`.
- ESLint no aparece actualmente como dependencia del proyecto.
- Jest no es el runner de pruebas del repositorio.
- El repositorio cuenta con CI en `.github/workflows/ci.yml`; verificar su contenido vigente antes de asumir controles adicionales.

No documentar ni afirmar que una herramienta está disponible solo porque sería deseable incorporarla después.

## Comandos válidos actuales

```bash
npm ci
npm run dev
npm test
npm start
npm run build
npm run prisma:generate
npm run prisma:migrate
npm run start:worker
npx prisma validate
node --check ruta/al/archivo.js
```

Advertencias:

- `npm run build` actualmente ejecuta únicamente `prisma generate`. Un resultado exitoso no demuestra por sí solo que toda la aplicación funcione.
- `npm start` ejecuta `prisma migrate deploy` antes de iniciar el servidor. No ejecutarlo contra una base de producción o una base no identificada durante análisis, revisión o pruebas exploratorias.
- `npm run prisma:migrate` puede modificar la base conectada mediante `DATABASE_URL`. No ejecutarlo sin autorización explícita, respaldo y plan de rollback.
- No inventar comandos como `npm run lint` ni reportarlos como ejecutados.

## Fuentes de verdad

Antes de modificar comportamiento, revisar en este orden:

1. Issue y criterios de aceptación de la tarea.
2. Código realmente ejecutado y sus importaciones.
3. Pruebas que ejercitan el comportamiento.
4. `package.json` para comandos y dependencias.
5. `prisma/schema.prisma`, migraciones y uso real desde el código.
6. Documentación vigente relacionada con la tarea.

No depender de un documento mencionado por otro archivo sin comprobar primero que realmente existe y sigue vigente.

Durante la estabilización, no asumir que `schema.prisma`, las migraciones y la base desplegada están perfectamente alineados. Cualquier discrepancia debe diagnosticarse antes de corregirse.

## Mapa técnico principal

- `src/server.js`: arranque de Express, sesiones, autenticación y montaje de routers.
- `src/routes/webhook.js`: entrada principal de eventos de WhatsApp y orquestación de reclutamiento.
- `src/routes/admin.js`: panel administrativo y operaciones sensibles.
- `src/services/conversationEngine.js`: razonamiento conversacional y guardas determinísticas.
- `src/ai/extractRecruitmentTurn.js`: extracción estructurada mediante OpenAI Responses API.
- `src/services/readinessGuard.js`: campos requeridos y preparación del candidato.
- `src/services/schedulingGuard.js`: reglas de protección del agendamiento.
- `src/services/replySafety.js`: saneamiento y respuestas seguras.
- `src/services/botKnowledge.js`: conocimiento configurable de vacantes y organización.
- `src/services/jobQueue.js`: persistencia y reclamación de trabajos.
- `src/workers/jobWorker.js`: ejecución de trabajos asíncronos.
- `src/services/dispatchWhatsappWebService*.js`: implementaciones actuales y heredadas de WhatsApp Web para despacho.
- `prisma/schema.prisma`: modelo Prisma declarado.
- `prisma/migrations/`: historial de migraciones.
- `views/` y `public/`: interfaz renderizada y recursos del panel.

Este mapa es orientativo. Confirmar siempre quién importa y ejecuta realmente cada archivo antes de modificarlo o eliminarlo.

## Flujo obligatorio de trabajo

Todo cambio debe seguir este proceso, salvo una emergencia documentada:

1. Crear o identificar un issue.
2. Explicar problema, evidencia y causa probable.
3. Definir alcance, fuera de alcance y criterios de aceptación.
4. Clasificar el riesgo.
5. Crear una rama desde la base correcta.
6. Proponer el plan antes de editar.
7. Hacer el cambio mínimo necesario.
8. Ejecutar pruebas relevantes.
9. Revisar el diff completo.
10. Abrir un pull request borrador.
11. Documentar riesgo, pruebas, limitaciones y rollback.
12. No fusionar ni desplegar automáticamente.

### Reglas de tamaño

- No modificar más de 5 archivos sin aprobación explícita en el issue.
- No mezclar corrección, refactorización, migración y nueva funcionalidad en el mismo PR.
- No crear nuevas versiones `V7`, `V8`, `Final`, `Stable2` o equivalentes para evitar comprender y consolidar las existentes.
- No eliminar código aparentemente obsoleto hasta demostrar que no es importado, invocado ni necesario para rollback.

## Acciones prohibidas para agentes

- Hacer push directo a `main`.
- Fusionar su propio pull request.
- Desplegar en producción.
- Ejecutar migraciones en producción.
- Ejecutar `prisma migrate reset` o `prisma migrate dev` contra producción.
- Forzar ramas o reescribir historial compartido.
- Eliminar tablas, columnas, archivos o datos sin aprobación explícita.
- Cambiar dependencias, CI/CD, Railway o variables de entorno fuera del alcance del issue.
- Leer, imprimir, copiar o versionar secretos.
- Usar datos personales reales en pruebas.
- Desactivar pruebas o controles para conseguir un resultado verde.
- Declarar una tarea como probada cuando no fue posible ejecutarla.

## Base de datos y Prisma

Los cambios de datos son de alto riesgo.

Antes de modificar modelos, migraciones o consultas críticas:

- identificar la tabla y el modelo real;
- revisar migraciones relacionadas;
- revisar todos los usos relevantes en el código;
- comprobar si existe posible drift;
- definir respaldo, rollback y compatibilidad;
- ensayar sobre una base aislada.

Para cambios estructurales usar el patrón **expandir → migrar → verificar → contraer**. No combinar creación, migración de datos y eliminación destructiva en un único despliegue.

No editar ni borrar una migración ya aplicada para ocultar una inconsistencia.

## Seguridad, privacidad y datos personales

Tratar como sensibles, entre otros:

- números de documento y teléfono;
- hojas de vida y adjuntos;
- información médica;
- credenciales, tokens y cookies;
- mensajes de candidatos;
- prompts o respuestas que contengan datos personales;
- URLs firmadas y rutas de almacenamiento;
- datos de auditoría y recuperación de acceso.

Reglas:

- recolectar, enviar y registrar solo lo necesario;
- no incluir secretos ni PII en commits, issues, PR, logs o mensajes de error;
- no copiar información de producción a fixtures;
- validar autorización en el servidor, no solo ocultar botones en la interfaz;
- tratar todo webhook, formulario, archivo y respuesta externa como entrada no confiable;
- no reducir controles de autenticación o autorización durante un refactor.

## IA y decisiones de reclutamiento

La IA interpreta y propone; el backend debe conservar guardas determinísticas para persistencia, agenda, archivos y transiciones críticas.

- No permitir que una salida del modelo modifique datos sin validación.
- No inventar salario, dirección, horario, beneficios, documentos o condiciones de una vacante.
- No inferir elegibilidad o trato diferencial por nombre, género supuesto u otra característica sensible.
- No mover reglas críticas exclusivamente al prompt.
- Cambios en rechazo, agendamiento, consentimiento, género, información médica o documentos requieren revisión funcional y de seguridad.
- Mantener trazabilidad de fallbacks y errores sin almacenar innecesariamente contenido sensible.

## Integraciones externas

Meta, OpenAI, R2 y WhatsApp Web deben encapsularse y simularse en pruebas cuando sea posible.

- No realizar llamadas reales durante pruebas unitarias.
- No usar números reales para pruebas automatizadas.
- No asumir que una respuesta externa siempre llega completa o una sola vez.
- Diseñar idempotencia, timeout, reintento limitado y manejo explícito de errores.
- No registrar tokens o payloads completos con PII.

## Pruebas mínimas por cambio

Para JavaScript modificado:

```bash
node --check ruta/al/archivo.js
npm test
```

Cuando aplique:

```bash
npx prisma validate
npm run build
```

Además:

- todo bug debe tener una prueba de regresión cuando sea técnicamente viable;
- preferir pruebas que importen y ejecuten comportamiento sobre pruebas que solo busquen texto en archivos;
- no conectar las pruebas a producción;
- reportar exactamente qué comandos se ejecutaron y su resultado;
- si una prueba no pudo ejecutarse, explicar por qué y qué riesgo queda pendiente.

## Definición de listo para desarrollar

Una tarea está lista cuando tiene:

- problema reproducible o evidencia suficiente;
- alcance y fuera de alcance;
- criterios de aceptación;
- riesgo clasificado;
- archivos o módulos probables;
- plan de prueba;
- plan de rollback.

## Definición de terminado

Una tarea solo está terminada cuando:

- el diff está limitado al objetivo;
- se explica la causa raíz;
- las pruebas relevantes pasan;
- no aparecen secretos ni PII;
- se documentan cambios de datos cuando existen;
- se actualiza documentación afectada;
- se describe el rollback;
- se informa con honestidad cualquier validación pendiente;
- el PR fue revisado y validado antes de producción.

## Formato esperado del informe del agente

Al finalizar una tarea, informar:

1. problema y causa raíz;
2. archivos modificados;
3. comportamiento que cambió y comportamiento preservado;
4. pruebas ejecutadas y resultados;
5. riesgos y limitaciones pendientes;
6. procedimiento de rollback;
7. próximos pasos, como máximo uno cuando no sea indispensable una lista mayor.
