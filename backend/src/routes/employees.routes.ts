// src/routes/employees.routes.ts
// A simple staff directory each office maintains for their own location.
// Office staff manage their own list; reps can view any location's list —
// meant to help reps recognize who they're meeting with when they visit.
// Mount with: app.use('/api/employees', employeesRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();

// --- Office staff: view their own location's staff directory --------------
router.get('/mine', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const employees = await prisma.officeEmployee.findMany({
      where: { locationId: staff.locationId },
      orderBy: { name: 'asc' },
    });
    res.json(employees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch staff directory' });
  }
});

// --- Office staff: replace their own location's staff directory -----------
router.post('/mine', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const employees = Array.isArray(req.body.employees) ? req.body.employees : [];
    const rows = employees
      .map((e: any) => ({
        name: String(e.name || '').trim(),
        title: String(e.title || '').trim() || null,
        npi: String(e.npi || '').trim() || null,
      }))
      .filter((e: { name: string }) => e.name);

    await prisma.$transaction([
      prisma.officeEmployee.deleteMany({ where: { locationId: staff.locationId } }),
      prisma.officeEmployee.createMany({
        data: rows.map((e: { name: string; title: string | null; npi: string | null }) => ({ ...e, locationId: staff.locationId })),
      }),
    ]);

    const saved = await prisma.officeEmployee.findMany({
      where: { locationId: staff.locationId },
      orderBy: { name: 'asc' },
    });
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save staff directory' });
  }
});

// --- Rep: view a location's staff directory --------------------------------
router.get('/location/:locationId', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const employees = await prisma.officeEmployee.findMany({
      where: { locationId: req.params.locationId },
      orderBy: { name: 'asc' },
    });
    res.json(employees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch staff directory' });
  }
});

export default router;
