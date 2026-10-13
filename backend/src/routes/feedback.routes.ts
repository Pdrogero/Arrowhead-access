// src/routes/feedback.routes.ts
// A one-time, dismissible "rate the site" prompt shown in-app (both the
// rep and office dashboards) a couple weeks after signup. Distinct from
// VisitReview (bookings.routes.ts / reviews.routes.ts), which rates a
// specific visit between a rep and an office — this rates the platform
// itself. Mount with: app.use('/api/feedback', feedbackRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../auth/auth.guard';
import { notifyAdmin } from '../email';

const prisma = new PrismaClient();
const router = Router();

// How long after signup before the prompt is eligible to show — "a week
// or two" landed in the middle of that range.
const FEEDBACK_PROMPT_DELAY_MS = 10 * 24 * 60 * 60 * 1000;

function isStaff(role: string): boolean {
  return role === 'office_admin' || role === 'office_staff';
}

// --- Whether to show the prompt on this login ------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - FEEDBACK_PROMPT_DELAY_MS);
    if (req.user!.role === 'rep') {
      const rep = await prisma.rep.findUnique({ where: { id: req.user!.sub }, select: { createdAt: true, feedbackPromptDismissed: true } });
      if (!rep) return res.status(404).json({ error: 'Rep not found' });
      return res.json({ show: !rep.feedbackPromptDismissed && rep.createdAt <= cutoff });
    }
    if (isStaff(req.user!.role)) {
      const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub }, select: { createdAt: true, feedbackPromptDismissed: true } });
      if (!staff) return res.status(404).json({ error: 'Staff account not found' });
      return res.json({ show: !staff.feedbackPromptDismissed && staff.createdAt <= cutoff });
    }
    res.json({ show: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check feedback prompt status' });
  }
});

// Pings the same admin inbox every other "something happened" notification
// in this app goes to (new signups, verification requests, etc.) — so
// feedback shows up the moment it's submitted instead of only being
// visible by remembering to check GET /api/admin/feedback.
function notifyAdminOfFeedback(authorType: 'REP' | 'STAFF', name: string, email: string, rating: number, comment: string | null) {
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  notifyAdmin(
    `New feedback (${stars}) — Arrowhead Access`,
    `<p><strong>${name}</strong> (${authorType === 'REP' ? 'rep' : 'office staff'}, ${email}) rated Arrowhead Access <strong>${stars}</strong>.</p>${comment ? `<p>"${comment.replace(/</g, '&lt;')}"</p>` : '<p>(no comment left)</p>'}`
  );
}

// --- Submit a rating (+ optional comment) — counts as dismissed too --------
router.post('/submit', requireAuth, async (req, res) => {
  try {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
    }
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 2000) || null : null;

    if (req.user!.role === 'rep') {
      const rep = await prisma.rep.findUnique({ where: { id: req.user!.sub }, select: { name: true, email: true } });
      if (!rep) return res.status(404).json({ error: 'Rep not found' });
      await prisma.$transaction([
        prisma.platformFeedback.create({ data: { authorType: 'REP', repId: req.user!.sub, rating, comment } }),
        prisma.rep.update({ where: { id: req.user!.sub }, data: { feedbackPromptDismissed: true } }),
      ]);
      notifyAdminOfFeedback('REP', rep.name, rep.email, rating, comment);
      return res.status(201).json({ ok: true });
    }
    if (isStaff(req.user!.role)) {
      const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub }, select: { name: true, email: true } });
      if (!staff) return res.status(404).json({ error: 'Staff account not found' });
      await prisma.$transaction([
        prisma.platformFeedback.create({ data: { authorType: 'STAFF', staffId: req.user!.sub, rating, comment } }),
        prisma.staffUser.update({ where: { id: req.user!.sub }, data: { feedbackPromptDismissed: true } }),
      ]);
      notifyAdminOfFeedback('STAFF', staff.name || staff.email, staff.email, rating, comment);
      return res.status(201).json({ ok: true });
    }
    res.status(403).json({ error: 'Not permitted for this role' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit feedback' });
  }
});

// --- Dismiss without submitting a rating ------------------------------------
router.post('/dismiss', requireAuth, async (req, res) => {
  try {
    if (req.user!.role === 'rep') {
      await prisma.rep.update({ where: { id: req.user!.sub }, data: { feedbackPromptDismissed: true } });
      return res.json({ ok: true });
    }
    if (isStaff(req.user!.role)) {
      await prisma.staffUser.update({ where: { id: req.user!.sub }, data: { feedbackPromptDismissed: true } });
      return res.json({ ok: true });
    }
    res.status(403).json({ error: 'Not permitted for this role' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not dismiss feedback prompt' });
  }
});

export default router;
