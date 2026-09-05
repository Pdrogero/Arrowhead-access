// Wires the booking engine service to real HTTP endpoints.
// Mount with: app.use('/api/bookings', bookingsRouter)

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireRole, requireVerifiedRep, requireActiveSubscription } from '../auth/auth.guard';
import { assertOwnsLocation, assertOwnsRep } from '../auth/scoping';
import { claimOpenSlot, requestNewSlot, decideBooking, BookingError } from '../booking/booking.service';
import { PrismaClient } from '@prisma/client';
import { sendEmail, emailLogoHeader, emailLoginButton } from '../email';

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
// Claiming never auto-confirms — it always creates a REQUESTED booking so
// the office gets a chance to approve or decline it (see check-expired-
// requests below, which reopens the slot if they don't respond in 3 days).
router.post('/slots/:slotId/claim', requireAuth, requireVerifiedRep, requireActiveSubscription, async (req, res) => {
  try {
    const booking = await claimOpenSlot({
      slotId: req.params.slotId,
      repId: req.user!.sub,
      requiresApproval: true,
      topic: req.body.topic,
    });

    const full = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (full) {
      const dateStr = full.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      sendEmail({
        to: full.rep.email,
        subject: `Request sent — ${full.slot.location.name}`,
        html: `${emailLogoHeader()}<p>Your request to visit <strong>${full.slot.location.name}</strong> on ${dateStr} has been sent to the office. They have 3 days to approve or decline it — if they don't respond, the slot automatically reopens for other reps.</p>`,
      }).catch(() => {});

      const staff = await prisma.staffUser.findMany({ where: { locationId: full.slot.locationId } });
      for (const s of staff) {
        sendEmail({
          to: s.email,
          subject: `New visit request from ${full.rep.name}`,
          html: `${emailLogoHeader()}<p><strong>${full.rep.name}</strong>${full.rep.companyName ? ` (${full.rep.companyName})` : ''} has requested your ${dateStr} slot. Log in to approve or decline — if there's no response within 3 days, it automatically reopens.</p>`,
        }).catch(() => {});
      }
    }

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
// Cancelled/declined bookings drop off this list on their own once the
// visit's date has passed (nothing to act on anymore), or sooner if the rep
// dismisses one manually via POST /:bookingId/hide-from-bookings below.
router.get('/mine', requireAuth, requireRole('rep'), async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: {
      repId: req.user!.sub,
      hiddenFromRepBookings: false,
      OR: [
        { status: { notIn: ['CANCELLED', 'DECLINED'] } },
        { slot: { startTime: { gte: new Date() } } },
      ],
    },
    include: { slot: { include: { location: true } } },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(bookings);
});

// --- Rep: dismiss a cancelled/declined booking from "Your bookings" -------
router.post('/:bookingId/hide-from-bookings', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking || booking.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.status !== 'CANCELLED' && booking.status !== 'DECLINED') {
      return res.status(400).json({ error: 'Only cancelled or declined bookings can be removed from this list' });
    }
    await prisma.booking.update({ where: { id: booking.id }, data: { hiddenFromRepBookings: true } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove booking' });
  }
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
  // Defaults to today onward so the office lands on what's current instead
  // of scrolling past months of old entries — past visits still live under
  // Visit History. A still-pending request always shows regardless of its
  // slot's date, so nothing waiting on a decision quietly falls off the
  // list. The office calendar's month-back navigation needs full history
  // though, so it passes ?scope=all to opt out of this filter.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const slots = await prisma.slot.findMany({
    where: {
      locationId: req.params.locationId,
      ...(req.query.scope === 'all' ? {} : { OR: [{ startTime: { gte: todayStart } }, { status: 'REQUESTED' }] }),
    },
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
        html: `${emailLogoHeader()}<p><strong>${slot.location.name}</strong>, a location you've visited before, just posted a new open slot on ${dateStr}. Log in to claim it before someone else does.</p>`,
      }).catch(() => {});
    }
  }

  res.status(201).json(slot);
});

