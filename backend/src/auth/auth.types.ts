// Shared types for the auth system — one JWT shape for all three actor types.

export type Role = 'office_admin' | 'office_staff' | 'rep';

export interface JwtPayload {
  sub: string;           // user id (StaffUser.id or Rep.id)
  role: Role;
  organizationId: string;
  locationId?: string;   // present for office_admin / office_staff only
  verified?: boolean;    // present for rep only
}
