// Handles account creation and login for both reps and office staff.
// Mount with: app.use('/api/auth', authRouter)

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { JwtPayload } from '../auth/auth.types';
import { sendEmail, emailLogoHeader, emailLoginButton } from '../email';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { verifyTurnstile } from '../turnstile';

const prisma = new PrismaClient();
const router = Router();

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

// Security notice sent to an account whenever its password changes —
// whether through the logged-in "change password" flow or a forgot-
// password reset link — so the real owner has a paper trail to notice if
// it wasn't them. Never blocks the request it's called from.
function sendPasswordChangedEmail(to: string) {
  sendEmail({
    to,
    subject: 'Your Arrowhead Access password was changed',
    html: `${emailLogoHeader()}<p>This is a confirmation that your Arrowhead Access password was just changed.</p><p>If this was you, no action is needed. If you didn't make this change, contact us right away at <a href="mailto:legal@arrowheadaccess.com">legal@arrowheadaccess.com</a> so we can secure your account.</p>`,
  }).catch(() => {});
}

router.post('/rep/signup', async (req, res) => {
  try {
    const { password, name, companyName, turnstileToken } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !password || !name || !companyName) {
      return res.status(400).json({ error: 'email, password, name, and companyName are required' });
    }

    if (!(await verifyTurnstile(turnstileToken, req.ip))) {
      return res.status(400).json({ error: 'Verification failed. Please try again.' });
    }

    const existing = await prisma.rep.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const domain = email.split('@')[1]?.toLowerCase();
    const knownDomain = domain
      ? await prisma.knownManufacturerDomain.findUnique({ where: { domain } })
      : null;

    const passwordHash = await bcrypt.hash(password, 10);

    const FOUNDING_REP_LIMIT = 30;
    const foundingCount = await prisma.rep.count({ where: { isFoundingRep: true } });
    const isFoundingRep = foundingCount < FOUNDING_REP_LIMIT;

    const rep = await prisma.rep.create({
      data: {
        email,
        passwordHash,
        name,
        companyName,
        verificationStatus: knownDomain ? 'VERIFIED' : 'UNVERIFIED',
        verificationMethod: knownDomain ? 'DOMAIN_MATCH' : undefined,
        isFoundingRep,
      },
    });

    const token = signToken({
      sub: rep.id,
      role: 'rep',
      organizationId: rep.organizationId ?? '',
      verified: rep.verificationStatus === 'VERIFIED',
    });

    // Claim any visit transfers that were offered to this email before they
    // had an account — they'll now show up under Incoming transfers.
    const claimedTransfers = await prisma.bookingTransfer.updateMany({
      where: { toRepEmail: { equals: email, mode: 'insensitive' }, toRepId: null, status: 'PENDING' },
      data: { toRepId: rep.id },
    });

    sendEmail({
      to: rep.email,
      subject: 'Welcome to Arrowhead Access',
      html: `${emailLogoHeader()}<p>Hi ${rep.name},</p><p>Your Arrowhead Access rep account is set up. You can now complete your profile, browse open visit slots, and start booking with offices on the platform.</p>${claimedTransfers.count ? `<p>You also have ${claimedTransfers.count} pending visit transfer${claimedTransfers.count > 1 ? 's' : ''} waiting for you under Transfers.</p>` : ''}${emailLoginButton()}`,
    }).catch(() => {});

    res.status(201).json({
      token,
      rep: { id: rep.id, name: rep.name, email: rep.email, verificationStatus: rep.verificationStatus },
    });
  } catch (err: any) {
    // The pre-check above can't catch two signups for the same email
    // landing at the same instant — the database's own unique constraint
    // on email (Prisma error P2002) is the real backstop for that race.
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during signup' });
  }
});

