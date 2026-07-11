# Runbook de respaldo, restauración y rollback de Lórren

**Estado:** Procedimiento propuesto; pendiente de ensayo  
**Issue:** #380

## 1. Objetivo

Garantizar que un cambio pueda revertirse sin improvisación y que los datos puedan recuperarse en un ambiente aislado. Un archivo de respaldo no se considera válido hasta que una restauración haya sido ejecutada y verificada.

## 2. Alcance

Este procedimiento cubre:

- PostgreSQL;
- objetos y CV almacenados en R2;
- configuración de despliegue y lista de variables;
- sesión de WhatsApp Web de despacho;
- versión de aplicación;
- rollback de aplicación y migraciones compatibles.

No deben guardarse secretos dentro del repositorio ni adjuntarse en issues.

## 3. Responsabilidades

| Actividad | Responsable | Evidencia requerida |
|---|---|---|
| Crear respaldo | Jhon/operador autorizado | Fecha, tamaño, checksum y ubicación |
| Restaurar en ambiente aislado | Responsable técnico | Log de restauración redactado |
| Validar datos y aplicación | Producto + técnico | Smoke test y conteos |
| Autorizar cambio crítico | Producto + revisor | Aprobación en PR/issue |

## 4. Preparación

Antes de cualquier cambio de riesgo alto o crítico:

1. Confirmar el commit actualmente desplegado.
2. Confirmar el ambiente y la base de datos objetivo.
3. Detener tareas que puedan modificar masivamente datos durante la ventana, cuando corresponda.
4. Revisar espacio disponible y permisos.
5. Crear un directorio seguro fuera del repositorio.
6. Registrar fecha/hora UTC y zona `America/Bogota`.
7. Verificar que las credenciales se suministren mediante variables de entorno.

## 5. Respaldo PostgreSQL

### 5.1 Formato recomendado

Usar formato custom para permitir restauración selectiva:

```bash
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="lorren-YYYYMMDD-HHMM.dump" \
  "$DATABASE_URL"
```

No escribir `DATABASE_URL` directamente en el comando compartido, documentación o historial público.

### 5.2 Verificación inmediata

```bash
pg_restore --list "lorren-YYYYMMDD-HHMM.dump" > "lorren-YYYYMMDD-HHMM.contents.txt"
sha256sum "lorren-YYYYMMDD-HHMM.dump" > "lorren-YYYYMMDD-HHMM.sha256"
```

Registrar:

- tamaño;
- checksum;
- versión de PostgreSQL cliente;
- hora de inicio y fin;
- resultado del comando;
- commit desplegado.

## 6. Restauración de ensayo

### Prohibición

Nunca ejecutar la restauración de prueba contra la base de producción.

### Procedimiento

1. Crear una base PostgreSQL aislada y vacía.
2. Configurar una URL diferente a producción.
3. Restaurar:

```bash
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname="$RESTORE_DATABASE_URL" \
  "lorren-YYYYMMDD-HHMM.dump"
```

4. Comprobar que el comando termina sin errores no aceptados.
5. Ejecutar conteos de tablas principales.
6. Verificar relaciones y registros críticos con datos redactados.
7. Iniciar una instancia de la aplicación apuntando únicamente a la base restaurada.
8. Ejecutar el smoke test aplicable.
9. Destruir de forma segura el ambiente temporal cuando termine la verificación.

## 7. Comprobaciones mínimas de datos

Registrar conteos, sin publicar datos personales:

- candidatos;
- mensajes;
- vacantes;
- postulaciones;
- citas;
- solicitudes de despacho;
- auxiliares;
- asignaciones;
- trabajos de cola por estado;
- eventos de consentimiento;
- eventos de auditoría;
- referencias de archivos/CV.

También verificar:

- claves foráneas;
- índices importantes;
- tabla `_prisma_migrations`;
- sesiones activas, sin copiar su contenido;
- registros huérfanos relevantes.

## 8. Respaldo de R2

1. Enumerar objetos del bucket correspondiente.
2. Exportar inventario con clave, tamaño, fecha y ETag/checksum cuando esté disponible.
3. Copiar objetos a un bucket o ubicación de respaldo con acceso restringido.
4. Comprobar una muestra de descargas.
5. Verificar que las claves de objetos de la base restaurada existan en el inventario.
6. Aplicar cifrado, control de acceso y política de retención.

No utilizar un bucket público para el respaldo de CV.

## 9. Sesión de WhatsApp Web de despacho

La sesión puede contener credenciales operativas sensibles.

1. Identificar la única ruta de `LocalAuth` que realmente está activa.
2. Detener controladamente el proceso que usa la sesión antes de copiarla.
3. Copiar el directorio a almacenamiento cifrado y restringido.
4. Registrar versión de `whatsapp-web.js`, Chromium y sistema operativo.
5. No subir la sesión al repositorio, issues, artifacts públicos ni almacenamiento sin cifrar.
6. Probar la recuperación solamente en un ambiente controlado y evitando dos clientes simultáneos sobre la misma sesión.

## 10. Configuración e infraestructura

Conservar de manera segura:

- lista de nombres de variables de entorno;
- ambiente al que pertenece cada variable;
- servicio de Railway y configuración de arranque;
- dominios y webhooks configurados;
- bucket y endpoint de R2;
- identificadores no secretos de Meta;
- comandos de release, aplicación y worker;
- versiones de Node, Prisma y PostgreSQL.

Los valores secretos deben permanecer en un gestor de secretos o en la plataforma, no en este documento.

## 11. Rollback de aplicación

### Cambio sin migración

1. Seleccionar el último commit verificado.
2. Redeploy de esa versión.
3. Confirmar variables y servicios.
4. Ejecutar smoke test básico.
5. Registrar incidente y motivo del rollback.

### Cambio con migración compatible hacia atrás

1. Mantener la estructura nueva si la versión anterior la tolera.
2. Revertir la aplicación al commit verificado.
3. No eliminar columnas en la misma ventana.
4. Validar lecturas y escrituras.
5. Programar la corrección en un PR posterior.

### Cambio destructivo

No se autoriza durante la etapa inicial. Debe existir un plan específico, ensayo sobre copia de producción, respaldo validado y aprobación independiente.

## 12. Criterios de respaldo válido

Un respaldo se marca `VALIDADO` cuando:

- el archivo existe y tiene checksum;
- `pg_restore --list` lo puede leer;
- fue restaurado en una base aislada;
- la aplicación inició contra la restauración;
- los conteos y relaciones esperados fueron verificados;
- el smoke test mínimo pasó;
- la evidencia quedó registrada sin secretos ni PII.

## 13. Registro del ensayo

| Campo | Valor |
|---|---|
| Fecha del backup | Pendiente |
| Commit desplegado | Pendiente |
| Archivo/checksum | Pendiente, en ubicación segura |
| Fecha de restauración | Pendiente |
| Ambiente aislado | Pendiente |
| Resultado de restauración | Pendiente |
| Resultado de smoke test | Pendiente |
| Incidencias | Pendiente |
| Aprobación técnica | Pendiente |

## 14. Frecuencia futura recomendada

- respaldo automático diario de PostgreSQL;
- retención escalonada según política de datos;
- inventario periódico de R2;
- restauración de ensayo mensual;
- respaldo antes de todo cambio de base de datos de riesgo alto o crítico;
- revisión del runbook después de cada incidente o cambio de infraestructura.