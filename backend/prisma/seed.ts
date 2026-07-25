// prisma/seed.ts — creates one test office (Organization + Location + StaffUser)
// so the app demo has something real to log into.
// Run with: npx prisma db seed  (after adding the "prisma.seed" config below)

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('demo1234', 10);

  const org = await prisma.organization.upsert({
    where: { id: 'demo-office-org' },
    update: {},
    create: {
      id: 'demo-office-org',
      name: 'Meridian Family Practice',
      type: 'OFFICE',
      billingEmail: 'billing@meridianfamilypractice.com',
    },
  });

  const location = await prisma.location.upsert({
    where: { id: 'demo-office-location' },
    update: {},
    create: {
      id: 'demo-office-location',
      organizationId: org.id,
      name: 'Meridian Family Practice — Main Office',
      address: '123 Main St, Springfield',
      timezone: 'America/New_York',
      maxVisitsPerRepPerMonth: 1,
      maxVisitsPerCompanyPerMonth: 2,
    },
  });

  const staff = await prisma.staffUser.upsert({
    where: { email: 'staff@meridianfamilypractice.com' },
    update: {},
    create: {
      email: 'staff@meridianfamilypractice.com',
      passwordHash,
      role: 'ADMIN',
      locationId: location.id,
    },
  });

  // Also seed one known manufacturer domain so a rep signing up with a
  // matching email auto-verifies instead of needing ID upload.
  await prisma.knownManufacturerDomain.upsert({
    where: { domain: 'meridianpharma.com' },
    update: {},
    create: { domain: 'meridianpharma.com' },
  });

  console.log('Seeded office login:');
  console.log('  email: staff@meridianfamilypractice.com');
  console.log('  password: demo1234');
  console.log(`  locationId: ${location.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
