// src/routes/policies.routes.ts
// Lets offices set their policies (max visits, confirmation deadline, closed days)
// and create recurring slot templates (e.g., "every Tuesday 1-3pm is open")
// Mount with: app.use('/api/policies', policiesRouter)

import { Router } from 'express';
import { PrismaClient, SlotStatus } from '@prisma/client';
import { requireAuth } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();

// --- Get office policy --------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const policy = await prisma.officePolicy.findUnique({
      where: { locationId: staff.locationId },
    });

    res.json(policy || {
      maxVisitsPerRepPerMonth: 1,
      maxVisitsPerCompanyPerMonth: 2,
      confirmationDeadlineHours: 48,
      closedDays: [],
      generalAllergyNotes: '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch policy' });
  }
});

// --- Create or update office policy ------------------------------------
router.post('/', requireAuth, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const { maxVisitsPerRepPerMonth, maxVisitsPerCompanyPerMonth, confirmationDeadlineHours, closedDays, generalAllergyNotes } = req.body;

    const policy = await prisma.officePolicy.upsert({
      where: { locationId: staff.locationId },
      update: {
        maxVisitsPerRepPerMonth: maxVisitsPerRepPerMonth || 1,
        maxVisitsPerCompanyPerMonth: maxVisitsPerCompanyPerMonth || 2,
        confirmationDeadlineHours: confirmationDeadlineHours || 48,
        closedDays: closedDays || [],
        generalAllergyNotes: generalAllergyNotes || null,
      },
      create: {
        locationId: staff.locationId,
        maxVisitsPerRepPerMonth: maxVisitsPerRepPerMonth || 1,
        maxVisitsPerCompanyPerMonth: maxVisitsPerCompanyPerMonth || 2,
        confirmationDeadlineHours: confirmationDeadlineHours || 48,
        closedDays: closedDays || [],
        generalAllergyNotes: generalAllergyNotes || null,
      },
    });

    res.json(policy);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save policy' });
  }
});

// --- List existing recurring slot templates for this office's location ----
router.get('/recurring', requireAuth, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const templates = await prisma.recurringSlotTemplate.findMany({
      where: { locationId: staff.locationId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(templates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch recurring slots' });
  }
});

// --- Create recurring slot template (expands into actual slots) --------
router.post('/recurring', requireAuth, async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const { daysOfWeek, startTime, endTime, eventType, endsAt } = req.body;
    if (!daysOfWeek || !startTime || !endTime || !eventType) {
      return res.status(400).json({ error: 'daysOfWeek, startTime, endTime, eventType required' });
    }
    if (eventType === 'LUNCH') {
      return res.status(400).json({ error: 'For recurring lunches, use "Post an open slot" instead — it carries headcount, allergies, and order details to every repeat.' });
    }

    const template = await prisma.recurringSlotTemplate.create({
      data: {
        locationId: staff.locationId,
        daysOfWeek,
        startTime,
        endTime,
        eventType,
        endsAt: endsAt ? new Date(endsAt) : null,
      },
    });

    // Immediately generate slots for the next 12 weeks
    await generateSlotsFromTemplate(staff.locationId, template);

    res.status(201).json(template);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create recurring slot' });
  }
});

// Helper: expand a recurring template into actual Slot rows
async function generateSlotsFromTemplate(locationId: string, template: any) {
  const now = new Date();
  const endDate = template.endsAt || new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000); // 12 weeks

  const [startHour, startMin] = template.startTime.split(':').map(Number);
  const [endHour, endMin] = template.endTime.split(':').map(Number);

  const daysMap: { [key: string]: number } = {
    SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
  };

  const slots = [];
  let current = new Date(now);
  current.setHours(0, 0, 0, 0);

  while (current < endDate) {
    const dayName = Object.keys(daysMap).find(k => daysMap[k] === current.getDay());
    if (dayName && template.daysOfWeek.includes(dayName)) {
      const slotStart = new Date(current);
      slotStart.setHours(startHour, startMin, 0, 0);

      const slotEnd = new Date(current);
      slotEnd.setHours(endHour, endMin, 0, 0);

      slots.push({
        locationId,
        startTime: slotStart,
        endTime: slotEnd,
        status: SlotStatus.OPEN,
        eventType: template.eventType,
      });
    }

    current.setDate(current.getDate() + 1);
  }

  await prisma.slot.createMany({ data: slots });
}

export default router;
