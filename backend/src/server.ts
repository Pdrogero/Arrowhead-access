// src/server.ts — application entry point

import express from 'express';
import cors from 'cors';
import bookingsRouter from './routes/bookings.routes';
import authRouter from './routes/auth.routes';
import billingRouter from './routes/billing.routes';
import profileRouter from './routes/profile.routes';
import transfersRouter from './routes/transfers.routes';

const app = express();
app.use(cors());

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/profile', profileRouter);
app.use('/api/transfers', transfersRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Arrowhead Access backend listening on port ${PORT}`);
});
