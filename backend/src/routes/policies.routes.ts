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
      maxVisitsPerRepPerMonth: 4,
      maxVisitsPerCompanyPerMonth: 8,
      confirmationDeadline: '48 hours',
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

    const { maxVisitsPerRepPerMonth, maxVisitsPerCompanyPerMonth, confirmationDeadline, closedDays, generalAllergyNotes } = req.body;

    const policy = await prisma.officePolicy.upsert({
      where: { locationId: staff.locationId },
      update: {
        maxVisitsPerRepPerMonth: maxVisitsPerRepPerMonth || 4,
        maxVisitsPerCompanyPerMonth: maxVisitsPerCompanyPerMonth || 8,
        confirmationDeadline: confirmationDeadline || null,
        closedDays: closedDays || [],
        generalAllergyNotes: generalAllergyNotes || null,
      },
      create: {
        locationId: staff.locationId,
        maxVisitsPerRepPerMonth: maxVisitsPerRepPerMonth || 4,
        maxVisitsPerCompanyPerMonth: maxVisitsPerCompanyPerMonth || 8,
        confirmationDeadline: confirmationDeadline || null,
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

    const location = await prisma.location.findUnique({ where: { id: staff.locationId } });
    if (!location) return res.status(404).json({ error: 'Location not found' });

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
    await generateSlotsFromTemplate(staff.locationId, template, location.timezone);

    res.status(201).json(template);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create recurring slot' });
  }
});

// Converts a wall-clock date/time as understood in a given IANA timezone
// into the correct UTC instant, accounting for that timezone's DST rules
// on that specific date. Needed because Render always runs the server
// itself in UTC — naively calling Date#setHours would apply the office's
// entered time-of-day as if it were UTC, which is off by the office's
// actual UTC offset (e.g. entering "12:00" for an Eastern-time office
// would store 12:00 UTC, which displays back as 8am Eastern).
function zonedWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcGuess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string, string>);
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  const offset = asIfUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offset);
}

// Helper: expand a recurring template into actual Slot rows
async function generateSlotsFromTemplate(locationId: string, template: any, timezone: string) {
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
      const slotStart = zonedWallClockToUtc(current.getFullYear(), current.getMonth(), current.getDate(), startHour, startMin, timezone);
      const slotEnd = zonedWallClockToUtc(current.getFullYear(), current.getMonth(), current.getDate(), endHour, endMin, timezone);

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
