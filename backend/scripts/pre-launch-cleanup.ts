// scripts/pre-launch-cleanup.ts
// One-off pre-launch cleanup: removes the demo office (Meridian Family
// Practice) and everything hanging off it, and resets isFoundingRep back to
// false on every existing rep account so testing/dev signups don't eat into
// the real 30-spot founding-rep pool.
//
// SAFE BY DEFAULT: running this with no flags only PRINTS what it would do.
// Nothing is deleted or changed until you re-run it with --confirm.
//
// Run from the backend/ directory:
//   npx ts-node scripts/pre-launch-cleanup.ts            (dry run — read only)
//   npx ts-node scripts/pre-launch-cleanup.ts --confirm  (actually applies it)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_LOCATION_ID = 'demo-office-location';
const DEMO_ORG_ID = 'demo-office-org';
const DEMO_DOMAIN = 'meridianpharma.com';

const CONFIRM = process.argv.includes('--confirm');

async function cleanupDemoOffice() {
  const location = await prisma.location.findUnique({ where: { id: DEMO_LOCATION_ID } });
  if (!location) {
    console.log('No demo office found (id "demo-office-location") — nothing to delete, already cleaned up.\n');
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

  console.log(`Demo office found: "${location.name}" (${DEMO_LOCATION_ID})`);
  console.log('Will delete:');
  console.log(`  ${slotIds.length} slots, ${bookingIds.length} bookings, ${reviewCount} reviews, ${attendeeCount} attendees, ${transferCount} transfers`);
  console.log(`  ${conversationIds.length} conversations, ${messageCount} messages`);
  console.log(`  ${literatureCount} literature items, ${employeeCount} staff-directory entries, ${templateCount} recurring templates`);
  console.log(`  ${staffCount} staff login(s), the Location, the Organization, and the "${DEMO_DOMAIN}" known-manufacturer-domain entry`);

  // Orgs can theoretically have Reps or a Subscription tied to them — check
  // before deleting so an unexpected foreign key doesn't blow up mid-run.
  const [orgRepCount, orgSubCount] = await Promise.all([
    prisma.rep.count({ where: { organizationId: DEMO_ORG_ID } }),
    prisma.subscription.count({ where: { organizationId: DEMO_ORG_ID } }),
  ]);
  const orgIsSafeToDelete = orgRepCount === 0 && orgSubCount === 0;
  if (!orgIsSafeToDelete) {
    console.log(`  WARNING: organization ${DEMO_ORG_ID} has ${orgRepCount} rep(s) and ${orgSubCount} subscription(s) attached — skipping org deletion, investigate manually.`);
  }

  if (!CONFIRM) {
    console.log('  (dry run — pass --confirm to actually delete)\n');
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

  console.log('  Done — demo office deleted.\n');
}

async function resetFoundingReps() {
  const reps = await prisma.rep.findMany({
    select: { id: true, email: true, name: true, isFoundingRep: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const founders = reps.filter(r => r.isFoundingRep);

  console.log(`${reps.length} total rep account(s) currently in the database:`);
  reps.forEach(r => {
    console.log(`  ${r.isFoundingRep ? '[FOUNDING]' : '          '} ${r.email}  —  ${r.name}  —  created ${r.createdAt.toISOString().slice(0, 10)}`);
  });
  console.log(`\n${founders.length} of them currently hold a founding-rep slot (out of 30 total).`);
  console.log('Review the list above — if any of these are real prospective customers you want to');
  console.log('keep their founding status, stop here and tell me before running with --confirm.\n');

  if (!CONFIRM) {
    console.log('(dry run — pass --confirm to reset all of the above to isFoundingRep=false)\n');
    return;
  }

  const result = await prisma.rep.updateMany({ where: { isFoundingRep: true }, data: { isFoundingRep: false } });
  console.log(`Reset isFoundingRep to false for ${result.count} rep account(s). All 30 founding spots are available again.\n`);
}

async function main() {
  console.log(CONFIRM ? '=== APPLYING CHANGES ===\n' : '=== DRY RUN (pass --confirm to apply) ===\n');
  await cleanupDemoOffice();
  await resetFoundingReps();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
