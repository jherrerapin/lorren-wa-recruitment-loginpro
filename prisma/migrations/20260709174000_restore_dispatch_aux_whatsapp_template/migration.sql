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

  UPDATE "DispatchMessageTemplate"
  SET "content" = template_text,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "key" = 'DISPATCH_ASSIGNMENT_WHATSAPP';

  IF NOT FOUND THEN
    INSERT INTO "DispatchMessageTemplate" ("id", "key", "content", "createdAt", "updatedAt")
    VALUES ('cm-template-dispatch-assignment-whatsapp-restore-20260709', 'DISPATCH_ASSIGNMENT_WHATSAPP', template_text, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;
END $$;
