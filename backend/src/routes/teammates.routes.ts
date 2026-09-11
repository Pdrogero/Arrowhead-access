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

// Reps already teammates with (or with a pending invite to/from) `repId` —
// shared by /suggested and /search so neither offers a duplicate "+ Add"
// for someone already in that state.
async function excludedTeammateIds(repId: string): Promise<Set<string>> {
  const existing = await prisma.teammateInvite.findMany({
    where: { OR: [{ fromRepId: repId }, { toRepId: repId }] },
    select: { fromRepId: true, toRepId: true },
  });
  const excludeIds = new Set<string>([repId]);
  existing.forEach(inv => { excludeIds.add(inv.fromRepId); if (inv.toRepId) excludeIds.add(inv.toRepId); });
  return excludeIds;
}

// --- Suggested teammates: same company, not already connected/pending -----
router.get('/suggested', requireAuth, requireRole('rep'), async (req, res) => {
  const me = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
  const excludeIds = await excludedTeammateIds(me.id);

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

// --- Search all reps on Arrowhead Access by name/company, to invite one --
// as a teammate even outside your own company — Suggested Teammates only
// ever covers same-company automatically.
router.get('/search', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const excludeIds = await excludedTeammateIds(req.user!.sub);
    const results = await prisma.rep.findMany({
      where: {
        id: { notIn: [...excludeIds] },
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { companyName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: REP_SUMMARY_SELECT,
      orderBy: { name: 'asc' },
      take: 20,
    });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not search reps' });
  }
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

// --- Invites I've sent that are still pending --------------------------------
// So a rep who invited someone can tell whether it's still awaiting a
// response, rather than wondering why that person never showed up as a
// teammate. toRep is null when the invite went to an email that hasn't
// signed up yet — toRepEmail always has the address either way.
router.get('/invites/sent', requireAuth, requireRole('rep'), async (req, res) => {
  const invites = await prisma.teammateInvite.findMany({
    where: { fromRepId: req.user!.sub, status: 'PENDING' },
    include: { toRep: { select: REP_SUMMARY_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invites);
});

// --- Count of pending invites addressed to me --------------------------------
// Powers a badge on the Transfers nav icon so a rep notices they have a
// teammate invite waiting on them, without having to go looking for it.
router.get('/invites/count', requireAuth, requireRole('rep'), async (req, res) => {
  const count = await prisma.teammateInvite.count({ where: { toRepId: req.user!.sub, status: 'PENDING' } });
  res.json({ count });
});

// --- Send an invite ----------------------------------------------------------
router.post('/invite', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const me = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });

    // Two ways in: toRepId picks an existing rep (the Suggested Teammates
    // "+ Add" button); toRepEmail invites someone by email who may not be
    // on Arrowhead Access yet — mirrors how visit transfers handle
    // inviting a not-yet-registered rep.
    let toRepId: string | null = null;
    let toRepEmail: string;

    if (req.body.toRepId) {
      toRepId = String(req.body.toRepId);
      if (toRepId === me.id) return res.status(400).json({ error: "You can't invite yourself" });
      const toRep = await prisma.rep.findUnique({ where: { id: toRepId } });
      if (!toRep) return res.status(404).json({ error: 'Rep not found' });
      toRepEmail = toRep.email;
    } else {
      toRepEmail = String(req.body.toRepEmail || '').trim().toLowerCase();
      if (!toRepEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toRepEmail)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
      }
      if (toRepEmail === me.email.toLowerCase()) {
        return res.status(400).json({ error: "You can't invite yourself" });
      }
      const existingRep = await prisma.rep.findFirst({ where: { email: { equals: toRepEmail, mode: 'insensitive' } } });
      toRepId = existingRep?.id ?? null;
    }

    const existing = await prisma.teammateInvite.findFirst({
      where: toRepId
        ? { OR: [{ fromRepId: me.id, toRepId }, { fromRepId: toRepId, toRepId: me.id }] }
        : { fromRepId: me.id, toRepEmail },
    });
    if (existing) {
      if (existing.status === 'ACCEPTED') return res.status(409).json({ error: 'You are already teammates' });
      if (existing.fromRepId === me.id) return res.status(409).json({ error: 'You already invited this person' });
      return res.status(409).json({ error: 'This rep already invited you — check your Invites tab to accept' });
    }

    const invite = await prisma.teammateInvite.create({
      data: { fromRepId: me.id, toRepId, toRepEmail },
    });

    if (toRepId) {
      sendEmail({
        to: toRepEmail,
        subject: `${me.name} invited you to connect on Arrowhead Access`,
        html: `${emailLogoHeader()}<p><strong>${me.name}</strong> (${me.companyName}) invited you to connect as teammates on Arrowhead Access.</p><p>Log in and check Transfers → My Team → Invites to accept.</p>${emailLoginButton()}`,
      }).catch(() => {});
    } else {
      const appUrl = process.env.APP_URL || 'https://arrowheadaccess.com';
      const signupUrl = `${appUrl}/app.html?teammate=1&email=${encodeURIComponent(toRepEmail)}`;
      sendEmail({
        to: toRepEmail,
        subject: `${me.name} invited you to join Arrowhead Access`,
        html: `${emailLogoHeader()}<p><strong>${me.name}</strong> (${me.companyName}) uses Arrowhead Access to schedule visits with medical offices, and wants to connect with you there as a teammate.</p><p><a href="${signupUrl}">Sign up with this email address</a> to join — it only takes a minute.</p>`,
      }).catch(() => {});
    }

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

    // toRepId was already confirmed to match the authenticated caller above,
    // so toRep is guaranteed to be populated here.
    if (decision === 'ACCEPTED' && updated.toRep) {
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
