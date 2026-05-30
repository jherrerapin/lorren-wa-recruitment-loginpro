-- Normalize existing DispatchWorker.transportMode values so assignment filters do not show
-- old free-text values such as bus, colectivo, TransMilenio or SITP as separate options.

WITH normalized_transport AS (
  SELECT
    id,
    NULLIF(
      regexp_replace(
        lower(
          translate(
            coalesce("transportMode", ''),
            'ÁÉÍÓÚÜáéíóúüÑñ',
            'AEIOUUaeiouuNn'
          )
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      ),
      ''
    ) AS normalized_value
  FROM "DispatchWorker"
)
UPDATE "DispatchWorker" AS worker
SET "transportMode" = CASE
  WHEN transport.normalized_value IS NULL THEN NULL
  WHEN transport.normalized_value = 'sin medio de transporte'
    OR transport.normalized_value = 'sin transporte'
    OR transport.normalized_value = 'sin vehiculo'
    OR transport.normalized_value = 'ninguno'
    OR transport.normalized_value = 'ninguna'
    OR transport.normalized_value = 'no tiene'
    OR transport.normalized_value = 'no tengo'
    OR transport.normalized_value LIKE 'sin %'
    OR transport.normalized_value LIKE 'no tengo%'
    OR transport.normalized_value LIKE 'no tiene%'
    OR transport.normalized_value LIKE 'no cuento con%'
    THEN 'Publico'
  WHEN transport.normalized_value ~ '(^| )(moto|motocicleta)( |$)' THEN 'Moto'
  WHEN transport.normalized_value ~ '(^| )(bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)( |$)' THEN 'Bicicleta'
  WHEN transport.normalized_value ~ '(^| )(carro|auto|automovil|coche|vehiculo propio|carro propio)( |$)' THEN 'Carro'
  WHEN transport.normalized_value ~ '(^| )(a pie|voy a pie|caminando|caminar)( |$)' THEN 'Publico'
  WHEN transport.normalized_value ~ '(^| )(bus|buseta|colectivo|transmilenio|transmi|sitp|alimentador|metro|transporte publico|publico|servicio publico|didi|uber|indrive|in drive|taxi|transporte urbano)( |$)' THEN 'Publico'
  ELSE NULL
END
FROM normalized_transport AS transport
WHERE worker.id = transport.id;

-- Normalize existing DispatchWorker.transportMode values so assignment filters do not show
-- old free-text values such as bus, colectivo, TransMilenio or SITP as separate options.

WITH normalized_transport AS (
  SELECT
    id,
    NULLIF(
      regexp_replace(
        lower(
          translate(
            coalesce("transportMode", ''),
            'ÁÉÍÓÚÜáéíóúüÑñ',
            'AEIOUUaeiouuNn'
          )
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      ),
      ''
    ) AS normalized_value
  FROM "Candidate"
)
UPDATE "Candidate" AS candidate
SET "transportMode" = CASE
  WHEN transport.normalized_value IS NULL THEN NULL
  WHEN transport.normalized_value = 'sin medio de transporte'
    OR transport.normalized_value = 'sin transporte'
    OR transport.normalized_value = 'sin vehiculo'
    OR transport.normalized_value = 'ninguno'
    OR transport.normalized_value = 'ninguna'
    OR transport.normalized_value = 'no tiene'
    OR transport.normalized_value = 'no tengo'
    OR transport.normalized_value LIKE 'sin %'
    OR transport.normalized_value LIKE 'no tengo%'
    OR transport.normalized_value LIKE 'no tiene%'
    OR transport.normalized_value LIKE 'no cuento con%'
    THEN 'Publico'
  WHEN transport.normalized_value ~ '(^| )(moto|motocicleta)( |$)' THEN 'Moto'
  WHEN transport.normalized_value ~ '(^| )(bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)( |$)' THEN 'Bicicleta'
  WHEN transport.normalized_value ~ '(^| )(carro|auto|automovil|coche|vehiculo propio|carro propio)( |$)' THEN 'Carro'
  WHEN transport.normalized_value ~ '(^| )(a pie|voy a pie|caminando|caminar)( |$)' THEN 'Publico'
  WHEN transport.normalized_value ~ '(^| )(bus|buseta|colectivo|transmilenio|transmi|sitp|alimentador|metro|transporte publico|publico|servicio publico|didi|uber|indrive|in drive|taxi|transporte urbano)( |$)' THEN 'Publico'
  ELSE NULL
END
FROM normalized_transport AS transport
WHERE candidate.id = transport.id;