// --- Office staff: remove an open slot that hasn't been booked ------------
// --- Office staff: remove several open, unbooked slots at once, e.g. to ---
// clean up a batch of slots that were generated with a wrong time and need
// to be deleted before recreating the recurring schedule correctly.
router.post('/slots/bulk-delete', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const slotIds = Array.isArray(req.body.slotIds)
      ? req.body.slotIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    if (!slotIds.length) return res.status(400).json({ error: 'Select at least one slot to remove' });

    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    // Only ever deletes this staff member's own location's OPEN (unbooked)
    // slots — same restriction as the single-slot delete below, just
    // applied as a where clause instead of a per-slot check.
    const result = await prisma.slot.deleteMany({
      where: { id: { in: slotIds }, locationId: staff.locationId, status: 'OPEN' },
    });

    res.json({ removed: result.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove these slots' });
  }
});

router.delete('/slots/:slotId', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const slot = await prisma.slot.findUnique({ where: { id: req.params.slotId } });
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    try {
      assertOwnsLocation(req, slot.locationId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (slot.status !== 'OPEN') {
      return res.status(409).json({ error: 'Only open, unbooked slots can be removed this way' });
    }

    await prisma.slot.delete({ where: { id: slot.id } });
    res.json({ message: 'Removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove this slot' });
  }
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
        html: `${emailLogoHeader()}<p>Your visit request at <strong>${full.slot.location.name}</strong> on ${dateStr} was ${approved ? 'approved' : 'declined'}.</p>${approved ? emailLoginButton() : ''}`,
      }).catch(() => {});
    }

    res.json(booking);
  } catch (err) {
    handleBookingError(err, res);
  }
});

// --- Office staff: cancel a confirmed visit, with a reason sent to the rep -
router.post('/:bookingId/cancel', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsLocation(req, booking.slot.locationId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CONFIRMED') {
      return res.status(409).json({ error: 'Only confirmed visits can be cancelled this way' });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation reason is required so the rep understands why' });

    let suggestedRescheduleAt: Date | null = null;
    if (req.body.suggestedTime) {
      const parsed = new Date(req.body.suggestedTime);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'That suggested time is not valid' });
      suggestedRescheduleAt = parsed;
    }

    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED', cancelReason: reason, cancelledBy: 'OFFICE', decidedAt: new Date(), suggestedRescheduleAt },
      }),
      prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'CANCELLED' } }),
    ]);

    const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const suggestionHtml = suggestedRescheduleAt
      ? `<p>The office would like to suggest rescheduling to <strong>${suggestedRescheduleAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>. Log in to Arrowhead Access to accept or decline that time.</p>`
      : '';
    sendEmail({
      to: booking.rep.email,
      subject: `Your visit at ${booking.slot.location.name} on ${dateStr} was cancelled`,
      html: `${emailLogoHeader()}<p>Your visit at <strong>${booking.slot.location.name}</strong> on ${dateStr} has been cancelled by the office.</p><p><strong>Reason:</strong> ${reason}</p>${suggestionHtml}`,
    }).catch(() => {});

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel this visit' });
  }
});

// --- Office staff: undo a cancellation they just made ----------------------
// Only for a cancellation the office itself made (not one the rep
// initiated — that's the rep's call to reverse, not the office's), the
// visit hasn't already passed, and the rep hasn't already responded to a
// suggested reschedule (accepting one creates a separate new booking, so
// restoring this one at that point would just create a confusing duplicate).
router.post('/:bookingId/undo-cancel', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsLocation(req, booking.slot.locationId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CANCELLED' || booking.cancelledBy !== 'OFFICE') {
      return res.status(409).json({ error: 'Only a cancellation your office made can be undone this way' });
    }
    if (booking.rescheduleResponse) {
      return res.status(409).json({ error: 'The rep already responded to your reschedule suggestion, so this can\'t be undone — message them directly instead.' });
    }
    if (booking.slot.startTime.getTime() < Date.now()) {
      return res.status(409).json({ error: 'This visit\'s time has already passed' });
    }

    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CONFIRMED',
          cancelReason: null,
          cancelledBy: null,
          suggestedRescheduleAt: null,
        },
      }),
      prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'CONFIRMED' } }),
    ]);

    const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    sendEmail({
      to: booking.rep.email,
      subject: `${booking.slot.location.name} restored your visit on ${dateStr}`,
      html: `${emailLogoHeader()}<p>Good news — <strong>${booking.slot.location.name}</strong> undid their cancellation. Your visit on ${dateStr} is confirmed again.</p>${emailLoginButton()}`,
    }).catch(() => {});

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not undo this cancellation' });
  }
});

