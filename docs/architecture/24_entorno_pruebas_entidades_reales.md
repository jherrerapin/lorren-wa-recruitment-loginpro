# Entorno de pruebas con entidades reales

## Objetivo

Permitir que DEV y usuarios ADMIN autorizados reproduzcan escenarios de asistencia y nómina utilizando auxiliares, clientes y operaciones existentes, sin modificar la operación real.

## Permiso

El permiso **Entorno de pruebas de asistencia y nómina** es independiente de:

- Operaciones / Despacho;
- Asistencia;
- Nómina y tiempo trabajado.

DEV tiene acceso automático. Solo DEV puede concederlo o retirarlo desde la administración de usuarios. Cada cambio se guarda en `DevAuditEvent` con `entityType = APP_USER_TEST_WORKSPACE_ACCESS`.

## Entidades permitidas

El entorno consulta:

- todos los clientes activos;
- todas las operaciones activas del cliente;
- todos los servicios activos del cliente;
- todos los auxiliares cuyo estado no sea `ELIMINADO`.

Los campos `isTestClient` e `isTestProfile` se muestran como información, pero ya no restringen la selección.

## Frontera de aislamiento

Las entidades reales se usan únicamente como referencia. Los registros creados mantienen obligatoriamente:

- solicitud: `source = DEV_TEST`;
- estado de solicitud: `DEV_TEST_PENDING`, `DEV_TEST_PARTIAL` o `DEV_TEST_COMPLETE`;
- asignación: `DEV_TEST_ASSIGNED` o `DEV_TEST_CONFIRMED`;
- sesión de asistencia: `source = DEV_TEST_MANUAL`;
- marcas manuales: `riskFlags = [DEV_TEST_MANUAL]`.

No se modifica:

- `isTestProfile` ni `operationalStatus` del auxiliar;
- la disponibilidad operativa del auxiliar;
- asignaciones reales;
- marcaciones reales;
- estados operativos;
- compensatorios operativos.

La barrera Prisma permite un auxiliar real en una solicitud `DEV_TEST` únicamente cuando el estado de la asignación también pertenece a `DEV_TEST_*`. Sigue rechazando estados como `CONFIRMATION_PENDING` o `CONFIRMED`.

## Cálculo

El resultado se calcula dentro del propio entorno usando únicamente las sesiones `DEV_TEST_MANUAL` de la solicitud seleccionada. Un usuario con solo este permiso no necesita abrir Nómina operativa.

El cálculo reutiliza:

- la política de jornada del cliente;
- el motor oficial de conceptos;
- el límite diario y semanal vigente;
- el umbral mínimo de horas extra;
- la clasificación diurna, nocturna, dominical y festiva.

No se leen ni escriben compensatorios operativos para el cálculo aislado.

## WhatsApp

La vinculación y el envío desde la segunda cuenta de WhatsApp permanecen restringidos a DEV. Los usuarios habilitados pueden probar solicitudes, asignaciones y jornadas manuales, pero no controlar una sesión de WhatsApp vinculada.

## Eliminación de una prueba

Al retirar una asignación de prueba se eliminan únicamente:

- su sesión `DEV_TEST_MANUAL`;
- sus marcas de prueba;
- sus revisiones de prueba;
- sus confirmaciones pendientes de la cuenta secundaria;
- la asignación `DEV_TEST_*`.

El auxiliar real permanece intacto.
