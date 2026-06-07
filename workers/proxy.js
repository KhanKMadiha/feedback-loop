/**
 * Feature Signal — Claude API proxy (Cloudflare Worker)
 *
 * Keeps ANTHROPIC_API_KEY on the server. Adds demo safeguards:
 * origin allowlist, per-IP rate limiting (KV), and payload caps.
 *
 * Local:  workers/.dev.vars  → ANTHROPIC_API_KEY=sk-ant-...
 * Deploy: wrangler secret put ANTHROPIC_API_KEY
 *         wrangler secret put ALLOWED_ORIGINS  (comma-separated Pages URLs)
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ALLOWED_MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 8192;
const MAX_TICKETS = 25;
const DEFAULT_ORIGINS =
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8787";

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || DEFAULT_ORIGINS;
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = parseAllowedOrigins(env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return headers;
}

function jsonResponse(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

function isOriginAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return parseAllowedOrigins(env).includes(origin);
}

function countTicketsInPayload(body) {
  const msg = body.messages?.find((m) => m.role === "user");
  if (!msg?.content || typeof msg.content !== "string") return 0;

  const marker = "\n\n";
  const idx = msg.content.lastIndexOf(marker);
  if (idx === -1) return 0;

  try {
    const tickets = JSON.parse(msg.content.slice(idx + marker.length));
    return Array.isArray(tickets) ? tickets.length : 0;
  } catch {
    return 0;
  }
}

function validatePayload(body) {
  if (body.model !== ALLOWED_MODEL) {
    return `Model not allowed. Use ${ALLOWED_MODEL}.`;
  }

  const maxTokens = Number(body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    return `max_tokens must be between 1 and ${MAX_TOKENS}.`;
  }

  const ticketCount = countTicketsInPayload(body);
  if (ticketCount < 1 || ticketCount > MAX_TICKETS) {
    return `Request must include between 1 and ${MAX_TICKETS} tickets.`;
  }

  if (!body.system || !Array.isArray(body.messages) || body.messages.length === 0) {
    return "Invalid messages payload.";
  }

  return null;
}

async function checkRateLimit(request, env) {
  const max = Number(env.RATE_LIMIT_MAX || 5);
  const windowSec = Number(env.RATE_LIMIT_WINDOW || 3600);
  if (!env.RATE_LIMIT_KV || max < 1) return null;

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `synth:${ip}`;
  const raw = await env.RATE_LIMIT_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= max) {
    return `Demo limit reached (${max} synthesis runs per hour). Try again later.`;
  }

  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: windowSec });
  return null;
}

export default {
  async fetch(request, env) {
    if (env.DEMO_ENABLED === "false") {
      return jsonResponse({ error: "Signal synthesis is temporarily unavailable." }, 503, request, env);
    }

    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(request, env)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "feature-signal-proxy" }, 200, request, env);
    }

    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return jsonResponse({ error: "Not found" }, 404, request, env);
    }

    if (!isOriginAllowed(request, env)) {
      return jsonResponse({ error: "Origin not allowed." }, 403, request, env);
    }

    const rateError = await checkRateLimit(request, env);
    if (rateError) {
      return jsonResponse({ error: rateError }, 429, request, env);
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return jsonResponse(
        { error: "ANTHROPIC_API_KEY is not configured on the worker." },
        500,
        request,
        env
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400, request, env);
    }

    const validationError = validatePayload(body);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400, request, env);
    }

    const upstream = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const responseText = await upstream.text();

    return new Response(responseText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        ...corsHeaders(request, env),
      },
    });
  },
};
