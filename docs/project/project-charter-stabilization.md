# Acta del proyecto de estabilización de Lórren

**Estado:** Borrador para revisión  
**Fecha de inicio:** 2026-07-10  
**Repositorio:** `jherrerapin/lorren-wa-recruitment-loginpro`  
**Issue de seguimiento:** #380  
**Responsable del producto:** Jhon Herrera

## 1. Propósito

Estabilizar y profesionalizar Lórren sin interrumpir el servicio actual, reduciendo progresivamente los riesgos técnicos, operativos, de seguridad y de datos. El resultado debe ser un sistema mantenible, verificable, escalable y preparado para una futura evolución a SaaS.

## 2. Situación actual

El sistema presta servicio y contiene procesos funcionales de reclutamiento, agenda, mensajería, administración y despacho. Sin embargo, su crecimiento ha sido principalmente reactivo, con correcciones localizadas y deuda técnica acumulada.

La estrategia aprobada para esta iniciativa es una modernización incremental. No se realizará una reescritura total ni se introducirán microservicios durante la etapa inicial.

## 3. Objetivos

1. Crear una línea base funcional verificable y recuperable.
2. Introducir control de cambios mediante issues, ramas y pull requests.
3. Implementar pruebas, integración continua, staging y rollback.
4. Corregir primero los riesgos críticos de datos, disponibilidad, seguridad y privacidad.
5. Convertir gradualmente el código en un monolito modular.
6. Diseñar el aislamiento multiempresa solo después de alcanzar estabilidad operativa.

## 4. Alcance inicial

La primera etapa incluye:

- documentación del funcionamiento actual;
- smoke tests de procesos críticos;
- respaldo y restauración verificables;
- registro de riesgos;
- identificación del commit base;
- preparación de CI y staging;
- análisis y reconciliación posterior de Prisma/PostgreSQL;
- corrección progresiva de componentes críticos.

## 5. Fuera de alcance de la Fase 0

- cambios en el esquema de base de datos;
- ejecución de migraciones;
- modificación del webhook de Meta;
- cambios en prompts o decisiones del bot;
- eliminación de versiones antiguas de WhatsApp Web;
- cambios de autenticación o permisos;
- introducción de multi-tenant, planes o facturación;
- cambio de Express o reescritura del sistema.

## 6. Principios de trabajo

- `main` representa producción.
- Ningún trabajo nuevo se desarrolla directamente sobre `main`.
- Un PR debe resolver un solo problema.
- Los cambios de alto riesgo requieren staging, respaldo y rollback.
- Las migraciones serán compatibles hacia atrás y se realizarán por etapas.
- No se eliminará código antiguo hasta que el reemplazo haya sido probado y observado.
- No se usarán datos reales de candidatos en pruebas cuando puedan utilizarse datos ficticios.
- Toda afirmación de “probado” debe tener evidencia.

## 7. Roles

### Propietario del producto

Responsable de priorizar necesidades, validar procesos y aceptar resultados funcionales.

### Responsable técnico

Responsable de ramas, cambios, pruebas, documentación, despliegue y trazabilidad.

### Revisor independiente

Recomendado para migraciones destructivas, autenticación, autorización, privacidad, webhook, multiempresa y cambios que puedan producir pérdida o exposición de datos.

### Usuarios validadores

Personal de selección, operaciones y administración que valida que los procesos reales se conserven.

## 8. Gobierno del cambio

Todo cambio debe tener:

1. issue con problema y criterios de aceptación;
2. clasificación de riesgo;
3. rama independiente;
4. pull request;
5. pruebas automáticas y manuales según corresponda;
6. validación en staging;
7. plan de rollback;
8. evidencia posterior al despliegue.

## 9. Criterios de éxito de la estabilización

- backups restaurables;
- base de datos reproducible;
- CI obligatorio;
- staging independiente;
- smoke tests de procesos críticos;
- ausencia de hallazgos críticos abiertos;
- una implementación activa por integración crítica;
- trazabilidad de cambios y despliegues;
- observabilidad y runbooks operativos;
- módulos con responsabilidades claras;
- diseño multi-tenant probado antes de incorporar un segundo cliente.

## 10. Riesgos iniciales

Los riesgos se mantienen en `docs/project/risk-register.md`. Ningún riesgo se considera cerrado solamente porque el sistema esté desplegado; debe existir una verificación específica.

## 11. Fases

1. Línea base, respaldo y procesos críticos.
2. Gobierno de GitHub, CI y staging.
3. Pruebas de caracterización.
4. Reconciliación Prisma/PostgreSQL.
5. Corrección de riesgos P0.
6. Modularización incremental.
7. Operación, observabilidad y recuperación.
8. Preparación SaaS y aislamiento por tenant.

## 12. Aprobación

Este documento se considera aprobado cuando el PR correspondiente sea revisado y fusionado. La aprobación no autoriza todavía cambios de runtime ni migraciones.