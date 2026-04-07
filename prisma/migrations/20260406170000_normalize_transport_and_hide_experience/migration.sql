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
    THEN 'Sin medio de transporte'
  WHEN transport.normalized_value ~ '(^| )(moto|motocicleta)( |$)' THEN 'Moto'
  WHEN transport.normalized_value ~ '(^| )(bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)( |$)' THEN 'Bicicleta'
  WHEN transport.normalized_value ~ '(^| )(bus|buseta|transporte publico|servicio publico)( |$)' THEN 'Bus'
  ELSE initcap(transport.normalized_value)
END
FROM normalized_transport AS transport
WHERE candidate.id = transport.id;

UPDATE "Candidate"
SET
  "experienceInfo" = NULL,
  "experienceTime" = NULL,
  "experienceSummary" = NULL
WHERE
  "experienceInfo" IS NOT NULL
  OR "experienceTime" IS NOT NULL
  OR "experienceSummary" IS NOT NULL;
