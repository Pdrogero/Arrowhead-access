// src/instrument.ts
// Initializes Sentry error tracking. Must be the very first thing server.ts
// imports so Sentry's instrumentation is in place before express, prisma,
// etc. are first required. Requires SENTRY_DSN on Render — the SDK safely
// no-ops when it's unset, so this is harmless to deploy without it.

import * as Sentry from '@sentry/node';

if (!process.env.SENTRY_DSN) {
  console.warn('SENTRY_DSN is not set — backend error tracking is currently disabled.');
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
});
