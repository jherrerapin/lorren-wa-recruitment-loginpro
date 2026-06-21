DO $$
DECLARE
  template_text TEXT;
BEGIN
  template_text := concat(
    'Hola ', chr(42), '{{nombre}}', chr(42), ',', chr(10), chr(10),
    'Mañana: ', chr(42), '{{fecha}}', chr(42), chr(10),
    'Llegar a: ', chr(42), '{{operacion}}  - {{direccion}}', chr(42), chr(10),
    'Hora : ', chr(42), '{{horaInicio}} por favor.', chr(42), chr(10), chr(10), chr(10),
    chr(42), 'Confirmado?', chr(42)
  );

  EXECUTE 'UPDATE "DispatchMessageTemplate" SET "content" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = $2'
  USING template_text, 'DISPATCH_ASSIGNMENT_WHATSAPP';

  IF NOT EXISTS (SELECT 1 FROM "DispatchMessageTemplate" WHERE "key" = 'DISPATCH_ASSIGNMENT_WHATSAPP') THEN
    INSERT INTO "DispatchMessageTemplate" ("id", "key", "content", "createdAt", "updatedAt")
    VALUES ('cm-template-dispatch-assignment-whatsapp-v2', 'DISPATCH_ASSIGNMENT_WHATSAPP', template_text, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;
END $$;