router.post('/rep/login', async (req, res) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email || '').trim();
    // Case-insensitive lookup — mobile keyboards (iPad in particular) can
    // auto-capitalize the first letter of an email field, which would
    // otherwise fail an exact-match lookup even with the right password.
    const rep = await prisma.rep.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!rep || !(await bcrypt.compare(password, rep.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({
      sub: rep.id,
      role: 'rep',
      organizationId: rep.organizationId ?? '',
      verified: rep.verificationStatus === 'VERIFIED',
    });

    res.json({
      token,
      rep: { id: rep.id, name: rep.name, email: rep.email, verificationStatus: rep.verificationStatus },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during login' });
  }
});

// Staff accounts predate the organizationId column, so it may be unset —
// resolve it from their current location the first time it's needed and
// persist it so future lookups are a plain field read.
async function resolveStaffOrgId(staff: { id: string; organizationId: string | null; locationId: string }): Promise<string | null> {
  if (staff.organizationId) return staff.organizationId;
  const location = await prisma.location.findUnique({ where: { id: staff.locationId } });
  if (!location) return null;
  await prisma.staffUser.update({ where: { id: staff.id }, data: { organizationId: location.organizationId } });
  return location.organizationId;
}

router.post('/staff/login', async (req, res) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email || '').trim();
    const staff = await prisma.staffUser.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const organizationId = await resolveStaffOrgId(staff);

    const token = signToken({
      sub: staff.id,
      role: staff.role === 'ADMIN' ? 'office_admin' : 'office_staff',
      organizationId: organizationId ?? '',
      locationId: staff.locationId,
    });

    res.json({ token, staff: { id: staff.id, email: staff.email, role: staff.role, locationId: staff.locationId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during login' });
  }
});

// --- Whoever this token belongs to, rep or staff — just echoes the JWT's
// own claims (sub, role, organizationId, locationId, verified). No DB call
// needed since the token already carries everything; used by the frontend
// on page load to figure out who's logged in before fetching a full profile.
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// --- Office staff: switch which of their org's locations this login is
// currently scoped to. Updates the StaffUser row in place (so every other
// route that reads staff.locationId picks it up automatically) and issues
// a fresh token carrying the new locationId.
router.post('/switch-location', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const organizationId = await resolveStaffOrgId(staff);
    if (!organizationId) return res.status(500).json({ error: 'Could not resolve your organization' });

    const targetLocationId = String(req.body.locationId || '');
    const target = await prisma.location.findUnique({ where: { id: targetLocationId } });
    if (!target || target.organizationId !== organizationId) {
      return res.status(403).json({ error: 'That location is not part of your organization' });
    }

    const updated = await prisma.staffUser.update({
      where: { id: staff.id },
      data: { locationId: targetLocationId, organizationId },
    });

    const token = signToken({
      sub: updated.id,
      role: updated.role === 'ADMIN' ? 'office_admin' : 'office_staff',
      organizationId,
      locationId: updated.locationId,
    });

    res.json({ token, staff: { id: updated.id, email: updated.email, role: updated.role, locationId: updated.locationId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not switch location' });
  }
});

router.post('/office/signup', async (req, res) => {
  try {
    const { officeName, locationName, address, timezone, password, turnstileToken } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!officeName || !locationName || !address || !email || !password) {
      return res.status(400).json({ error: 'officeName, locationName, address, email, and password are required' });
    }

    if (!(await verifyTurnstile(turnstileToken, req.ip))) {
      return res.status(400).json({ error: 'Verification failed. Please try again.' });
    }

    const existing = await prisma.staffUser.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: officeName, type: 'OFFICE', billingEmail: email },
      });
      const location = await tx.location.create({
        data: {
          organizationId: org.id,
          name: locationName,
          address,
          timezone: timezone || 'America/New_York',
        },
      });
      const staff = await tx.staffUser.create({
        data: { email, passwordHash, role: 'ADMIN', locationId: location.id, organizationId: org.id },
      });
      return { org, location, staff };
    });

    // Notify any reps who asked to hear when this office joined — matched
    // loosely (case-insensitive, either name containing the other) since
    // the rep's search term won't always exactly match the office's
    // official location name.
    const newNameLower = result.location.name.toLowerCase();
    const pendingInterest = await prisma.officeInterestRequest.findMany({
      where: { notified: false },
      include: { rep: true },
    });
    const matches = pendingInterest.filter(r => {
      const searched = r.officeName.toLowerCase();
      return newNameLower.includes(searched) || searched.includes(newNameLower);
    });
    if (matches.length) {
      await prisma.officeInterestRequest.updateMany({
        where: { id: { in: matches.map(m => m.id) } },
        data: { notified: true },
      });
      matches.forEach(m => {
        sendEmail({
          to: m.rep.email,
          subject: `${result.location.name} just joined Arrowhead Access`,
          html: `${emailLogoHeader()}<p>Good news — <strong>${result.location.name}</strong>, the office you asked to be notified about, just joined Arrowhead Access. You can now find them and book a visit.</p>${emailLoginButton()}`,
        }).catch(() => {});
      });
    }

    // Every other rep also hears about it — just with generic copy instead
    // of "the office you asked about", since they didn't specifically ask.
    const matchedRepIds = new Set(matches.map(m => m.rep.id));
    const otherReps = await prisma.rep.findMany({
      where: { id: { notIn: [...matchedRepIds] } },
      select: { email: true },
    });
    otherReps.forEach(rep => {
      sendEmail({
        to: rep.email,
        subject: `${result.location.name} just joined Arrowhead Access`,
        html: `${emailLogoHeader()}<p><strong>${result.location.name}</strong> just joined Arrowhead Access. Log in to check out their open slots and book a visit.</p>${emailLoginButton()}`,
      }).catch(() => {});
    });

    const token = signToken({
      sub: result.staff.id,
      role: 'office_admin',
      organizationId: result.org.id,
      locationId: result.location.id,
    });

    sendEmail({
      to: result.staff.email,
      subject: 'Welcome to Arrowhead Access',
      html: `${emailLogoHeader()}<p>Hi,</p><p>Your Arrowhead Access office account for <strong>${result.location.name}</strong> is set up. You can now post open slots, review visit requests, and manage your office's availability for sales reps.</p>${emailLoginButton()}`,
    }).catch(() => {});

    res.status(201).json({
      token,
      staff: {
        id: result.staff.id,
        email: result.staff.email,
        role: result.staff.role,
        locationId: result.location.id,
      },
    });
  } catch (err: any) {
    // Same race-condition backstop as rep signup above.
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during office signup' });
  }
});

