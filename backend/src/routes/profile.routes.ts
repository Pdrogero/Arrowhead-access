// src/routes/profile.routes.ts
// Manufacturer catalog lookup + rep profile completion (title, phone,
// specialties, company/products picker) — mirrors the RxVantage-style
// multi-step signup flow.
// Mount with: app.use('/api/profile', profileRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();

// --- List the manufacturer catalog (companies + their products) ----------
// Used to populate the company dropdown and its dependent products list.
router.get('/catalog', requireAuth, requireRole('rep'), async (req, res) => {
  const companies = await prisma.manufacturerCompany.findMany({
    include: { products: { orderBy: { name: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  res.json(companies);
});

// --- Rep self-service: add a manufacturer company not yet in the catalog --
// Reuses an existing company (case-insensitive match on name) instead of
// creating a duplicate if one already exists.
router.post('/catalog/company', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Company name is required' });

    const productNames = Array.from(
      new Set((req.body.products || []).map((p: string) => String(p).trim()).filter(Boolean))
    ) as string[];

    let company = await prisma.manufacturerCompany.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (!company) {
      company = await prisma.manufacturerCompany.create({ data: { name } });
    }

    for (const productName of productNames) {
      await prisma.product.upsert({
        where: { companyId_name: { companyId: company.id, name: productName } },
        update: {},
        create: { companyId: company.id, name: productName },
      });
    }

    const withProducts = await prisma.manufacturerCompany.findUnique({
      where: { id: company.id },
      include: { products: { orderBy: { name: 'asc' } } },
    });

    res.status(201).json(withProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add company' });
  }
});

// --- Complete / update the logged-in rep's profile ------------------------
router.patch('/rep', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { title, phone, specialties, manufacturerCompanyId, productIds } = req.body;

    if (manufacturerCompanyId) {
      const company = await prisma.manufacturerCompany.findUnique({ where: { id: manufacturerCompanyId } });
      if (!company) return res.status(400).json({ error: 'Unknown manufacturer company' });
    }

    if (productIds?.length && manufacturerCompanyId) {
      const validCount = await prisma.product.count({
        where: { id: { in: productIds }, companyId: manufacturerCompanyId },
      });
      if (validCount !== productIds.length) {
        return res.status(400).json({ error: 'One or more products do not belong to the selected company' });
      }
    }

    const rep = await prisma.rep.update({
      where: { id: req.user!.sub },
      data: {
        title,
        phone,
        specialties: specialties ?? undefined,
        manufacturerCompanyId: manufacturerCompanyId ?? undefined,
        ...(productIds ? { products: { set: productIds.map((id: string) => ({ id })) } } : {}),
      },
      include: { manufacturerCompany: true, products: true },
    });

    res.json({ rep });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

export default router;
