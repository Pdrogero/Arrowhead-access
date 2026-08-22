// Wires the booking engine service to real HTTP endpoints.
// Mount with: app.use('/api/bookings', bookingsRouter)

import { Router } from 'express';
import { requireAuth, requireRole, requireVerifiedRep } from '../auth/auth.guard';
import { assertOwnsLocation } from '../auth/scoping';
import { claimOpenSlot, requestNewSlot, decideBooking, BookingError } from '../booking/booking.service';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

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
  });
  res.status(201).json(slot);
});

// --- Office staff: approve or decline a request ---------------------------
router.post('/:bookingId/decide', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const { decision } = req.body; // 'approve' | 'decline'
    const booking = await decideBooking({ bookingId: req.params.bookingId, decision, staffId: req.user!.sub });
    res.json(booking);
  } catch (err) {
    handleBookingError(err, res);
  }
});

export default router;
