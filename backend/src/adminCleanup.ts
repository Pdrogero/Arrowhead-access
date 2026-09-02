// src/adminCleanup.ts
// Shared logic for the one-off pre-launch cleanup: removes the demo office
// organization (Meridian Family Practice) — every Location under it, not
// just the original seeded one, since testing added at least one more via
// the location-switcher feature — and everything hanging off them, and
// resets isFoundingRep back to false on every existing rep account so
// testing/dev signups don't eat into the real 30-spot founding-rep pool.
//
// Used by both scripts/pre-launch-cleanup.ts (run from a shell) and the
// temporary /api/admin/cleanup route (for environments with no shell access).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_ORG_ID = 'demo-office-org';
const DEMO_DOMAIN = 'meridianpharma.com';
// The account owner's own real trial account — excluded from the
// founding-rep reset below so their in-progress subscription keeps its
// founding rate, even though it was created during the same testing pass
// as the throwaway accounts.
const PRESERVE_FOUNDING_REP_ID = 'cmt3ffadh0008rs1hhtp3wv57';

async function cleanupDemoOffice(confirm: boolean, out: string[]) {
  const locations = await prisma.location.findMany({ where: { organizationId: DEMO_ORG_ID } });
  if (!locations.length) {
    out.push('No demo office locations found under org "demo-office-org" — nothing to delete, already cleaned up.\n');
    return;
  }

  const locationIds = locations.map(l => l.id);
  const slots = await prisma.slot.findMany({ where: { locationId: { in: locationIds } }, select: { id: true } });
  const slotIds = slots.map(s => s.id);
  const bookings = await prisma.booking.findMany({ where: { slotId: { in: slotIds } }, select: { id: true } });
  const bookingIds = bookings.map(b => b.id);
  const conversations = await prisma.conversation.findMany({ where: { locationId: { in: locationIds } }, select: { id: true } });
  const conversationIds = conversations.map(c => c.id);

  const [literatureCount, employeeCount, staffCount, templateCount, messageCount, reviewCount, attendeeCount, transferCount] = await Promise.all([
    prisma.literatureItem.count({ where: { locationId: { in: locationIds } } }),
    prisma.officeEmployee.count({ where: { locationId: { in: locationIds } } }),
    prisma.staffUser.count({ where: { locationId: { in: locationIds } } }),
    prisma.recurringSlotTemplate.count({ where: { locationId: { in: locationIds } } }),
    prisma.message.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.visitReview.count({ where: { bookingId: { in: bookingIds } } }),
    prisma.visitAttendee.count({ where: { bookingId: { in: bookingIds } } }),
    prisma.bookingTransfer.count({ where: { bookingId: { in: bookingIds } } }),
  ]);

  out.push(`Demo office org found: ${locations.length} location(s) — ${locations.map(l => `"${l.name}" (${l.id})`).join(', ')}`);
  out.push('Will delete:');
  out.push(`  ${slotIds.length} slots, ${bookingIds.length} bookings, ${reviewCount} reviews, ${attendeeCount} attendees, ${transferCount} transfers`);
  out.push(`  ${conversationIds.length} conversations, ${messageCount} messages`);
  out.push(`  ${literatureCount} literature items, ${employeeCount} staff-directory entries, ${templateCount} recurring templates`);
  out.push(`  ${staffCount} staff login(s), all ${locations.length} Location(s), the Organization, and the "${DEMO_DOMAIN}" known-manufacturer-domain entry`);

  const [orgRepCount, orgSubCount] = await Promise.all([
    prisma.rep.count({ where: { organizationId: DEMO_ORG_ID } }),
    prisma.subscription.count({ where: { organizationId: DEMO_ORG_ID } }),
  ]);
  const orgIsSafeToDelete = orgRepCount === 0 && orgSubCount === 0;
  if (!orgIsSafeToDelete) {
    out.push(`  WARNING: organization ${DEMO_ORG_ID} has ${orgRepCount} rep(s) and ${orgSubCount} subscription(s) attached — skipping org deletion, investigate manually.`);
  }

  if (!confirm) {
    out.push('  (dry run — pass confirm=1 to actually delete)\n');
    return;
  }

  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.visitReview.deleteMany({ where: { bookingId: { in: bookingIds } } }),
    prisma.visitAttendee.deleteMany({ where: { bookingId: { in: bookingIds } } }),
    prisma.bookingTransfer.deleteMany({ where: { bookingId: { in: bookingIds } } }),
    prisma.booking.deleteMany({ where: { id: { in: bookingIds } } }),
    prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }),
    prisma.literatureItem.deleteMany({ where: { locationId: { in: locationIds } } }), // attachments cascade automatically
    prisma.slot.deleteMany({ where: { locationId: { in: locationIds } } }),
    prisma.officeEmployee.deleteMany({ where: { locationId: { in: locationIds } } }),
    prisma.officePolicy.deleteMany({ where: { locationId: { in: locationIds } } }),
    prisma.recurringSlotTemplate.deleteMany({ where: { locationId: { in: locationIds } } }),
    prisma.staffUser.deleteMany({ where: { locationId: { in: locationIds } } }),
    prisma.location.deleteMany({ where: { id: { in: locationIds } } }),
    ...(orgIsSafeToDelete ? [prisma.organization.deleteMany({ where: { id: DEMO_ORG_ID } })] : []),
  ]);
  await prisma.knownManufacturerDomain.deleteMany({ where: { domain: DEMO_DOMAIN } });

  out.push('  Done — demo office deleted.\n');
}

