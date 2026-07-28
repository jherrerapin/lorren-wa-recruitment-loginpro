# Biometría local del Portal del Auxiliar

## Objetivo

Añadir una barrera antifraude de bajo costo al registro de llegada y salida sin contratar una API biométrica por transacción.

La función se activa por auxiliar únicamente después de una inscripción facial supervisada. Un auxiliar sin inscripción conserva el flujo de asistencia anterior.

## Componentes

### En el celular

`@vladmandic/human` 3.3.6 ejecuta mediante WebGL y usa CPU como respaldo. Solo se cargan:

- BlazeFace para detectar el rostro;
- FaceMesh e Iris para ubicación y movimiento;
- FaceRes para el descriptor facial;
- AntiSpoof para la señal `real`;
- Liveness para la señal `live`.

No se cargan modelos de cuerpo, manos, objetos, edad, género ni emociones.

El navegador solicita un puente local en `src/public/vendor/human/human.js`. Ese puente carga desde jsDelivr la versión fija `3.3.6` del runtime y sus modelos, y fuerza `modelBasePath` al mismo origen versionado. El procesamiento continúa ocurriendo en el celular; Railway no instala ni ejecuta la librería facial.

### En el servidor

El servidor:

- emite un desafío aleatorio con vigencia de dos minutos;
- vincula el desafío con auxiliar, asignación, tipo de marcación e idempotencia;
- firma el desafío con HMAC-SHA256;
- compara el descriptor capturado con la plantilla inscrita;
- conserva únicamente puntajes, señales y hashes para auditoría;
- envía a revisión cualquier resultado dudoso.

### En PostgreSQL

Los triggers de la migración `20260728033000_enforce_worker_biometric_review` impiden que una marcación de un auxiliar inscrito quede autovalidada cuando:

- no existe evaluación biométrica;
- el desafío es inválido o venció;
- la vivacidad o anti-spoof quedan por debajo del umbral;
- el rostro no coincide;
- se detecta repetición exacta del descriptor.

La marcación no se elimina ni se rechaza: queda como `REVIEW_REQUIRED`.

## Inscripción

La inscripción se realiza desde `Activar Portal del Auxiliar`:

1. seleccionar el auxiliar contratado;
2. confirmar la autorización;
3. capturar tres muestras frontales estables;
4. validar una sola cara, posición, tamaño, anti-spoof y vivacidad;
5. promediar y normalizar los descriptores;
6. cifrar la plantilla mediante AES-256-GCM.

Al actualizar o revocar una inscripción, el material cifrado anterior se elimina de los eventos históricos. Se conserva únicamente la trazabilidad de que ocurrió la acción.

## Configuración

Variable recomendada:

```text
ATTENDANCE_BIOMETRIC_SECRET=<secreto aleatorio de al menos 32 caracteres>
```

Si no existe, se reutiliza `ATTENDANCE_INSTALLATION_PEPPER`. Para separar responsabilidades criptográficas se recomienda configurar una variable independiente antes de realizar la primera inscripción.

El secreto no debe cambiarse mientras existan plantillas activas. Si debe rotarse, primero deben revocarse o migrarse las inscripciones.

## Costos

No existe pago por consulta ni dependencia de AWS, Azure u otro proveedor biométrico. El costo operativo se concentra en:

- descarga inicial del runtime y los modelos al celular;
- CPU/GPU del dispositivo durante la captura;
- una plantilla cifrada por auxiliar;
- fotografía de evidencia según la política de asistencia;
- eventos de auditoría pequeños.

Railway no ejecuta los modelos de inteligencia artificial en esta versión. La primera carga biométrica requiere conectividad hacia jsDelivr; posteriormente el navegador puede reutilizar su caché HTTP.

## Limitaciones de seguridad

Esta solución usa una cámara RGB normal y modelos ejecutados en un navegador controlado por el usuario. Aumenta la dificultad del fraude, pero no equivale a una prueba de vida certificada con sensores de profundidad o infrarrojos.

La decisión no debe basarse únicamente en biometría. Lórren combina:

- dispositivo activado;
- geocerca y precisión GPS;
- desafío activo;
- anti-spoof y vivacidad;
- similitud facial;
- fotografía de evidencia;
- idempotencia;
- revisión humana.

La primera etapa debe observar falsos positivos y falsos negativos con celulares reales antes de endurecer umbrales. Los fallos biométricos se envían a revisión y no bloquean automáticamente el registro laboral.

## Privacidad

La plantilla facial es un dato biométrico sensible. Antes de utilizar la función en producción deben estar vigentes:

- autorización expresa e informada del auxiliar;
- finalidad específica de control de asistencia y prevención de fraude;
- alternativa no biométrica y procedimiento de revisión;
- política de retención y eliminación;
- control de acceso administrativo;
- procedimiento para revocar la autorización.

El texto de consentimiento y la política jurídica deben ser aprobados por la empresa responsable del tratamiento. La implementación técnica no sustituye esa validación.
