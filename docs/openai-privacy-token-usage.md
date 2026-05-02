# OpenAI: privacidad, data sharing y medición de tokens

## Objetivo

Reducir el riesgo de enviar datos personales crudos de candidatos a OpenAI cuando se use un proyecto con `OPENAI_DATA_SHARING_ENABLED=true`.

## Cambios implementados

- Enmascaramiento previo a OpenAI mediante `src/services/openaiPrivacy.js`.
- Registro de consumo de tokens mediante `src/services/openaiUsageLogger.js`.
- Modelo Prisma `OpenAIUsageLog` y migración asociada.
- Ajuste de extracción por `chat/completions` en `src/services/aiParser.js`.
- Ajuste de extracción por `responses` en `src/ai/extractRecruitmentTurn.js`.
- Ajuste de respuestas naturales en `src/services/naturalReply.js`.

## Datos enmascarados

El sistema intenta reemplazar antes de llamar a OpenAI:

- correos electrónicos
- teléfonos
- documentos con tipo explícito
- números largos que pueden ser documento
- nombres detectados por frases explícitas

Ejemplos:

```txt
CC 123456789 -> [TIPO_DOCUMENTO] [DOCUMENTO]
3001234567 -> [TELEFONO]
mi nombre es Carlos Perez -> mi nombre es [NOMBRE_CANDIDATO]
```

## Registro de tokens

La tabla `OpenAIUsageLog` guarda:

- modelo solicitado
- modelo devuelto
- tokens de entrada
- tokens de salida
- tokens cacheados
- total de tokens
- tipo de uso
- si data sharing estaba marcado como activo
- si hubo enmascaramiento
- resumen de tipos de datos enmascarados

No debe guardar:

- prompt enviado
- respuesta cruda de OpenAI
- teléfono crudo
- número de documento crudo
- nombre completo crudo

## Variables de entorno recomendadas

```env
OPENAI_MODEL=gpt-5.5-2026-04-23
OPENAI_EXTRACTION_MODEL=gpt-5.5-2026-04-23
OPENAI_DATA_SHARING_ENABLED=true
OPENAI_PRIVACY_MASKING_ENABLED=true
OPENAI_USAGE_LOGGING_ENABLED=true
```

## Pendiente crítico

`src/services/conversationEngine.js` también llama directamente a OpenAI y construye un estado curado del candidato. Ese archivo debe ajustarse antes de considerar completa la protección, porque puede incluir campos como:

- fullName
- documentNumber
- historial reciente
- otros datos del candidato

Hasta que ese archivo no quede ajustado, no se debe afirmar que todo el tráfico hacia OpenAI está enmascarado.

## Mensaje recomendado de autorización

Antes de solicitar datos personales al candidato, el flujo debe enviar o incluir una frase como:

> Antes de continuar, te informamos que tus datos serán tratados únicamente para gestionar tu postulación laboral con LoginPro. Al continuar y compartir tus datos, autorizas su tratamiento para fines de reclutamiento, contacto y agendamiento de entrevista.

Si LoginPro tiene política formal publicada, se debe agregar el enlace correspondiente.

## Checklist antes de producción

- Aplicar migración Prisma.
- Ejecutar `npx prisma generate`.
- Ejecutar `npm test`.
- Ejecutar flujo manual con candidato ficticio que envíe nombre, teléfono y documento.
- Verificar que OpenAI no reciba texto crudo en `aiParser`, `extractRecruitmentTurn` ni `naturalReply`.
- Ajustar `conversationEngine.js` antes de activar data sharing en producción.
- Validar disponibilidad real de `gpt-5.5-2026-04-23` en el proyecto OpenAI.