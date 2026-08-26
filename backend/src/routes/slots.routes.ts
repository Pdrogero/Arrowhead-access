// src/routes/slots.routes.ts
// Lets office staff post open visiting slots, and lets verified reps browse
// and claim them. Mount with: app.use('/api/slots', slotsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();

// Months to add per repeat interval, for duplicating a lunch's schedule
// (and its headcount/allergy/order details) forward in time so an office
// doesn't have to re-enter the same recurring lunch over and over.
const REPEAT_INTERVAL_MONTHS: Record<string, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};
const REPEAT_HORIZON_YEARS = 2;

const DAY_NAME_TO_INDEX: Record<string, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
};

// Adds N months to a date, clamping to the last valid day of the target
// month (e.g. Jan 31 + 1mo -> Feb 28, not the JS default of overflowing
// into March 3). Always computed from the given date rather than chained
// from a prior result, so a lunch on the 31st lands on the 28th in
// February but goes right back to the 31st in March instead of drifting
// permanently to the 28th.
function addMonthsPreserveTime(date: Date, months: number): Date {
  const d = new Date(date);
  const originalDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(originalDay, daysInTargetMonth));
  return d;
}

// --- Office staff: post a new open slot at their own location -------------
router.post('/', requireAuth, async (req, res) => {
  if (!['office_admin', 'office_staff'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only office staff can post slots' });
  }
  try {
    const { startTime, endTime, eventType, headCount, allergyNotes, foodOrderNotes, repHandlesOrder, repeatInterval, daysOfWeek } = req.body;
    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff account not found' });

    const lunchDetails = eventType === 'LUNCH' ? {
      headCount: headCount != null && headCount !== '' ? parseInt(headCount, 10) : null,
      allergyNotes: allergyNotes || null,
      foodOrderNotes: foodOrderNotes || null,
      repHandlesOrder: !!repHandlesOrder,
    } : {};

    // A lunch posted for specific weekdays (e.g. every Mon/Wed) replaces the
    // single-slot + same-date-repeat path below: startTime/endTime supply
    // the starting date, time-of-day, and duration, and a slot is created
    // for every matching weekday out to the chosen repeat length (or just
    // the current week if no repeat length was chosen).
    if (eventType === 'LUNCH' && Array.isArray(daysOfWeek) && daysOfWeek.length) {
      const selectedDays: number[] = daysOfWeek
        .map((d: string) => DAY_NAME_TO_INDEX[d])
        .filter((i: number | undefined): i is number => i !== undefined);
      if (!selectedDays.length) {
        return res.status(400).json({ error: 'daysOfWeek contains no valid day names' });
      }

      const origStart = new Date(startTime);
      const origEnd = new Date(endTime);
      const durationMs = origEnd.getTime() - origStart.getTime();
      const months = REPEAT_INTERVAL_MONTHS[repeatInterval];
      const horizon = months
        ? addMonthsPreserveTime(origStart, months)
        : new Date(origStart.getTime() + 7 * 24 * 60 * 60 * 1000);

      const created = [];
      const cursor = new Date(origStart);
      cursor.setHours(0, 0, 0, 0);
      while (cursor < horizon) {
        if (selectedDays.includes(cursor.getDay())) {
          const occStart = new Date(cursor);
          occStart.setHours(origStart.getHours(), origStart.getMinutes(), 0, 0);
          if (occStart >= origStart) {
            created.push({
              locationId: staff.locationId,
              startTime: occStart,
              endTime: new Date(occStart.getTime() + durationMs),
              status: 'OPEN' as const,
              eventType: 'LUNCH' as const,
              createdByStaffId: staff.id,
              ...lunchDetails,
            });
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }

      if (!created.length) {
        return res.status(400).json({ error: 'No matching days fall between the start time and the repeat length chosen' });
      }
      await prisma.slot.createMany({ data: created });
      return res.status(201).json({ created: created.length });
    }

    const slot = await prisma.slot.create({
      data: {
        locationId: staff.locationId,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: 'OPEN',
        eventType: eventType || 'REP_VISIT',
        createdByStaffId: staff.id,
        ...lunchDetails,
      },
    });

    const months = eventType === 'LUNCH' ? REPEAT_INTERVAL_MONTHS[repeatInterval] : undefined;
    if (months) {
      const horizon = new Date(startTime);
      horizon.setFullYear(horizon.getFullYear() + REPEAT_HORIZON_YEARS);

      const origStart = new Date(startTime);
      const origEnd = new Date(endTime);
      const repeats = [];
      for (let i = 1; ; i++) {
        const occStart = addMonthsPreserveTime(origStart, months * i);
        if (occStart >= horizon) break;
        repeats.push({
          locationId: staff.locationId,
          startTime: occStart,
          endTime: addMonthsPreserveTime(origEnd, months * i),
          status: 'OPEN' as const,
          eventType: 'LUNCH' as const,
          createdByStaffId: staff.id,
          ...lunchDetails,
        });
      }
      if (repeats.length) await prisma.slot.createMany({ data: repeats });
    }

    res.status(201).json({ created: 1, slot });
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
