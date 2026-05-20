# Railway redeploy — 2026-05-20

## Motivo

Se crea este commit operativo para forzar un nuevo despliegue en Railway después de que el ajuste de separación de ciudades por origen ya quedó mezclado en `main`, pero no fue tomado por el despliegue anterior.

## Cambio esperado ya incluido en `main`

- `City.sourceModule` clasifica ciudades como `RECRUITMENT`, `DISPATCH` o `ADMIN`.
- El panel de ciudades separa visualmente las ciudades del bot/reclutamiento, despacho y administración.
- El CRUD permite crear y editar el origen de cada ciudad.
- La migración `20260520013000_add_city_source_module` agrega el campo e índice requeridos.

## Validación posterior al despliegue

1. Entrar al panel administrativo.
2. Abrir `/admin/locations`.
3. Verificar las secciones `Bot / Reclutamiento`, `Despacho` y `Administración`.
4. Crear una ciudad con origen `Despacho`.
5. Confirmar que aparece en el apartado de `Despacho` y no mezclada con las ciudades del bot.
