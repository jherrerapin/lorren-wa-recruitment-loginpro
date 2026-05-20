# Railway redeploy — 2026-05-20

## Motivo

Se crea este cambio operativo mediante PR para forzar un nuevo despliegue en Railway después de que los ajustes de ciudades quedaron mezclados en `main`, pero no fueron visibles en producción.

## Cambio esperado ya incluido en `main`

- `City.sourceModule` clasifica ciudades únicamente como `RECRUITMENT` o `DISPATCH`.
- El panel de ciudades separa visualmente las ciudades del bot/reclutamiento y las ciudades de despacho.
- La etiqueta `Administración` fue eliminada porque no tiene uso operativo claro.
- El CRUD permite crear y editar el origen de cada ciudad usando solo dos opciones: `Bot / Reclutamiento` o `Despacho`.
- La migración `20260520071500_remove_admin_city_source` convierte cualquier ciudad antigua con origen `ADMIN` a `RECRUITMENT` y elimina ese valor del enum.

## Validación posterior al despliegue

1. Entrar al panel administrativo.
2. Abrir `/admin/locations`.
3. Verificar que solo existan las secciones `Bot / Reclutamiento` y `Despacho`.
4. Crear una ciudad con origen `Despacho`.
5. Confirmar que aparece en el apartado de `Despacho` y no mezclada con las ciudades del bot.
6. Confirmar que no aparece la opción `Administración` al crear o editar ciudades.
