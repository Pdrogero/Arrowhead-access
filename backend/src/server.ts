// src/server.ts — application entry point

import './instrument';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bookingsRouter from './routes/bookings.routes';
import authRouter from './routes/auth.routes';
import billingRouter from './routes/billing.routes';
import profileRouter from './routes/profile.routes';
import transfersRouter from './routes/transfers.routes';
import slotsRouter from './routes/slots.routes';
import policiesRouter from './routes/policies.routes';
import employeesRouter from './routes/employees.routes';
import reviewsRouter from './routes/reviews.routes';
import messagesRouter from './routes/messages.routes';
import literatureRouter from './routes/literature.routes';
import locationsRouter from './routes/locations.routes';
import teammatesRouter from './routes/teammates.routes';

const app = express();

// Render sits behind a reverse proxy, so trust its X-Forwarded-For header
// to get each request's real client IP — otherwise every request looks
// like it comes from the proxy and shares one rate-limit bucket.
app.set('trust proxy', 1);

app.use(cors());
// This is a pure JSON API with no HTML pages of its own, so the default
// Content-Security-Policy (built for HTML) is unnecessary; explicitly
// allow cross-origin loads since app.html (on a different domain) is the
// only consumer of this API.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// General baseline against abuse/DoS across the whole API.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
// Tighter limit on login specifically, so a script can't brute-force
// passwords — well below what a real user could ever hit by hand.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});
app.use(['/api/auth/rep/login', '/api/auth/staff/login', '/api/auth/forgot-password'], loginLimiter);

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/profile', profileRouter);
app.use('/api/transfers', transfersRouter);
app.use('/api/slots', slotsRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/literature', literatureRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/teammates', teammatesRouter);

// Reports any error that reaches Express's error-handling chain to Sentry
// before falling through to Express's default 500 response. Must be
// registered after all routes.
Sentry.setupExpressErrorHandler(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Arrowhead Access backend listening on port ${PORT}`);
});
