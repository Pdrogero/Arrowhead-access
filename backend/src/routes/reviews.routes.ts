// src/routes/reviews.routes.ts
// Mutual 1-5 star rating + optional comment that a rep and the office staff
// they met with can leave about each other, one per side per booking.
// Mount with: app.use('/api/reviews', reviewsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../auth/auth.guard';
import { JwtPayload } from '../auth/auth.types';

const prisma = new PrismaClient();
const router = Router();

async function getBookingAccess(bookingId: string, user: JwtPayload) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { slot: true } });
  if (!booking) return null;

  if (user.role === 'rep') {
    if (booking.repId !== user.sub) return null;
    return { booking, authorType: 'REP' as const };
  }

  const staff = await prisma.staffUser.findUnique({ where: { id: user.sub } });
  if (!staff || staff.locationId !== booking.slot.locationId) return null;
  return { booking, authorType: 'OFFICE' as const };
}

// --- Get the caller's own review for a booking (null if not left yet) -----
router.get('/:bookingId/mine', requireAuth, async (req, res) => {
  try {
    const access = await getBookingAccess(req.params.bookingId, req.user!);
    if (!access) return res.status(404).json({ error: 'Booking not found' });

    const review = await prisma.visitReview.findUnique({
      where: { bookingId_authorType: { bookingId: req.params.bookingId, authorType: access.authorType } },
    });
    res.json(review);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch review' });
  }
});

// --- Leave or update the caller's own review for a booking -----------------
router.post('/:bookingId', requireAuth, async (req, res) => {
  try {
    const access = await getBookingAccess(req.params.bookingId, req.user!);
    if (!access) return res.status(404).json({ error: 'Booking not found' });
    if (access.booking.status !== 'CONFIRMED') {
      return res.status(400).json({ error: 'Only confirmed visits can be rated' });
    }

    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
    }
    const comment = req.body.comment ? String(req.body.comment).trim() : null;

    const review = await prisma.visitReview.upsert({
      where: { bookingId_authorType: { bookingId: req.params.bookingId, authorType: access.authorType } },
      update: { rating, comment },
      create: { bookingId: req.params.bookingId, authorType: access.authorType, authorId: req.user!.sub, rating, comment },
    });

    res.json(review);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save review' });
  }
});

// --- Aggregate rating: how reps have rated a location ----------------------
router.get('/office-average/:locationId', requireAuth, async (req, res) => {
  try {
    const result = await prisma.visitReview.aggregate({
      where: { authorType: 'REP', booking: { slot: { locationId: req.params.locationId } } },
      _avg: { rating: true },
      _count: true,
    });
    res.json({ average: result._avg.rating, count: result._count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch rating' });
  }
});

// --- Aggregate rating: how offices have rated a rep -------------------------
router.get('/rep-average/:repId', requireAuth, async (req, res) => {
  try {
    const result = await prisma.visitReview.aggregate({
      where: { authorType: 'OFFICE', booking: { repId: req.params.repId } },
      _avg: { rating: true },
      _count: true,
    });
    res.json({ average: result._avg.rating, count: result._count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch rating' });
  }
});

export default router;
