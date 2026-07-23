# Asistencia operativa: mapa y parámetros protegidos del punto

## Estado

Implementación del issue #633. Continúa el Portal del Auxiliar integrado en #625.

## Problema resuelto

La configuración anterior obligaba a escribir latitud, longitud, radio de geocerca y precisión GPS. Un punto sin esos cuatro valores no podía habilitar la marcación y el Portal del Auxiliar mostraba `Marcación no habilitada`.

## Experiencia administrativa

En **Clientes → Operaciones → Configurar asistencia**, cada punto incorpora un mapa que permite:

- buscar una dirección mediante una acción explícita;
- usar la ubicación actual con permiso del navegador;
- tocar el mapa para seleccionar el punto;
- arrastrar el marcador hasta la entrada real de la operación;
- ver el círculo que representa el radio permitido.

Las coordenadas se conservan en campos ocultos y siguen validándose en el servidor.

## Parámetros protegidos

Mientras la asistencia queda habilitada, el servidor fija siempre:

- radio de geocerca: `100` metros;
- precisión GPS máxima: `50` metros.

El navegador no envía ni puede decidir esos valores. Aunque un cliente manipule el formulario, la autoridad aplica nuevamente los estándares del producto.

## Proveedores cartográficos

La interfaz usa Leaflet 1.9.4 y mosaicos visibles de OpenStreetMap con atribución. No realiza precarga, uso sin conexión ni descarga masiva de mosaicos.

La búsqueda usa el servicio público Nominatim únicamente después de pulsar **Buscar dirección**. No hay autocompletado. Las consultas se limitan globalmente a una frecuencia inferior a una por segundo. Si el servicio no está disponible, el mapa continúa permitiendo selección manual y ubicación actual.

Referencias:

- Leaflet Quick Start: https://leafletjs.com/examples/quick-start/
- Leaflet Mobile: https://leafletjs.com/examples/mobile/
- OpenStreetMap Tile Usage Policy: https://operations.osmfoundation.org/policies/tiles/
- Nominatim Usage Policy: https://operations.osmfoundation.org/policies/nominatim/
- MDN Geolocation getCurrentPosition: https://developer.mozilla.org/docs/Web/API/Geolocation/getCurrentPosition

## Seguridad y privacidad

- La geolocalización administrativa se solicita solo al pulsar el botón correspondiente.
- La selección del mapa no realiza seguimiento continuo.
- La búsqueda de dirección se envía a Nominatim solo mediante acción explícita.
- El Portal del Auxiliar sigue validando propiedad de la asignación, dispositivo, geocerca, precisión e idempotencia en servidor.
- La fotografía permanece como evidencia visual y no reconocimiento facial.

## Rollback

Revertir los cambios de vista, ruta y autoridad. Los puntos ya guardados conservan coordenadas y valores 100/50, que siguen siendo compatibles con el esquema anterior.
