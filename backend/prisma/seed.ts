// prisma/seed.ts — creates a test office, plus a starter manufacturer/product
// catalog so the company/product picker has real data to select from.
// Run with: npx prisma db seed

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const CATALOG: Record<string, string[]> = {
  'Smith & Nephew': ['GrafixPL', 'Stravix', 'Oasis', 'ALLEVYN Dressings', 'PICO Negative Pressure Wound Therapy', 'VERSAJET Hydrosurgery System'],
  'Organogenesis': ['Apligraf', 'Dermagraft', 'PuraPly AM', 'Affinity', 'NuShield'],
  'Integra LifeSciences': ['Integra Wound Matrix', 'PriMatrix', 'MicroMatrix', 'SurgiMend'],
  'MTF Biologics': ['DermACELL', 'AmnioClear', 'AlloPatch'],
  'Medtronic': ['Vascular Closure Devices', 'Endovascular Stents', 'Covidien Wound Closure Sutures'],
  'Stryker': ['Foot & Ankle Plating Systems', 'Wound Care Solutions', 'SurgiCount Safety-Sponge System'],
  'Boston Scientific': ['Peripheral Vascular Devices', 'Interventional Solutions'],
  '3M (KCI)': ['V.A.C. Therapy System', 'Prevena Incision Management System', 'Tegaderm', 'SNaP Wound Care System'],
  'ConvaTec': ['AQUACEL Ag Advantage', 'Foam Dressings', 'Duoderm', 'Avelle Negative Pressure Wound Therapy'],
  'Coloplast': ['Biatain Dressings', 'Comfeel', 'Purilon Gel'],
  'Mölnlycke Health Care': ['Mepilex', 'Exufiber', 'Mepitel'],
  'MiMedx Group': ['EpiFix', 'AmnioFix', 'EpiCord'],
};

// Verified corporate email domains for the manufacturers above — a rep
// signing up with one of these auto-verifies instead of going through
// manual ID review. Confirmed against each company's own site/investor
// pages rather than guessed, since a wrong entry here is a trust decision.
// Always seeded (not demo-gated) so production actually has real coverage;
// admins can grow this list over time too — approving a rep's manual ID
// review from the notification email includes an "Approve & trust this
// domain" option that adds their domain here for future signups.
const KNOWN_MANUFACTURER_DOMAINS = [
  'smith-nephew.com',
  'organogenesis.com',
  'integralife.com',
  'mtfbiologics.org',
  'medtronic.com',
  'stryker.com',
  'bostonscientific.com',
  'bsci.com',
  '3m.com',
  'convatec.com',
  'coloplast.com',
  'molnlycke.com',
  'mimedx.com',
];

async function main() {
  // The demo office (and its known-manufacturer-domain used for rep
  // auto-verification testing) is test data — it only gets created when
  // explicitly requested, so production deploys don't keep recreating a
  // fake office real reps could stumble into. Set SEED_DEMO_OFFICE=true
  // to seed it, e.g. for local development.
  if (process.env.SEED_DEMO_OFFICE === 'true') {
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

    console.log('Seeded office login:');
    console.log('  email: staff@meridianfamilypractice.com');
    console.log('  password: demo1234');
    console.log(`  locationId: ${location.id}`);
  }

  // --- Known manufacturer domains (always seeded — production needs this ---
  // --- table populated for rep auto-verification to actually work) --------
  for (const domain of KNOWN_MANUFACTURER_DOMAINS) {
    await prisma.knownManufacturerDomain.upsert({
      where: { domain },
      update: {},
      create: { domain },
    });
  }
  console.log(`Seeded ${KNOWN_MANUFACTURER_DOMAINS.length} known manufacturer domains.`);

  // --- Manufacturer / product catalog (always seeded — real data the ---
  // --- rep profile's company picker needs in production too) ----------
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
