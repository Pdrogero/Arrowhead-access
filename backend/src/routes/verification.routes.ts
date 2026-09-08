// src/routes/verification.routes.ts
// Lets a rep whose email domain doesn't auto-verify (see /api/auth/rep/signup)
// upload a photo of a company ID/badge instead, for manual admin review via
// a signed one-click approve/reject link sent by email — there's no admin
// dashboard in this app, so the email link IS the review UI.
// Mount with: app.use('/api/verification', verificationRouter)
//
// Requires this env var on Render (same Vercel Blob token literature/profile
// uploads already use):
//   BLOB_READ_WRITE_TOKEN

import { Router } from 'express';
import path from 'path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader, emailLoginButton, notifyAdmin } from '../email';
import { put } from '@vercel/blob';
import multer from 'multer';

const prisma = new PrismaClient();
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// The backend's own public URL — the approve/reject links in the admin
// email have to hit this Express server directly (there's no frontend
// screen for them), same constant bookings.routes.ts uses for the
// calendar feed link.
const API_URL = process.env.RENDER_EXTERNAL_URL || 'https://arrowhead-access-api.onrender.com';

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
};

function blobKeyFor(file: Express.Multer.File): string {
  const originalExt = path.extname(file.originalname);
  const ext = originalExt || EXTENSION_BY_MIME_TYPE[file.mimetype] || '';
  const baseName = path.basename(file.originalname, originalExt) || 'file';
  return `verification/${Date.now()}-${baseName}${ext}`;
}

