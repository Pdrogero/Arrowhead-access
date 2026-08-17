// src/routes/slots.routes.ts
// Lets office staff post open visiting slots, and lets verified reps browse
// and claim them. Mount with: app.use('/api/slots', slotsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();

// --- Office staff: post a new open slot at their own location -------------
router.post('/', requireAuth, async (req, res) => {
  if (!['office_admin', 'office_staff'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only office staff can post slots' });
  }
  try {
    const { startTime, endTime } = req.body;
    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff account not found' });

    const slot = await prisma.slot.create({
      data: {
        locationId: staff.locationId,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: 'OPEN',
        createdByStaffId: staff.id,
      },
    });

    res.status(201).json(slot);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create slot' });
  }
});

// --- Reps: browse open slots across all locations --------------------------
router.get('/open', requireAuth, requireRole('rep'), async (req, res) => {
  const slots = await prisma.slot.findMany({
    where: { status: 'OPEN', startTime: { gte: new Date() } },
    include: { location: true },
    orderBy: { startTime: 'asc' },
    take: 50,
  });
  res.json(slots);
});

// --- Reps: claim an open slot ----------------------------------------------
router.post('/:id/claim', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const rep = await prisma.rep.findUnique({ where: { id: req.user!.sub } });
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    if (rep.verificationStatus !== 'VERIFIED') {
      return res.status(403).json({ error: 'Only verified reps can claim slots' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const slot = await tx.slot.findUnique({ where: { id: req.params.id } });
      if (!slot || slot.status !== 'OPEN') {
        throw new Error('This slot is no longer available');
      }

      const updatedSlot = await tx.slot.update({ where: { id: slot.id }, data: { status: 'CONFIRMED' } });
      const booking = await tx.booking.create({
        data: { slotId: slot.id, repId: rep.id, status: 'CONFIRMED', decidedAt: new Date() },
      });
      return { slot: updatedSlot, booking };
    });

    res.status(201).json(result);
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not claim slot' });
  }
});

export default router;
