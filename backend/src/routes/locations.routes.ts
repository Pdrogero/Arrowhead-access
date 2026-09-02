// src/routes/locations.routes.ts
// Lets an office account with more than one physical location list them
// and add new ones. Switching which location a login is currently scoped
// to lives in auth.routes.ts (POST /api/auth/switch-location), since it
// issues a fresh token.
// Mount with: app.use('/api/locations', locationsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';

const prisma = new PrismaClient();
const router = Router();

async function resolveStaffOrgId(staff: { id: string; organizationId: string | null; locationId: string }): Promise<string | null> {
  if (staff.organizationId) return staff.organizationId;
  const location = await prisma.location.findUnique({ where: { id: staff.locationId } });
  if (!location) return null;
  await prisma.staffUser.update({ where: { id: staff.id }, data: { organizationId: location.organizationId } });
  return location.organizationId;
}

// --- List every location that belongs to this staff member's organization -
router.get('/mine', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const organizationId = await resolveStaffOrgId(staff);
    if (!organizationId) return res.status(500).json({ error: 'Could not resolve your organization' });

    const locations = await prisma.location.findMany({
      where: { organizationId },
      select: { id: true, name: true, address: true, managerEmail: true },
      orderBy: { name: 'asc' },
    });
    res.json(locations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch locations' });
  }
});

// --- Add another location under this admin's organization -----------------
router.post('/', requireAuth, requireRole('office_admin'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const organizationId = await resolveStaffOrgId(staff);
    if (!organizationId) return res.status(500).json({ error: 'Could not resolve your organization' });

    const name = String(req.body.name || '').trim();
    const address = String(req.body.address || '').trim();
    const timezone = String(req.body.timezone || 'America/New_York').trim();
    const managerEmail = String(req.body.managerEmail || '').trim().toLowerCase();
    if (!name || !address) return res.status(400).json({ error: 'name and address are required' });
    if (managerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
      return res.status(400).json({ error: 'That manager email address does not look valid' });
    }

    const location = await prisma.location.create({
      data: { organizationId, name, address, timezone, managerEmail: managerEmail || null },
    });

    if (managerEmail) {
      const org = await prisma.organization.findUnique({ where: { id: organizationId } });
      sendEmail({
        to: managerEmail,
        subject: `You've been added as the contact for ${location.name} on Arrowhead Access`,
        html: `${emailLogoHeader()}<p>Hi,</p><p>${org?.name || 'Your organization'} added <strong>${location.name}</strong> (${location.address}) as a location on Arrowhead Access, the platform used to manage sales rep visit scheduling — and listed you as the contact for it.</p><p>If you need your own login to manage this location, reach out to your office administrator, or contact us at legal@arrowheadaccess.com.</p>`,
      }).catch(() => {});
    }

    res.status(201).json(location);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add location' });
  }
});

// --- Rep: their saved shortlist of favorite offices, shown on profile -----
router.get('/favorites', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const favorites = await prisma.favoriteLocation.findMany({
      where: { repId: req.user!.sub },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            address: true,
            _count: { select: { slots: { where: { status: 'OPEN', startTime: { gte: new Date() } } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(favorites.map(f => ({
      id: f.location.id,
      name: f.location.name,
      address: f.location.address,
      openSlotCount: f.location._count.slots,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load favorite offices' });
  }
});

router.post('/:locationId/favorite', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const location = await prisma.location.findUnique({ where: { id: req.params.locationId } });
    if (!location) return res.status(404).json({ error: 'Office not found' });

    await prisma.favoriteLocation.upsert({
      where: { repId_locationId: { repId: req.user!.sub, locationId: req.params.locationId } },
      create: { repId: req.user!.sub, locationId: req.params.locationId },
      update: {},
    });
    res.status(201).json({ favorited: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not favorite this office' });
  }
});

router.delete('/:locationId/favorite', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    await prisma.favoriteLocation.deleteMany({
      where: { repId: req.user!.sub, locationId: req.params.locationId },
    });
    res.json({ favorited: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not unfavorite this office' });
  }
});

// --- Rep: a single office's detail — address (for a map), standing visit --
// policy/notes, and this rep's own booking history at that office. Powers
// the office-detail screen reached by tapping an office name anywhere.
router.get('/:locationId/detail', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const location = await prisma.location.findUnique({ where: { id: req.params.locationId } });
    if (!location) return res.status(404).json({ error: 'Office not found' });

    const policy = await prisma.officePolicy.findUnique({ where: { locationId: location.id } });

    const repId = req.user!.sub;
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const pastBookingStatuses = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] as const;
    const [totalBookings, bookingsPastYear, upcomingBookings] = await Promise.all([
      prisma.booking.count({ where: { repId, status: { in: [...pastBookingStatuses] }, slot: { locationId: location.id } } }),
      prisma.booking.count({ where: { repId, status: { in: [...pastBookingStatuses] }, slot: { locationId: location.id }, requestedAt: { gte: oneYearAgo } } }),
      prisma.booking.count({ where: { repId, status: { in: ['CONFIRMED', 'REQUESTED'] }, slot: { locationId: location.id, startTime: { gte: new Date() } } } }),
    ]);

    res.json({
      id: location.id,
      name: location.name,
      address: location.address,
      policy: policy ? {
        confirmationDeadline: policy.confirmationDeadline,
        closedDays: policy.closedDays,
        generalAllergyNotes: policy.generalAllergyNotes,
      } : null,
      myStats: { totalBookings, bookingsPastYear, upcomingBookings },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load office detail' });
  }
});

// --- Rep: search all offices on the platform by name, regardless of ------
// whether they currently have any open slots posted.
router.get('/search', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);

    const locations = await prisma.location.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        address: true,
        _count: { select: { slots: { where: { status: 'OPEN', startTime: { gte: new Date() } } } } },
      },
      orderBy: { name: 'asc' },
      take: 20,
    });

    res.json(locations.map(l => ({ id: l.id, name: l.name, address: l.address, openSlotCount: l._count.slots })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not search offices' });
  }
});

// --- Rep: ask to be emailed once an office not yet on the platform joins --
router.post('/notify-me', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const officeName = String(req.body.officeName || '').trim();
    const address = String(req.body.address || '').trim();
    if (!officeName) return res.status(400).json({ error: 'officeName is required' });

    const request = await prisma.officeInterestRequest.create({
      data: { repId: req.user!.sub, officeName, address: address || null },
    });
    res.status(201).json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save notify request' });
  }
});

// --- Rep: real-world business/address lookup, used to help fill in the ---
// notify-me name+address when an office isn't on the platform yet. Proxies
// OpenStreetMap's free Nominatim geocoder (no API key needed) — proxied
// server-side rather than called from the browser so we can set the
// identifying User-Agent their usage policy requires, and so a hiccup on
// their end never surfaces raw third-party errors to the rep.
router.get('/geo-search', requireAuth, requireRole('rep'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
    const geoRes = await fetch(url, {
      headers: { 'User-Agent': 'ArrowheadAccess/1.0 (legal@arrowheadaccess.com)' },
      signal: AbortSignal.timeout(4000),
    });
    if (!geoRes.ok) return res.json([]);

    const results = (await geoRes.json()) as Array<{ name?: string; display_name?: string }>;
    const suggestions = results
      .map(r => ({
        name: r.name || (r.display_name || '').split(',')[0].trim(),
        address: r.display_name || '',
      }))
      .filter(s => s.name && s.address);

    res.json(suggestions);
  } catch (err) {
    // Best-effort only — never let a geocoding hiccup block the notify-me
    // flow, the rep can still just type the name in by hand.
    res.json([]);
  }
});

export default router;
