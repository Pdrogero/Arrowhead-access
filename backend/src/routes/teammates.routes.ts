// src/routes/teammates.routes.ts
// Lets reps at the same company find each other on Arrowhead Access and
// connect as teammates — a lightweight mutual connection, not tied to any
// specific booking (that's what BookingTransfer/transfers.routes is for).
// Mount with: app.use('/api/teammates', teammatesRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader, emailLoginButton } from '../email';

const prisma = new PrismaClient();
const router = Router();

const REP_SUMMARY_SELECT = { id: true, name: true, companyName: true, title: true } as const;

// --- My teammates (accepted, either direction) -----------------------------
router.get('/', requireAuth, requireRole('rep'), async (req, res) => {
  const invites = await prisma.teammateInvite.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ fromRepId: req.user!.sub }, { toRepId: req.user!.sub }],
    },
    include: { fromRep: { select: REP_SUMMARY_SELECT }, toRep: { select: REP_SUMMARY_SELECT } },
  });
  const teammates = invites.map(inv => (inv.fromRepId === req.user!.sub ? inv.toRep : inv.fromRep));
  res.json(teammates);
});

// --- Suggested teammates: same company, not already connected/pending -----
router.get('/suggested', requireAuth, requireRole('rep'), async (req, res) => {
  const me = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });

  const existing = await prisma.teammateInvite.findMany({
    where: { OR: [{ fromRepId: me.id }, { toRepId: me.id }] },
    select: { fromRepId: true, toRepId: true },
  });
  const excludeIds = new Set<string>([me.id]);
  existing.forEach(inv => { excludeIds.add(inv.fromRepId); excludeIds.add(inv.toRepId); });

  const suggested = await prisma.rep.findMany({
    where: {
      companyName: me.companyName,
      id: { notIn: [...excludeIds] },
    },
    select: REP_SUMMARY_SELECT,
    take: 25,
    orderBy: { name: 'asc' },
  });
  res.json(suggested);
});

// --- Pending invites addressed to me ----------------------------------------
router.get('/invites', requireAuth, requireRole('rep'), async (req, res) => {
  const invites = await prisma.teammateInvite.findMany({
    where: { toRepId: req.user!.sub, status: 'PENDING' },
    include: { fromRep: { select: REP_SUMMARY_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invites);
});

// --- Send an invite ----------------------------------------------------------
router.post('/invite', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const toRepId = String(req.body.toRepId || '');
    if (!toRepId) return res.status(400).json({ error: 'toRepId is required' });
    if (toRepId === req.user!.sub) return res.status(400).json({ error: "You can't invite yourself" });

    const [me, toRep] = await Promise.all([
      prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } }),
      prisma.rep.findUnique({ where: { id: toRepId } }),
    ]);
    if (!toRep) return res.status(404).json({ error: 'Rep not found' });

    const existing = await prisma.teammateInvite.findFirst({
      where: {
        OR: [
          { fromRepId: me.id, toRepId },
          { fromRepId: toRepId, toRepId: me.id },
        ],
      },
    });
    if (existing) {
      if (existing.status === 'ACCEPTED') return res.status(409).json({ error: 'You are already teammates' });
      if (existing.fromRepId === me.id) return res.status(409).json({ error: 'You already invited this rep' });
      return res.status(409).json({ error: 'This rep already invited you — check your Invites tab to accept' });
    }

    const invite = await prisma.teammateInvite.create({
      data: { fromRepId: me.id, toRepId },
    });

    sendEmail({
      to: toRep.email,
      subject: `${me.name} invited you to connect on Arrowhead Access`,
      html: `${emailLogoHeader()}<p><strong>${me.name}</strong> (${me.companyName}) invited you to connect as teammates on Arrowhead Access.</p><p>Log in and check your Team invites under Transfers to accept.</p>${emailLoginButton()}`,
    }).catch(() => {});

    res.status(201).json(invite);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send invite' });
  }
});

// --- Accept or decline an invite addressed to me ----------------------------
router.post('/invites/:id/respond', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const invite = await prisma.teammateInvite.findUnique({ where: { id: req.params.id } });
    if (!invite || invite.toRepId !== req.user!.sub) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    if (invite.status !== 'PENDING') {
      return res.status(409).json({ error: 'This invite has already been decided' });
    }

    const decision = req.body.decision === 'accept' ? 'ACCEPTED' : req.body.decision === 'decline' ? 'DECLINED' : null;
    if (!decision) return res.status(400).json({ error: 'decision must be "accept" or "decline"' });

    const updated = await prisma.teammateInvite.update({
      where: { id: invite.id },
      data: { status: decision, respondedAt: new Date() },
      include: { fromRep: true, toRep: true },
    });

    if (decision === 'ACCEPTED') {
      sendEmail({
        to: updated.fromRep.email,
        subject: `${updated.toRep.name} accepted your teammate invite`,
        html: `${emailLogoHeader()}<p><strong>${updated.toRep.name}</strong> accepted your invite to connect as teammates on Arrowhead Access.</p>`,
      }).catch(() => {});
    }

    res.json({ status: decision });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not respond to invite' });
  }
});

export default router;
