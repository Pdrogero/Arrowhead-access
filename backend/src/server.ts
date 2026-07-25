// src/server.ts — application entry point

import express from 'express';
import cors from 'cors';
import bookingsRouter from './routes/bookings.routes';
import authRouter from './routes/auth.routes';

const app = express();
app.use(cors()); // allows the browser-based app demo (or any frontend) to call this API
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Arrowhead Access backend listening on port ${PORT}`);
});
