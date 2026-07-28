# Desbloqueo temporal de instalación biométrica

Railway estaba ejecutando `npm ci --omit=dev` porque detectaba un `package-lock.json` heredado. Ese archivo no contenía `@vladmandic/human@3.3.6`, aunque la dependencia ya estaba declarada en `package.json`, por lo que npm detenía la construcción antes del build.

Se retira temporalmente el lockfile desactualizado. Sin ese archivo, el constructor resuelve las dependencias declaradas mediante la instalación normal de npm. La versión biométrica permanece fijada exactamente en `3.3.6`.

Después de estabilizar el despliegue debe regenerarse un `package-lock.json` completo con `npm install`, validarlo y volver a incluirlo para recuperar instalaciones estrictamente reproducibles.
