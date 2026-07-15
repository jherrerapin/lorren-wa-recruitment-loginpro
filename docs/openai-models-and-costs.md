# Modelos OpenAI, controles y costo

- `OPENAI_MODEL`: es el modelo principal. Controla el motor conversacional y sirve como respaldo para las tareas especializadas. El valor predeterminado de la aplicación es `gpt-5.6-terra`.
- `OPENAI_EXTRACTION_MODEL`: override opcional para extracción estructurada, consentimiento y origen del candidato.
- `OPENAI_CV_MODEL`: override opcional para lectura y comparación de hojas de vida.
- `OPENAI_ATTACHMENT_MODEL`: override opcional para clasificar archivos recibidos por el bot.
- `OPENAI_CONTEXTUAL_REPLY_MODEL`: override opcional para respuestas contextuales.
- `OPENAI_SUPERVISOR_REPLY_MODEL`: override opcional para respuestas solicitadas por el coordinador.
- `FF_RESPONSES_EXTRACTOR`: habilita/deshabilita el extractor estructurado Responses.
- `USE_CONVERSATION_ENGINE`: habilita/deshabilita el motor conversacional. Las respuestas determinísticas de vacante y adjuntos deben preferirse cuando el dato se puede resolver por código.
- `OPENAI_MIN_FIELD_CONFIDENCE`: umbral mínimo para persistir campos sugeridos por IA.
- `OPENAI_TIMEOUT_MS`: timeout de la capa de IA; ante error se debe usar fallback seguro o pausa trazable.

## Recomendación de costo

`gpt-5.6-terra` ofrece un mejor equilibrio cuando importa entender contexto, documentos y criterios de selección. Si el volumen conversacional crece y el costo o la velocidad pesan más, puede configurarse `OPENAI_MODEL=gpt-5.6-luna` y conservar Terra solo en `OPENAI_EXTRACTION_MODEL` y `OPENAI_CV_MODEL`.

La selección efectiva y la variable que la originó están centralizadas en `src/services/openAiModelConfig.js`. Al iniciar, Railway muestra el evento `[OPENAI_MODEL_CONFIG]` con los modelos efectivos y sus fuentes. Las trazas también guardan `response_model_source` y `extraction_model_source` para comprobar cada conversación.

## Monitoreo sugerido

Monitorear `blockedClaims`, `rejectedFields`, `botPauseReason`, `fallbackReason`, `openai_input_tokens`, `openai_output_tokens`, `openai_total_tokens`, `extractionModel`, `responseModel`, `extraction_model_source` y `response_model_source` en `debugTrace`/logs.