async function resetFoundingReps(confirm: boolean, out: string[]) {
  const reps = await prisma.rep.findMany({
    select: { id: true, email: true, name: true, isFoundingRep: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const founders = reps.filter(r => r.isFoundingRep);
  const resettable = founders.filter(r => r.id !== PRESERVE_FOUNDING_REP_ID);
  const preserved = founders.find(r => r.id === PRESERVE_FOUNDING_REP_ID);

  out.push(`${reps.length} total rep account(s) currently in the database:`);
  reps.forEach(r => {
    const tag = r.id === PRESERVE_FOUNDING_REP_ID ? '[FOUNDING - PRESERVED]' : r.isFoundingRep ? '[FOUNDING]' : '               ';
    out.push(`  ${tag} ${r.email}  —  ${r.name}  —  created ${r.createdAt.toISOString().slice(0, 10)}`);
  });
  out.push(`\n${founders.length} of them currently hold a founding-rep slot (out of 30 total), ${resettable.length} of which will be reset.`);
  if (preserved) out.push(`"${preserved.email}" is excluded and will keep its founding-rep status.`);
  out.push('Review the list above — if any of these are real prospective customers you want to');
  out.push('keep their founding status, stop here before running with confirm=1.\n');

  if (!confirm) {
    out.push('(dry run — pass confirm=1 to reset the above to isFoundingRep=false)\n');
    return;
  }

  const result = await prisma.rep.updateMany({
    where: { isFoundingRep: true, id: { not: PRESERVE_FOUNDING_REP_ID } },
    data: { isFoundingRep: false },
  });
  out.push(`Reset isFoundingRep to false for ${result.count} rep account(s). ${preserved ? `"${preserved.email}" kept its founding status. ` : ''}Founding spots are available again.\n`);
}

export async function runPreLaunchCleanup(confirm: boolean): Promise<string> {
  const out: string[] = [];
  out.push(confirm ? '=== APPLYING CHANGES ===\n' : '=== DRY RUN (pass confirm=1 to apply) ===\n');
  try {
    await cleanupDemoOffice(confirm, out);
    await resetFoundingReps(confirm, out);
  } finally {
    await prisma.$disconnect();
  }
  return out.join('\n');
}

// --- One-off: find every rep account matching an email case-insensitively -
// (duplicate case-variant signups aren't possible going forward, but a few
// predate that protection) so it's clear which row actually has activity
// before picking one to delete with deleteRepById below.
export async function lookupRepsByEmail(email: string): Promise<string> {
  const out: string[] = [];
  try {
    const reps = await prisma.rep.findMany({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!reps.length) {
      out.push(`No rep account found matching "${email}".`);
      return out.join('\n');
    }
    out.push(`${reps.length} rep account(s) match "${email}" (case-insensitive):\n`);
    for (const rep of reps) {
      const [bookingCount, conversationCount, literatureCount, transferCount] = await Promise.all([
        prisma.booking.count({ where: { repId: rep.id } }),
        prisma.conversation.count({ where: { repId: rep.id } }),
        prisma.literatureItem.count({ where: { repId: rep.id } }),
        prisma.bookingTransfer.count({ where: { OR: [{ fromRepId: rep.id }, { toRepId: rep.id }] } }),
      ]);
      out.push(`repId: ${rep.id}`);
      out.push(`  email (as stored): ${rep.email}`);
      out.push(`  name: ${rep.name}`);
      out.push(`  created: ${rep.createdAt.toISOString().slice(0, 10)}`);
      out.push(`  verificationStatus: ${rep.verificationStatus}  isFoundingRep: ${rep.isFoundingRep}`);
      out.push(`  subscriptionStatus: ${rep.subscriptionStatus}  stripeCustomerId: ${rep.stripeCustomerId || '(none)'}`);
      out.push(`  bookings: ${bookingCount}  conversations: ${conversationCount}  literature items: ${literatureCount}  transfers: ${transferCount}`);
      out.push('');
    }
    out.push('Pass the repId of the one you want to REMOVE to /api/admin/delete-rep?repId=...');
  } finally {
    await prisma.$disconnect();
  }
  return out.join('\n');
}

// --- One-off: fully delete a single rep account and everything it owns ----
// (bookings, transfers it sent/received, conversations+messages,
// literature, verification requests) — used to clear out a stray
// duplicate account. SAFE BY DEFAULT: confirm=false only reports what
// would be deleted.
export async function deleteRepById(repId: string, confirm: boolean): Promise<string> {
  const out: string[] = [];
  try {
    const rep = await prisma.rep.findUnique({ where: { id: repId } });
    if (!rep) {
      out.push(`No rep found with id "${repId}".`);
      return out.join('\n');
    }

    const bookings = await prisma.booking.findMany({ where: { repId }, select: { id: true, slotId: true } });
    const bookingIds = bookings.map(b => b.id);
    const slotIds = bookings.map(b => b.slotId);
    const conversations = await prisma.conversation.findMany({ where: { repId }, select: { id: true } });
    const conversationIds = conversations.map(c => c.id);

    const [transferCount, messageCount, reviewCount, attendeeCount, literatureCount, verificationRequestCount] = await Promise.all([
      prisma.bookingTransfer.count({ where: { OR: [{ fromRepId: repId }, { toRepId: repId }] } }),
      prisma.message.count({ where: { conversationId: { in: conversationIds } } }),
      prisma.visitReview.count({ where: { bookingId: { in: bookingIds } } }),
      prisma.visitAttendee.count({ where: { bookingId: { in: bookingIds } } }),
      prisma.literatureItem.count({ where: { repId } }),
      prisma.verificationRequest.count({ where: { repId } }),
    ]);

    out.push(`Rep found: "${rep.name}" <${rep.email}> (${repId}), created ${rep.createdAt.toISOString().slice(0, 10)}`);
    out.push('Will delete:');
    out.push(`  ${bookingIds.length} bookings, ${reviewCount} reviews, ${attendeeCount} attendees, ${transferCount} transfers (sent or received)`);
    out.push(`  ${conversationIds.length} conversations, ${messageCount} messages`);
    out.push(`  ${literatureCount} literature items, ${verificationRequestCount} verification requests`);
    out.push('  Plus this rep\'s saved marketing materials and office-interest requests (cascade automatically).');

    if (!confirm) {
      out.push('  (dry run — pass confirm=1 to actually delete)');
      return out.join('\n');
    }

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } }),
      prisma.visitReview.deleteMany({ where: { bookingId: { in: bookingIds } } }),
      prisma.visitAttendee.deleteMany({ where: { bookingId: { in: bookingIds } } }),
      prisma.bookingTransfer.deleteMany({ where: { OR: [{ fromRepId: repId }, { toRepId: repId }] } }),
      prisma.booking.deleteMany({ where: { id: { in: bookingIds } } }),
      // Reopen the slots those bookings held so they don't sit orphaned
      // showing CONFIRMED/REQUESTED with no booking behind them.
      prisma.slot.updateMany({ where: { id: { in: slotIds } }, data: { status: 'OPEN' } }),
      prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }),
      prisma.literatureItem.deleteMany({ where: { repId } }), // attachments cascade automatically
      prisma.verificationRequest.deleteMany({ where: { repId } }),
      prisma.rep.delete({ where: { id: repId } }), // marketing materials + office-interest requests cascade
    ]);

    out.push('  Done — rep account deleted.');
  } finally {
    await prisma.$disconnect();
  }
  return out.join('\n');
}
