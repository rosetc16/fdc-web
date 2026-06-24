# Fantasy Draft Compass — Web App

The website people use. React + Vite. Builds to a folder of static files (`dist/`) you can host
anywhere (Render Static Site, Netlify, Vercel, Cloudflare Pages…).

You do **not** need to be a developer to deploy this — see `DEPLOY-GUIDE-2-frontend.md`. This README
is the technical reference.

## What it is
- The full Fantasy Draft Compass app: marketing site, sign up / season pass, league setup, the live
  draft room with the prediction engine, mocks, ADP Intelligence, trade tools, admin console.
- It talks to the backend (`fdc-backend`) for real accounts, payments, and live ADP/projections —
  **but only if you point it at one.** Without a backend it runs in local/demo mode so it always works.

## Local development
```bash
npm install
npm run dev        # opens a local dev server (prints the URL)
```
To test against your backend locally, create `.env`:
```
VITE_API_URL=https://fdc-backend.onrender.com
```

## Build for production
```bash
npm run build      # outputs static files to dist/
npm run preview    # preview the production build locally
```

## The one setting that matters: `VITE_API_URL`
- **Set it** to your backend URL → real accounts, Stripe checkout, live data.
- **Leave it empty** → demo mode (simulated accounts/payments, built-in sample data). Good for a
  marketing-only preview, but launch with it set.

> Note: Vite bakes env vars in at **build time**, so after changing `VITE_API_URL` you must rebuild
> (on Render, that means triggering a redeploy).

## Deploy on Render (static site)
1. New → Static Site, connect this repo.
2. Build command: `npm install && npm run build`. Publish directory: `dist`.
3. Add environment variable `VITE_API_URL` = your backend URL.
4. Add a **rewrite rule**: Source `/*` → Destination `/index.html` (so the single-page app handles
   its own routing). Render: Settings → Redirects/Rewrites → Add, type "Rewrite".
5. Add your custom domain on the Settings page (copy-paste DNS records).

## How backend wiring works (for the curious)
- `src/api.js` — the backend client. `hasBackend` is true when `VITE_API_URL` is set.
- `src/App.jsx` — the app. Auth, payments, and session restore check `hasBackend`: if true they call
  the API; if not they fall back to the original local/simulated behavior. So the same build works
  both ways and connecting the backend is a pure upgrade.
- `src/storage.js` — installs `window.storage` backed by localStorage for local persistence.

## Notes
- Fonts (Barlow Condensed, DM Mono, Inter) and Tabler icons load from CDNs in `index.html` /
  `index.css` — no font files bundled.
- The prediction engine runs entirely in the browser on its dataset; live ADP/projections from the
  backend enhance it via the ADP Intelligence view and (when wired further) the board numbers.
