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
    const { startTime, endTime, eventType, headCount, allergyNotes, foodOrderNotes, repHandlesOrder } = req.body;
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
        eventType: eventType || 'REP_VISIT',
        createdByStaffId: staff.id,
        ...(eventType === 'LUNCH' ? {
          headCount: headCount != null && headCount !== '' ? parseInt(headCount, 10) : null,
          allergyNotes: allergyNotes || null,
          foodOrderNotes: foodOrderNotes || null,
          repHandlesOrder: !!repHandlesOrder,
        } : {}),
      },
    });

    res.status(201).json(slot);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create slot' });
  }
});

// --- Office staff: add or update lunch order details on one of their slots -
router.patch('/:id/lunch-details', requireAuth, async (req, res) => {
  if (!['office_admin', 'office_staff'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only office staff can edit lunch order details' });
  }
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff account not found' });

    const slot = await prisma.slot.findUnique({ where: { id: req.params.id } });
    if (!slot || slot.locationId !== staff.locationId) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    if (slot.eventType !== 'LUNCH') {
      return res.status(400).json({ error: 'Only lunch slots can have order details' });
    }

    const { headCount, allergyNotes, foodOrderNotes, repHandlesOrder, startTime, endTime } = req.body;
    if ((startTime && !endTime) || (!startTime && endTime)) {
      return res.status(400).json({ error: 'startTime and endTime must be updated together' });
    }
    if (startTime && endTime && new Date(endTime) <= new Date(startTime)) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    const updated = await prisma.slot.update({
      where: { id: slot.id },
      data: {
        headCount: headCount != null && headCount !== '' ? parseInt(headCount, 10) : null,
        allergyNotes: allergyNotes || null,
        foodOrderNotes: foodOrderNotes || null,
        repHandlesOrder: !!repHandlesOrder,
        ...(startTime && endTime ? { startTime: new Date(startTime), endTime: new Date(endTime) } : {}),
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update lunch order details' });
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
