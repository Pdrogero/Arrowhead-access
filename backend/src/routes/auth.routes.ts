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

router.
