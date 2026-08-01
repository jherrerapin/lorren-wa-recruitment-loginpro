# Sesión del Portal del Auxiliar al abrir la PWA

La aplicación instalada inicia mediante una nueva navegación GET desde el sistema operativo. La cookie de sesión debe conservar las protecciones `Secure`, `HttpOnly` y host-only, pero usar `SameSite=Lax` para que también viaje en esa navegación superior.

`SameSite=Strict` puede omitir la cookie en la primera solicitud iniciada desde el icono del sistema y provocar que el servidor renderice `Acceso no activo`, aunque la misma sesión funcione en la pestaña donde se activó.

Las acciones que modifican asistencia siguen protegidas mediante métodos POST, validación de sesión, encabezado `X-Requested-With`, geocerca, idempotencia y validación biométrica. `SameSite=Lax` no envía la cookie en solicitudes cruzadas de subrecursos ni en métodos cruzados no seguros.
