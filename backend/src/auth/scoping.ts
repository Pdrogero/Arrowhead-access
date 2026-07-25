// Helper to make sure a request can only touch data it's scoped to.
// Call this at the top of every route handler that reads/writes Location or Rep data.

import { Request } from 'express';

export function assertOwnsLocation(req: Request, locationId: string) {
  if (req.user?.role === 'rep') {
    throw new Error('Reps cannot access location-scoped resources directly');
  }
  if (req.user?.locationId !== locationId) {
    throw new Error('Not authorized for this location');
  }
}

export function assertOwnsRep(req: Request, repId: string) {
  if (req.user?.role !== 'rep' || req.user.sub !== repId) {
    throw new Error('Not authorized for this rep account');
  }
}
