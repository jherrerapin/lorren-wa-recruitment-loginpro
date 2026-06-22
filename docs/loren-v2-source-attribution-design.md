# Loren V2 - Diseño de atribución de origen con IA

## Regla obligatoria

Loren V2 no debe detectar referidos por frases fijas, palabras quemadas, expresiones regulares ni listas de palabras.

## Orden profesional de decisión

1. Metadatos internos de Meta / WhatsApp.
2. IA estructurada solo cuando no exista metadata suficiente.
3. Revisión humana cuando la confianza sea baja o haya conflicto.

## Diseño recomendado

El fallback de IA debe vivir en el extractor estructurado existente, no en un detector paralelo.

El extractor debe devolver una sección `sourceAttribution` con:

- tipo de origen: desconocido, recomendado u otro;
- confianza numérica entre 0 y 1;
- nombre de la persona que recomienda, si existe;
- teléfono de la persona que recomienda, si existe;
- evidencia textual mínima.

## Umbral recomendado

Solo se debe guardar como referido si la confianza es igual o mayor a 0.78 y no existe ya una fuente más fuerte por metadata de campaña.

## Prioridad de fuentes

Una campaña atribuida por metadata de Meta tiene prioridad sobre una inferencia de IA.

## Auditoría

Cada decisión debe quedar en debugTrace para poder explicar por qué se clasificó o no se clasificó el origen.