// --- Rep: cancel a confirmed visit, with a reason sent to the office -------
router.post('/:bookingId/cancel-by-rep', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsRep(req, booking.repId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CONFIRMED') {
      return res.status(409).json({ error: 'Only confirmed visits can be cancelled this way' });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation reason is required so the office understands why' });

    let suggestedRescheduleAt: Date | null = null;
    if (req.body.suggestedTime) {
      const parsed = new Date(req.body.suggestedTime);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'That suggested time is not valid' });
      suggestedRescheduleAt = parsed;
    }

    const rep = await prisma.rep.findUniqueOrThrow({ where: { id: booking.repId } });

    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED', cancelReason: reason, cancelledBy: 'REP', decidedAt: new Date(), suggestedRescheduleAt },
      }),
      prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'CANCELLED' } }),
    ]);

    const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const suggestionHtml = suggestedRescheduleAt
      ? `<p>${rep.name} would like to suggest rescheduling to <strong>${suggestedRescheduleAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>. Log in to Arrowhead Access to accept or decline that time.</p>`
      : '';
    const staff = await prisma.staffUser.findMany({ where: { locationId: booking.slot.locationId } });
    staff.forEach(s => {
      sendEmail({
        to: s.email,
        subject: `${rep.name} cancelled their visit on ${dateStr}`,
        html: `${emailLogoHeader()}<p><strong>${rep.name}</strong> (${rep.companyName}) cancelled their visit at <strong>${booking.slot.location.name}</strong> on ${dateStr}.</p><p><strong>Reason:</strong> ${reason}</p>${suggestionHtml}`,
      }).catch(() => {});
    });

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel this visit' });
  }
});

// --- Rep: undo a cancellation they just made --------------------------
// Mirrors the office's undo-cancel above — only for a cancellation the
// rep themselves made, the visit hasn't already passed, and the office
// hasn't already responded to a suggested reschedule (accepting one
// creates a separate new booking, so undoing at that point would just
// create a confusing duplicate).
router.post('/:bookingId/undo-cancel-by-rep', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsRep(req, booking.repId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CANCELLED' || booking.cancelledBy !== 'REP') {
      return res.status(409).json({ error: 'Only a cancellation you made can be undone this way' });
    }
    if (booking.rescheduleResponse) {
      return res.status(409).json({ error: 'The office already responded to your reschedule suggestion, so this can\'t be undone — message them directly instead.' });
    }
    if (booking.slot.startTime.getTime() < Date.now()) {
      return res.status(409).json({ error: 'This visit\'s time has already passed' });
    }

    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CONFIRMED',
          cancelReason: null,
          cancelledBy: null,
          suggestedRescheduleAt: null,
        },
      }),
      prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'CONFIRMED' } }),
    ]);

    const undoDateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const undoStaff = await prisma.staffUser.findMany({ where: { locationId: booking.slot.locationId } });
    undoStaff.forEach(s => {
      sendEmail({
        to: s.email,
        subject: `${booking.rep.name} restored their visit on ${undoDateStr}`,
        html: `${emailLogoHeader()}<p><strong>${booking.rep.name}</strong> (${booking.rep.companyName}) undid their cancellation. Their visit at <strong>${booking.slot.location.name}</strong> on ${undoDateStr} is confirmed again.</p>`,
      }).catch(() => {});
    });

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not undo this cancellation' });
  }
});

// --- Rep: undo a claim made by accident, before the office has acted -------
// Only for a still-pending request — a confirmed visit is a real
// commitment the office has already made, so that goes through
// cancel-by-rep above instead. Withdrawing removes the request entirely
// (rather than leaving a CANCELLED record) and reopens the slot, since as
// far as the office is concerned nothing happened.
router.post('/:bookingId/withdraw', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.bookingId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsRep(req, booking.repId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'REQUESTED') {
      return res.status(409).json({ error: 'Only a pending request can be withdrawn this way' });
    }

    await prisma.$transaction([
      prisma.bookingTransfer.deleteMany({ where: { bookingId: booking.id } }),
      prisma.booking.delete({ where: { id: booking.id } }),
      prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'OPEN' } }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not withdraw this request' });
  }
});

