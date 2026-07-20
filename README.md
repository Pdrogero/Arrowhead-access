# Arrowhead Access — static site (Phase 1)

Two files, cross-linked, ready to push to GitHub and deploy on Vercel.

## Files
- `index.html` — landing page (home)
- `pricing.html` — pricing page with the volume-pricing calculator

## Deploy steps (Vercel)
1. Push both files to the root of your `arrowhead-access` GitHub repo (or a `/public` folder — just update Vercel's "Output Directory" setting to match).
2. In Vercel: **Add New Project** → import `arrowhead-access` → since there's no build step, leave "Framework Preset" as **Other** and leave build command blank.
3. Deploy. Vercel gives you a temporary `*.vercel.app` URL to confirm it works.
4. Once your Namecheap domain payment/renewal is complete: in the Vercel project → **Settings → Domains** → add your domain. Vercel will show you the DNS records (usually an A record or CNAME) to add in Namecheap's DNS settings.
5. DNS propagation can take a few minutes to a few hours.

## What's NOT in this package yet
No backend, no login, no real booking — this is Phase 1 (static marketing site) only. The "Log in" and "Request access" buttons need to eventually point to the real app once Phase 2 (backend) is deployed somewhere and wired up.
