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
//   CRON_SECRET              (shared secret the daily renewal-reminder trigger must send)

import { Router } from 'express';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireRole } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';

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
    if (customerId) {
      // The stored ID can go stale (customer deleted in Stripe, or left over
      // from a different Stripe mode/account) — verify it still resolves
      // before reusing it, rather than letting checkout hard-fail on it.
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as Stripe.Customer | Stripe.DeletedCustomer).deleted) {
          customerId = null;
        }
      } catch (err) {
        customerId = null;
      }
    }
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
    hasActiveSubscription: !!rep.stripeSubscriptionId && rep.subscriptionStatus !== 'CANCELED',
    subscriptionStatus: rep.subscriptionStatus,
    cancelAtPeriodEnd: rep.cancelAtPeriodEnd,
    currentPeriodEnd: rep.currentPeriodEnd,
    billingCycle: rep.billingCycle,
  });
});

// --- Cancel the rep's subscription, effective at the end of the current --
// billing period (no partial refund for time already paid, per the ToS) —
// they keep full access until then, then it simply stops renewing.
router.post('/rep/cancel', requireAuth, requireRole('rep'), async (req, res) => {
  try {
    const rep = await prisma.rep.findUniqueOrThrow({ where: { id: req.user!.sub } });
    if (!rep.stripeSubscriptionId || rep.subscriptionStatus === 'CANCELED') {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }

    const sub = await stripe.subscriptions.update(rep.stripeSubscriptionId, { cancel_at_period_end: true });

    const currentPeriodEnd = new Date(sub.current_period_end * 1000);
    await prisma.rep.update({
      where: { id: rep.id },
      data: { cancelAtPeriodEnd: true, currentPeriodEnd },
    });

    res.json({ cancelAtPeriodEnd: true, currentPeriodEnd });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
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
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await prisma.rep.update({
          where: { id: repId },
          data: {
            stripeSubscriptionId: session.subscription as string,
            billingCycle,
            subscriptionStatus: 'TRIALING',
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            renewalReminder30dSent: false,
            renewalReminder7dSent: false,
            renewalReminder1dSent: false,
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
        const newPeriodEnd = new Date(sub.current_period_end * 1000);
        const renewed = !rep.currentPeriodEnd || newPeriodEnd.getTime() > rep.currentPeriodEnd.getTime();
        await prisma.rep.update({
          where: { id: rep.id },
          data: {
            subscriptionStatus: status,
            currentPeriodEnd: newPeriodEnd,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            ...(renewed ? { renewalReminder30dSent: false, renewalReminder7dSent: false, renewalReminder1dSent: false } : {}),
          },
        });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const rep = await prisma.rep.findFirst({ where: { stripeSubscriptionId: sub.id } });
      if (rep) {
        await prisma.rep.update({ where: { id: rep.id }, data: { subscriptionStatus: 'CANCELED', cancelAtPeriodEnd: false } });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// --- Daily renewal-reminder check, called by an external scheduled trigger -
// Not behind requireAuth (there's no logged-in user calling this) — instead
// guarded by a shared secret the trigger must send.
router.post('/check-renewals', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const reps = await prisma.rep.findMany({
      where: { subscriptionStatus: { in: ['TRIALING', 'ACTIVE'] }, currentPeriodEnd: { not: null } },
    });

    const now = new Date();
    let remindersSent = 0;

    for (const rep of reps) {
      const daysUntil = Math.ceil((rep.currentPeriodEnd!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const cycleLabel = rep.billingCycle === 'ANNUAL' ? 'annual' : 'monthly';
      const dateStr = rep.currentPeriodEnd!.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      const reminders: Array<{ threshold: number; field: 'renewalReminder30dSent' | 'renewalReminder7dSent' | 'renewalReminder1dSent'; label: string }> = [
        { threshold: 30, field: 'renewalReminder30dSent', label: 'in about a month' },
        { threshold: 7, field: 'renewalReminder7dSent', label: 'in about a week' },
        { threshold: 1, field: 'renewalReminder1dSent', label: 'tomorrow' },
      ];

      for (const r of reminders) {
        if (daysUntil <= r.threshold && !rep[r.field]) {
          await sendEmail({
            to: rep.email,
            subject: `Your ${cycleLabel} subscription renews ${r.label}`,
            html: `${emailLogoHeader()}<p>Your Arrowhead Access ${cycleLabel} subscription is set to renew on <strong>${dateStr}</strong>.</p>`,
          });
          await prisma.rep.update({ where: { id: rep.id }, data: { [r.field]: true } });
          remindersSent++;
        }
      }
    }

    res.json({ checked: reps.length, remindersSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check renewals' });
  }
});

export default router;
