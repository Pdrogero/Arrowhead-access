// src/adminCleanup.ts
// Shared logic for the one-off pre-launch cleanup: removes the demo office
// (Meridian Family Practice) and everything hanging off it, and resets
// isFoundingRep back to false on every existing rep account so testing/dev
// signups don't eat into the real 30-spot founding-rep pool.
//
// Used by both scripts/pre-launch-cleanup.ts (run from a shell) and the
// temporary /api/admin/cleanup route (for environments with no shell access).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_LOCATION_ID = 'demo-office-location';
const DEMO_ORG_ID = 'demo-office-org';
const DEMO_DOMAIN = 'meridianpharma.com';

async function cleanupDemoOffice(confirm: boolean, out: string[]) {
  const location = await prisma.location.findUnique({ where: { id: DEMO_LOCATION_ID } });
  if (!location) {
    out.push('No demo office found (id "demo-office-location") — nothing to delete, already cleaned up.\n');
    return;
  }

  const slots = await prisma.slot.findMany({ where: { locationId: DEMO_LOCATION_ID }, select: { id: true } });
  const slotIds = slots.map(s => s.id);
  const bookings = await prisma.booking.findMany({ where: { slotId: { in: slotIds } }, select: { id: true } });
  const bookingIds = bookings.map(b => b.id);
  const conversations = await prisma.conversation.findMany({ where: { locationId: DEMO_LOCATION_ID }, select: { id: true } });
  const conversationIds = conversations.map(c => c.id);

  const [literatureCount, employeeCount, staffCount, templateCount, messageCount, reviewCount, attendeeCount, transferCount] = await Promise.all([
    prisma.literatureItem.count({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.officeEmployee.count({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.staffUser.count({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.recurringSlotTemplate.count({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.message.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.visitReview.count({ where: { bookingId: { in: bookingIds } } }),
    prisma.visitAttendee.count({ where: { bookingId: { in: bookingIds } } }),
    prisma.bookingTransfer.count({ where: { bookingId: { in: bookingIds } } }),
  ]);

  out.push(`Demo office found: "${location.name}" (${DEMO_LOCATION_ID})`);
  out.push('Will delete:');
  out.push(`  ${slotIds.length} slots, ${bookingIds.length} bookings, ${reviewCount} reviews, ${attendeeCount} attendees, ${transferCount} transfers`);
  out.push(`  ${conversationIds.length} conversations, ${messageCount} messages`);
  out.push(`  ${literatureCount} literature items, ${employeeCount} staff-directory entries, ${templateCount} recurring templates`);
  out.push(`  ${staffCount} staff login(s), the Location, the Organization, and the "${DEMO_DOMAIN}" known-manufacturer-domain entry`);

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
    prisma.literatureItem.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }), // attachments cascade automatically
    prisma.slot.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.officeEmployee.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.officePolicy.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.recurringSlotTemplate.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.staffUser.deleteMany({ where: { locationId: DEMO_LOCATION_ID } }),
    prisma.location.delete({ where: { id: DEMO_LOCATION_ID } }),
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

  out.push(`${reps.length} total rep account(s) currently in the database:`);
  reps.forEach(r => {
    out.push(`  ${r.isFoundingRep ? '[FOUNDING]' : '          '} ${r.email}  —  ${r.name}  —  created ${r.createdAt.toISOString().slice(0, 10)}`);
  });
  out.push(`\n${founders.length} of them currently hold a founding-rep slot (out of 30 total).`);
  out.push('Review the list above — if any of these are real prospective customers you want to');
  out.push('keep their founding status, stop here before running with confirm=1.\n');

  if (!confirm) {
    out.push('(dry run — pass confirm=1 to reset all of the above to isFoundingRep=false)\n');
    return;
  }

  const result = await prisma.rep.updateMany({ where: { isFoundingRep: true }, data: { isFoundingRep: false } });
  out.push(`Reset isFoundingRep to false for ${result.count} rep account(s). All 30 founding spots are available again.\n`);
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
