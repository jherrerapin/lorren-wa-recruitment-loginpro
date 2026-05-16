# Principios aplicados para Lórren

Este ajuste sigue prácticas oficiales de diseño y mejora continua de asistentes conversacionales:

- OpenAI recomienda tratar las instrucciones como una definición versionable del comportamiento del modelo, con reglas claras, contexto dinámico y pruebas/evaluación continua: https://platform.openai.com/docs/guides/prompting
- Rasa define Conversation-Driven Development como escuchar conversaciones reales, revisarlas con regularidad, anotar patrones y usar esos aprendizajes para mejorar el asistente de forma iterativa: https://rasa.com/docs/rasa/next/conversation-driven-development/
- Rasa Conversation Review documenta el uso de historial, tags y revisión por turnos para detectar fallos de diseño, alcance o enrutamiento en conversaciones reales: https://rasa.com/docs/rasa/conversation-driven-development/
- Microsoft Bot Framework recomienda diseñar conversaciones alrededor de la intención del usuario y la progresión natural del diálogo, evitando experiencias rígidas tipo formulario: https://learn.microsoft.com/azure/bot-service/bot-builder-concept-conversation-flow

## Decisiones de producto

1. Lórren solo se presenta como “Lórren, asistente de selección de LoginPro” cuando el candidato pregunta directamente por su nombre, identidad o si es bot.
2. La memoria manual del panel dev se guarda como aprendizajes curados y se inyecta como contexto, no como frases literales para repetir.
3. La respuesta debe considerar intención, momento del proceso, historial y estado curado del candidato antes de pedir datos.
4. Si no hay una respuesta útil, el motor puede no responder y dejar que el flujo avance sin insistencia robotizada.
5. Se bloquea explícitamente la frase quemada “Ya tengo la información principal; voy a revisar el siguiente paso del proceso”.
6. Los recordatorios de proceso pendiente deben ser contextuales: pedir solo los datos o la HV que falten, sin reiniciar el flujo ni sonar como formulario.
7. El recordatorio de entrevista se envía 40 minutos antes; respuestas breves como “sí”, “claro” o “listo” se interpretan como confirmación solo cuando existe contexto de recordatorio/entrevista activa.
8. Si faltan 5 minutos para la entrevista y el candidato no respondió al recordatorio, la entrevista pasa a `NO_RESPONSE`; si respondió, se interpreta la intención (confirma, cancela o solicita reagendar).
