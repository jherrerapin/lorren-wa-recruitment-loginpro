# Criterios para crear el GPT auditor de Lórren

Relacionado con: #421, #422 y #423.

## Decisión

El GPT interno de arquitectura y QA no se crea todavía. Primero se estabilizan las fuentes que deberá utilizar, para evitar duplicar reglas cambiantes o convertir decisiones provisionales en instrucciones permanentes.

## Propósito futuro

El GPT servirá exclusivamente para mantenimiento, supervisión, reestructuración y aumento de calidad del proyecto. No formará parte del runtime de candidatos ni será fuente de verdad de datos, estados o configuración.

## Capacidades previstas

- revisar propuestas contra la arquitectura aprobada;
- detectar responsabilidades duplicadas y autoridades paralelas;
- generar y revisar escenarios del corpus conversacional;
- verificar cumplimiento de multitenencia, consentimiento, idempotencia y observabilidad;
- asistir en onboarding y consulta de ADR;
- preparar listas de comprobación para PR;
- identificar desviaciones del comportamiento humano y contextual esperado de Lórren.

## Requisitos previos

Antes de construirlo deben existir y estar fusionados:

1. hoja de ruta modular y validación técnica;
2. contratos iniciales de `TenantContext`, `TurnUnderstanding` y `TurnPlan`;
3. corpus de regresión y formato de escenarios;
4. convenciones de código y revisión;
5. ADR principales;
6. política de actualización y versionado del conocimiento.

## Fuentes de conocimiento

El GPT consumirá copias versionadas de documentación del repositorio. Las reglas de comportamiento se mantendrán en sus instrucciones; la documentación, contratos y ADR se usarán como conocimiento de referencia.

## Gobierno

- propietario definido;
- versión vinculada a una revisión del repositorio;
- pruebas de aceptación antes de publicar cambios;
- acceso privado al equipo;
- ninguna capacidad de merge automático;
- acciones externas limitadas y auditables, si se habilitan posteriormente.

## Criterio de activación

Crear el GPT cuando los requisitos previos estén estables y el equipo necesite reutilizar el conocimiento fuera de este proyecto de ChatGPT. Hasta entonces, este proyecto continúa como centro de dirección técnica y GitHub como fuente de verdad.