// --- Rep: accept or decline a reschedule the office suggested --------------
router.post('/:bookingId/reschedule/respond', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsRep(req, booking.repId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CANCELLED' || !booking.suggestedRescheduleAt || booking.cancelledBy !== 'OFFICE') {
      return res.status(409).json({ error: 'There is no suggested reschedule to respond to' });
    }
    if (booking.rescheduleResponse) {
      return res.status(409).json({ error: 'You already responded to this suggestion' });
    }

    const decision = req.body.decision === 'accept' ? 'ACCEPTED' : req.body.decision === 'decline' ? 'DECLINED' : null;
    if (!decision) return res.status(400).json({ error: "decision must be 'accept' or 'decline'" });

    const message = String(req.body.message || '').trim();
    if (decision === 'DECLINED' && !message) {
      return res.status(400).json({ error: 'A message is required so the office knows why' });
    }

    const rep = await prisma.rep.findUniqueOrThrow({ where: { id: booking.repId } });
    let newBooking = null;

    if (decision === 'ACCEPTED') {
      const duration = booking.slot.endTime.getTime() - booking.slot.startTime.getTime();
      const newSlot = await prisma.slot.create({
        data: {
          locationId: booking.slot.locationId,
          startTime: booking.suggestedRescheduleAt,
          endTime: new Date(booking.suggestedRescheduleAt.getTime() + duration),
          status: 'CONFIRMED',
          eventType: booking.slot.eventType,
        },
      });
      newBooking = await prisma.booking.create({
        data: {
          slotId: newSlot.id,
          repId: booking.repId,
          topic: booking.topic,
          status: 'CONFIRMED',
          decidedAt: new Date(),
        },
      });
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        rescheduleResponse: decision,
        rescheduleResponseMessage: message || null,
        rescheduleRespondedAt: new Date(),
        rescheduledBookingId: newBooking?.id || null,
      },
    });

    const staff = await prisma.staffUser.findMany({ where: { locationId: booking.slot.locationId } });
    const newDateStr = booking.suggestedRescheduleAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const subject = decision === 'ACCEPTED'
      ? `${rep.name} accepted your suggested reschedule to ${newDateStr}`
      : `${rep.name} declined your suggested reschedule to ${newDateStr}`;
    const html = emailLogoHeader() + (decision === 'ACCEPTED'
      ? `<p><strong>${rep.name}</strong> (${rep.companyName}) accepted your suggested reschedule to <strong>${newDateStr}</strong> — it's now on the calendar as confirmed.</p>${message ? `<p>Their message: "${message}"</p>` : ''}`
      : `<p><strong>${rep.name}</strong> (${rep.companyName}) declined your suggested reschedule to <strong>${newDateStr}</strong>.</p><p>Their message: "${message}"</p>`);
    staff.forEach(s => {
      sendEmail({ to: s.email, subject, html }).catch(() => {});
    });

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your response' });
  }
});

