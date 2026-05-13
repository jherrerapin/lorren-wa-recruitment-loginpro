# Modelos OpenAI, guard rails y costo

- `OPENAI_EXTRACTION_MODEL`: controla el extractor estructurado con Responses API (`src/ai/extractRecruitmentTurn.js`). Analiza turno, intención, datos del candidato, género, documento, residencia y señales de adjuntos. Recomendación inicial: `gpt-5.4-mini-2026-03-17`; `gpt-5-mini` solo si las regresiones se mantienen estables.
- `OPENAI_MODEL`: controla el motor conversacional/chat-completions (`src/services/conversationEngine.js`) y parser legacy cuando aplique. Sugiere `reply`, `nextStep`, `actions` y `extractedFields`; el backend valida antes de persistir, agendar o enviar.
- `FF_RESPONSES_EXTRACTOR`: habilita/deshabilita el extractor estructurado Responses.
- `USE_CONVERSATION_ENGINE`: habilita/deshabilita el motor conversacional. Las respuestas determinísticas de vacante y adjuntos deben preferirse cuando el dato se puede resolver por código.
- `OPENAI_MIN_FIELD_CONFIDENCE`: umbral mínimo para persistir campos sugeridos por IA.
- `OPENAI_TIMEOUT_MS`: timeout de la capa de IA; ante error se debe usar fallback seguro o pausa trazable.

## Recomendación de costo

No subir todas las capas a modelos más caros. Mantener extracción y respuesta separadas permite usar un modelo más estable para extracción y un modelo más económico para redacción. Si `OPENAI_MODEL=gpt-5-nano`, la seguridad depende de `replySafety`, `fieldSanitizer` y guard rails de agenda, no del modelo.

## Monitoreo sugerido

Monitorear `blockedClaims`, `rejectedFields`, `botPauseReason`, `fallbackReason`, `openai_input_tokens`, `openai_output_tokens`, `openai_total_tokens`, `extractionModel` y `responseModel` en `debugTrace`/logs.
