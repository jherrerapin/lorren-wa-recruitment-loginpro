# Integración Operaciones / Despacho con LoginPro

## Estado actual

El panel principal sigue siendo `lorren-wa-recruitment-loginpro`.

`opera-dispatch` queda anclado como módulo externo desde la ruta DEV-only:

```text
/admin/operaciones
```

La ruta muestra un botón hacia el despliegue web de Opera Dispatch usando la variable:

```env
DISPATCH_MODULE_URL=https://url-de-opera-dispatch-web
```

## Ya implementado

- Acceso visible solo para perfil DEV.
- Ruta protegida con rechazo para usuarios no DEV.
- Botón externo configurado por `DISPATCH_MODULE_URL`.
- Pruebas de contrato para evitar exposición accidental a reclutadores.
- Documentación de QA y regresión.
- Opera Dispatch desplegado como módulo externo temporal.
- Opera Dispatch API con healthcheck activo.
- Opera Dispatch Web accesible desde el botón del panel del bot.

## Decisiones vigentes

- No fusionar todavía los repositorios.
- No copiar código de Opera Dispatch dentro del bot.
- No mezclar Prisma schemas todavía.
- No compartir base de datos todavía.
- No duplicar usuarios como decisión final de producto.
- El bot conserva WhatsApp Cloud API para reclutamiento.
- Dispatch conserva contacto manual asistido por WhatsApp para operación.

## Límite actual

Opera Dispatch aún puede mostrar su propio login interno. Ese login se mantiene como barrera temporal y no debe entenderse como la integración final.

La integración final debe evitar doble login o resolverlo mediante una estrategia controlada.

## Opciones futuras de autenticación

1. Token interno firmado desde LoginPro hacia Opera Dispatch.
2. Sesión compartida controlada por dominio.
3. Migración gradual de pantallas de Dispatch hacia el panel LoginPro.
4. Unificación posterior de identidad sobre `AppUser` del bot.

No se debe eliminar la autenticación de Dispatch sin reemplazo seguro.

## Qué no se debe hacer todavía

- Ejecutar seed productivo de usuarios duplicados sin decisión de identidad.
- Abrir dashboard de Dispatch sin validación.
- Exponer el módulo a reclutadores.
- Exponerlo a clientes.
- Tocar FSM del bot por esta integración.
- Tocar webhook de WhatsApp por esta integración.
- Migrar datos entre bases sin diseño.

## Validación manual

1. Iniciar sesión en LoginPro como DEV.
2. Entrar a `/admin/operaciones`.
3. Confirmar que aparece el botón de despacho.
4. Abrir el botón.
5. Confirmar que carga Opera Dispatch Web.
6. Confirmar que un reclutador no ve el enlace.
7. Confirmar que un reclutador no puede entrar manualmente a `/admin/operaciones`.

## Próximo paso recomendado

Definir la estrategia de autenticación entre LoginPro y Opera Dispatch antes de usar el módulo con datos reales.