// --- Forgot / reset password (both rep and office accounts) --------------
// Uses a short-lived signed JWT as the reset token instead of a DB-backed
// table — reuses the same JWT_SECRET already configured for login.
router.post('/forgot-password', async (req, res) => {
  try {
    const { role } = req.body; // role: 'rep' | 'office'
    const email = String(req.body.email || '').trim();
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }

    const account = role === 'rep'
      ? await prisma.rep.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
      : await prisma.staffUser.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

    // Respond identically whether or not the account exists, so this
    // endpoint can't be used to discover which emails are registered.
    if (account) {
      const resetToken = jwt.sign(
        { sub: account.id, role, type: 'password_reset' },
        process.env.JWT_SECRET!,
        { expiresIn: '30m' }
      );
      const resetUrl = `${process.env.APP_URL}/app.html?resetToken=${resetToken}`;
      await sendEmail({
        to: email,
        subject: 'Reset your Arrowhead Access password',
        html: `${emailLogoHeader()}<p>Someone requested a password reset for this account. Click below to choose a new password — this link expires in 30 minutes.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
      });
    }

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }

    let payload: { sub: string; role: string; type: string };
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET!) as typeof payload;
    } catch {
      return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    }
    if (payload.type !== 'password_reset') {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    let accountEmail: string;
    if (payload.role === 'rep') {
      const rep = await prisma.rep.update({ where: { id: payload.sub }, data: { passwordHash } });
      accountEmail = rep.email;
    } else {
      const staff = await prisma.staffUser.update({ where: { id: payload.sub }, data: { passwordHash } });
      accountEmail = staff.email;
    }
    sendPasswordChangedEmail(accountEmail);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// --- Change password (logged-in rep or office staff) ---------------------
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const isRep = req.user!.role === 'rep';
    const account = isRep
      ? await prisma.rep.findUnique({ where: { id: req.user!.sub } })
      : await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });

    if (!account || !(await bcrypt.compare(currentPassword, account.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    if (isRep) {
      await prisma.rep.update({ where: { id: req.user!.sub }, data: { passwordHash } });
    } else {
      await prisma.staffUser.update({ where: { id: req.user!.sub }, data: { passwordHash } });
    }
    sendPasswordChangedEmail(account.email);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

export default router;
