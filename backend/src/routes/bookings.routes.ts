// Wires the booking engine service to real HTTP endpoints.
// Mount with: app.use('/api/bookings', bookingsRouter)

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireRole, requireVerifiedRep } from '../auth/auth.guard';
import { assertOwnsLocation } from '../auth/scoping';
import { claimOpenSlot, requestNewSlot, decideBooking, BookingError } from '../booking/booking.service';
import { PrismaClient } from '@prisma/client';
import { sendEmail } from '../email';

const prisma = new PrismaClient();
const router = Router();

// The backend's own public URL — used to build each rep's calendar feed
// link. Render sets RENDER_EXTERNAL_URL automatically; the literal fallback
// matches the API_BASE hardcoded in app.html.
const API_URL = process.env.RENDER_EXTERNAL_URL || 'https://arrowhead-access-api.onrender.com';

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function toIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function handleBookingError(err: unknown, res: any) {
  if (err instanceof BookingError) {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  console.error(err);
  return res.status(500).json({ error: 'Unexpected server error' });
}

// --- Rep: browse open slots at a location -------------------------------
router.get('/locations/:locationId/slots', requireAuth, requireVerifiedRep, async (req, res) => {
  const slots = await prisma.slot.findMany({
    where: { locationId: req.params.locationId, status: 'OPEN', startTime: { gte: new Date() } },
    orderBy: { startTime: 'asc' },
  });
  res.json(slots);
});

// --- Rep: claim an open slot ---------------------------------------------
router.post('/slots/:slotId/claim', requireAuth, requireVerifiedRep, async (req, res) => {
  try {
    const slot = await prisma.slot.findUniqueOrThrow({ where: { id: req.params.slotId } });
    const location = await prisma.location.findUniqueOrThrow({ where: { id: slot.locationId } });
    const booking = await claimOpenSlot({
      slotId: req.params.slotId,
      repId: req.user!.sub,
      requiresApproval: (location as any).requiresApprovalForOpenSlots ?? false,
      topic: req.body.topic,
    });
    res.status(201).json(booking);
  } catch (err) {
    handleBookingError(err, res);
  }
});

// --- Rep: request a new (non-listed) time --------------------------------
router.post('/locations/:locationId/request', requireAuth, requireVerifiedRep, async (req, res) => {
  try {
    const booking = await requestNewSlot({
      locationId: req.params.locationId,
      repId: req.user!.sub,
      startTime: new Date(req.body.startTime),
      endTime: new Date(req.body.endTime),
      topic: req.body.topic,
    });
    res.status(201).json(booking);
  } catch (err) {
    handleBookingError(err, res);
  }
});

// --- Rep: view own bookings ------------------------------------------------
router.get('/mine', requireAuth, requireRole('rep'), async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { repId: req.user!.sub },
    include: { slot: { include: { location: true } } },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(bookings);
});

// --- Rep: visit history (past visits that were actually confirmed) ------
router.get('/history', requireAuth, requireRole('rep'), async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: {
      repId: req.user!.sub,
      status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] },
      slot: { endTime: { lt: new Date() } },
    },
    include: { slot: { include: { location: true } } },
    orderBy: { slot: { startTime: 'desc' } },
  });
  res.json(bookings);
});

// --- Rep: get (or create) their private calendar subscription link -------
router.get('/calendar-link', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    let rep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
    if (!rep.calendarToken) {
      rep = await prisma.rep.update({
        where: { id: rep.id },
        data: { calendarToken: crypto.randomBytes(24).toString('hex') },
      });
    }
    const url = `${API_URL}/api/bookings/calendar/${rep.calendarToken}.ics`;
    res.json({ url, webcalUrl: url.replace(/^https?:\/\//, 'webcal://') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not get calendar link' });
  }
});

// --- Public: the actual .ics feed Google/Apple Calendar subscribes to ----
// No login here — the random token in the URL is the credential, same
// pattern most calendar apps use for "secret address" subscription links.
router.get('/calendar/:token', async (req, res) => {
  const token = req.params.token.replace(/\.ics$/i, '');
  const rep = await prisma.rep.findUnique({ where: { calendarToken: token } });
  if (!rep) return res.status(404).send('Calendar not found');

  const bookings = await prisma.booking.findMany({
    where: { repId: rep.id, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    include: { slot: { include: { location: true } } },
    orderBy: { slot: { startTime: 'asc' } },
  });

  const events = bookings.map(b => [
    'BEGIN:VEVENT',
    `UID:booking-${b.id}@arrowheadaccess.com`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(b.slot.startTime)}`,
    `DTEND:${toIcsDate(b.slot.endTime)}`,
    `SUMMARY:${icsEscape('Visit: ' + b.slot.location.name)}`,
    `LOCATION:${icsEscape(b.slot.location.address)}`,
    b.topic ? `DESCRIPTION:${icsEscape(b.topic)}` : null,
    'END:VEVENT',
  ].filter(Boolean).join('\r\n')).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Arrowhead Access//Rep Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Arrowhead Access Visits',
    events,
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="arrowhead-visits.ics"');
  res.send(ics);
});

// --- Office staff: view this location's ledger ---------------------------
router.get('/locations/:locationId/ledger', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    assertOwnsLocation(req, req.params.locationId);
  } catch (err) {
    return res.status(403).json({ error: (err as Error).message });
  }
  const slots = await prisma.slot.findMany({
    where: { locationId: req.params.locationId },
    include: { booking: { include: { rep: true } } },
    orderBy: { startTime: 'asc' },
  });
  res.json(slots);
});

// --- Office staff: visit history (past slots with a confirmed visit) ----
router.get('/locations/:locationId/history', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    assertOwnsLocation(req, req.params.locationId);
  } catch (err) {
    return res.status(403).json({ error: (err as Error).message });
  }
  const slots = await prisma.slot.findMany({
    where: {
      locationId: req.params.locationId,
      endTime: { lt: new Date() },
      booking: { status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] } },
    },
    include: { booking: { include: { rep: true } } },
    orderBy: { startTime: 'desc' },
  });
  res.json(slots);
});

// --- Office staff: open a new slot ----------------------------------------
router.post('/locations/:locationId/slots', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    assertOwnsLocation(req, req.params.locationId);
  } catch (err) {
    return res.status(403).json({ error: (err as Error).message });
  }
  const slot = await prisma.slot.create({
    data: {
      locationId: req.params.locationId,
      startTime: new Date(req.body.startTime),
      endTime: new Date(req.body.endTime),
      status: 'OPEN',
      createdByStaffId: req.user!.sub,
    },
    include: { location: true },
  });

  // Notify reps who've had a confirmed visit at this location before.
  const pastReps = await prisma.rep.findMany({
    where: { bookings: { some: { status: 'CONFIRMED', slot: { locationId: req.params.locationId } } } },
    select: { email: true },
  });
  if (pastReps.length) {
    const dateStr = slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    for (const rep of pastReps) {
      sendEmail({
        to: rep.email,
        subject: `New open slot at ${slot.location.name}`,
        html: `<p><strong>${slot.location.name}</strong>, a location you've visited before, just posted a new open slot on ${dateStr}. Log in to claim it before someone else does.</p>`,
      }).catch(() => {});
    }
  }

  res.status(201).json(slot);
});

