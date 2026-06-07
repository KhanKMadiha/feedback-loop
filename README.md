# Feedback Loop

Prototype **Voice of the Customer (VoC)** pipeline: support feature requests → AI-assisted grouping → enterprise-weighted prioritisation → engineering-ready briefs.

Built as a portfolio project by [Madiha Khan](https://madihaintech.me) — aligned with product quality / user operations workflows (structured intake, ranked themes, business-context prioritisation).

**Repository:** [github.com/KhanKMadiha/feedback-loop](https://github.com/KhanKMadiha/feedback-loop)

## Live demo

- **Dashboard:** https://feedback-loop.pages.dev/src/dashboard.html
- **Submit feature request:** https://feedback-loop.pages.dev/src/submit-feature-request.html

AI analysis runs via a Cloudflare Worker proxy (5 synthesis runs per IP per hour on the public demo).

## What it demonstrates

- **VoC intake** — Capture structured feature requests by **request type** (Authentication, API, Billing, etc.), account tier, and context — with local persistence.
- **Ranked themes** — Claude groups selected tickets by theme, scores priority 1–10 from frequency and account tier (Enterprise > Pro > Free), and returns summaries, recommended actions, and affected accounts.
- **Product briefs** — Export a formatted PDF brief for engineering, with per-ticket supporting evidence.
- **Secure API access** — Cloudflare Worker proxies the Claude API so keys never ship to the browser.

**Request types:** Authentication · API · Integrations · User Management · Billing

## Demo flow

1. **Submit feature request** — `/src/submit-feature-request.html`
2. **Dashboard** — `/src/dashboard.html`
   - **Step 1:** Filter and select tickets
   - **Step 2:** Analyse → ranked themes → Product brief (PDF)

## Run locally

Clone the repo, then start the static file server:

```bash
git clone https://github.com/KhanKMadiha/feedback-loop.git
cd feedback-loop
npm start
```

Or, from anywhere (no `cd` required):

```bash
git clone https://github.com/KhanKMadiha/feedback-loop.git
bash feedback-loop/start.sh
```

**Do not paste a folder path alone into the terminal** — that causes `zsh: permission denied`. Always use `cd` or `bash start.sh`.

Then open:

- http://localhost:3000/src/submit-feature-request.html — VoC intake
- http://localhost:3000/src/dashboard.html — VoC dashboard (tickets → ranked themes)

For **Analyse tickets**, start the proxy in a second terminal:

```bash
npm run dev:proxy
```

### API key (local)

Copy `workers/.dev.vars.example` to `workers/.dev.vars` and add your Anthropic key:

```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

Restart `npm run dev:proxy` after creating or editing `.dev.vars`.

## Deploy (live public demo)

### 1. Worker proxy

```bash
cd workers

# Create KV for rate limiting (once)
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create RATE_LIMIT --preview

# Paste the returned ids into wrangler.toml under [[kv_namespaces]]

wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ALLOWED_ORIGINS
# e.g. https://feedback-loop.pages.dev,https://madihaintech.me

wrangler deploy
```

Production Worker URL: `https://feedback-loop-proxy.madiha00.workers.dev`

Update `data-proxy-url` on the `<script>` tags in `src/dashboard.html` and `src/submit-feature-request.html` if you deploy under a different account subdomain. Local dev automatically uses `http://localhost:8787`.

### 2. Frontend (Cloudflare Pages)

**Automatic deploys (recommended):** This repo includes a GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) that deploys to Pages on every push to `main`. Add these secrets in GitHub → **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|--------|
| `CLOUDFLARE_API_TOKEN` | API token with **Cloudflare Pages — Edit** permission ([create here](https://dash.cloudflare.com/profile/api-tokens)) |
| `CLOUDFLARE_ACCOUNT_ID` | `abb09903dc138368f3cd06baf5b3edbe` |

> **Note:** This Pages project was created via direct upload (Wrangler), so Cloudflare dashboard Git integration cannot be added to it. GitHub Actions provides the same result — deploy on every push.

**Manual deploy:**

```bash
# From the repo root
wrangler pages deploy . --project-name feedback-loop --branch main
```

Demo URLs:

- `/src/submit-feature-request.html` — intake
- `/src/dashboard.html` — dashboard

## Demo abuse safeguards

The Worker proxy includes:

| Safeguard | Default |
|-----------|---------|
| **Origin allowlist** | Only requests from `ALLOWED_ORIGINS` (your Pages URL + localhost for dev) |
| **Rate limit** | 5 synthesis runs per IP per hour (KV-backed) |
| **Payload caps** | Allowed model only, max 8192 tokens, max 25 tickets per request |
| **Kill switch** | Set `DEMO_ENABLED=false` as a Worker secret to pause synthesis |

Also set a **monthly spend limit** in the [Anthropic console](https://console.anthropic.com/settings/billing) as a billing backstop.

## Stack

- Vanilla HTML / CSS / JavaScript
- Claude Sonnet 4 (Anthropic Messages API)
- Cloudflare Workers + KV
- jsPDF (product brief export)

## Project structure

```
feedback-loop/
  data/mock-tickets.json   # Sample tickets by request type
  src/                     # Intake, dashboard, settings
  workers/proxy.js         # Claude API proxy (rate limit + origin check)
```

## Application note (portfolio / job applications)

*Feedback Loop is a prototype VoC tool I built to mirror how user operations teams turn scattered support feedback into actionable product signal. Support agents submit structured tickets by request type (e.g. Authentication, API, Billing) and account tier; the dashboard loads that data and uses Claude (via a Cloudflare Worker proxy) to synthesise signal by theme, score priority using frequency and enterprise weighting, and surface engineering briefs with recommended actions and affected accounts. It demonstrates the feedback loop between frontline support and engineering — AI-assisted synthesis with human-in-the-loop intake — and the kind of tooling infrastructure that makes quality operations scalable.*