// --- Office staff: accept or decline a reschedule the rep suggested --------
router.post('/:bookingId/reschedule/office-respond', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    try {
      assertOwnsLocation(req, booking.slot.locationId);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }

    if (booking.status !== 'CANCELLED' || !booking.suggestedRescheduleAt || booking.cancelledBy !== 'REP') {
      return res.status(409).json({ error: 'There is no suggested reschedule to respond to' });
    }
    if (booking.rescheduleResponse) {
      return res.status(409).json({ error: 'You already responded to this suggestion' });
    }

    const decision = req.body.decision === 'accept' ? 'ACCEPTED' : req.body.decision === 'decline' ? 'DECLINED' : null;
    if (!decision) return res.status(400).json({ error: "decision must be 'accept' or 'decline'" });

    const message = String(req.body.message || '').trim();
    if (decision === 'DECLINED' && !message) {
      return res.status(400).json({ error: 'A message is required so the rep knows why' });
    }

    let newBooking = null;

    if (decision === 'ACCEPTED') {
      const duration = booking.slot.endTime.getTime() - booking.slot.startTime.getTime();
      const newSlot = await prisma.slot.create({
        data: {
          locationId: booking.slot.locationId,
          startTime: booking.suggestedRescheduleAt,
          endTime: new Date(booking.suggestedRescheduleAt.getTime() + duration),
          status: 'CONFIRMED',
          eventType: booking.slot.eventType,
        },
      });
      newBooking = await prisma.booking.create({
        data: {
          slotId: newSlot.id,
          repId: booking.repId,
          topic: booking.topic,
          status: 'CONFIRMED',
          decidedAt: new Date(),
        },
      });
    }

    const updatedBooking = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        rescheduleResponse: decision,
        rescheduleResponseMessage: message || null,
        rescheduleRespondedAt: new Date(),
        rescheduledBookingId: newBooking?.id || null,
      },
    });

    const newDateStr = booking.suggestedRescheduleAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const subject = decision === 'ACCEPTED'
      ? `${booking.slot.location.name} accepted your suggested reschedule to ${newDateStr}`
      : `${booking.slot.location.name} declined your suggested reschedule to ${newDateStr}`;
    const html = emailLogoHeader() + (decision === 'ACCEPTED'
      ? `<p><strong>${booking.slot.location.name}</strong> accepted your suggested reschedule to <strong>${newDateStr}</strong> — it's now on your calendar as confirmed.</p>${message ? `<p>Their message: "${message}"</p>` : ''}`
      : `<p><strong>${booking.slot.location.name}</strong> declined your suggested reschedule to <strong>${newDateStr}</strong>.</p><p>Their message: "${message}"</p>`);
    sendEmail({ to: booking.rep.email, subject, html }).catch(() => {});

    res.json(updatedBooking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save your response' });
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
          html: `${emailLogoHeader()}<p>Just a reminder — you have a lunch scheduled at <strong>${booking.slot.location.name}</strong> tomorrow, ${dateStr}.</p>`,
        });
        await prisma.booking.update({ where: { id: booking.id }, data: { lunchReminder1dSent: true } });
        remindersSent++;
      } else if (dayDiff === 0 && !booking.lunchReminderDaySent) {
        await sendEmail({
          to: booking.rep.email,
          subject: `Reminder: lunch at ${booking.slot.location.name} today`,
          html: `${emailLogoHeader()}<p>Just a reminder — you have a lunch scheduled at <strong>${booking.slot.location.name}</strong> today, ${dateStr}.</p>`,
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

// --- Daily check: nudge offices about pending requests, then auto-decline -
// the ones they never answered. A REQUESTED booking gives the office 3
// days to approve or decline: at the 1-day mark (with no response yet)
// this emails the office a one-time reminder, and past the 3-day mark it
// declines the request and reopens the slot so other reps can grab it,
// rather than leaving it stuck pending forever.
router.post('/check-expired-requests', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const dueForReminder = await prisma.booking.findMany({
      where: { status: 'REQUESTED', officeReminderSent: false, requestedAt: { lte: oneDayAgo, gt: threeDaysAgo } },
      include: { rep: true, slot: { include: { location: true } } },
    });

    for (const booking of dueForReminder) {
      const staff = await prisma.staffUser.findMany({ where: { locationId: booking.slot.locationId } });
      const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      staff.forEach(s => {
        sendEmail({
          to: s.email,
          subject: `Reminder: pending visit request from ${booking.rep.name}`,
          html: `${emailLogoHeader()}<p>You still have a pending request from <strong>${booking.rep.name}</strong>${booking.rep.companyName ? ` (${booking.rep.companyName})` : ''} for ${dateStr}. Log in to approve or decline it — if there's no response within 3 days of the original request, it automatically reopens for other reps.</p>${emailLoginButton()}`,
        }).catch(() => {});
      });
      await prisma.booking.update({ where: { id: booking.id }, data: { officeReminderSent: true } });
    }

    const expired = await prisma.booking.findMany({
      where: { status: 'REQUESTED', requestedAt: { lte: threeDaysAgo } },
      include: { rep: true, slot: { include: { location: true } } },
    });

    for (const booking of expired) {
      await prisma.$transaction([
        prisma.slot.update({ where: { id: booking.slotId }, data: { status: 'OPEN' } }),
        prisma.booking.update({ where: { id: booking.id }, data: { status: 'DECLINED', decidedAt: new Date() } }),
      ]);
      const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      sendEmail({
        to: booking.rep.email,
        subject: `Request expired — ${booking.slot.location.name}`,
        html: `${emailLogoHeader()}<p>The office at <strong>${booking.slot.location.name}</strong> didn't respond to your request for ${dateStr} within 3 days, so it's been released back to the open slots list. Feel free to request it again or find another time.</p>`,
      }).catch(() => {});
    }

    res.json({ reminded: dueForReminder.length, expired: expired.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check expired requests' });
  }
});

// --- Rep: manually nudge the office about a pending request ---------------
// Rate-limited to once every 24 hours per booking so a rep can't spam the
// office — separate from (and in addition to) the automatic 1-day reminder
// above, for when a rep wants to give it a friendly push themselves.
router.post('/:bookingId/nudge', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: { rep: true, slot: { include: { location: true } } },
    });
    if (!booking || booking.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: 'This request has already been decided' });
    }
    if (booking.lastNudgedAt && Date.now() - booking.lastNudgedAt.getTime() < 24 * 60 * 60 * 1000) {
      return res.status(429).json({ error: 'You can nudge this office once every 24 hours.' });
    }

    const staff = await prisma.staffUser.findMany({ where: { locationId: booking.slot.locationId } });
    const dateStr = booking.slot.startTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    staff.forEach(s => {
      sendEmail({
        to: s.email,
        subject: `Friendly reminder: ${booking.rep.name} is still waiting on your response`,
        html: `${emailLogoHeader()}<p><strong>${booking.rep.name}</strong>${booking.rep.companyName ? ` (${booking.rep.companyName})` : ''} sent a friendly reminder about their pending request for ${dateStr}. Log in to approve or decline it.</p>${emailLoginButton()}`,
      }).catch(() => {});
    });

    await prisma.booking.update({ where: { id: booking.id }, data: { lastNudgedAt: new Date() } });
    res.json({ message: 'Nudge sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send nudge' });
  }
});

