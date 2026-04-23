# Hardening P0

## Resumen

Se implementó un refactor incremental con feature flags (default `false`) para endurecer extracción, policy, adjuntos y scheduling operativo:

- Nuevo extractor estructurado con Responses API + JSON Schema estricto.
- Capa de policy para bloquear nombre-saludo y edad desde direcciones.
- Cola persistente en PostgreSQL con modelos Prisma `JobQueue` y `AttachmentAnalysis`.
- Worker dedicado para polling de jobs (sin loops de reminder en `server.js`).
- Analyzer de adjuntos con clasificación `CV_VALID`, `CV_IMAGE_ONLY`, `ID_DOC`, `OTHER`, `UNREADABLE`.
- Keepalive endurecido para cortar cuando la entrevista ya pasó (política operativa permanente).

## Feature flags

- `FF_RESPONSES_EXTRACTOR`
- `FF_POLICY_LAYER`
- `FF_POSTGRES_JOB_QUEUE`
- `FF_ATTACHMENT_ANALYZER`
- `FF_SEMANTIC_SHORT_MEMORY`
- `FF_ASYNC_ADMIN_MEDIA_FORWARD`

## Notas de compatibilidad

- Node 20+, ESM/JS y Prisma preservados.
- Cambios dashboard/admin/login: no funcionales.
