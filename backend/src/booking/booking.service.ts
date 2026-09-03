// The core product logic. Every booking action goes through here — never
// mutate Slot/Booking status directly from a route handler.

import { PrismaClient, SlotStatus, BookingStatus } from '@prisma/client';

const prisma = new PrismaClient();

export class BookingError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// A rep can claim at most this many lunches, and separately this many
// breakfasts, at the same office in a trailing 30-day window (so up to 4
// meal bookings total), regardless of the office's own configurable visit
// cap — keeps one rep from claiming every meal slot in a month and
// shutting other reps out of that office's lunches/breakfasts entirely.
const MEALS_PER_TYPE_PER_REP_PER_LOCATION_CAP = 2;
const MEAL_EVENT_TYPES = ['LUNCH', 'BREAKFAST'];

// --- Frequency cap check -----------------------------------------------
// Counts CONFIRMED bookings for this rep (and separately, this rep's company)
// at this location in the trailing 30 days, and compares against the
// location's policy. Called inside a transaction so it's race-safe.
// `eventType`, when given, additionally enforces the fixed lunch/breakfast
// cap above — pass it whenever the slot being booked has a known type.

async function checkFrequencyCap(tx: any, locationId: string, repId: string, eventType?: string) {
  const location = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
  const rep = await tx.rep.findUniqueOrThrow({ where: { id: repId } });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const repVisits = await tx.booking.count({
    where: {
      repId,
      status: 'CONFIRMED',
      slot: { locationId },
      requestedAt: { gte: thirtyDaysAgo },
    },
  });
  if (repVisits >= location.maxVisitsPerRepPerMonth) {
    throw new BookingError(
      `This rep has already reached the ${location.maxVisitsPerRepPerMonth}-visit monthly limit at this location.`,
      'REP_CAP_REACHED'
    );
  }

  if (rep.companyName) {
    const companyVisits = await tx.booking.count({
      where: {
        status: 'CONFIRMED',
        slot: { locationId },
        requestedAt: { gte: thirtyDaysAgo },
        rep: { companyName: rep.companyName },
      },
    });
    if (companyVisits >= location.maxVisitsPerCompanyPerMonth) {
      throw new BookingError(
        `${rep.companyName} has already reached the ${location.maxVisitsPerCompanyPerMonth}-visit monthly limit at this location.`,
        'COMPANY_CAP_REACHED'
      );
    }
  }

  if (eventType && MEAL_EVENT_TYPES.includes(eventType)) {
    const mealVisits = await tx.booking.count({
      where: {
        repId,
        status: 'CONFIRMED',
        slot: { locationId, eventType },
        requestedAt: { gte: thirtyDaysAgo },
      },
    });
    if (mealVisits >= MEALS_PER_TYPE_PER_REP_PER_LOCATION_CAP) {
      const label = eventType === 'LUNCH' ? 'lunches' : 'breakfasts';
      throw new BookingError(
        `This rep has already claimed ${MEALS_PER_TYPE_PER_REP_PER_LOCATION_CAP} ${label} at this office this month.`,
        'MEAL_CAP_REACHED'
      );
    }
  }
}

// --- Claim an already-open slot -----------------------------------------
// If the location's policy requires approval even for open slots, this
// creates a REQUESTED booking instead of confirming immediately — pass
// `requiresApproval` from the location's own settings.

export async function claimOpenSlot(params: {
  slotId: string;
  repId: string;
  requiresApproval: boolean;
  topic?: string;
}) {
  const { slotId, repId, requiresApproval, topic } = params;

  return prisma.$transaction(async (tx) => {
    const slot = await tx.slot.findUniqueOrThrow({ where: { id: slotId } });
    if (slot.status !== SlotStatus.OPEN || slot.eventType === 'OFFICE_CLOSED') {
      throw new BookingError('This slot is no longer open.', 'SLOT_UNAVAILABLE');
    }

    const rep = await tx.rep.findUniqueOrThrow({ where: { id: repId } });
    if (rep.verificationStatus !== 'VERIFIED') {
      throw new BookingError('Only verified reps can book visits.', 'REP_NOT_VERIFIED');
    }

    await checkFrequencyCap(tx, slot.locationId, repId, slot.eventType);

    const newSlotStatus = requiresApproval ? SlotStatus.REQUESTED : SlotStatus.CONFIRMED;
    const newBookingStatus = requiresApproval ? BookingStatus.REQUESTED : BookingStatus.CONFIRMED;

    await tx.slot.update({ where: { id: slotId }, data: { status: newSlotStatus } });

    return tx.booking.create({
      data: {
        slotId,
        repId,
        topic,
        status: newBookingStatus,
        decidedAt: requiresApproval ? null : new Date(),
      },
    });
  });
}

// --- Request a new (non-listed) time ------------------------------------
// Only valid if the location allows open requests. Creates both the Slot
// and the Booking in REQUESTED state, routed to office staff.

export async function requestNewSlot(params: {
  locationId: string;
  repId: string;
  startTime: Date;
  endTime: Date;
  topic?: string;
}) {
  const { locationId, repId, startTime, endTime, topic } = params;

  return prisma.$transaction(async (tx) => {
    const rep = await tx.rep.findUniqueOrThrow({ where: { id: repId } });
    if (rep.verificationStatus !== 'VERIFIED') {
      throw new BookingError('Only verified reps can request visits.', 'REP_NOT_VERIFIED');
    }

    await checkFrequencyCap(tx, locationId, repId);

    const slot = await tx.slot.create({
      data: { locationId, startTime, endTime, status: SlotStatus.REQUESTED },
    });

    return tx.booking.create({
      data: { slotId: slot.id, repId, topic, status: BookingStatus.REQUESTED },
    });
  });
}

// --- Office staff approves or declines a request ------------------------

export async function decideBooking(params: {
  bookingId: string;
  decision: 'approve' | 'decline';
  staffId: string;
}) {
  const { bookingId, decision } = params;

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { slot: true },
    });
    if (booking.status !== BookingStatus.REQUESTED) {
      throw new BookingError('This booking has already been decided.', 'ALREADY_DECIDED');
    }

    if (decision === 'approve') {
      // Re-check the cap at approval time too — time may have passed since the request.
      await checkFrequencyCap(tx, booking.slot.locationId, booking.repId, booking.slot.eventType);
      await tx.slot.update({ where: { id: booking.slotId }, data: { status: SlotStatus.CONFIRMED } });
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CONFIRMED, decidedAt: new Date() },
      });
    } else {
      await tx.slot.update({ where: { id: booking.slotId }, data: { status: SlotStatus.OPEN } });
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.DECLINED, decidedAt: new Date() },
      });
    }
  });
}
