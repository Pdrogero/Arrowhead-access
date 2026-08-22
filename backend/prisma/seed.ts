// prisma/seed.ts — creates a test office, plus a starter manufacturer/product
// catalog so the company/product picker has real data to select from.
// Run with: npx prisma db seed

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const CATALOG: Record<string, string[]> = {
  'Smith & Nephew': ['GrafixPL', 'Stravix', 'Oasis'],
  'Organogenesis': ['Apligraf', 'Dermagraft', 'PuraPly AM'],
  'Integra LifeSciences': ['Integra Wound Matrix', 'PriMatrix', 'MicroMatrix'],
  'MTF Biologics': ['DermACELL', 'AmnioClear'],
  'Medtronic': ['Vascular Closure Devices', 'Endovascular Stents'],
  'Stryker': ['Foot & Ankle Plating Systems', 'Wound Care Solutions'],
  'Boston Scientific': ['Peripheral Vascular Devices', 'Interventional Solutions'],
  '3M (KCI)': ['V.A.C. Therapy System', 'Prevena Incision Management System', 'Tegaderm'],
  'ConvaTec': ['AQUACEL Ag Advantage', 'Foam Dressings', 'Duoderm'],
  'Coloplast': ['Biatain Dressings', 'Comfeel'],
  'Mölnlycke Health Care': ['Mepilex', 'Exufiber'],
  'MiMedx Group': ['EpiFix', 'AmnioFix'],
};

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

  await prisma.staffUser.upsert({
    where: { email: 'staff@meridianfamilypractice.com' },
    update: {},
    create: {
      email: 'staff@meridianfamilypractice.com',
      passwordHash,
      role: 'ADMIN',
      locationId: location.id,
    },
  });

  await prisma.knownManufacturerDomain.upsert({
    where: { domain: 'meridianpharma.com' },
    update: {},
    create: { domain: 'meridianpharma.com' },
  });

  // --- Manufacturer / product catalog ---
  for (const [companyName, products] of Object.entries(CATALOG)) {
    const company = await prisma.manufacturerCompany.upsert({
      where: { name: companyName },
      update: {},
      create: { name: companyName },
    });
    for (const productName of products) {
      await prisma.product.upsert({
        where: { companyId_name: { companyId: company.id, name: productName } },
        update: {},
        create: { companyId: company.id, name: productName },
      });
    }
  }

  console.log('Seeded office login:');
  console.log('  email: staff@meridianfamilypractice.com');
  console.log('  password: demo1234');
  console.log(`  locationId: ${location.id}`);
  console.log(`Seeded ${Object.keys(CATALOG).length} manufacturer companies with products.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
