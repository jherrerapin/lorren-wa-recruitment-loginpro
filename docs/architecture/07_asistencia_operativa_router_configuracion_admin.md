# Asistencia operativa: router de configuración administrativa

## Estado

Implementación relacionada con los issues #509 y #527. Consume la autoridad integrada en #522 y parte del `main` corregido por #524.

Esta entrega introduce únicamente el router administrativo aislado. Todavía no lo monta en `dispatchBridgeRouter` ni agrega el formulario visual; esas dos modificaciones quedan para el siguiente PR pequeño para evitar reescrituras amplias del módulo de Operaciones.

## Contrato previsto de montaje

```text
POST /admin/operaciones/clientes/:clientId/operaciones/:operationId/asistencia
```

El router se crea con `mergeParams: true` para recibir `clientId` y `operationId` desde la ruta padre. Cuando se monte, deberá quedar detrás de `requireOps`.

## Escritura

La ruta delega exclusivamente en:

```text
updateDispatchAttendancePointConfig(prisma, input)
```

No llama directamente a `dispatchOperationPoint.update`, `create` ni `upsert`. La autoridad conserva la validación de pertenencia cliente-punto, estado activo, geocerca, límites y catálogos.

## Booleanos de formulario

Los checkboxes futuros enviarán:

- un campo oculto `<nombre>Fallback=false`;
- el checkbox `<nombre>=true` únicamente cuando esté marcado.

El router rechaza valores ambiguos como `on`, `1`, `yes`, ausencia del fallback o arreglos. Después entrega a la autoridad solo las cadenas explícitas `true` o `false`.

## Errores

Los códigos internos conocidos se traducen a mensajes operativos. Los errores desconocidos devuelven un mensaje genérico y no exponen detalles de base de datos o implementación.

## Seguridad funcional

- no existe ruta pública de marcación;
- no se invoca `registerDispatchArrival`;
- no se modifica `DispatchAssignment.status`;
- no se activan puntos automáticamente;
- no se aplican migraciones;
- no se toca Railway.

## Pruebas

La suite específica cubre:

- checkbox marcado y desmarcado;
- rechazo de valores permisivos;
- traducción de errores conocidos;
- ocultamiento de errores desconocidos;
- `mergeParams`;
- delegación exclusiva en la autoridad;
- ausencia de marcación pública.

## Próximo PR

1. Importar y montar el router dentro de `dispatchBridgeRouter` detrás de `requireOps`.
2. Agregar la sección de formulario dentro de **Clientes → Operaciones**.
3. Usar `type="number"`, `min`, `max` y `step` coherentes con la autoridad.
4. Mantener la validación del servidor como autoridad definitiva.
5. Ejecutar CI y revisar visualmente la página antes de integrar.

## Rollback

Revertir los tres archivos nuevos. Al no existir montaje, no hay escritura alcanzable desde producción.
