import express from 'express';
import { normalizeKnowledgeContent, normalizeKnowledgeScope } from '../services/botKnowledge.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function ensureDevRole(req, res, next) {
  if (req.session?.userRole === 'dev') return next();
  return res.redirect('/admin?error=' + encodeURIComponent('Solo desarrollo puede gestionar aprendizajes de Lórren.'));
}

function redirectWith(type, message) {
  return '/admin/bot-knowledge?' + type + '=' + encodeURIComponent(message);
}

export function botKnowledgeCrudRouter(prisma) {
  const router = express.Router();

  router.use(ensureDevRole);
  router.use(express.urlencoded({ extended: true }));

  router.post('/:id/update', async (req, res) => {
    const id = normalizeString(req.params.id);
    const scope = normalizeKnowledgeScope(req.body.scope);
    const content = normalizeKnowledgeContent(req.body.content);
    const tags = normalizeKnowledgeContent(req.body.tags);
    const vacancyId = scope === 'VACANCY' ? normalizeString(req.body.vacancyId) : null;
    const candidateId = scope === 'CANDIDATE' ? normalizeString(req.body.candidateId) : null;

    if (!id) return res.redirect(redirectWith('error', 'Aprendizaje inválido.'));
    if (!content) return res.redirect(redirectWith('error', 'El aprendizaje no puede quedar vacío.'));
    if (scope === 'VACANCY' && !vacancyId) {
      return res.redirect(redirectWith('error', 'Selecciona una vacante para el aprendizaje de vacante.'));
    }

    try {
      await prisma.botKnowledge.update({
        where: { id },
        data: {
          scope,
          content,
          tags: tags || null,
          vacancyId,
          candidateId,
          updatedBy: req.username || req.userRole || 'dev'
        }
      });
      return res.redirect(redirectWith('success', 'Aprendizaje actualizado correctamente.'));
    } catch (error) {
      console.error('[bot_knowledge_update]', { id, error: error?.message || error });
      return res.redirect(redirectWith('error', 'No fue posible actualizar el aprendizaje.'));
    }
  });

  router.post('/:id/delete', async (req, res) => {
    const id = normalizeString(req.params.id);
    if (!id) return res.redirect(redirectWith('error', 'Aprendizaje inválido.'));

    try {
      await prisma.botKnowledge.delete({ where: { id } });
      return res.redirect(redirectWith('success', 'Aprendizaje eliminado correctamente.'));
    } catch (error) {
      console.error('[bot_knowledge_delete]', { id, error: error?.message || error });
      return res.redirect(redirectWith('error', 'No fue posible eliminar el aprendizaje.'));
    }
  });

  return router;
}
