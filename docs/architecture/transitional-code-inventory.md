# Inventario de código transitorio

Relacionado con #578, #570 y #421.

## Propósito

Este inventario convierte los feature flags y aliases temporales en deuda explícita y verificable. No cambia el runtime. Su función es impedir que un camino paralelo aparezca, desaparezca o cambie de responsabilidad sin una modificación revisable del inventario y sus pruebas.

La limpieza es una condición previa para convertir Lórren en SaaS multitenant. Añadir `tenantId` sobre caminos duplicados multiplicaría las autoridades, los fallbacks y los riesgos de acceso cruzado.

La fuente canónica es:

- `config/transitional-code-inventory.json`
- `test/transitionalCodeInventory.test.js`

## Estados

| Estado | Significado |
| --- | --- |
| `ACTIVE` | Capacidad estable sin plan actual de retiro. |
| `TRANSITIONAL` | Coexiste temporalmente con otro camino y tiene una condición concreta de consolidación. |
| `RETIRABLE` | La condición de retiro ya fue demostrada y existe evidencia explícita. |
| `BLOCKED` | No puede activarse, consolidarse o retirarse con seguridad porque falta una decisión o evidencia. |

Marcar una entrada como `RETIRABLE` exige pruebas existentes y `retirementEvidence`. El scanner falla si solo se cambia la etiqueta.

## Hallazgos actuales

### Orquestación conversacional

`USE_CONVERSATION_ENGINE` es transitorio y no pertenece todavía a la autoridad central de `featureFlags.js`. Selecciona entre el motor extraído y lógica legacy del webhook. Debe mantenerse hasta demostrar paridad por replays y elegir una sola autoridad del turno.

`FF_RESPONSES_EXTRACTOR` también es transitorio, pero ya tiene un default canónico. Responses API es el camino principal y el parser legacy permanece como rollback.

`FF_POLICY_LAYER` está bloqueado: antes de activarlo o retirarlo debe definirse si será la autoridad de política o si será absorbido por el orquestador.

### Procesamiento asíncrono

`FF_POSTGRES_JOB_QUEUE` y `FF_ASYNC_ADMIN_MEDIA_FORWARD` no deben considerarse solución SaaS definitiva mientras la cola, deduplicación, ownership y observabilidad no estén aislados por tenant.

### Adjuntos

`FF_ATTACHMENT_ANALYZER` sigue siendo transitorio hasta consolidar consentimiento, clasificación, almacenamiento y revisión manual detrás de un único caso de uso.

### Aliases del webhook

No quedan aliases puros inventariados en `src/routes/webhook.js`. La prueba consolidada bloquea su reaparición y exige llamadas directas a las autoridades canónicas.

## Retiros completados

### `buildDataRequestPrompt()` — #663

La auditoría encontró una sola definición, dos consumidores directos y ninguna referencia indirecta. Ambos consumidores invocan ahora `buildCandidateDataCollectionMessage()`, la autoridad existente en `readinessGuard.js`.

No cambian el texto, el orden ni las reglas del mensaje de recolección; se elimina únicamente el último nombre intermedio del webhook.

### `formatFieldList()` — #661

El alias se retiró porque solo reenviaba los mismos argumentos a `formatFieldListForVacancy()` y tenía un único consumidor. El formateador real permanece sin cambios.

En el mismo slice se consolidaron las pruebas de aliases retirados y se eliminó un archivo de prueba duplicado con una expectativa obsoleta.

### `getRequiredFieldKeys()` — #658

El alias se retiró porque solo reenviaba la vacante a `getRequiredCandidateFieldKeys()`. Todos sus consumidores usan ahora directamente la autoridad de campos requeridos definida en `readinessGuard.js`.

No cambian los campos exigidos, su orden ni la configuración dinámica por vacante; se elimina únicamente un nombre intermedio.

### Cadena `getMissingFields()` / `getMissingFieldsForVacancy()` — #656

Ambos aliases se retiraron porque no añadían política ni transformación. Todos los consumidores del webhook invocan directamente `getMissingFieldLabels(candidate, vacancy)`, la autoridad existente en `readinessGuard.js`.

El cambio conserva las mismas etiquetas y el mismo orden de campos faltantes; únicamente elimina dos nombres intermedios y la cadena local entre ellos.

### `FF_SEMANTIC_SHORT_MEMORY` — #651

El flag se retiró porque no existía ningún consumidor productivo, ruta de configuración, worker, persistencia ni caso de uso que leyera su valor. Solo estaba declarado en `featureFlags.js`, proyectado por `getHardeningFlags()` y repetido en pruebas y documentación.

Una variable externa con ese nombre no podía alterar el runtime. Su eliminación reduce configuración fantasma sin introducir ni retirar una capacidad real de memoria. Los documentos históricos de hardening conservan la referencia como registro de la fase en la que el flag fue propuesto; este inventario representa el estado vigente.

## Qué bloquea CI

La prueba falla cuando:

- aparece en `src` un flag `FF_*` o un selector `USE_*ENGINE*` no inventariado;
- desaparece un flag inventariado o cambia de ruta sin actualizar el contrato;
- un default canónico difiere del inventario;
- una ruta de definición, consumo, configuración o prueba deja de existir;
- falta estado, propietario, propósito o condición de retiro;
- una entrada se marca `RETIRABLE` sin evidencia;
- un alias inventariado desaparece, apunta a un target inexistente o deja de ser puro sin reclasificación;
- un alias ya retirado reaparece en el webhook o vuelve a registrarse en el inventario.

## Orden de limpieza después de este inventario

1. Eliminar la política global de edad del webhook y usar la configuración de cada vacante (#642).
2. Retirar configuración fantasma sin consumidores, comenzando por `FF_SEMANTIC_SHORT_MEMORY` (#651).
3. Consolidar extractor, política y motor conversacional en una sola interpretación y un solo plan por turno.
4. Extraer autenticación, sesión, administración y adaptación de webhook fuera de los monolitos.
5. Diseñar `TenantContext` y la migración del tenant inicial LoginPro.
6. Introducir aislamiento de datos, archivos, campañas, jobs, cachés, sesiones y observabilidad por tenant antes de incorporar un segundo cliente.

## Regla de evolución

Cada retiro futuro debe citar la entrada correspondiente, demostrar que su `retirementCondition` se cumplió, mantener CI y replays en verde y evitar mezclar limpieza de legado con migraciones multitenant.
