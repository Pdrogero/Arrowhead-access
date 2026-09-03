// src/routes/slots.routes.ts
// Lets office staff post open visiting slots, and lets verified reps browse
// and claim them. Mount with: app.use('/api/slots', slotsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole, requireActiveSubscription } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';

const prisma = new PrismaClient();
const router = Router();

const EVENT_TYPE_LABEL: Record<string, string> = {
  REP_VISIT: 'Rep visit',
  LUNCH: 'Lunch',
  BREAKFAST: 'Breakfast',
  QUICK_VISIT: 'Quick visit',
  STAFF_TRAINING: 'Staff training',
};

// Emails every rep with an active subscription that a new open slot just
// went up at this office — mirrors the "Lunch Available" alert competitors
// send, so reps don't have to keep re-checking Open Slots by hand. Fired
// once per post action (not once per recurring occurrence generated from
// it), and skipped for OFFICE_CLOSED placeholders since those aren't a
// bookable opportunity. Best-effort: a failure here never blocks the
// office's slot-posting request.
async function notifyRepsOfNewSlot(locationId: string, startTime: Date, eventType: string) {
  if (eventType === 'OFFICE_CLOSED') return;
  try {
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      include: { employees: { orderBy: { name: 'asc' } } },
    });
    if (!location) return;

    const reps = await prisma.rep.findMany({
      where: {
        verificationStatus: 'VERIFIED',
        subscriptionStatus: { in: ['TRIALING', 'ACTIVE'] },
        stripeSubscriptionId: { not: null },
      },
      select: { email: true },
    });
    if (!reps.length) return;

    const eventLabel = EVENT_TYPE_LABEL[eventType] || 'Visit';
    const whenStr = startTime.toLocaleString('en-US', {
      timeZone: location.timezone,
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const doctorsHtml = location.employees.length
      ? `<p><strong>Doctors at this office include:</strong><br>${location.employees.map(e => e.name + (e.title ? ` (${e.title})` : '')).join(', ')}</p>`
      : '';
    const viewUrl = `${process.env.APP_URL}/app.html?openSlots=1`;
    const html = `${emailLogoHeader()}
      <p><strong>${eventLabel} available at ${location.name}</strong></p>
      <p>${whenStr}<br>${location.address}</p>
      ${doctorsHtml}
      <p><a href="${viewUrl}" style="display:inline-block;background:#2E6F5E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">View Open Slots</a></p>
      <p style="font-size:12px;color:#6b7280;">Act fast — open slots go quickly. This alert went out to every verified rep with an active Arrowhead Access subscription.</p>`;

    reps.forEach(rep => {
      sendEmail({ to: rep.email, subject: `${eventLabel} available at ${location.name}`, html }).catch(() => {});
    });
  } catch (err) {
    console.error('Failed to notify reps of new slot:', err);
  }
}

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
      notifyRepsOfNewSlot(staff.locationId, created[0].startTime, 'LUNCH');
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

    notifyRepsOfNewSlot(staff.locationId, slot.startTime, slot.eventType);
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
router.get('/open', requireAuth, requireRole('rep'), requireActiveSubscription, async (req, res) => {
  const slots = await prisma.slot.findMany({
    where: { status: 'OPEN', startTime: { gte: new Date() } },
    include: { location: true },
    orderBy: { startTime: 'asc' },
    take: 50,
  });
  res.json(slots);
});

// Claiming an open slot lives at POST /api/bookings/slots/:slotId/claim
// (bookings.routes.ts) — it goes through booking.service so a claim always
// creates a REQUESTED booking pending office approval, with the same
// frequency-cap checks as every other booking path. This route used to
// duplicate that logic with an instant-auto-confirm shortcut; removed so
// there's exactly one place a slot ever gets claimed.

export default router;
