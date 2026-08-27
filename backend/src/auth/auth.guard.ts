// Express middleware — verifies the JWT and attaches the payload to req.user.

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { JwtPayload, Role } from './auth.types';

const prisma = new PrismaClient();

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Restricts a route to specific roles. Use after requireAuth.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not permitted for this role' });
    }
    next();
  };
}

// Blocks any action that requires a verified rep badge.
export function requireVerifiedRep(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'rep' || !req.user.verified) {
    return res.status(403).json({ error: 'Verified rep account required' });
  }
  next();
}

// Blocks paid-feature routes until a rep has actually completed Stripe
// checkout (stripeSubscriptionId set) and is still trialing/active. Checked
// against the DB rather than the JWT so a webhook-driven status change takes
// effect immediately, without requiring the rep to log out and back in.
// A no-op for non-rep callers, so it's safe to use on routes shared with
// office accounts (e.g. sending a message).
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'rep') return next();

  const rep = await prisma.rep.findUnique({
    where: { id: req.user.sub },
    select: { stripeSubscriptionId: true, subscriptionStatus: true },
  });
  const hasAccess = !!rep?.stripeSubscriptionId && (rep.subscriptionStatus === 'TRIALING' || rep.subscriptionStatus === 'ACTIVE');
  if (!hasAccess) {
    return res.status(402).json({ error: 'Please complete your subscription checkout under Billing to continue.' });
  }
  next();
}
