# Inventario de compatibilidad HTTP heredada

## Propósito

Este inventario separa código comprobablemente inútil de compatibilidad que todavía
puede tener consumidores. Retirar una función sin efecto no autoriza a eliminar rutas
históricas.

## Retiro seguro realizado

`injectMetaAdsSyncButton()` devolvía exactamente el mismo HTML recibido y se ejecutaba
desde el wrapper global de `res.send()`. Se elimina la función y su única llamada. El
resultado de cada respuesta permanece idéntico porque no existía transformación.

El wrapper conserva `shouldReplaceLorenV2UiLabel()` y `replaceLorenV2UiLabel()`. El
wrapper de `res.render()` conserva la inyección de scripts de asignación y
`injectLorenV2NavbarLink()`.

## Rutas preservadas

| Método | Ruta histórica | Código | Destino actual |
| --- | --- | ---: | --- |
| GET | `/admin/v2` | 301 | `/admin/estadisticas` |
| GET | `/admin/v2/campaigns` | 301 | `/admin/estadisticas/campaigns` |
| GET | `/admin/v2/campaigns/:id` | 301 | detalle equivalente de estadísticas |
| POST | `/admin/v2/campaigns` | 308 | creación equivalente de estadísticas |
| POST | `/admin/v2/campaigns/associate` | 308 | asociación equivalente de estadísticas |
| POST | `/admin/v2/campaigns/:id/edit` | 308 | edición equivalente de estadísticas |
| GET | `/admin/v2/reports` | 301 | `/admin/estadisticas` |
| GET | `/admin/v2/daily-summary` | 301 | `/admin/estadisticas` |
| GET | `/admin/v2/data-consents` | 301 | `/admin/estadisticas` |
| GET | `/admin/v2/cv-analysis` | 301 | `/admin/estadisticas/cv-analysis` |

Estas rutas permanecen activas hasta contar con evidencia de ausencia de tráfico,
referencias internas, enlaces guardados o integraciones externas. Su retiro deberá ser
un PR independiente con ventana de observación y rollback explícito.

## Fuera de alcance

No se renombran módulos `lorenV2*`, no se modifican Meta Ads, sesiones, autenticación,
permisos, dashboard, webhook, Prisma, migraciones, textos visibles ni lógica relacionada
con género.
