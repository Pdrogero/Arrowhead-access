// Handles account creation and login for both reps and office staff.
// Mount with: app.use('/api/auth', authRouter)

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { JwtPayload } from '../auth/auth.types';
import { sendEmail } from '../email';

const prisma = new PrismaClient();
const router = Router();

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

router.post('/rep/signup', async (req, res) => {
  try {
    const { email, password, name, companyName } = req.body;
    if (!email || !password || !name || !companyName) {
      return res.status(400).json({ error: 'email, password, name, and companyName are required' });
    }

    const existing = await prisma.rep.findUnique({ where: { email } });
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

    res.status(201).json({
      token,
      rep: { id: rep.id, name: rep.name, email: rep.email, verificationStatus: rep.verificationStatus },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during signup' });
  }
});

router.post('/rep/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rep = await prisma.rep.findUnique({ where: { email } });
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

router.post('/staff/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const staff = await prisma.staffUser.findUnique({ where: { email } });
    if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({
      sub: staff.id,
      role: staff.role === 'ADMIN' ? 'office_admin' : 'office_staff',
      organizationId: '',
      locationId: staff.locationId,
    });

    res.json({ token, staff: { id: staff.id, email: staff.email, role: staff.role, locationId: staff.locationId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during login' });
  }
});
router.post('/office/signup', async (req, res) => {
  try {
    const { officeName, locationName, address, timezone, email, password } = req.body;
    if (!officeName || !locationName || !address || !email || !password) {
      return res.status(400).json({ error: 'officeName, locationName, address, email, and password are required' });
    }

    const existing = await prisma.staffUser.findUnique({ where: { email } });
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
        data: { email, passwordHash, role: 'ADMIN', locationId: location.id },
      });
      return { org, location, staff };
    });

    const token = signToken({
      sub: result.staff.id,
      role: 'office_admin',
      organizationId: result.org.id,
      locationId: result.location.id,
    });

    res.status(201).json({
      token,
      staff: {
        id: result.staff.id,
        email: result.staff.email,
        role: result.staff.role,
        locationId: result.location.id,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error during office signup' });
  }
});

// --- Forgot / reset password (both rep and office accounts) --------------
// Uses a short-lived signed JWT as the reset token instead of a DB-backed
// table — reuses the same JWT_SECRET already configured for login.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, role } = req.body; // role: 'rep' | 'office'
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }

    const account = role === 'rep'
      ? await prisma.rep.findUnique({ where: { email } })
      : await prisma.staffUser.findUnique({ where: { email } });

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
        html: `<p>Someone requested a password reset for this account. Click below to choose a new password — this link expires in 30 minutes.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
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
    if (payload.role === 'rep') {
      await prisma.rep.update({ where: { id: payload.sub }, data: { passwordHash } });
    } else {
      await prisma.staffUser.update({ where: { id: payload.sub }, data: { passwordHash } });
    }

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

export default router;
