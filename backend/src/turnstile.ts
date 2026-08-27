// src/turnstile.ts
// Verifies a Cloudflare Turnstile token against Cloudflare's siteverify
// endpoint, to keep automated scripts from mass-creating rep/office
// accounts. Requires TURNSTILE_SECRET_KEY on Render (paired with the site
// key embedded in app.html).

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token: unknown, remoteip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Not configured yet — don't block real signups on a missing env var,
    // but make the gap visible in logs until it's set.
    console.warn('TURNSTILE_SECRET_KEY is not set — bot-verification check is currently a no-op.');
    return true;
  }
  if (typeof token !== 'string' || !token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.set('remoteip', remoteip);

    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification request failed:', err);
    return false;
  }
}
