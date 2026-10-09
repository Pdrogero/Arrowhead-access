// One-off maintenance script: removes a manufacturer company from the
// catalog by name, safely — reports (and clears) anything still pointing
// at it first, so the delete never fails on a foreign-key constraint or
// silently corrupts a rep's profile.
//
// Run from the backend/ directory, against the environment whose
// DATABASE_URL you want to target (e.g. in Render's Shell tab, which
// already has production's DATABASE_URL set):
//   npx ts-node scripts/remove-company.ts "Rogero Group LLC"

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: npx ts-node scripts/remove-company.ts "<company name>"');
    process.exit(1);
  }

  const company = await prisma.manufacturerCompany.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    include: { products: true, reps: { select: { id: true, name: true, email: true } } },
  });

  if (!company) {
    console.log(`No manufacturer company matching "${name}" found — nothing to do.`);
    return;
  }

  console.log(`Found "${company.name}" (id ${company.id})`);
  console.log(`  Products: ${company.products.length ? company.products.map(p => p.name).join(', ') : 'none'}`);
  console.log(`  Reps currently set to this company: ${company.reps.length ? company.reps.map(r => `${r.name} <${r.email}>`).join(', ') : 'none'}`);

  if (company.reps.length) {
    await prisma.rep.updateMany({
      where: { manufacturerCompanyId: company.id },
      data: { manufacturerCompanyId: null },
    });
    console.log(`  Cleared manufacturerCompanyId on ${company.reps.length} rep(s) — they'll need to re-pick a company next time they edit their profile.`);
  }

  if (company.products.length) {
    await prisma.product.deleteMany({ where: { companyId: company.id } });
    console.log(`  Deleted ${company.products.length} product(s) under this company.`);
  }

  await prisma.manufacturerCompany.delete({ where: { id: company.id } });
  console.log(`Removed "${company.name}" from the catalog.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
