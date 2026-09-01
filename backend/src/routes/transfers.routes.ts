// src/routes/transfers.routes.ts
// Lets a rep hand off one of their own bookings to another rep, who can
// accept (booking moves to them) or decline (booking stays put).
// Mount with: app.use('/api/transfers', transfersRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';

const prisma = new PrismaClient();
const router = Router();

// --- Offer a transfer -----------------------------------------------------
// toRepEmail doesn't have to belong to an existing rep — if nobody's signed
// up with that email yet, the transfer is created unclaimed (toRepId null)
// and an invite email goes out instead of a "you've got a transfer" email.
// It's automatically claimed the moment someone signs up with that email
// (see /api/auth/rep/signup).
router.post('/', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { bookingId } = req.body;
    const toRepEmail = String(req.body.toRepEmail || '').trim().toLowerCase();
    if (!bookingId || !toRepEmail) {
      return res.status(400).json({ error: 'bookingId and toRepEmail are required' });
    }

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.status !== 'CONFIRMED' && booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: 'Only confirmed or requested bookings can be transferred' });
    }

    const fromRep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
    if (toRepEmail === fromRep.email.toLowerCase()) {
      return res.status(400).json({ error: "You can't transfer a booking to yourself" });
    }

    const existingPending = await prisma.bookingTransfer.findFirst({
      where: { bookingId, status: 'PENDING' },
    });
    if (existingPending) return res.status(409).json({ error: 'This booking already has a pending transfer' });

    const toRep = await prisma.rep.findFirst({ where: { email: { equals: toRepEmail, mode: 'insensitive' } } });

    const transfer = await prisma.bookingTransfer.create({
      data: { bookingId, fromRepId: req.user!.sub, toRepEmail, toRepId: toRep?.id ?? null },
      include: {
        booking: { include: { slot: { include: { location: true } } } },
      },
    });

    const dateStr = transfer.booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    if (toRep) {
      sendEmail({
        to: toRepEmail,
        subject: `${fromRep.name} wants to transfer a visit to you`,
        html: `${emailLogoHeader()}<p><strong>${fromRep.name}</strong> (${fromRep.companyName}) wants to transfer their visit at <strong>${transfer.booking.slot.location.name}</strong> on ${dateStr} to you. Log in to accept or decline it.</p>`,
      }).catch(() => {});
    } else {
      const signupUrl = `${process.env.APP_URL}/app.html?transfer=1&email=${encodeURIComponent(toRepEmail)}`;
      sendEmail({
        to: toRepEmail,
        subject: `${fromRep.name} wants to transfer a visit to you on Arrowhead Access`,
        html: `${emailLogoHeader()}<p><strong>${fromRep.name}</strong> (${fromRep.companyName}) wants to transfer their visit at <strong>${transfer.booking.slot.location.name}</strong> on ${dateStr} to you on Arrowhead Access.</p><p>You don't have an account yet — <a href="${signupUrl}">sign up with this email address</a> to review and accept it.</p>`,
      }).catch(() => {});
    }

    res.status(201).json(transfer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create transfer' });
  }
});

// --- Incoming transfers (offered to me, still pending) --------------------
router.get('/incoming', requireAuth, requireRole('rep'), async (req, res) => {
  const transfers = await prisma.bookingTransfer.findMany({
    where: { toRepId: req.user!.sub, status: 'PENDING' },
    include: {
      booking: { include: { slot: { include: { location: true } } } },
      fromRep: { select: { id: true, name: true, companyName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(transfers);
});

// --- Outgoing transfers (offered by me) ------------------------------------
router.get('/outgoing', requireAuth, requireRole('rep'), async (req, res) => {
  const transfers = await prisma.bookingTransfer.findMany({
    where: { fromRepId: req.user!.sub },
    include: {
      booking: { include: { slot: { include: { location: true } } } },
      toRep: { select: { id: true, name: true, companyName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(transfers);
});

// --- Accept or decline a transfer offered to me ----------------------------
router.post('/:id/decide', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { decision } = req.body; // 'accept' | 'decline'
    const transfer = await prisma.bookingTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer || transfer.toRepId !== req.user!.sub) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    if (transfer.status !== 'PENDING') {
      return res.status(400).json({ error: 'This transfer has already been decided' });
    }

    if (decision === 'accept') {
      await prisma.$transaction([
        prisma.booking.update({ where: { id: transfer.bookingId }, data: { repId: transfer.toRepId } }),
        prisma.bookingTransfer.update({ where: { id: transfer.id }, data: { status: 'ACCEPTED', decidedAt: new Date() } }),
      ]);
    } else {
      await prisma.bookingTransfer.update({ where: { id: transfer.id }, data: { status: 'DECLINED', decidedAt: new Date() } });
    }

    const full = await prisma.bookingTransfer.findUnique({
      where: { id: transfer.id },
      include: {
        booking: { include: { slot: { include: { location: true } } } },
        fromRep: true,
        toRep: { select: { name: true } },
      },
    });
    if (full && full.toRep) {
      const dateStr = full.booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const accepted = decision === 'accept';
      sendEmail({
        to: full.fromRep.email,
        subject: accepted ? `${full.toRep.name} accepted your transfer` : `${full.toRep.name} declined your transfer`,
        html: `${emailLogoHeader()}<p><strong>${full.toRep.name}</strong> ${accepted ? 'accepted' : 'declined'} the visit transfer for <strong>${full.booking.slot.location.name}</strong> on ${dateStr}.</p>`,
      }).catch(() => {});
    }

    res.json({ status: decision === 'accept' ? 'ACCEPTED' : 'DECLINED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not decide transfer' });
  }
});

export default router;