// --- Office staff: approve or decline a request ---------------------------
router.post('/:bookingId/decide', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const { decision } = req.body; // 'approve' | 'decline'
    const booking = await decideBooking({ bookingId: req.params.bookingId, decision, staffId: req.user!.sub });

    const full = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (full) {
      const dateStr = full.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const approved = decision === 'approve';
      sendEmail({
        to: full.rep.email,
        subject: approved ? 'Your visit request was approved' : 'Your visit request was declined',
        html: `<p>Your visit request at <strong>${full.slot.location.name}</strong> on ${dateStr} was ${approved ? 'approved' : 'declined'}.</p>`,
      }).catch(() => {});
    }

    res.json(booking);
  } catch (err) {
    handleBookingError(err, res);
  }
});

// --- Rep: view the attendee list logged for one of their own bookings -----
router.get('/:bookingId/attendees', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking || booking.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const attendees = await prisma.visitAttendee.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(attendees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch attendees' });
  }
});

// --- Rep: log/replace the attendee list for one of their own bookings -----
// For their own expense-report records. NPI is optional.
router.post('/:bookingId/attendees', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking || booking.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const attendees = Array.isArray(req.body.attendees) ? req.body.attendees : [];
    const cleaned = attendees
      .map((a: any) => ({
        firstName: String(a.firstName || '').trim(),
        lastName: String(a.lastName || '').trim(),
        npi: a.npi ? String(a.npi).trim() : null,
      }))
      .filter((a: any) => a.firstName && a.lastName);

    await prisma.$transaction([
      prisma.visitAttendee.deleteMany({ where: { bookingId: req.params.bookingId } }),
      prisma.visitAttendee.createMany({
        data: cleaned.map((a: any) => ({ ...a, bookingId: req.params.bookingId })),
      }),
    ]);

    const saved = await prisma.visitAttendee.findMany({
      where: { bookingId: req.params.bookingId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save attendees' });
  }
});

// --- Daily lunch-reminder check, called by a scheduled trigger --------------
// Not behind requireAuth — guarded by the same shared cron secret used for
// the renewal-reminder check. Sends a rep one email the calendar day before
// a confirmed lunch, and one on the day of.
router.post('/check-lunch-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        slot: { eventType: 'LUNCH' },
        OR: [{ lunchReminder1dSent: false }, { lunchReminderDaySent: false }],
      },
      include: { rep: true, slot: { include: { location: true } } },
    });

    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const todayStart = startOfDay(now).getTime();

    let remindersSent = 0;

    for (const booking of bookings) {
      const lunchDayStart = startOfDay(booking.slot.startTime).getTime();
      const dayDiff = Math.round((lunchDayStart - todayStart) / (1000 * 60 * 60 * 24));
      const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

      if (dayDiff === 1 && !booking.lunchReminder1dSent) {
        await sendEmail({
          to: booking.rep.email,
          subject: `Reminder: lunch at ${booking.slot.location.name} tomorrow`,
          html: `<p>Just a reminder — you have a lunch scheduled at <strong>${booking.slot.location.name}</strong> tomorrow, ${dateStr}.</p>`,
        });
        await prisma.booking.update({ where: { id: booking.id }, data: { lunchReminder1dSent: true } });
        remindersSent++;
      } else if (dayDiff === 0 && !booking.lunchReminderDaySent) {
        await sendEmail({
          to: booking.rep.email,
          subject: `Reminder: lunch at ${booking.slot.location.name} today`,
          html: `<p>Just a reminder — you have a lunch scheduled at <strong>${booking.slot.location.name}</strong> today, ${dateStr}.</p>`,
        });
        await prisma.booking.update({ where: { id: booking.id }, data: { lunchReminderDaySent: true } });
        remindersSent++;
      }
    }

    res.json({ checked: bookings.length, remindersSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check lunch reminders' });
  }
});

export default router;
