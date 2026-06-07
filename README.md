# Feature Signal

Prototype **Voice of the Customer (VoC)** pipeline: support feature requests → AI-assisted grouping → enterprise-weighted prioritisation → engineering-ready briefs.

Built as a portfolio project aligned with product quality / user operations workflows (structured intake, ranked themes, business-context prioritisation).

## What it demonstrates

- **VoC intake** — Capture structured feature requests by **request type** (Authentication, API, Billing, etc.), account tier, and context—with local persistence.
- **Ranked themes** — Claude groups tickets by theme, scores priority 1–10 from frequency and account tier (Enterprise > Pro > Free), and returns summaries, recommended actions, and affected accounts.
- **Secure API access** — Cloudflare Worker proxies the Claude API so keys never ship to the browser.

**Request types:** Authentication · API · Integrations · User Management · Billing

V1 focuses on **feature requests**; the same pipeline extends to bug triage and agentic prioritisation.

## Run locally

**Do not paste the project folder path alone into the terminal** — that causes `zsh: permission denied`. Use `cd` first, or run `start.sh` below.

From the project root:

```bash
cd /Users/maryamkhan/Madiha/Projects/feature-signal
npm start
```

Or, from anywhere:

```bash
bash /Users/maryamkhan/Madiha/Projects/feature-signal/start.sh
```

Then open:

- http://localhost:3000/src/index.html — VoC intake
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
# e.g. https://feature-signal.pages.dev,https://your-portfolio.com

wrangler deploy
```

Update `data-proxy-url` on the `<script>` tags in `src/index.html` and `src/dashboard.html` to your Worker URL (e.g. `https://feature-signal-proxy.<account>.workers.dev`).

### 2. Frontend (Cloudflare Pages)

Deploy the repo root as a static site. Demo URLs:

- `/src/index.html` — intake
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

## Project structure

```
feature-signal/
  data/mock-tickets.json   # Sample tickets by request type
  src/                     # Intake + dashboard (vanilla HTML/CSS/JS)
  workers/proxy.js         # Claude API proxy (rate limit + origin check)
```

## Application note (portfolio / job applications)

*Feature Signal is a prototype VoC tool I built to mirror how user operations teams turn scattered support feedback into actionable product signal. Support agents submit structured tickets by request type (e.g. Authentication, API, Billing) and account tier; the dashboard loads that data and uses Claude (via a Cloudflare Worker proxy) to synthesise signal by theme, score priority using frequency and enterprise weighting, and surface engineering briefs with recommended actions and affected accounts. It demonstrates the feedback loop between frontline support and engineering—AI-assisted synthesis with human-in-the-loop intake—and the kind of tooling infrastructure that makes quality operations scalable.*
