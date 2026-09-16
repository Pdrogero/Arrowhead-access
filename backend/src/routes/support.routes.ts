import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';

const prisma = new PrismaClient();
const router = Router();

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@arrowheadaccess.com';

const CATEGORY_LABELS: Record<string, string> = {
  ACCOUNT: 'Account or login issue',
  BOOKING: 'Booking or scheduling',
  BILLING: 'Billing',
  BUG: 'Something looks broken',
  OTHER: 'Other',
};

// In-app replacement for the old mailto: Help links — gives us who's asking
// and what kind of issue it is without them having to explain that up front.
router.post('/contact', requireAuth, async (req, res) => {
  try {
    const category = typeof req.body.category === 'string' ? req.body.category : 'OTHER';
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Please describe your question or issue' });

    let name: string;
    let email: string;
    let context: string;
    if (req.user!.role === 'rep') {
      const rep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
      name = rep.name;
      email = rep.email;
      context = `Rep · ${rep.companyName}`;
    } else {
      const staff = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.user!.sub } });
      const location = await prisma.location.findUnique({ where: { id: staff.locationId } });
      name = staff.name || staff.email;
      email = staff.email;
      context = `Office staff${location ? ` · ${location.name}` : ''}`;
    }

    const categoryLabel = CATEGORY_LABELS[category] || CATEGORY_LABELS.OTHER;

    await sendEmail({
      to: SUPPORT_EMAIL,
      subject: `[Support] ${categoryLabel} — ${name}`,
      html: `${emailLogoHeader()}<p><strong>${name}</strong> (${email}) — ${context}</p><p><strong>Category:</strong> ${categoryLabel}</p><p><strong>Message:</strong></p><p>${message.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
      replyTo: email,
    });

    res.json({ message: 'Sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send your message — please try again or email us directly.' });
  }
});

export default router;
