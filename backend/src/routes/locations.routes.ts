// src/routes/locations.routes.ts
// Lets an office account with more than one physical location list them
// and add new ones. Switching which location a login is currently scoped
// to lives in auth.routes.ts (POST /api/auth/switch-location), since it
// issues a fresh token.
// Mount with: app.use('/api/locations', locationsRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

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
      select: { id: true, name: true, address: true },
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
    if (!name || !address) return res.status(400).json({ error: 'name and address are required' });

    const location = await prisma.location.create({
      data: { organizationId, name, address, timezone },
    });
    res.status(201).json(location);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add location' });
  }
});

export default router;