// --- Rep: upload the ID/badge photo, get back a URL to submit -------------
router.post('/upload', requireAuth, requireRole('rep'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const blob = await put(blobKeyFor(req.file), req.file.buffer, {
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

// --- Rep: their own most recent verification request, if any --------------
// Lets the frontend show "pending review" / "not approved, try again"
// instead of just a blank upload form every time this screen is opened.
router.get('/mine', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const request = await prisma.verificationRequest.findFirst({
      where: { repId: req.user!.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch verification status' });
  }
});

// --- Rep: submit an uploaded ID/badge photo for review ---------------------
router.post('/submit', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const idDocumentUrl = String(req.body.idDocumentUrl || '').trim();
    if (!idDocumentUrl) return res.status(400).json({ error: 'idDocumentUrl is required' });

    const rep = await prisma.rep.findUnique({ where: { id: req.user!.sub } });
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    if (rep.verificationStatus === 'VERIFIED') {
      return res.status(409).json({ error: 'Your account is already verified' });
    }

    const alreadyPending = await prisma.verificationRequest.findFirst({
      where: { repId: rep.id, status: 'PENDING_REVIEW' },
    });
    if (alreadyPending) {
      return res.status(409).json({ error: 'You already have a submission under review' });
    }

    const request = await prisma.verificationRequest.create({
      data: { repId: rep.id, method: 'ID_UPLOAD', idDocumentUrl, status: 'PENDING_REVIEW' },
    });
    await prisma.rep.update({ where: { id: rep.id }, data: { verificationStatus: 'PENDING_REVIEW' } });

    // A signed link IS the approval action — clicking it (no login) hits
    // GET /review below and applies the decision. Mirrors the password
    // reset token pattern (signed JWT, no separate DB table needed).
    const reviewLink = (decision: 'approve' | 'reject' | 'approve_trust_domain') => {
      const token = jwt.sign(
        { requestId: request.id, decision, type: 'verification_review' },
        process.env.JWT_SECRET!,
        { expiresIn: '14d' }
      );
      return `${API_URL}/api/verification/review?token=${token}`;
    };

    const repDomain = rep.email.split('@')[1]?.toLowerCase();

    notifyAdmin(
      `ID verification request — ${rep.name}`,
      `<p><strong>${rep.name}</strong> (${rep.companyName}, ${rep.email}) submitted a photo for manual identity verification, since their email didn't match a known company domain.</p>
       <p><a href="${idDocumentUrl}">View the submitted photo</a></p>
       <p>
         <a href="${reviewLink('approve')}" style="display:inline-block;background:#2E6F5E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;margin-right:10px;">Approve</a>
         <a href="${reviewLink('reject')}" style="display:inline-block;background:#C23C3C;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;">Reject</a>
       </p>
       ${repDomain ? `<p><a href="${reviewLink('approve_trust_domain')}" style="color:#2E6F5E;font-size:13px;">Approve &amp; trust @${repDomain} for future signups &rarr;</a><br><span style="font-size:12px;color:#6E7C77;">Future signups from this domain will auto-verify without needing manual review — only use this if ${rep.companyName} legitimately owns this domain.</span></p>` : ''}`
    );

    res.status(201).json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit for review' });
  }
});

function reviewResultPage(res: import('express').Response, title: string, message: string) {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} — Arrowhead Access</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#EEF2ED;color:#16241F;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
  .card{background:#fff;border:1px solid #CBD6CD;border-radius:14px;padding:36px 40px;max-width:420px;text-align:center;}
  h1{font-size:20px;margin:0 0 10px;}
  p{color:#6E7C77;font-size:14px;margin:0;line-height:1.5;}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`);
}

// --- Admin: approve/reject a request via the one-click emailed link --------
// No login — the signed token itself is the credential, same trust model as
// a password-reset link. Safe to leave unauthenticated for that reason.
router.get('/review', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    let payload: { requestId: string; decision: 'approve' | 'reject' | 'approve_trust_domain'; type: string };
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET!) as typeof payload;
    } catch {
      return reviewResultPage(res, 'Link expired', 'This review link is invalid or has expired.');
    }
    if (payload.type !== 'verification_review') {
      return reviewResultPage(res, 'Invalid link', 'This is not a valid verification review link.');
    }

    const request = await prisma.verificationRequest.findUnique({
      where: { id: payload.requestId },
      include: { rep: true },
    });
    if (!request) {
      return reviewResultPage(res, 'Not found', 'This verification request no longer exists.');
    }
    if (request.status !== 'PENDING_REVIEW') {
      return reviewResultPage(
        res,
        'Already decided',
        `This request was already marked ${request.status.replace('_', ' ').toLowerCase()}${request.reviewedAt ? ` on ${request.reviewedAt.toLocaleDateString()}` : ''}.`
      );
    }

    const trustDomain = payload.decision === 'approve_trust_domain';
    const approved = payload.decision === 'approve' || trustDomain;
    const newStatus = approved ? 'VERIFIED' : 'REJECTED';

    await prisma.verificationRequest.update({
      where: { id: request.id },
      data: { status: newStatus, reviewedAt: new Date(), reviewedBy: 'admin-email-link' },
    });
    await prisma.rep.update({
      where: { id: request.repId },
      data: {
        verificationStatus: newStatus,
        ...(approved ? { verificationMethod: 'ID_UPLOAD' } : {}),
      },
    });

    let trustedDomain: string | null = null;
    if (trustDomain) {
      const domain = request.rep.email.split('@')[1]?.toLowerCase();
      if (domain) {
        await prisma.knownManufacturerDomain.upsert({ where: { domain }, update: {}, create: { domain } });
        trustedDomain = domain;
      }
    }

    sendEmail({
      to: request.rep.email,
      subject: approved ? "You're verified on Arrowhead Access" : 'Your ID verification was not approved',
      html: approved
        ? `${emailLogoHeader()}<p>Hi ${request.rep.name},</p><p>Your submitted photo has been reviewed and your account is now verified — you can request and claim open slots.</p>${emailLoginButton()}`
        : `${emailLogoHeader()}<p>Hi ${request.rep.name},</p><p>We weren't able to verify your account from the photo you submitted. You can log in and upload a new one to try again, or sign up with your company email if you have one.</p>${emailLoginButton()}`,
    }).catch(() => {});

    reviewResultPage(
      res,
      approved ? 'Approved' : 'Rejected',
      `${request.rep.name} (${request.rep.email}) has been marked ${approved ? 'verified' : 'rejected'}. They've been notified by email.${trustedDomain ? ` Future signups from @${trustedDomain} will now auto-verify.` : ''}`
    );
  } catch (err) {
    console.error(err);
    reviewResultPage(res, 'Error', 'Something went wrong processing this request.');
  }
});

// --- Daily check: nudge reps who are still unverified two days after -------
// signup, called by an external scheduled trigger. Guarded by the same
// shared cron secret as the other daily reminder checks.
const UNVERIFIED_REMINDER_DELAY_MS = 2 * 24 * 60 * 60 * 1000;

router.post('/check-unverified-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const cutoff = new Date(Date.now() - UNVERIFIED_REMINDER_DELAY_MS);
    const reps = await prisma.rep.findMany({
      where: { verificationStatus: 'UNVERIFIED', unverifiedReminder2dSent: false, createdAt: { lte: cutoff } },
    });

    let remindersSent = 0;
    for (const rep of reps) {
      sendEmail({
        to: rep.email,
        subject: "You're not verified yet on Arrowhead Access",
        html: `${emailLogoHeader()}<p>Hi ${rep.name},</p><p>Your Arrowhead Access account is still unverified — we couldn't automatically confirm it from your email address, so booking is on hold until you upload a quick photo of your company ID or badge. It only takes a minute, and our team usually reviews it within a business day.</p>${emailLoginButton('Upload ID to get verified')}`,
      }).catch(() => {});
      await prisma.rep.update({ where: { id: rep.id }, data: { unverifiedReminder2dSent: true } });
      remindersSent++;
    }

    res.json({ checked: reps.length, remindersSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check unverified reminders' });
  }
});

export default router;
