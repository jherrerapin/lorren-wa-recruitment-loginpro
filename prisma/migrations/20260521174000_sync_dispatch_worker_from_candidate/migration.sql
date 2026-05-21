-- Keep DispatchWorker synchronized with Candidate when the operational worker comes from the bot flow.
-- Dispatch assignment screens read DispatchWorker, so candidate edits must update the operational copy too.

CREATE OR REPLACE FUNCTION normalize_dispatch_transport_mode(input_value TEXT)
RETURNS TEXT AS $$
DECLARE
  normalized_value TEXT;
BEGIN
  normalized_value := NULLIF(
    regexp_replace(
      lower(
        translate(
          coalesce(input_value, ''),
          'ÁÉÍÓÚÜáéíóúüÑñ',
          'AEIOUUaeiouuNn'
        )
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    ),
    ''
  );

  IF normalized_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF normalized_value = 'sin medio de transporte'
    OR normalized_value = 'sin transporte'
    OR normalized_value = 'sin vehiculo'
    OR normalized_value = 'ninguno'
    OR normalized_value = 'ninguna'
    OR normalized_value = 'no tiene'
    OR normalized_value = 'no tengo'
    OR normalized_value LIKE 'sin %'
    OR normalized_value LIKE 'no tengo%'
    OR normalized_value LIKE 'no tiene%'
    OR normalized_value LIKE 'no cuento con%'
  THEN
    RETURN 'Sin medio de transporte';
  END IF;

  IF normalized_value ~ '(^| )(moto|motocicleta)( |$)' THEN
    RETURN 'Moto';
  END IF;

  IF normalized_value ~ '(^| )(bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)( |$)' THEN
    RETURN 'Bicicleta';
  END IF;

  IF normalized_value ~ '(^| )(carro|auto|automovil|coche|vehiculo propio|carro propio)( |$)' THEN
    RETURN 'Carro';
  END IF;

  IF normalized_value ~ '(^| )(a pie|caminando|caminar)( |$)' THEN
    RETURN 'A pie';
  END IF;

  IF normalized_value ~ '(^| )(bus|buseta|colectivo|transmilenio|transmi|sitp|alimentador|metro|transporte publico|publico|servicio publico|didi|uber|taxi|transporte urbano)( |$)' THEN
    RETURN 'Público';
  END IF;

  RETURN initcap(normalized_value);
END;
$$ LANGUAGE plpgsql;

-- Backfill existing operational workers from their linked candidate.
UPDATE "DispatchWorker" AS worker
SET
  "fullName" = COALESCE(NULLIF(trim(candidate."fullName"), ''), worker."fullName"),
  "phone" = NULLIF(trim(candidate."phone"), ''),
  "documentType" = NULLIF(trim(candidate."documentType"), ''),
  "documentNumber" = NULLIF(trim(candidate."documentNumber"), ''),
  "residenceCity" = COALESCE(NULLIF(trim(candidate."zone"), ''), worker."residenceCity"),
  "residenceLocality" = COALESCE(NULLIF(trim(candidate."locality"), ''), NULLIF(trim(candidate."neighborhood"), ''), worker."residenceLocality"),
  "transportMode" = normalize_dispatch_transport_mode(candidate."transportMode"),
  "updatedAt" = now()
FROM "Candidate" AS candidate
WHERE worker."candidateId" = candidate.id;

CREATE OR REPLACE FUNCTION sync_dispatch_worker_from_candidate()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "DispatchWorker"
  SET
    "fullName" = COALESCE(NULLIF(trim(NEW."fullName"), ''), "DispatchWorker"."fullName"),
    "phone" = NULLIF(trim(NEW."phone"), ''),
    "documentType" = NULLIF(trim(NEW."documentType"), ''),
    "documentNumber" = NULLIF(trim(NEW."documentNumber"), ''),
    "residenceCity" = COALESCE(NULLIF(trim(NEW."zone"), ''), "DispatchWorker"."residenceCity"),
    "residenceLocality" = COALESCE(NULLIF(trim(NEW."locality"), ''), NULLIF(trim(NEW."neighborhood"), ''), "DispatchWorker"."residenceLocality"),
    "transportMode" = normalize_dispatch_transport_mode(NEW."transportMode"),
    "updatedAt" = now()
  WHERE "candidateId" = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_dispatch_worker_from_candidate ON "Candidate";
CREATE TRIGGER trg_sync_dispatch_worker_from_candidate
AFTER UPDATE OF "fullName", "phone", "documentType", "documentNumber", "zone", "locality", "neighborhood", "transportMode"
ON "Candidate"
FOR EACH ROW
EXECUTE FUNCTION sync_dispatch_worker_from_candidate();
