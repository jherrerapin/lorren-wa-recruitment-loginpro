import fs from 'fs';

const file = 'src/routes/lorenV2.js';
let source = fs.readFileSync(file, 'utf8');

const oldBlock = `  router.post('/campaigns/:id/edit', requireLorenV2, async (req, res) => {
    const { body } = req;
    const name = normalizeString(body.name);
    const city = normalizeString(body.city);
    const vacancyId = normalizeString(body.vacancyId);
    const notes = normalizeString(body.notes);
    const startsAt = normalizeDateInput(body.startsAt);
    const endsAt = normalizeDateInput(body.endsAt);
    const isActive = body.isActive === '1';
    const budgetCOP = body.budgetCOP ? parseFloat(body.budgetCOP) : null;
    try {
      await prisma.campaign.update({
        where: { id: req.params.id },
        data: { name: name || undefined, city: city || null, vacancyId: vacancyId || null, notes: notes || null, budgetCOP: budgetCOP !== null ? budgetCOP : null, startsAt: startsAt ? new Date(\`${'${startsAt}'}T05:00:00Z\`) : null, endsAt: endsAt ? new Date(\`${'${endsAt}'}T23:59:59Z\`) : null, isActive }
      });
      res.redirect(\`${'${STATS_BASE_PATH}'}/campaigns/${'${req.params.id}'}?success=1\`);
    } catch (err) {
      console.error('[lorenV2 campaign edit]', err);
      res.redirect(\`${'${STATS_BASE_PATH}'}/campaigns/${'${req.params.id}'}?error=1\`);
    }
  });`;

const newBlock = `  router.post('/campaigns/:id/edit', requireLorenV2, async (req, res) => {
    const { body } = req;
    const city = normalizeString(body.city);
    const vacancyId = normalizeString(body.vacancyId);
    try {
      await prisma.campaign.update({
        where: { id: req.params.id },
        data: { city: city || null, vacancyId: vacancyId || null }
      });
      res.redirect(\`${'${STATS_BASE_PATH}'}/campaigns?classification=1\`);
    } catch (err) {
      console.error('[lorenV2 campaign classification]', err);
      res.redirect(\`${'${STATS_BASE_PATH}'}/campaigns/${'${req.params.id}'}?error=1\`);
    }
  });`;

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
  fs.writeFileSync(file, source);
  console.log('[patch-loren-v2] clasificación de anuncios ajustada');
} else {
  console.log('[patch-loren-v2] ruta de clasificación ya estaba ajustada o cambió');
}
