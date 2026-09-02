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

// --- Rep self-service: add a product to an existing manufacturer company --
router.post('/catalog/company/:companyId/product', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { companyId } = req.params;
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Product name is required' });

    const company = await prisma.manufacturerCompany.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Unknown manufacturer company' });

    const product = await prisma.product.upsert({
      where: { companyId_name: { companyId, name } },
      update: {},
      create: { companyId, name },
    });

    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add product' });
  }
});

// --- Rep self-service: remove a product from the shared catalog -----------
// Note: this is a shared resource — removing it here removes it for every
// rep, not just the caller. Any product that gets removed is also silently
// unselected from every rep who had it checked (implicit many-to-many).
router.delete('/catalog/company/:companyId/product/:productId', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { companyId, productId } = req.params;
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.companyId !== companyId) {
      return res.status(404).json({ error: 'Product not found for this company' });
    }
    await prisma.product.delete({ where: { id: productId } });
    res.json({ message: 'Product removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove product' });
  }
});

// --- Get the logged-in rep's own profile ----------------------------------
// Used to pre-fill the "Complete your profile" screen with previously saved
// values, so it also works as a review screen.
router.get('/rep', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const rep = await prisma.rep.findUnique({
      where: { id: req.user!.sub },
      select: {
        id: true,
        name: true,
        email: true,
        title: true,
        roleFunction: true,
        phone: true,
        mobilePhone: true,
        additionalEmail: true,
        credentials: true,
        relationshipToCompany: true,
        companyName: true,
        specialties: true,
        manufacturerCompanyId: true,
        profileImageUrl: true,
        verificationStatus: true,
        products: { select: { id: true, name: true } },
      },
    });
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    res.json(rep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch profile' });
  }
});

// --- Office staff: view a rep's profile — only for reps who've actually ---
// booked at this location, so it's not a way to browse the whole rep list.
router.get('/rep/:repId', requireAuth, requireRole('office_admin', 'office_staff'), async (req, res) => {
  try {
    const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const hasBookedHere = await prisma.booking.findFirst({
      where: { repId: req.params.repId, slot: { locationId: staff.locationId } },
    });
    if (!hasBookedHere) {
      return res.status(403).json({ error: 'You can only view profiles for reps who have booked at your location' });
    }

    const rep = await prisma.rep.findUnique({
      where: { id: req.params.repId },
      select: {
        name: true,
        companyName: true,
        title: true,
        roleFunction: true,
        phone: true,
        mobilePhone: true,
        credentials: true,
        relationshipToCompany: true,
        specialties: true,
        profileImageUrl: true,
        verificationStatus: true,
        manufacturerCompany: { select: { name: true } },
        products: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
        marketingMaterials: { select: { id: true, title: true, url: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    res.json(rep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch this rep\'s profile' });
  }
});

const MAX_PROFILE_IMAGE_LENGTH = 700_000; // ~500KB of actual image data once base64-decoded

// --- Complete / update the logged-in rep's profile ------------------------
router.patch('/rep', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const {
      firstName, lastName, title, roleFunction, phone, mobilePhone,
      additionalEmail, credentials, relationshipToCompany,
      specialties, manufacturerCompanyId, productIds, profileImageUrl,
    } = req.body;

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

    if (typeof profileImageUrl === 'string' && profileImageUrl.length > MAX_PROFILE_IMAGE_LENGTH) {
      return res.status(400).json({ error: 'Profile photo is too large' });
    }

    const name = firstName?.trim() && lastName?.trim() ? `${firstName.trim()} ${lastName.trim()}` : undefined;

    const rep = await prisma.rep.update({
      where: { id: req.user!.sub },
      data: {
        name,
        title,
        roleFunction,
        phone,
        mobilePhone,
        additionalEmail,
        credentials,
        relationshipToCompany,
        specialties: specialties ?? undefined,
        manufacturerCompanyId: manufacturerCompanyId ?? undefined,
        ...(productIds ? { products: { set: productIds.map((id: string) => ({ id })) } } : {}),
        ...('profileImageUrl' in req.body ? { profileImageUrl } : {}),
      },
      include: { manufacturerCompany: true, products: true },
    });

    res.json({ rep });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

// --- Rep's saved marketing materials library --------------------------------
// The actual file upload reuses POST /api/literature/upload (same Vercel
// Blob storage) — these endpoints just save/list/remove the resulting URL
// against the rep, so it can be reused across multiple literature sends.

router.get('/materials', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const materials = await prisma.repMarketingMaterial.findMany({
      where: { repId: req.user!.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json(materials);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch marketing materials' });
  }
});

router.post('/materials', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const url = String(req.body.url || '').trim();
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });

    const material = await prisma.repMarketingMaterial.create({
      data: { repId: req.user!.sub, title, url },
    });
    res.status(201).json(material);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save marketing material' });
  }
});

router.delete('/materials/:id', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const material = await prisma.repMarketingMaterial.findUnique({ where: { id: req.params.id } });
    if (!material || material.repId !== req.user!.sub) {
      return res.status(404).json({ error: 'Material not found' });
    }
    await prisma.repMarketingMaterial.delete({ where: { id: req.params.id } });
    res.json({ message: 'Removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove marketing material' });
  }
});

export default router;
