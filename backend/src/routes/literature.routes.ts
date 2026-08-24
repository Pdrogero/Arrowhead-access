// src/routes/literature.routes.ts
// Lets a rep send literature/sample info to an office they've visited
// before, for the office to accept or decline.
// Mount with: app.use('/api/literature', literatureRouter)
//
// Requires this env var on Render:
//   BLOB_READ_WRITE_TOKEN   (from Vercel Blob — used to upload literature files)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail } from '../email';
import { put } from '@vercel/blob';
import multer from 'multer';

const prisma = new PrismaClient();
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const MAX_ATTACHMENTS = 10;

// --- Rep: upload a literature/sample file (PDF, image, etc.) --------------
// Returns a public URL to use as the linkUrl when creating the item.
router.post('/upload', requireAuth, requireRole('rep'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const blob = await put(`literature/${Date.now()}-${req.file.originalname}`, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    res.json({ url: blob.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not upload file' });
  }
});

// --- Rep: send literature/samples to an office they've visited before -----
router.post('/', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const locationId = String(req.body.locationId || '');
    const title = String(req.body.title || '').trim();
    const description = req.body.description ? String(req.body.description).trim() : null;
    const linkUrl = req.body.linkUrl ? String(req.body.linkUrl).trim() : null;
    const attachmentUrls = Array.isArray(req.body.attachmentUrls)
      ? req.body.attachmentUrls.filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, MAX_ATTACHMENTS)
      : [];

    if (!locationId || !title) {
      return res.status(400).json({ error: 'locationId and title are required' });
    }

    const hasVisited = await prisma.booking.findFirst({
      where: { repId: req.user!.sub, status: 'CONFIRMED', slot: { locationId } },
    });
    if (!hasVisited) {
      return res.status(403).json({ error: 'You can only send literature to offices you have visited before' });
    }

    // Flag (but don't block) a likely duplicate — same title already sent to
    // this same office and not yet declined. The rep can confirm and resend
    // anyway by passing force: true.
    if (!req.body.force) {
      const duplicate = await prisma.literatureItem.findFirst({
        where: {
          repId: req.user!.sub,
          locationId,
          title: { equals: title, mode: 'insensitive' },
          status: { in: ['PENDING', 'ACCEPTED'] },
        },
      });
      if (duplicate) {
        return res.status(409).json({
          code: 'DUPLICATE',
          error: `You already sent "${title}" to this office (currently ${duplicate.status.toLowerCase()}). Send it again anyway?`,
        });
      }
    }

    const item = await prisma.literatureItem.create({
      data: {
        repId: req.user!.sub,
        locationId,
        title,
        description,
        linkUrl,
        attachments: { create: attachmentUrls.map((url: string) => ({ url })) },
      },
      include: { rep: true, location: { include: { staff: true } }, attachments: true },
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
      include: { location: { select: { name: true } }, attachments: true },
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
      include: { rep: { select: { name: true, companyName: true } }, attachments: true },
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

// --- Rep or office: delete a literature item -------------------------------
// A rep can delete anything they sent; office staff can delete anything
// sent to their own location. Removing the row cascades to its attachments.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const item = await prisma.literatureItem.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const role = req.user!.role;

    if (role === 'rep') {
      if (item.repId !== req.user!.sub) return res.status(403).json({ error: 'You can only delete literature you sent' });
    } else if (role === 'office_admin' || role === 'office_staff') {
      const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
      if (!staff || staff.locationId !== item.locationId) {
        return res.status(403).json({ error: 'You can only delete literature sent to your own office' });
      }
    } else {
      return res.status(403).json({ error: 'Not permitted for this role' });
    }

    await prisma.literatureItem.delete({ where: { id: item.id } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete item' });
  }
});

export default router;
