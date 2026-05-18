# Estrategia de autenticación LoginPro + Opera Dispatch

## Objetivo

Definir cómo debe evolucionar la autenticación entre el panel principal de LoginPro y el módulo Opera Dispatch sin romper el bot de reclutamiento ni duplicar accesos de forma definitiva.

## Estado actual

- LoginPro es el panel principal.
- Opera Dispatch está anclado desde `/admin/operaciones`.
- Solo el perfil DEV puede ver y abrir el módulo.
- La URL del módulo se configura con `DISPATCH_MODULE_URL`.
- Opera Dispatch conserva su propio login interno como barrera temporal.

## Problema a resolver

La experiencia actual puede mostrar dos accesos:

1. LoginPro para entrar al panel principal.
2. Opera Dispatch para entrar al módulo operativo.

Esto no debe ser la experiencia final si el módulo queda integrado al dashboard del bot.

## Decisión recomendada

La opción recomendada para la siguiente fase es un token interno firmado desde LoginPro hacia Opera Dispatch.

Flujo propuesto:

1. Usuario DEV inicia sesión en LoginPro.
2. LoginPro valida que el usuario tiene rol DEV.
3. LoginPro genera un token interno de corta duración para abrir Dispatch.
4. El enlace hacia Dispatch incluye el token o usa una ruta puente segura.
5. Opera Dispatch valida el token con un secreto compartido entre servicios.
6. Opera Dispatch crea una sesión temporal de módulo o permite el acceso interno correspondiente.

## Por qué esta opción

- No requiere fusionar repositorios todavía.
- No requiere compartir base de datos todavía.
- No elimina la seguridad del backend de Dispatch.
- Mantiene a LoginPro como punto principal de entrada.
- Evita depender de usuarios seed como experiencia final.
- Permite limitar el acceso solo a DEV o a roles definidos después.

## Variables futuras probables

En LoginPro:

```env
DISPATCH_MODULE_URL=https://url-de-opera-dispatch-web
DISPATCH_INTEGRATION_SECRET=secreto-largo-compartido
DISPATCH_TOKEN_EXPIRES_SECONDS=300
```

En Opera Dispatch:

```env
LOGINPRO_INTEGRATION_SECRET=secreto-largo-compartido
LOGINPRO_ALLOWED_ORIGIN=https://url-de-loginpro
```

## Reglas de seguridad

- El token debe tener expiración corta.
- El token no debe exponer credenciales reales.
- El token debe incluir rol, origen y timestamp.
- Opera Dispatch debe rechazar tokens expirados o inválidos.
- El acceso debe seguir limitado a DEV hasta definir roles operativos.
- No se debe abrir el dashboard de Dispatch sin validación.
- No se deben guardar secretos en el repositorio.

## Lo que no se hará todavía

- No fusionar los repositorios.
- No mezclar schemas Prisma.
- No compartir `DATABASE_URL` entre ambos sistemas.
- No eliminar el login interno de Dispatch sin reemplazo seguro.
- No tocar WhatsApp Cloud API.
- No tocar FSM del bot.
- No cambiar reglas de reclutamiento.

## Fases propuestas

### Fase 1: integración visual completa

Estado actual casi completo.

- `/admin/operaciones` solo DEV.
- `DISPATCH_MODULE_URL` configurado.
- Apertura en misma pestaña.
- Opera Dispatch desplegado.

### Fase 2: token puente DEV-only

- Crear ruta en LoginPro para generar token corto.
- Crear endpoint o middleware en Dispatch para validar token.
- Mantener acceso solo DEV.
- No tocar datos productivos.

### Fase 3: roles operativos reales

- Definir si coordinador operativo, supervisor o admin salen de `AppUser`, de Dispatch o de un modelo unificado.
- Definir si cliente accede desde Dispatch o desde LoginPro.

### Fase 4: integración profunda opcional

- Evaluar migración de pantallas.
- Evaluar sesión compartida.
- Evaluar unificación de usuarios.
- Evaluar unificación parcial de datos si el producto lo exige.

## Validación antes de implementar Fase 2

Antes de escribir código de token puente:

- Confirmar que LoginPro y Dispatch están en Railway en el mismo entorno.
- Confirmar dominios públicos reales de ambos servicios.
- Confirmar que Dispatch no debe ser visible para reclutador normal.
- Confirmar si el primer acceso será solo DEV o también coordinador operativo.
- Confirmar duración deseada del token.

## Decisión operativa actual

Hasta implementar Fase 2, la integración se mantiene como anclaje seguro DEV-only por URL externa. El bot de reclutamiento no debe cambiar por esta integración.
