# Instalación biométrica con Nixpacks

El servicio de producción está configurado en Railway con el builder Nixpacks.

`package.json` incluye `@vladmandic/human@3.3.6`, mientras el lockfile heredado aún no contiene esa entrada. Nixpacks se configura para ejecutar:

```text
npm install --ignore-scripts --no-audit --no-fund
```

`npm install` incorpora la dependencia declarada en `package.json` sin rechazar el lockfile desactualizado. Los scripts de dependencias permanecen desactivados durante esta fase. Después, el script `build` de Lórren ejecuta `prepare:human` y copia solamente los modelos faciales requeridos.

Esta configuración es transitoria hasta que el `package-lock.json` pueda regenerarse y confirmarse completo. En ese momento puede restablecerse una instalación estricta con `npm ci`.
