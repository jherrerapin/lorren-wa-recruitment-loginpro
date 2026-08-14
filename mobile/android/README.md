# Lórren · Portal del Auxiliar para Android

Esta carpeta contiene la primera fase de la aplicación Android privada del **mismo Portal del Auxiliar**. No crea un segundo backend de asistencia ni reemplaza las autoridades del servidor.

## Qué hace esta fase

- abre el Portal del Auxiliar existente dentro de un WebView de origen HTTPS controlado;
- acepta una transferencia temporal de sesión por `lorren://portal/transferencia?...` y deja que el endpoint canónico del Portal rote el token y coloque la nueva cookie;
- conserva las capacidades web ya existentes del Portal, incluido almacenamiento local, cámara y geolocalización;
- genera en Android Keystore una clave EC P-256 no exportable para firmar respuestas de presencia;
- usa Google Nearby Connections con `P2P_STAR` para que un encargado descubra varios teléfonos Lórren cercanos sin Internet;
- permite que un auxiliar deje su app en estado `Listo para asistencia` y responda un challenge local firmado;
- muestra en el Portal un panel de prueba con el conteo de teléfonos cuya firma local fue verificada.

**Esta fase no registra asistencia.** El puente nativo declara `attendanceWriter: false`, el JavaScript nativo no llama endpoints de llegada y una prueba de contrato protege esa barrera.

## Qué no hace

- no instala ningún beacon o equipo Bluetooth en una operación;
- no necesita Play Store;
- no contiene APK, AAB, keystore ni clave de firma dentro del repositorio;
- no detecta teléfonos si el sistema cerró por completo la aplicación;
- no identifica a una persona únicamente por el nombre Bluetooth o por RSSI;
- no marca como presente a un teléfono cuya identidad todavía no esté provisionada por el servidor;
- no implementa todavía iPhone, almuerzo grupal ni salida grupal.

## Requisitos de desarrollo

- Android Studio compatible con Android Gradle Plugin 9.3.0;
- JDK 17;
- Android SDK 37 instalado;
- un teléfono Android con Google Play services para las pruebas de Nearby Connections;
- un origen HTTPS del Portal del Auxiliar.

No hay una URL productiva quemada en el proyecto. El origen se entrega al compilar mediante la propiedad Gradle `lorrenPortalBaseUrl`.

Ejemplo con Gradle instalado localmente:

```bash
gradle :app:assembleDebug \
  -PlorrenPortalBaseUrl=https://portal.example.invalid
```

El valor del ejemplo es deliberadamente inválido. Para una compilación de prueba debe sustituirse por el origen HTTPS autorizado del Portal.

El APK debug se genera normalmente en:

```text
app/build/outputs/apk/debug/app-debug.apk
```

La firma de una versión release debe realizarla el propietario con una clave fuera del repositorio. Los patrones `*.jks`, `*.keystore`, `*.apk` y `*.aab` están ignorados.

## Flujo de sesión

Chrome y el WebView no comparten cookies. Por eso no se copia una cookie ni un token de sesión manualmente.

El flujo previsto reutiliza `workerPortalSessionHandoff.js`:

1. el Portal autenticado crea un token de transferencia temporal;
2. Android abre `lorren://portal/transferencia?transferencia=<token>`;
3. la app carga dentro de su WebView `/operaciones/portal/sesion-transferencia/continuar`;
4. el servidor valida el token, rota la sesión y coloca la nueva cookie segura en el WebView;
5. la URL final ya no conserva el token temporal.

La integración del botón de descarga/apertura automática pertenece a la fase de distribución privada. Esta fase implementa el receptor y no escribe el token en logs.

## Flujo local sin Internet

Prueba mínima prevista con tres Android reales:

1. Instalar la misma build en los tres teléfonos.
2. Abrir el Portal con conexión al menos una vez para que cada teléfono tenga sesión y contexto de cuadrilla almacenado.
3. En los dos auxiliares, abrir Lórren y pulsar **Quedar listo para asistencia**.
4. Desactivar datos móviles/Internet manteniendo Bluetooth y las radios locales habilitadas.
5. En el teléfono marcado como encargado, abrir Lórren y pulsar **Comprobar teléfonos cercanos**.
6. El encargado genera un `attemptId` y un `challenge` nuevos y descubre los auxiliares mediante Nearby Connections.
7. Cada auxiliar responde con su clave pública y una firma ECDSA del challenge específico del intento.
8. El encargado verifica la firma local y cuenta únicamente respuestas válidas.
9. Al terminar debe mostrar el número verificado y el mensaje **Ninguna asistencia fue registrada**.
10. Verificar en el backend que la prueba no creó `DispatchAttendanceMark` ni alteró una sesión de asistencia.

Antes de habilitar una marcación automática deben probarse físicamente como mínimo tres Android y completar la fase de credencial server-side que vincula la clave pública con el `DispatchWorkerDevice` autorizado.

## Seguridad de esta fase

La clave privada se crea con `AndroidKeyStore` y solo se usa para firmar. Nunca se serializa ni se entrega al JavaScript. Nearby anuncia el nombre genérico `LORREN`; no anuncia nombre, documento o teléfono del trabajador.

Una firma local válida prueba que el mismo poseedor de esa clave respondió al challenge, pero **todavía no prueba quién es esa persona para Lórren**. Esa asociación se hará con una credencial firmada por el servidor en la siguiente fase. Hasta entonces, los proofs son únicamente evidencia para pruebas del transporte local.

## Rollback

Eliminar esta carpeta y su prueba de contrato retira la aplicación Android sin afectar la PWA, las sesiones del Portal, las asignaciones ni las autoridades de asistencia existentes. No hay migración de Prisma en esta fase.
