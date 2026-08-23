// src/routes/literature.routes.ts
// Lets a rep send literature/sample info to an office they've visited
// before, for the office to accept or decline.
// Mount with: app.use('/api/literature', literatureRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail } from '../email';

const prisma = new PrismaClient();
const router = Router();

// --- Rep: send literature/samples to an office they've visited before -----
router.post('/', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const locationId = String(req.body.locationId || '');
    const title = String(req.body.title || '').trim();
    const description = req.body.description ? String(req.body.description).trim() : null;
    const linkUrl = req.body.linkUrl ? String(req.body.linkUrl).trim() : null;

    if (!locationId || !title) {
      return res.status(400).json({ error: 'locationId and title are required' });
    }

    const hasVisited = await prisma.booking.findFirst({
      where: { repId: req.user!.sub, status: 'CONFIRMED', slot: { locationId } },
    });
    if (!hasVisited) {
      return res.status(403).json({ error: 'You can only send literature to offices you have visited before' });
    }

    const item = await prisma.literatureItem.create({
      data: { repId: req.user!.sub, locationId, title, description, linkUrl },
      include: { rep: true, location: { include: { staff: true } } },
    });

    item.location.staff.forEach(staff => {
      sendEmail({
        to: staff.email,
        subject: `${item.rep.name} shared literature for you to review`,
        html: `<p><strong>${item.rep.name}</strong> (${item.rep.companyName}) sent "${item.title}" for your review. Log in to accept or decline it.</p>`,
      }).catch(() => {});
    });

    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send literature' });
  }
});

// --- Rep: view what they've submitted, and its status ----------------------
router.get('/mine', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const items = await prisma.literatureItem.findMany({
      where: { repId: req.user!.sub },
      include: { location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch literature' });
  }
});

// --- Office: view what's been submitted for their location -----------------
router.get('/office', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const items = await prisma.literatureItem.findMany({
      where: { locationId: staff.locationId },
      include: { rep: { select: { name: true, companyName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch literature' });
  }
});

// --- Office: accept or decline a submitted item -----------------------------
router.post('/:id/decide', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const item = await prisma.literatureItem.findUnique({ where: { id: req.params.id }, include: { rep: true } });
    if (!item || item.locationId !== staff.locationId) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.status !== 'PENDING') {
      return res.status(400).json({ error: 'This item has already been decided' });
    }

    const decision = req.body.decision === 'accept' ? 'ACCEPTED' : 'DECLINED';
    const updated = await prisma.literatureItem.update({
      where: { id: item.id },
      data: { status: decision, reviewedByStaffId: req.user!.sub, reviewedAt: new Date() },
    });

    sendEmail({
      to: item.rep.email,
      subject: decision === 'ACCEPTED' ? `Your literature was accepted` : `Your literature was declined`,
      html: `<p>"${item.title}" was ${decision === 'ACCEPTED' ? 'accepted' : 'declined'}.</p>`,
    }).catch(() => {});

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not decide item' });
  }
});

export default router;
