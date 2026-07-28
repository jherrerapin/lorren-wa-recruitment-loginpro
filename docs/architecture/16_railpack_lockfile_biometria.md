# Corrección de instalación biométrica en Railpack

Railway usa Railpack para construir el servicio. El paquete biométrico fue agregado a `package.json`, pero el `package-lock.json` existente todavía no lo incluía. Una instalación congelada con `npm ci` falla cuando ambos archivos no coinciden.

`railpack.json` conserva la instalación reproducible mediante dos pasos:

1. `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` sincroniza el lockfile dentro de la imagen de construcción.
2. `npm ci --ignore-scripts --no-audit --no-fund` instala exactamente el árbol ya sincronizado.

El paquete `@vladmandic/human@3.3.6` no declara dependencias de producción adicionales, por lo que la sincronización solo agrega su entrada bloqueada. Los scripts permanecen desactivados durante la instalación; los modelos se copian después mediante el script de build del proyecto.
