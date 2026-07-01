-- Estadísticas: presupuesto manual de pauta por campaña/anuncio.
-- Este campo permite calcular costo por conversación, HV, apto, asistencia y contratación
-- sin depender exclusivamente de snapshots sincronizados desde Meta Ads.

ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "budgetCOP" DECIMAL(14, 2);
