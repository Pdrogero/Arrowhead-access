// Handles account creation and login for both reps and office staff.
// Mount with: app.use('/api/auth', authRouter)

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { JwtPayload } from '../auth/auth.types';

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

export default router;
