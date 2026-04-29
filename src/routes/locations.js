// routes/locations.js — CRUD de Ciudad y Operación
import express from 'express';

function sessionAuth(req, res, next) {
  const role = req.session?.userRole;
  if (!role) return res.redirect('/login');
  req.userRole = role;
  if (!['dev', 'admin'].includes(role)) return res.redirect('/admin');
  return next();
}

function flash(res, type, msg) {
  res.cookie('_flash_type', type, { maxAge: 5000, httpOnly: false });
  res.cookie('_flash_msg',  msg,  { maxAge: 5000, httpOnly: false });
}

function readFlash(req, res) {
  const type = req.cookies?._flash_type || null;
  const msg  = req.cookies?._flash_msg  || null;
  res.clearCookie('_flash_type');
  res.clearCookie('_flash_msg');
  return { successMsg: type === 'success' ? msg : null, errorMsg: type === 'error' ? msg : null };
}

function normalize(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
}

export function locationsRouter(prisma) {
  const router = express.Router();
  router.use(sessionAuth);

  // ── GET /admin/locations ────────────────────────────────────
  router.get('/', async (req, res) => {
    const cities = await prisma.city.findMany({
      orderBy: { name: 'asc' },
      include: {
        operations: {
          orderBy: { name: 'asc' },
          include: { _count: { select: { vacancies: true } } }
        }
      }
    });
    const { successMsg, errorMsg } = readFlash(req, res);
    res.render('locations', { cities, successMsg, errorMsg, role: req.userRole });
  });

  // ── API: listar operaciones por ciudad (para selects dinámicos) ─
  router.get('/api/operations', async (req, res) => {
    const operations = await prisma.operation.findMany({
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
      include: { city: { select: { name: true } } }
    });
    res.json(operations);
  });

  // ── POST /admin/locations/cities ─── Crear ciudad ──────────
  router.post('/cities', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre de la ciudad no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.city.create({ data: { name } });
      flash(res, 'success', `Ciudad "${name}" creada exitosamente.`);
    } catch (err) {
      if (err.code === 'P2002') {
        flash(res, 'error', `Ya existe una ciudad con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al crear la ciudad.');
      }
    }
    res.redirect('/admin/locations');
  });

  // ── POST /admin/locations/cities/:id/edit ─── Renombrar ────
  router.post('/cities/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.city.update({ where: { id: req.params.id }, data: { name } });
      flash(res, 'success', `Ciudad renombrada a "${name}".`);
    } catch (err) {
      if (err.code === 'P2002') {
        flash(res, 'error', `Ya existe una ciudad con el nombre "${name}".`);
      } else {
        flash(res, 'error', 'Error al renombrar la ciudad.');
      }
    }
    res.redirect('/admin/locations');
  });

  // ── POST /admin/locations/cities/:id/delete ─── Eliminar ───
  router.post('/cities/:id/delete', async (req, res) => {
    try {
      const city = await prisma.city.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { operations: true } } }
      });
      if (!city) {
        flash(res, 'error', 'Ciudad no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (city._count.operations > 0) {
        flash(res, 'error', `No se puede eliminar "${city.name}" porque tiene operaciones asociadas.`);
        return res.redirect('/admin/locations');
      }
      await prisma.city.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Ciudad "${city.name}" eliminada.`);
    } catch {
      flash(res, 'error', 'Error al eliminar la ciudad.');
    }
    res.redirect('/admin/locations');
  });

  // ── POST /admin/locations/cities/:cityId/operations ─── Crear operación ──
  router.post('/cities/:cityId/operations', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre de la operación no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.operation.create({ data: { name, cityId: req.params.cityId } });
      flash(res, 'success', `Operación "${name}" creada.`);
    } catch (err) {
      if (err.code === 'P2002') {
        flash(res, 'error', `Ya existe una operación "${name}" en esta ciudad.`);
      } else {
        flash(res, 'error', 'Error al crear la operación.');
      }
    }
    res.redirect('/admin/locations');
  });

  // ── POST /admin/locations/operations/:id/edit ─── Renombrar operación ──
  router.post('/operations/:id/edit', async (req, res) => {
    const name = normalize(req.body.name);
    if (!name) {
      flash(res, 'error', 'El nombre no puede estar vacío.');
      return res.redirect('/admin/locations');
    }
    try {
      await prisma.operation.update({ where: { id: req.params.id }, data: { name } });
      flash(res, 'success', `Operación renombrada a "${name}".`);
    } catch (err) {
      if (err.code === 'P2002') {
        flash(res, 'error', `Ya existe una operación con ese nombre en la misma ciudad.`);
      } else {
        flash(res, 'error', 'Error al renombrar la operación.');
      }
    }
    res.redirect('/admin/locations');
  });

  // ── POST /admin/locations/operations/:id/delete ─── Eliminar operación ──
  router.post('/operations/:id/delete', async (req, res) => {
    try {
      const op = await prisma.operation.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { vacancies: true } } }
      });
      if (!op) {
        flash(res, 'error', 'Operación no encontrada.');
        return res.redirect('/admin/locations');
      }
      if (op._count.vacancies > 0) {
        flash(res, 'error', `No se puede eliminar "${op.name}" porque tiene ${op._count.vacancies} vacante(s) asociada(s). Reasigna o elimina las vacantes primero.`);
        return res.redirect('/admin/locations');
      }
      await prisma.operation.delete({ where: { id: req.params.id } });
      flash(res, 'success', `Operación "${op.name}" eliminada.`);
    } catch {
      flash(res, 'error', 'Error al eliminar la operación.');
    }
    res.redirect('/admin/locations');
  });

  return router;
}
