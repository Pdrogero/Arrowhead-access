// src/routes/messages.routes.ts
// In-app messaging between a rep and an office — one conversation per
// (rep, location) pair, either side can send into it.
// Mount with: app.use('/api/messages', messagesRouter)

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireActiveSubscription } from '../auth/auth.guard';
import { sendEmail, emailLogoHeader } from '../email';
import { findPhiSignal } from '../phiFilter';

const prisma = new PrismaClient();
const router = Router();

async function resolveConversation(user: { sub: string; role: string }, body: any) {
  let repId: string;
  let locationId: string;

  if (user.role === 'rep') {
    repId = user.sub;
    locationId = String(body.locationId || '');
    if (!locationId) return null;
  } else {
    const staff = await prisma.staffUser.findUnique({ where: { id: user.sub } });
    if (!staff) return null;
    locationId = staff.locationId;
    repId = String(body.repId || '');
    if (!repId) return null;
  }

  const conversation = await prisma.conversation.upsert({
    where: { repId_locationId: { repId, locationId } },
    update: {},
    create: { repId, locationId },
  });
  return conversation;
}

// --- List the caller's conversations, newest activity first ---------------
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    let where: { repId: string } | { locationId: string };
    if (req.user!.role === 'rep') {
      where = { repId: req.user!.sub };
    } else {
      const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
      if (!staff) return res.status(404).json({ error: 'Staff not found' });
      where = { locationId: staff.locationId };
    }

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        rep: { select: { id: true, name: true, companyName: true } },
        location: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    conversations.sort((a, b) => {
      const aTime = a.messages[0]?.createdAt ?? a.createdAt;
      const bTime = b.messages[0]?.createdAt ?? b.createdAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    res.json(conversations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch conversations' });
  }
});

// --- Fetch full message history for one conversation ------------------------
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (req.user!.role === 'rep') {
      if (conversation.repId !== req.user!.sub) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      const staff = await prisma.staffUser.findUnique({ where: { id: req.user!.sub } });
      if (!staff || staff.locationId !== conversation.locationId) return res.status(404).json({ error: 'Conversation not found' });
    }

    // Opening a conversation reads everything the other side sent into it.
    const myType = req.user!.role === 'rep' ? 'REP' : 'OFFICE';
    const otherType = myType === 'REP' ? 'OFFICE' : 'REP';
    await prisma.message.updateMany({
      where: { conversationId: conversation.id, senderType: otherType, readAt: null },
      data: { readAt: new Date() },
    });

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// --- Send a message, creating the conversation on first contact -----------
// requireActiveSubscription is a no-op for office callers — it only blocks
// unsubscribed reps.
router.post('/', requireAuth, requireActiveSubscription, async (req, res) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message body is required' });

    const phiSignal = findPhiSignal(body);
    if (phiSignal) {
      return res.status(400).json({
        error: `This message looks like it may contain ${phiSignal} — please remove any patient-identifying information before sending. Messages on Arrowhead Access must not include PHI (see our Terms of Service).`,
      });
    }

    const conversation = await resolveConversation(req.user!, req.body);
    if (!conversation) return res.status(400).json({ error: 'locationId (rep) or repId (office) is required' });

    const eventLabel = typeof req.body.eventLabel === 'string' ? req.body.eventLabel.trim().slice(0, 200) || undefined : undefined;

    const senderType = req.user!.role === 'rep' ? 'REP' : 'OFFICE';
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, senderType, senderId: req.user!.sub, body, eventLabel },
    });

    const full = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: { rep: true, location: { include: { staff: true } } },
    });
    if (full) {
      if (senderType === 'REP') {
        full.location.staff.forEach(staff => {
          sendEmail({
            to: staff.email,
            subject: `New message from ${full.rep.name}`,
            html: `${emailLogoHeader()}<p><strong>${full.rep.name}</strong> (${full.rep.companyName}) sent you a message: "${body}"</p>`,
          }).catch(() => {});
        });
      } else {
        sendEmail({
          to: full.rep.email,
          subject: `New message from ${full.location.name}`,
          html: `${emailLogoHeader()}<p><strong>${full.location.name}</strong> sent you a message: "${body}"</p>`,
        }).catch(() => {});
      }
    }

    res.status(201).json(message);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send message' });
  }
});

// --- Daily unread-message check, called by a scheduled trigger --------------
// Not behind requireAuth — guarded by the same shared cron secret used for
// the lunch-reminder and renewal-reminder checks. Sends one reminder email
// per message that's sat unread for 24+ hours, then marks it so it's never
// reminded twice.
const UNREAD_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;

router.post('/check-unread-reminders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const cutoff = new Date(Date.now() - UNREAD_REMINDER_DELAY_MS);
    const messages = await prisma.message.findMany({
      where: { readAt: null, reminderSent: false, createdAt: { lte: cutoff } },
      include: { conversation: { include: { rep: true, location: { include: { staff: true } } } } },
    });

    let remindersSent = 0;
    for (const message of messages) {
      const { conversation } = message;
      if (message.senderType === 'REP') {
        for (const staff of conversation.location.staff) {
          await sendEmail({
            to: staff.email,
            subject: `Reminder: unread message from ${conversation.rep.name}`,
            html: `${emailLogoHeader()}<p>You still have an unread message from <strong>${conversation.rep.name}</strong> (${conversation.rep.companyName}) sent over a day ago: "${message.body}"</p>`,
          }).catch(() => {});
        }
      } else {
        await sendEmail({
          to: conversation.rep.email,
          subject: `Reminder: unread message from ${conversation.location.name}`,
          html: `${emailLogoHeader()}<p>You still have an unread message from <strong>${conversation.location.name}</strong> sent over a day ago: "${message.body}"</p>`,
        }).catch(() => {});
      }
      await prisma.message.update({ where: { id: message.id }, data: { reminderSent: true } });
      remindersSent++;
    }

    res.json({ checked: messages.length, remindersSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check unread message reminders' });
  }
});

export default router;
