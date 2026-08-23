// src/routes/transfers.routes.ts
// Lets a rep hand off one of their own bookings to another rep, who can
// accept (booking moves to them) or decline (booking stays put).
// Mount with: app.use('/api/transfers', transfersRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail } from '../email';

const prisma = new PrismaClient();
const router = Router();

// --- Offer a transfer -----------------------------------------------------
router.post('/', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { bookingId, toRepEmail } = req.body;
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

    const toRep = await prisma.rep.findUnique({ where: { email: toRepEmail } });
    if (!toRep) return res.status(404).json({ error: 'No rep found with that email' });
    if (toRep.id === req.user!.sub) return res.status(400).json({ error: "You can't transfer a booking to yourself" });

    const existingPending = await prisma.bookingTransfer.findFirst({
      where: { bookingId, status: 'PENDING' },
    });
    if (existingPending) return res.status(409).json({ error: 'This booking already has a pending transfer' });

    const transfer = await prisma.bookingTransfer.create({
      data: { bookingId, fromRepId: req.user!.sub, toRepId: toRep.id },
      include: {
        booking: { include: { slot: { include: { location: true } } } },
        toRep: true,
        fromRep: { select: { name: true, companyName: true } },
      },
    });

    const dateStr = transfer.booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    sendEmail({
      to: transfer.toRep.email,
      subject: `${transfer.fromRep.name} wants to transfer a visit to you`,
      html: `<p><strong>${transfer.fromRep.name}</strong> (${transfer.fromRep.companyName}) wants to transfer their visit at <strong>${transfer.booking.slot.location.name}</strong> on ${dateStr} to you. Log in to accept or decline it.</p>`,
    }).catch(() => {});

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
    if (full) {
      const dateStr = full.booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const accepted = decision === 'accept';
      sendEmail({
        to: full.fromRep.email,
        subject: accepted ? `${full.toRep.name} accepted your transfer` : `${full.toRep.name} declined your transfer`,
        html: `<p><strong>${full.toRep.name}</strong> ${accepted ? 'accepted' : 'declined'} the visit transfer for <strong>${full.booking.slot.location.name}</strong> on ${dateStr}.</p>`,
      }).catch(() => {});
    }

    res.json({ status: decision === 'accept' ? 'ACCEPTED' : 'DECLINED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not decide transfer' });
  }
});

export default router;