// --- Monthly new-month reminder, called by the same daily scheduled -------
// trigger — a no-op on every day except the 1st. Nudges offices to set up
// their lunch schedule for the new month, and reps to book their visits,
// each with a link back into the app.
router.post('/check-monthly-schedule-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  if (now.getDate() !== 1) {
    return res.json({ skipped: true, reason: 'Not the 1st of the month' });
  }

  try {
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const appUrl = process.env.APP_URL;

    const locations = await prisma.location.findMany({
      where: { OR: [{ lastMonthlyReminderMonth: null }, { lastMonthlyReminderMonth: { not: monthKey } }] },
      include: { staff: true },
    });
    let officeRemindersSent = 0;
    for (const location of locations) {
      for (const staff of location.staff) {
        sendEmail({
          to: staff.email,
          subject: `Set up your ${monthLabel} lunch schedule on Arrowhead Access`,
          html: `${emailLogoHeader()}<p>A new month has started — now's a good time to set up your lunch schedule and open slots for <strong>${monthLabel}</strong> so reps know when they're welcome to visit.</p><p><a href="${appUrl}/app.html">Log in to Arrowhead Access</a> to post open slots or set up recurring lunches.</p>`,
        }).catch(() => {});
      }
      await prisma.location.update({ where: { id: location.id }, data: { lastMonthlyReminderMonth: monthKey } });
      officeRemindersSent++;
    }

    const reps = await prisma.rep.findMany({
      where: {
        OR: [{ lastMonthlyReminderMonth: null }, { lastMonthlyReminderMonth: { not: monthKey } }],
        verificationStatus: 'VERIFIED',
      },
    });
    let repRemindersSent = 0;
    for (const rep of reps) {
      sendEmail({
        to: rep.email,
        subject: `Book your ${monthLabel} visits on Arrowhead Access`,
        html: `${emailLogoHeader()}<p>A new month has started — now's a good time to book your visits for <strong>${monthLabel}</strong> before the best times get taken.</p><p><a href="${appUrl}/app.html">Log in to Arrowhead Access</a> to browse open slots and book now.</p>`,
      }).catch(() => {});
      await prisma.rep.update({ where: { id: rep.id }, data: { lastMonthlyReminderMonth: monthKey } });
      repRemindersSent++;
    }

    res.json({ officeRemindersSent, repRemindersSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check monthly schedule reminders' });
  }
});

export default router;
