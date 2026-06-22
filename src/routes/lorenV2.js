import express from 'express';
import { canSeeLorenV2, requireLorenV2 } from '../services/lorenV2Gate.js';

export function lorenV2Router() {
  const router = express.Router();

  router.use(requireLorenV2);

  router.get('/', (req, res) => {
    res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loren V2</title>
</head>
<body>
  <main style="font-family: Arial, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px;">
    <p><a href="/admin">Volver al panel</a></p>
    <h1>Loren V2</h1>
    <p>Modulo habilitado para desarrollo y liberacion controlada.</p>
    <section>
      <h2>Funciones planeadas</h2>
      <ul>
        <li>Campanas y estadisticas</li>
        <li>Referidos y recomendados</li>
        <li>Resumen diario y reportes</li>
        <li>Extraccion inteligente de hojas de vida</li>
        <li>Alertas automaticas</li>
        <li>Check-in operativo</li>
        <li>Validacion documental asistida</li>
      </ul>
    </section>
  </main>
</body>
</html>`);
  });

  router.get('/status', (req, res) => {
    res.json({
      ok: true,
      lorenV2: true,
      canSeeLorenV2: canSeeLorenV2(req),
      userRole: req.userRole || null,
      username: req.username || null,
      userAccessScope: req.userAccessScope || null
    });
  });

  return router;
}
