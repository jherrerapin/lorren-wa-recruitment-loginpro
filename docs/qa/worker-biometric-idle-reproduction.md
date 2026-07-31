# Reproducción: degradación biométrica después de inactividad

> Documento temporal de diagnóstico. No cambia el comportamiento de producción.

## Síntoma

La validación facial funciona inmediatamente después del registro o al abrir el portal, pero puede dejar de concluir después de mantener el portal abierto, bloquear el teléfono, cambiar de aplicación o esperar hasta una marcación posterior como el inicio de almuerzo.

## Escenarios mínimos

1. Registrar rostro y marcar llegada inmediatamente.
2. Mantener el portal abierto y visible durante 30, 60 y 120 minutos.
3. Mantener el portal abierto, bloquear la pantalla durante 5 minutos y volver.
4. Cambiar a otra aplicación durante 5 minutos y volver.
5. Cerrar completamente el navegador, volver a abrir el portal y marcar.
6. Repetir cada escenario con llegada e inicio de almuerzo.

## Datos que deben observarse

- estado de la página: visible, hidden, frozen, resumed, discarded;
- backend de Human activo;
- estado de Human antes de detectar;
- tiempo de preparación del modelo;
- estado de la pista: readyState, muted, enabled;
- tiempo hasta el primer fotograma real;
- fase que agotó el tiempo: frontal inicial, desafío o frontal final;
- error exacto del servidor, si la verificación llegó a enviarse;
- duración total del intento.

## Criterio

No implementar cambios de umbral ni reintentos adicionales hasta distinguir entre:

- sesión vencida;
- cámara/pista sin fotogramas;
- página reanudada después de suspensión;
- contexto WebGL perdido;
- motor Human no recuperado;
- expiración del desafío;
- timeout compartido entre las tres fases.
