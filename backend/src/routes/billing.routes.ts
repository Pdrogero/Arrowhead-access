// src/routes/billing.routes.ts
// Handles Stripe checkout for the rep Professional plan, plus the webhook
// that keeps subscriptionStatus in sync with what actually happened in Stripe.
// Mount with: app.use('/api/billing', billingRouter)
//
// Requires these env vars on Render:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_PRICE_MONTHLY     (Price ID for $49.95/mo)
//   STRIPE_PRICE_ANNUAL      (Price ID for $479.40/yr, i.e. $39.95/mo billed annually)
//   STRIPE_PRICE_FOUNDING    (Price ID for the $379.99/yr founding-rep rate)
//   APP_URL                  (e.g. https://arrowheadaccess.com — used for redirect URLs)

import { Router } from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';

const prisma = new PrismaClient();
const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });

const FOUNDING_REP_LIMIT = 30;

router.post('/rep/checkout', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const { billingCycle } = req.body;
    const rep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });

    let priceId: string;
    if (billingCycle === 'ANNUAL' && rep.isFoundingRep) {
      priceId = process.env.STRIPE_PRICE_FOUNDING!;
    } else if (billingCycle === 'ANNUAL') {
      priceId = process.env.STRIPE_PRICE_ANNUAL!;
    } else {
      priceId = process.env.STRIPE_PRICE_MONTHLY!;
    }

    let customerId = rep.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: rep.email, name: rep.name, metadata: { repId: rep.id } });
      customerId = customer.id;
      await prisma.rep.update({ where: { id: rep.id }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 14 },
      success_url: `${process.env.APP_URL}/app.html?billing=success`,
      cancel_url: `${process.env.APP_URL}/app.html?billing=cancelled`,
      metadata: { repId: rep.id, billingCycle },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

router.get('/founding-status', requireAuth, requireRole('rep'), async (req, res) => {
  const rep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
  const foundingCount = await prisma.rep.count({ where: { isFoundingRep: true } });
  res.json({
    isFoundingRep: rep.isFoundingRep,
    foundingSpotsRemaining: Math.max(0, FOUNDING_REP_LIMIT - foundingCount),
  });
});

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const repId = session.metadata?.repId;
      const billingCycle = session.metadata?.billingCycle as 'MONTHLY' | 'ANNUAL' | undefined;
      if (repId && session.subscription) {
        await prisma.rep.update({
          where: { id: repId },
          data: {
            stripeSubscriptionId: session.subscription as string,
            billingCycle,
            subscriptionStatus: 'TRIALING',
          },
        });
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object as Stripe.Subscription;
      const rep = await prisma.rep.findFirst({ where: { stripeSubscriptionId: sub.id } });
      if (rep) {
        const status = sub.status === 'trialing' ? 'TRIALING'
          : sub.status === 'active' ? 'ACTIVE'
          : sub.status === 'past_due' ? 'PAST_DUE'
          : 'CANCELED';
        await prisma.rep.update({ where: { id: rep.id }, data: { subscriptionStatus: status } });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const rep = await prisma.rep.findFirst({ where: { stripeSubscriptionId: sub.id } });
      if (rep) {
        await prisma.rep.update({ where: { id: rep.id }, data: { subscriptionStatus: 'CANCELED' } });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
