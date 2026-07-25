// Express middleware — verifies the JWT and attaches the payload to req.user.

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { JwtPayload, Role } from './auth.types';

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
