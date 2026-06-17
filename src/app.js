/**
 * Feature Signal — vanilla JS app
 * Intake: persist tickets to localStorage
 * Dashboard: load mock + stored tickets, synthesise signal via Claude proxy
 */

(function () {
  "use strict";

  // --- Configuration ---

  const STORAGE_KEY = "feature-signal-tickets";
  const DATA_SOURCE_KEY = "feature-signal-data-source";
  const MODEL = "claude-sonnet-4-20250514";
  const MOCK_TICKETS_PATH = "../data/mock-tickets.json";
  const IMPORT_MAX_ROWS = 500;
  const TIERS = ["Enterprise", "Pro", "Free"];

  /** Request types used in mock tickets and intake. */
  const CATEGORIES = [
    "Authentication",
    "API",
    "Integrations",
    "User Management",
    "Billing",
  ];

  /** Ticket IDs selected via checkboxes for Step 2 analysis. */
  let selectedTicketIds = new Set();

  const LEGACY_CATEGORY_MAP = {
    Editor: "API",
    IDE: "API",
    Agents: "Integrations",
    DevOps: "API",
    Accessibility: "API",
    Dashboards: "Billing",
    "API & integrations": "API",
    "Security & access": "Authentication",
    "User management": "User Management",
    "CLI & DevOps": "Integrations",
  };

  const PRODUCTION_PROXY_URL = "https://feedback-loop-proxy.madiha00.workers.dev";

  /** Read proxy base URL from script tag; localhost always uses the dev worker. */
  function getProxyUrl() {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8787";
    }
    const script = document.querySelector('script[src*="app.js"]');
    return (script && script.dataset.proxyUrl) || PRODUCTION_PROXY_URL;
  }

  // --- Storage ---

  function getStoredTickets() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveTicket(ticket) {
    const tickets = getStoredTickets();
    tickets.push(ticket);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
  }

  /** Intake and imported tickets can be removed; mock/demo tickets are never deletable. */
  function isDeletableTicket(ticket) {
    return ticket?.source === "local" || ticket?.source === "import";
  }

  function getDataSourceMode() {
    try {
      const mode = localStorage.getItem(DATA_SOURCE_KEY);
      return mode === "import-only" ? "import-only" : "merge";
    } catch {
      return "merge";
    }
  }

  function setDataSourceMode(mode) {
    localStorage.setItem(DATA_SOURCE_KEY, mode === "import-only" ? "import-only" : "merge");
  }

  function replaceImportedTickets(tickets) {
    const kept = getStoredTickets().filter((t) => t.source !== "import");
    const imported = tickets.map((ticket) => ({ ...ticket, source: "import" }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...kept, ...imported]));
  }

  function deleteStoredTicket(ticketId) {
    const tickets = getStoredTickets().filter((t) => t.id !== ticketId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
  }

  const MOCK_ID_FLOOR = 184521;

  function parseTicketIdNumber(id) {
    const match = String(id || "").match(/#?(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function generateTicketId() {
    const stored = getStoredTickets();
    const max = stored.reduce((n, t) => Math.max(n, parseTicketIdNumber(t.id)), MOCK_ID_FLOOR);
    return `#${max + 1}`;
  }

  /** Unify mock and intake ticket shapes for dashboard rendering. */
  function normalizeTicket(ticket) {
    const priorityRaw = ticket.feature_request_priority || ticket.priority || "";
    const priorityMatch = String(priorityRaw).match(/^(Critical|High|Medium|Low)/i);
    const priority = priorityMatch ? priorityMatch[1] : ticket.priority || "";

    return {
      ...ticket,
      title: ticket.feature_request_name || ticket.title || "",
      description: ticket.feature_request_description || ticket.description || "",
      priority,
      business_impact: ticket.priority_justification || ticket.business_impact || "",
      sentiment: ticket.sentiment || "Neutral",
      sentiment_score: Number.isFinite(Number(ticket.sentiment_score))
        ? Number(ticket.sentiment_score)
        : 5,
    };
  }

  function getTicketTitle(ticket) {
    return ticket.title || ticket.feature_request_name || "";
  }

  // --- Ticket loading ---

  async function loadMockTickets() {
    const res = await fetch(MOCK_TICKETS_PATH);
    if (!res.ok) {
      throw new Error(`Failed to load mock tickets (${res.status})`);
    }
    const tickets = await res.json();
    return tickets.map((ticket) => ({ ...ticket, source: "mock" }));
  }

  async function loadAllTickets() {
    const useMock = getDataSourceMode() !== "import-only";
    const mock = useMock ? await loadMockTickets() : [];
    const stored = getStoredTickets().map((t) => ({ ...t, source: t.source || "local" }));
    return [...mock, ...stored].map(normalizeTicket);
  }

  // --- Claude signal synthesis ---

  const CLUSTER_SYSTEM_PROMPT = `You are a product intelligence assistant embedded in a Voice of the Customer tool used by a support team to brief engineering and product leadership. You will receive a list of enterprise SaaS feature request tickets. Each ticket has a category, account name, account tier, priority, priority justification, and feature request description.

Analyse the tickets and cluster them into themes. Return a JSON object only with no markdown formatting and no extra text.

Grouping rules (critical):
- Group tickets into the same theme only when they share the same underlying capability gap or root cause: the specific missing product capability that would satisfy every request in the group with one coherent engineering effort.
- Do NOT group tickets together only because they share a category (for example Authentication), product area, or broad topic. Category similarity alone is never sufficient.
- Do NOT group tickets that would require different engineering workstreams, different product surfaces, or unrelated fixes to resolve.
- Example of incorrect grouping: a permission sync request and a Slack notification routing request must NOT be one theme just because both are identity-adjacent.
- If a ticket does not share a root cause with any other ticket in the batch, it must become its own single-ticket theme. Never fold unrelated tickets into a larger theme to reduce theme count.
- Every ticket ID from the input must appear in exactly one theme's linked_tickets array. Do not omit, duplicate, or invent ticket IDs.

The JSON must have exactly one top-level field:

clusters: an array of theme objects, ordered from highest to lowest priority. Each theme object must have exactly these fields:

theme_name: three to five words maximum. Must read like a Jira ticket title or a Linear issue title. Be specific to the actual requests, never generic. Never use the words Enterprise, Platform, Operations, or Management. Good examples: Identity Provider Sync, Bulk Migration API, SSO Session Controls. Bad examples: Enterprise Onboarding, Scale Operations.
theme_description: exactly two lines separated by a newline character. Line one states the core customer need in under 15 words. Line two states the business impact if unresolved in under 15 words. Do not mention affected account names. Synthesise the need; do not copy phrasing from ticket fields.
theme_description_full: structured text for exported product briefs and the Analysis theme summary, using newline-separated lines in this exact format. Line one is a single opening sentence framing the overall problem in your own analytical voice. Then for each account in the linked tickets write one bullet point. Every account must have its own bullet point. Include every single account from the linked tickets without exception. Do not select only some accounts to mention. If four tickets are in this theme from four accounts there must be four bullet points. Do not summarise multiple accounts into one bullet or omit any account. Each bullet line must start with the bullet character followed by a space, then the account name, a colon, and the blocker for that account. Account bullet rules (critical): state what is blocking that account in the customer's own words — the operational pain or constraint they cannot get past. Write as analysis, not transcription. Do NOT lift, paraphrase closely, or concatenate wording from feature_request_name, feature_request_description, or priority_justification. Each bullet must read differently from the ticket detail a reader would see below; if it could be mistaken for pasted ticket text, rewrite it. Then one final closing sentence stating the business consequence if unresolved.
recommended_action: an object with two fields, title and description. Recommended action rules (critical): use the priority levels already present in the linked ticket data (Critical, High, Medium, Low) — do not ignore or flatten them across distinct asks. If this theme contains only one distinct technical capability, title is one specific actionable recommendation for engineering or product (for example Build SCIM 2.0 provisioning with Okta and Azure AD group sync) and description is two sentences expanding on what to build and why it unblocks the most customers. If this theme contains more than one distinct technical capability (for example real-time sync versus a bulk import endpoint), do NOT merge them into one flat sentence. Instead, description must use exactly one line per capability: each line names the specific build action for that capability and reflects the priority of the highest-priority ticket attached to it (state Critical, High, Medium, or Low at the start of the line). Order those lines from highest to lowest priority: Critical first, then High, then Medium, then Low. title in this case should be a short umbrella phrase for the theme (three to eight words), not a merged list of every capability.
linked_tickets: an array of ticket IDs assigned to this theme only. Include every ticket in this theme and no others.
ticket_count: the number of tickets in this theme.
customer_impact: one of Low, Medium, High, or Very high based on the priority and tier of the tickets in this theme.
priority: the highest priority level present across tickets in this theme, one of Critical, High, Medium, or Low.
top_linked_tickets: an array of up to the three most relevant tickets in this theme, each with id, feature_request_name, and date.
oldest_request_date: the earliest date value across linked tickets in this theme in YYYY-MM-DD format.
affected_accounts: an array of unique account names across linked tickets in this theme.
enterprise_ticket_count: the number of tickets in this theme where account_tier is Enterprise.

Ticket ids use the format "#184521".`;

  function buildClusterUserMessage(tickets) {
    return `Cluster these ${tickets.length} feature request tickets into themes by shared root cause. Tickets that do not share a capability gap with others must each become their own theme.\n\n${JSON.stringify(tickets, null, 2)}`;
  }

  /**
   * Send tickets to Claude via the Cloudflare Worker proxy.
   * @returns {Promise<{ clusters: Array }>}
   */
  async function clusterTicketsWithClaude(tickets) {
    const proxyUrl = getProxyUrl().replace(/\/$/, "");
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        system: CLUSTER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildClusterUserMessage(tickets),
          },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let message = `Proxy error ${res.status}`;
      try {
        const parsed = JSON.parse(errBody);
        if (parsed.error) {
          message =
            typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
        }
      } catch {
        if (errBody) message = errBody.slice(0, 280);
      }
      throw new Error(message);
    }

    const data = await res.json();
    const text = extractAssistantText(data);
    return parseClusterJson(text);
  }

  /** Pull text from Anthropic Messages API response shape. */
  function extractAssistantText(data) {
    if (!data.content || !Array.isArray(data.content)) {
      throw new Error("Unexpected API response format");
    }
    const block = data.content.find((b) => b.type === "text");
    if (!block || !block.text) {
      throw new Error("No text content in API response");
    }
    return block.text.trim();
  }

  function normalizeThemeCluster(raw) {
    return {
      name: raw.theme_name || raw.name || "Theme",
      summary: raw.theme_description || raw.summary || "",
      summary_full: raw.theme_description_full || "",
      recommended_action: raw.recommended_action || null,
      linked_tickets: raw.linked_tickets || raw.ticket_ids || [],
      ticket_count: raw.ticket_count,
      customer_impact: raw.customer_impact,
      priority: raw.priority,
      top_linked_tickets: raw.top_linked_tickets || [],
      oldest_request_date: raw.oldest_request_date,
      affected_accounts: raw.affected_accounts || [],
      enterprise_ticket_count: raw.enterprise_ticket_count,
    };
  }

  /** Parse JSON from model output, tolerating optional markdown fences. */
  function parseClusterJson(text) {
    let cleaned = text;
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      cleaned = fence[1].trim();
    }
    const parsed = JSON.parse(cleaned);
    if (parsed.theme_name || parsed.theme_description || parsed.theme_description_full) {
      return { clusters: [normalizeThemeCluster(parsed)] };
    }
    if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
      throw new Error("Response missing theme data");
    }
    return {
      clusters: parsed.clusters.map((cluster) => normalizeThemeCluster(cluster)),
    };
  }

  // --- UI helpers ---

  /** Normalise category from ticket data, including legacy intake labels. */
  function getTicketCategory(ticket) {
    const raw = ticket.category || ticket.product || ticket.platform || "Unknown";
    return LEGACY_CATEGORY_MAP[raw] || raw;
  }

  function categoryBadgeClass(category) {
    const map = {
      Authentication: "badge--category-authentication",
      API: "badge--category-api",
      Integrations: "badge--category-integrations",
      "User Management": "badge--category-user-management",
      Billing: "badge--category-billing",
    };
    return map[category] || "badge--category-api";
  }

  function tierBadgeClass(tier) {
    const t = (tier || "").toLowerCase();
    if (t === "enterprise") return "badge--tier-enterprise";
    if (t === "pro") return "badge--tier-pro";
    return "badge--tier-free";
  }

  function accountPillClass(tier) {
    const t = (tier || "").toLowerCase();
    if (t === "enterprise") return "theme-detail-card__account-pill--enterprise";
    if (t === "pro") return "theme-detail-card__account-pill--pro";
    return "theme-detail-card__account-pill--free";
  }

  function getAffectedAccountsWithTier(tickets) {
    const tierRank = { Enterprise: 3, Pro: 2, Free: 1 };
    const accountMap = new Map();
    for (const ticket of tickets) {
      const name = ticket.account_name;
      if (!name) continue;
      const tier = ticket.account_tier || "Free";
      const existing = accountMap.get(name);
      if (!existing || (tierRank[tier] || 0) > (tierRank[existing] || 0)) {
        accountMap.set(name, tier);
      }
    }
    return [...accountMap.entries()]
      .map(([name, tier]) => ({ name, tier }))
      .sort((a, b) => {
        const diff = (tierRank[b.tier] || 0) - (tierRank[a.tier] || 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
  }

  function getAccountRowsFromTickets(tickets) {
    const tierRank = { Enterprise: 3, Pro: 2, Free: 1 };
    const priorityOrder = ["Critical", "High", "Medium", "Low"];
    const accountMap = new Map();

    for (const ticket of tickets) {
      const name = ticket.account_name;
      if (!name) continue;
      const tier = ticket.account_tier || "Free";
      const priority = ticket.priority || "Low";
      const existing = accountMap.get(name);
      if (!existing) {
        accountMap.set(name, { name, tier, priority });
        continue;
      }
      if ((tierRank[tier] || 0) > (tierRank[existing.tier] || 0)) existing.tier = tier;
      const currentRank = priorityOrder.findIndex(
        (level) => level.toLowerCase() === String(existing.priority).toLowerCase()
      );
      const nextRank = priorityOrder.findIndex(
        (level) => level.toLowerCase() === String(priority).toLowerCase()
      );
      if (nextRank >= 0 && (currentRank < 0 || nextRank < currentRank)) {
        existing.priority = priority;
      }
    }

    return [...accountMap.values()].sort((a, b) => {
      const tierDiff = (tierRank[b.tier] || 0) - (tierRank[a.tier] || 0);
      return tierDiff !== 0 ? tierDiff : a.name.localeCompare(b.name);
    });
  }

  function getThemeDescriptionLines(summary) {
    return String(summary || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2);
  }

  function ticketPriorityBadgeClass(priority) {
    const p = (priority || "").toLowerCase();
    if (p === "critical") return "badge--priority-critical";
    if (p === "high") return "badge--priority-high";
    if (p === "medium") return "badge--priority-medium";
    if (p === "low") return "badge--priority-low";
    return "badge--priority-normal";
  }

  function formatTicketDate(dateStr) {
    if (!dateStr) return "—";
    const date = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function normalizePriorityScore(raw) {
    const score = Number(raw);
    if (!Number.isFinite(score) || score <= 0) return 0;
    if (score > 10) return Math.min(10, Math.round(score / 10));
    return Math.min(10, Math.round(score));
  }

  function priorityClass(score) {
    if (score >= 8) return "priority-score__value--high";
    if (score >= 5) return "priority-score__value--medium";
    return "priority-score__value--low";
  }

  function themePriorityTier(score) {
    if (score >= 8) return "High";
    if (score >= 5) return "Medium";
    return "Low";
  }

  function themePriorityBadgeClass(score) {
    if (score >= 8) return "badge--priority-high";
    if (score >= 5) return "badge--priority-medium";
    return "badge--priority-low";
  }

  function showAlert(el, message, type) {
    el.textContent = message;
    el.className = `alert alert--${type}`;
    el.hidden = false;
  }

  function hideAlert(el) {
    el.hidden = true;
    el.textContent = "";
  }

  /** User-facing message for signal synthesis failures. */
  function formatSynthesisError(message) {
    const msg = message || "Unknown error";
    if (msg.includes("Demo limit reached") || msg.includes("Origin not allowed")) {
      return msg;
    }
    if (msg.includes("authentication_error") || msg.includes("invalid x-api-key")) {
      return `${msg} Check ANTHROPIC_API_KEY in workers/.dev.vars and restart the proxy.`;
    }
    return `${msg} Ensure the proxy worker is running and ANTHROPIC_API_KEY is set.`;
  }

  // --- Toast ---

  let toastTimer = null;

  function showToast(message, type) {
    const toast = document.getElementById("toast");
    const messageEl = document.getElementById("toast-message");
    if (!toast || !messageEl) return;

    if (toastTimer) clearTimeout(toastTimer);

    messageEl.textContent = message;
    toast.className = `toast toast--${type || "success"}`;
    toast.hidden = false;

    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.hidden = true;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  // --- Intake page ---

  function initIntake() {
    const form = document.getElementById("intake-form");
    const submitBtn = document.getElementById("submit-btn");
    const toastClose = document.getElementById("toast-close");
    const productArea = document.getElementById("product_area");
    const productAreaOtherWrap = document.getElementById("product-area-other-wrap");
    const productAreaOther = document.getElementById("product_area_other");

    if (!form) return;

    if (toastClose) toastClose.addEventListener("click", hideToast);

    function syncProductAreaOther() {
      if (!productArea || !productAreaOtherWrap || !productAreaOther) return;
      const isOther = productArea.value === "Other";
      productAreaOtherWrap.hidden = !isOther;
      productAreaOther.required = isOther;
      if (!isOther) productAreaOther.value = "";
    }

    if (productArea) {
      productArea.addEventListener("change", syncProductAreaOther);
      syncProductAreaOther();
    }

    const priorityInput = document.getElementById("priority");
    const priorityTrigger = document.getElementById("priority-trigger");
    const priorityList = document.getElementById("priority-list");
    const priorityValueEl = priorityTrigger && priorityTrigger.querySelector(".priority-select__value");

    function closePrioritySelect() {
      if (!priorityList || !priorityTrigger) return;
      priorityList.hidden = true;
      priorityTrigger.setAttribute("aria-expanded", "false");
    }

    function renderPriorityValue(option) {
      if (!priorityValueEl || !option) return;
      const badge = option.querySelector(".priority-select__badge");
      const definition = option.querySelector(".priority-select__definition");
      priorityValueEl.innerHTML = "";
      priorityValueEl.classList.remove("priority-select__placeholder");
      if (badge) priorityValueEl.appendChild(badge.cloneNode(true));
      if (definition) priorityValueEl.appendChild(definition.cloneNode(true));
    }

    function resetPrioritySelect() {
      if (!priorityInput || !priorityValueEl) return;
      priorityInput.value = "";
      priorityValueEl.innerHTML = "Select priority…";
      priorityValueEl.classList.add("priority-select__placeholder");
      if (priorityList) {
        priorityList.querySelectorAll(".priority-select__option").forEach((option) => {
          option.setAttribute("aria-selected", "false");
        });
      }
      closePrioritySelect();
    }

    if (priorityTrigger && priorityList && priorityInput && priorityValueEl) {
      priorityTrigger.addEventListener("click", () => {
        const isOpen = !priorityList.hidden;
        if (isOpen) {
          closePrioritySelect();
        } else {
          priorityList.hidden = false;
          priorityTrigger.setAttribute("aria-expanded", "true");
        }
      });

      priorityList.querySelectorAll(".priority-select__option").forEach((option) => {
        option.addEventListener("click", () => {
          priorityInput.value = option.dataset.value || "";
          priorityList.querySelectorAll(".priority-select__option").forEach((item) => {
            item.setAttribute("aria-selected", item === option ? "true" : "false");
          });
          renderPriorityValue(option);
          closePrioritySelect();
        });
      });

      document.addEventListener("click", (e) => {
        if (!e.target.closest("#priority-select")) closePrioritySelect();
      });
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      hideToast();

      syncProductAreaOther();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const fd = new FormData(form);
      const productAreaValue = fd.get("product_area");
      const category =
        productAreaValue === "Other"
          ? String(fd.get("product_area_other") || "").trim()
          : productAreaValue;

      const ticket = normalizeTicket({
        id: generateTicketId(),
        category,
        account_name: fd.get("account_name"),
        account_tier: fd.get("account_tier"),
        submitted_by: fd.get("submitted_by"),
        platform: fd.get("platform"),
        date: new Date().toISOString().slice(0, 10),
        feature_request_name: fd.get("feature_request_name"),
        feature_request_description: fd.get("feature_request_description"),
        sentiment: "Neutral",
        sentiment_score: 5,
        feature_request_priority: fd.get("priority"),
        priority_justification: fd.get("priority_justification"),
        source: "local",
      });

      submitBtn.disabled = true;

      try {
        saveTicket(ticket);
        showToast(
          `Ticket ${ticket.id} saved successfully. It will appear on the dashboard for theme ranking.`,
          "success"
        );
        form.reset();
        syncProductAreaOther();
        resetPrioritySelect();
      } catch (err) {
        showToast(`Could not save ticket: ${err.message}`, "error");
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // --- Dashboard page ---

  /** Filter tickets by category; null/empty category returns all tickets. */
  const TICKET_PAGE_SIZE = 6;
  const PRIORITY_FILTERS = [
    { value: "", label: "All priorities" },
    { value: "Critical", label: "Critical" },
    { value: "High", label: "High" },
    { value: "Medium", label: "Medium" },
    { value: "Low", label: "Low" },
  ];

  const DATE_FILTER_LABELS = {
    90: "Last 90 days",
    30: "Last 30 days",
    7: "Last 7 days",
    0: "All time",
  };

  function sentimentScoreToDecimal(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 0;
    return Math.round(((5.5 - n) / 5) * 100) / 100;
  }

  function renderSentimentIcon(className) {
    const faces = {
      "sentiment--negative": `
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#c44840" stroke-width="1.5"/>
        <circle cx="7.25" cy="8.25" r="0.85" fill="#c44840"/>
        <circle cx="12.75" cy="8.25" r="0.85" fill="#c44840"/>
        <path d="M7 13.25c1-1.15 1.9-1.65 3-1.65s2 .5 3 1.65" stroke="#c44840" stroke-width="1.2" fill="none" stroke-linecap="round"/>`,
      "sentiment--neutral": `
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#d4a72c" stroke-width="1.5"/>
        <circle cx="7.25" cy="8.25" r="0.85" fill="#d4a72c"/>
        <circle cx="12.75" cy="8.25" r="0.85" fill="#d4a72c"/>
        <line x1="7.25" y1="13.25" x2="12.75" y2="13.25" stroke="#d4a72c" stroke-width="1.2" stroke-linecap="round"/>`,
      "sentiment--positive": `
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#3a8f6e" stroke-width="1.5"/>
        <circle cx="7.25" cy="8.25" r="0.85" fill="#3a8f6e"/>
        <circle cx="12.75" cy="8.25" r="0.85" fill="#3a8f6e"/>
        <path d="M7 12.5c1 1.55 1.9 2.2 3 2.2s2-.65 3-2.2" stroke="#3a8f6e" stroke-width="1.2" fill="none" stroke-linecap="round"/>`,
    };

    return `<svg class="sentiment-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">${faces[className] || faces["sentiment--neutral"]}</svg>`;
  }

  function getTicketSentiment(ticket) {
    const label = ticket.sentiment || "Neutral";
    const raw = label.toLowerCase();

    if (raw === "frustrated" || raw === "urgent") {
      return {
        type: "negative",
        label,
        score: sentimentScoreToDecimal(ticket.sentiment_score),
        className: "sentiment--negative",
      };
    }
    if (raw === "positive") {
      return {
        type: "positive",
        label,
        score: sentimentScoreToDecimal(ticket.sentiment_score),
        className: "sentiment--positive",
      };
    }
    return {
      type: "neutral",
      label: "Neutral",
      score: sentimentScoreToDecimal(ticket.sentiment_score),
      className: "sentiment--neutral",
    };
  }

  function filterTicketsByCategory(tickets, category) {
    if (!category) return tickets;
    return tickets.filter((t) => getTicketCategory(t) === category);
  }

  function applyTicketFilters(tickets, filters) {
    const { category, tier, priority, days } = filters;
    const cutoff =
      days && days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        : null;

    return tickets.filter((t) => {
      if (category && getTicketCategory(t) !== category) return false;
      if (tier && t.account_tier !== tier) return false;
      if (priority && (t.priority || "").toLowerCase() !== priority.toLowerCase()) return false;
      if (cutoff) {
        const ticketDate = new Date(`${t.date}T12:00:00`);
        if (Number.isNaN(ticketDate.getTime()) || ticketDate < cutoff) return false;
      }
      return true;
    });
  }

  function getTicketDateValue(ticket) {
    const time = new Date(`${ticket.date}T12:00:00`).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function getPrioritySortValue(priority) {
    const priorityOrder = ["Critical", "High", "Medium", "Low"];
    const match = String(priority || "").match(/^(Critical|High|Medium|Low)/i);
    const level = match ? match[1] : "";
    const index = priorityOrder.findIndex((p) => p.toLowerCase() === level.toLowerCase());
    return index >= 0 ? index : priorityOrder.length;
  }

  function sortTickets(tickets, column, order = "desc") {
    const dir = order === "asc" ? 1 : -1;

    return [...tickets].sort((a, b) => {
      let cmp = 0;

      switch (column) {
        case "category":
          cmp = getTicketCategory(a).localeCompare(getTicketCategory(b), undefined, { sensitivity: "base" });
          break;
        case "tier":
          cmp = (a.account_tier || "").localeCompare(b.account_tier || "", undefined, { sensitivity: "base" });
          break;
        case "priority":
          cmp = getPrioritySortValue(a.priority) - getPrioritySortValue(b.priority);
          break;
        case "date":
        default:
          cmp = getTicketDateValue(a) - getTicketDateValue(b);
          break;
      }

      return cmp * dir;
    });
  }

  function getCategoryCounts(tickets) {
    const counts = {};
    tickets.forEach((t) => {
      const category = getTicketCategory(t);
      counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  }

  function themeIconSvg() {
    return `<svg class="theme-panel__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
  }

  function renderFilterPill(key, label) {
    return `<button type="button" class="filter-chip filter-chip--active filter-chip--removable" data-clear="${escapeHtml(key)}">
      ${escapeHtml(label)}
      <span class="filter-chip__remove" aria-hidden="true">×</span>
      <span class="visually-hidden">Remove ${escapeHtml(label)} filter</span>
    </button>`;
  }

  function renderTicketPanel(allTickets, filters) {
    updateAnalyzeButton(allTickets, filters);
  }

  function hasRenderedClusterResults() {
    const results = document.getElementById("cluster-results");
    return Boolean(results && !results.hidden);
  }

  function setThemesEmptyVisible(show) {
    const empty = document.getElementById("themes-empty");
    if (empty) empty.hidden = !show;
  }

  function getSelectedTicketsInScope(allTickets, filters) {
    const visibleIds = new Set(applyTicketFilters(allTickets, filters).map((t) => t.id));
    return [...selectedTicketIds].filter((id) => visibleIds.has(id));
  }

  function pruneSelectedTickets(allTickets, filters) {
    const visibleIds = new Set(applyTicketFilters(allTickets, filters).map((t) => t.id));
    selectedTicketIds = new Set([...selectedTicketIds].filter((id) => visibleIds.has(id)));
  }

  function updateAnalyzeButton(allTickets, filters) {
    const selectedCount = getSelectedTicketsInScope(allTickets, filters).length;
    const hasResults = hasRenderedClusterResults();
    const analyzeBtnEmpty = document.getElementById("analyze-btn-empty");
    const analyzeBtnEmptyLabel = document.getElementById("analyze-btn-empty-label");
    const flowArrow = document.getElementById("analyse-flow-arrow");
    const showArrow = selectedCount === 0;

    if (analyzeBtnEmpty) {
      if (hasResults) {
        analyzeBtnEmpty.hidden = true;
      } else {
        analyzeBtnEmpty.hidden = false;
        analyzeBtnEmpty.disabled = selectedCount === 0;
        analyzeBtnEmpty.classList.toggle("btn--primary", selectedCount > 0);

        if (analyzeBtnEmptyLabel) {
          analyzeBtnEmptyLabel.textContent = "Analyse";
        }

        if (selectedCount > 0) {
          analyzeBtnEmpty.setAttribute(
            "aria-label",
            `Analyse ${selectedCount} selected ticket${selectedCount === 1 ? "" : "s"}`
          );
        } else {
          analyzeBtnEmpty.removeAttribute("aria-label");
        }
      }
    }

    if (flowArrow) {
      flowArrow.hidden = !showArrow;
    }
  }

  function getHighestPriority(tickets) {
    const priorityOrder = ["Critical", "High", "Medium", "Low"];

    for (const level of priorityOrder) {
      if (tickets.some((ticket) => (ticket.priority || "").toLowerCase() === level.toLowerCase())) {
        return level;
      }
    }

    return "Not set";
  }

  function getOldestRequestDate(cluster, tickets) {
    if (cluster.oldest_request_date) return cluster.oldest_request_date;
    let oldest = null;
    for (const ticket of tickets) {
      if (ticket.date && (!oldest || ticket.date < oldest)) oldest = ticket.date;
    }
    return oldest;
  }

  function daysSinceDate(dateStr) {
    if (!dateStr) return null;
    const date = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
  }

  function getTopLinkedTicketId(item) {
    if (!item) return null;
    return typeof item === "string" ? item : item.id || null;
  }

  function getThemeMetrics(cluster, visibleTickets, resolveTicket) {
    const ticketIds = cluster.linked_tickets || cluster.ticket_ids || [];
    const tickets = ticketIds.map((id) => resolveTicket(id)).filter(Boolean);
    const enterprise = tickets.filter((t) => t.account_tier === "Enterprise").length;
    const pro = tickets.filter((t) => t.account_tier === "Pro").length;

    let impact = cluster.customer_impact || "Moderate";
    if (!cluster.customer_impact) {
      if (enterprise >= 2) impact = "Very high";
      else if (enterprise >= 1 || pro >= 2) impact = "High";
      else if (tickets.length >= 3) impact = "Medium";
      else impact = "Low";
    }

    const priorityLevel = cluster.priority || getHighestPriority(tickets);
    const linked = cluster.ticket_count ?? ticketIds.length;
    const enterpriseCount = cluster.enterprise_ticket_count ?? enterprise;
    const affectedAccounts =
      Array.isArray(cluster.affected_accounts) && cluster.affected_accounts.length
        ? cluster.affected_accounts
        : [...new Set(tickets.map((t) => t.account_name).filter(Boolean))];
    const oldestDate = getOldestRequestDate(cluster, tickets);
    const oldestDays = daysSinceDate(oldestDate);

    return {
      linked,
      impact,
      priorityLevel,
      tickets,
      ticketIds,
      enterpriseCount,
      affectedAccounts,
      oldestDate,
      oldestDays,
    };
  }

  function renderFilterBar(allTickets, filters, onChange) {
    const container = document.getElementById("filter-bar");
    if (!container) return;

    const categories = ["", ...CATEGORIES.filter((name) => getCategoryCounts(allTickets)[name])];
    const categoryOptions = categories
      .map((name) => {
        const label = name || "All categories";
        const selected = !name ? " selected" : "";
        return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");

    const tierOptions = [`<option value="" selected>All account tiers</option>`]
      .concat(
        TIERS.map((tier) => `<option value="${escapeHtml(tier)}">${escapeHtml(tier)}</option>`)
      )
      .join("");

    const priorityOptions = PRIORITY_FILTERS.map(({ value, label }) => {
      const selected = !value ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join("");

    const activeDays = filters.days != null && filters.days !== 90;
    const dateControl = activeDays
      ? renderFilterPill("days", DATE_FILTER_LABELS[filters.days] || "Date range")
      : `<label class="filter-select filter-select--date">
          <span class="visually-hidden">Date range</span>
          <svg class="filter-select__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <select data-filter="days" aria-label="Date range">
            <option value="90"${!filters.days || filters.days === 90 ? " selected" : ""}>Last 90 days</option>
            <option value="30">Last 30 days</option>
            <option value="7">Last 7 days</option>
            <option value="0">All time</option>
          </select>
        </label>`;

    const categoryControl = filters.category
      ? renderFilterPill("category", filters.category)
      : `<label class="filter-select">
          <span class="visually-hidden">Category</span>
          <select data-filter="category" aria-label="Category">${categoryOptions}</select>
        </label>`;

    const tierControl = filters.tier
      ? renderFilterPill("tier", filters.tier)
      : `<label class="filter-select">
          <span class="visually-hidden">Account Tier</span>
          <select data-filter="tier" aria-label="Account Tier">${tierOptions}</select>
        </label>`;

    const priorityControl = filters.priority
      ? renderFilterPill("priority", filters.priority)
      : `<label class="filter-select">
          <span class="visually-hidden">Priority</span>
          <select data-filter="priority" aria-label="Priority">${priorityOptions}</select>
        </label>`;

    container.innerHTML = `
      <div class="filter-bar__row">
        ${dateControl}
        ${categoryControl}
        ${tierControl}
        ${priorityControl}
        <button type="button" class="filter-reset" data-action="reset">Reset</button>
      </div>`;

    container.querySelectorAll("select[data-filter]").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.dataset.filter;
        let value = select.value;
        if (key === "days") {
          onChange({ days: value === "" ? 90 : Number(value) });
          return;
        }
        onChange({ [key]: value || null });
      });
    });

    const resetBtn = container.querySelector('[data-action="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener("click", () => onChange({ reset: true }));
    }

    container.querySelectorAll("[data-clear]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.clear;
        if (key === "days") onChange({ days: 90 });
        else onChange({ [key]: null });
      });
    });
  }

  function renderTicketPagination(totalCount, currentPage, pageSize, onPageChange) {
    const el = document.getElementById("ticket-pagination");
    if (!el) return;

    if (totalCount === 0) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    const totalPages = Math.ceil(totalCount / pageSize);
    const start = (currentPage - 1) * pageSize + 1;
    const end = Math.min(currentPage * pageSize, totalCount);
    const pages = [];

    for (let i = 1; i <= totalPages; i += 1) {
      if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) {
        pages.push(i);
      } else if (pages[pages.length - 1] !== "…") {
        pages.push("…");
      }
    }

    const navHtml =
      totalPages > 1
        ? `<nav class="ticket-pagination__nav" aria-label="Ticket pages">
        <button type="button" class="ticket-pagination__btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
        ${pages
          .map((page) =>
            page === "…"
              ? `<span class="ticket-pagination__ellipsis">…</span>`
              : `<button type="button" class="ticket-pagination__btn${page === currentPage ? " ticket-pagination__btn--active" : ""}" data-page="${page}" ${page === currentPage ? 'aria-current="page"' : ""}>${page}</button>`
          )
          .join("")}
        <button type="button" class="ticket-pagination__btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? "disabled" : ""} aria-label="Next page">›</button>
      </nav>`
        : "";

    el.hidden = false;
    el.innerHTML = `
      <p class="ticket-pagination__summary">Showing ${start} to ${end} of ${totalCount} tickets</p>
      ${navHtml}`;

    el.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const page = Number(btn.dataset.page);
        if (!Number.isNaN(page) && page >= 1 && page <= totalPages) onPageChange(page);
      });
    });
  }

  function renderTicketGrid(visibleTickets, activeTicketId, currentPage = 1, sort = { column: "date", order: "desc" }) {
    const grid = document.getElementById("ticket-grid");
    if (!grid) return;

    if (visibleTickets.length === 0) {
      grid.innerHTML = `<div class="empty-state"><p>No tickets match your filters. Try adjusting filters or reset.</p></div>`;
      return;
    }

    const pageStart = (currentPage - 1) * TICKET_PAGE_SIZE;
    const pageTickets = visibleTickets.slice(pageStart, pageStart + TICKET_PAGE_SIZE);

    function renderSortableHeader(column, label, extraClass = "") {
      const isActive = sort.column === column;
      const ariaSort = isActive ? (sort.order === "desc" ? "descending" : "ascending") : "none";
      const sortIcon = isActive
        ? `<svg class="ticket-table__sort"${sort.order === "asc" ? ' style="transform: rotate(180deg)"' : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`
        : "";
      const className = ["ticket-table__col-sortable", extraClass].filter(Boolean).join(" ");
      return `<th scope="col" class="${className}" data-sort-column="${column}" aria-sort="${ariaSort}" tabindex="0">${label}${sortIcon ? ` ${sortIcon}` : ""}</th>`;
    }

    grid.innerHTML = `
      <table class="ticket-table">
        <thead>
          <tr>
            <th scope="col" class="ticket-table__col-check"><span class="visually-hidden">Select</span></th>
            <th scope="col">Ticket</th>
            ${renderSortableHeader("category", "Category")}
            ${renderSortableHeader("tier", "Account Tier")}
            ${renderSortableHeader("priority", "Priority")}
            ${renderSortableHeader("date", "Created", "ticket-table__col-date")}
          </tr>
        </thead>
        <tbody>
          ${pageTickets
            .map((t) => {
              const active = activeTicketId === t.id ? " ticket-table__row--active" : "";
              const priorityLabel = t.priority || "Not set";
              return `
            <tr class="ticket-table__row${active}" data-ticket-id="${escapeHtml(t.id)}" tabindex="0" role="button">
              <td class="ticket-table__col-check">
                <input type="checkbox" class="ticket-table__checkbox" aria-label="Select ${escapeHtml(t.id)}"${selectedTicketIds.has(t.id) ? " checked" : ""}>
              </td>
              <td class="ticket-table__ticket">
                <span class="ticket-table__title">${escapeHtml(getTicketTitle(t))}</span>
                <span class="ticket-table__id">${escapeHtml(t.id)}</span>
              </td>
              <td><span class="badge ${categoryBadgeClass(getTicketCategory(t))}">${escapeHtml(getTicketCategory(t))}</span></td>
              <td><span class="badge ${tierBadgeClass(t.account_tier)}">${escapeHtml(t.account_tier || "—")}</span></td>
              <td><span class="badge ${ticketPriorityBadgeClass(t.priority)}">${escapeHtml(priorityLabel)}</span></td>
              <td class="ticket-table__date">${escapeHtml(formatTicketDate(t.date))}</td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function populateTicketDetailPanel(ticket) {
    const idEl = document.getElementById("ticket-detail-id");
    const priorityEl = document.getElementById("ticket-detail-priority");
    const title = document.getElementById("ticket-detail-title");
    const requester = document.getElementById("ticket-detail-requester");
    const account = document.getElementById("ticket-detail-account");
    const category = document.getElementById("ticket-detail-category");
    const tier = document.getElementById("ticket-detail-tier");
    const date = document.getElementById("ticket-detail-date");
    const desc = document.getElementById("ticket-detail-desc");
    const impactSection = document.getElementById("ticket-detail-impact-section");
    const impact = document.getElementById("ticket-detail-impact");
    const deleteBtn = document.getElementById("ticket-detail-delete");

    if (!title || !requester || !account || !desc) return;

    const priorityLabel = ticket.priority || "Not set";
    const categoryLabel = getTicketCategory(ticket);
    const tierLabel = ticket.account_tier || "—";

    if (idEl) idEl.textContent = ticket.id || "—";
    if (priorityEl) {
      const badges = [];
      if (isDeletableTicket(ticket)) {
        badges.push('<span class="badge badge--local">Your submission</span>');
      }
      badges.push(
        `<span class="badge ${ticketPriorityBadgeClass(ticket.priority)}">${escapeHtml(priorityLabel)}</span>`
      );
      priorityEl.innerHTML = badges.join("");
    }

    title.textContent = getTicketTitle(ticket);
    requester.textContent = ticket.submitted_by || "—";
    account.textContent = ticket.account_name || "—";

    if (category) {
      category.innerHTML = `<span class="badge ${categoryBadgeClass(categoryLabel)}">${escapeHtml(categoryLabel)}</span>`;
    }
    if (tier) {
      tier.innerHTML = `<span class="badge ${tierBadgeClass(ticket.account_tier)}">${escapeHtml(tierLabel)}</span>`;
    }
    if (date) date.textContent = formatTicketDate(ticket.date);

    desc.textContent = ticket.description || ticket.feature_request_description || "—";

    if (impactSection && impact) {
      if (ticket.business_impact) {
        impact.textContent = ticket.business_impact;
        impactSection.hidden = false;
      } else {
        impact.textContent = "";
        impactSection.hidden = true;
      }
    }

    if (deleteBtn) {
      deleteBtn.hidden = !isDeletableTicket(ticket);
    }
  }

  function renderLinkedTicketsModalRows(ticketIds, resolveTicket) {
    return ticketIds
      .map((id) => resolveTicket(id))
      .filter(Boolean)
      .map((t) => {
        const priorityLabel = t.priority || "Not set";
        const categoryLabel = getTicketCategory(t);
        return `
          <tr class="linked-tickets-table__row" data-ticket-id="${escapeHtml(t.id)}" tabindex="0" role="button">
            <td><span class="badge badge--category">${escapeHtml(t.id)}</span></td>
            <td class="linked-tickets-table__name">${escapeHtml(getTicketTitle(t))}</td>
            <td><span class="badge ${categoryBadgeClass(categoryLabel)}">${escapeHtml(categoryLabel)}</span></td>
            <td><span class="badge ${tierBadgeClass(t.account_tier)}">${escapeHtml(t.account_tier || "—")}</span></td>
            <td><span class="badge ${ticketPriorityBadgeClass(t.priority)}">${escapeHtml(priorityLabel)}</span></td>
          </tr>`;
      })
      .join("");
  }

  function getPriorityBannerCopy(score, impact) {
    if (score >= 8) {
      return "High customer impact and volume. Addressing this theme will improve reliability and developer experience.";
    }
    if (score >= 5) {
      return "Moderate customer impact with meaningful volume. Worth scheduling alongside higher-priority themes.";
    }
    return "Lower urgency relative to other themes, but still worth tracking for emerging patterns.";
  }

  function renderThemePanelHtml(cluster, visibleTickets, resolveTicket, themeIndex = 0) {
    const metrics = getThemeMetrics(cluster, visibleTickets, resolveTicket);
    const recommended = cluster.recommended_action;
    const recommendedTitle = recommended?.title || "";
    const descriptionLines = getThemeDescriptionLines(cluster.summary);
    const affectedAccounts = getAffectedAccountsWithTier(metrics.tickets);
    const accountPills = affectedAccounts
      .map(
        ({ name, tier }) =>
          `<span class="theme-detail-card__account-pill ${accountPillClass(tier)}">${escapeHtml(name)}</span>`
      )
      .join("");
    const descriptionHtml = descriptionLines.length
      ? `<ul class="theme-detail-card__description">${descriptionLines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`
      : "";

    const oldestRequestHtml =
      metrics.oldestDays == null
        ? `<span class="theme-detail-card__metric-value">—</span>`
        : `<span class="theme-detail-card__metric-value theme-detail-card__metric-value--oldest">
            <span class="theme-detail-card__oldest-num">${metrics.oldestDays}</span>
            <span class="theme-detail-card__oldest-unit">days ago</span>
          </span>`;

    const ticketPills = metrics.ticketIds
      .map(
        (id) => `
        <button type="button" class="theme-detail-card__ticket-pill ticket-tag--link" data-ticket-id="${escapeHtml(id)}">
          ${escapeHtml(id)}
        </button>`
      )
      .join("");

    return `
      <article class="theme-detail-card" data-theme-index="${themeIndex}">
        <header class="theme-detail-card__header">
          <div class="theme-detail-card__title-row">
            <span class="theme-detail-card__icon-wrap">${themeIconSvg()}</span>
            <h3 class="theme-detail-card__title">${escapeHtml(cluster.name)}</h3>
          </div>
        </header>

        ${descriptionHtml}

        <hr class="theme-detail-card__divider" aria-hidden="true" />

        <div class="theme-detail-card__metrics" aria-label="Theme metrics">
          <div class="theme-detail-card__metric">
            <span class="theme-detail-card__metric-label">Linked tickets</span>
            <span class="theme-detail-card__metric-value">${metrics.linked}</span>
          </div>
          <div class="theme-detail-card__metric">
            <span class="theme-detail-card__metric-label">Priority</span>
            <span class="theme-detail-card__metric-value"><span class="badge ${ticketPriorityBadgeClass(metrics.priorityLevel)}">${escapeHtml(metrics.priorityLevel)}</span></span>
          </div>
          <div class="theme-detail-card__metric">
            <span class="theme-detail-card__metric-label">Oldest request</span>
            ${oldestRequestHtml}
          </div>
        </div>

        <hr class="theme-detail-card__divider" aria-hidden="true" />

        ${
          accountPills
            ? `<section class="theme-detail-card__submitted-by">
                <h4 class="theme-detail-card__submitted-by-title">Submitted by</h4>
                <div class="theme-detail-card__account-pills">${accountPills}</div>
              </section>`
            : ""
        }

        ${
          recommendedTitle
            ? `<section class="theme-detail-card__recommended">
                <span class="theme-detail-card__recommended-label">Recommended action</span>
                <h4 class="theme-detail-card__recommended-title">${escapeHtml(recommendedTitle)}</h4>
              </section>`
            : ""
        }

        ${
          ticketPills
            ? `<section class="theme-detail-card__linked">
                <h4 class="theme-detail-card__linked-title">Linked tickets</h4>
                <div class="theme-detail-card__ticket-pills">${ticketPills}</div>
              </section>`
            : ""
        }

        ${
          metrics.linked
            ? `<button type="button" class="btn btn--outline theme-detail-card__product-brief" data-action="export-brief-pdf">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Product brief
              </button>`
            : ""
        }
      </article>`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function themeBriefFilename() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, "0");
    const month = now.toLocaleDateString("en-GB", { month: "long" });
    const year = now.getFullYear();
    return `Feedback-Loop-Brief-${day}-${month}-${year}.pdf`;
  }

  function pdfPriorityRgb(priority) {
    const level = String(priority || "").toLowerCase();
    if (level.startsWith("critical")) return [163, 45, 45];
    if (level.startsWith("high")) return [146, 64, 14];
    if (level.startsWith("medium")) return [29, 78, 216];
    return [107, 114, 128];
  }

  function exportThemeBriefAsPdf(cluster, resolveTicket) {
    if (!cluster || !window.jspdf?.jsPDF) {
      throw new Error(
        !window.jspdf?.jsPDF
          ? "PDF library did not load. Refresh the page and try again."
          : "No theme data is available to export."
      );
    }

    const { jsPDF } = window.jspdf;
    const themeDescriptionFull =
      cluster.summary_full || cluster.theme_description_full || cluster.summary || "";
    const recommendedDescription = cluster.recommended_action?.description || "";
    const linkedTickets = (cluster.linked_tickets || cluster.ticket_ids || [])
      .map((id) => resolveTicket(id))
      .filter(Boolean);
    const accountRows = getAccountRowsFromTickets(linkedTickets);
    const accountsLine = accountRows.map((row) => `${row.name} (${row.tier})`).join(" · ");
    const exportDate = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - margin * 2;
    const headerLineY = margin + 12;
    const headerToThemeGap = (12 * 25.4) / 96;
    const contentTop = headerLineY + headerToThemeGap + 6;
    const footerTop = pageHeight - margin - 4;
    const contentBottom = footerTop - 8;

    const navy = [15, 23, 42];
    const bodyColor = [55, 65, 81];
    const labelColor = [156, 163, 175];
    const accentBlue = [24, 95, 165];
    const lightBlue = [230, 241, 251];
    const ruleGrey = [229, 231, 235];
    const metaGrey = [156, 163, 175];

    const bodySize = 11;
    const titleSize = 20;
    const ticketHeadingSize = 13;
    const metaSize = 10;
    const labelSize = 8;
    const lineHeight = 5;
    const summaryLineHeight = 6.5;
    const sectionGap = 6;
    const borderPad = 3;
    const blueBorderWidth = 0.8;

    let y = contentTop;

    function drawPageHeader() {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...navy);
      doc.text("Feedback Loop", margin, margin + 5);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(labelSize);
      doc.setTextColor(...labelColor);
      doc.text("PRODUCT BRIEF", pageWidth - margin, margin + 4, { align: "right" });
      doc.text(exportDate, pageWidth - margin, margin + 8, { align: "right" });

      doc.setDrawColor(...navy);
      doc.setLineWidth(0.6);
      doc.line(margin, headerLineY, pageWidth - margin, headerLineY);
    }

    function drawPageFooter(pageNumber) {
      doc.setDrawColor(...ruleGrey);
      doc.setLineWidth(0.2);
      doc.line(margin, footerTop - 4, pageWidth - margin, footerTop - 4);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...labelColor);
      doc.text("Generated by Feedback Loop", margin, footerTop);
      doc.text(String(pageNumber), pageWidth - margin, footerTop, { align: "right" });
    }

    function ensureSpace(needed) {
      if (y + needed > contentBottom) {
        doc.addPage();
        y = contentTop;
      }
    }

    function addUppercaseLabel(text) {
      ensureSpace(5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(labelSize);
      doc.setTextColor(...labelColor);
      doc.text(String(text).toUpperCase(), margin, y);
      y += 4.5;
    }

    function addBodyParagraph(text, options = {}) {
      const { italic = false, bold = false, width = contentWidth, spacing = lineHeight } = options;
      doc.setFont("helvetica", bold ? "bold" : italic ? "italic" : "normal");
      doc.setFontSize(bodySize);
      doc.setTextColor(...bodyColor);
      const lines = doc.splitTextToSize(String(text || "—"), width);
      for (const line of lines) {
        ensureSpace(spacing);
        doc.text(line, margin, y);
        y += spacing;
      }
    }

    function isBulletLine(line) {
      return /^[•·\-*]\s/.test(line) || line.startsWith("•");
    }

    function stripBulletPrefix(line) {
      return line.replace(/^[•·\-*]\s*/, "");
    }

    function renderThemeDescriptionFull(text) {
      const rawLines = String(text || "—")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!rawLines.length) {
        addBodyParagraph("—", { spacing: summaryLineHeight });
        return;
      }

      const bulletIndent = 4;
      const bulletSymbol = "•";
      const bulletTextWidth = contentWidth - bulletIndent - 1;

      let index = 0;
      while (index < rawLines.length) {
        const line = rawLines[index];
        if (isBulletLine(line)) {
          while (index < rawLines.length && isBulletLine(rawLines[index])) {
            const bulletText = stripBulletPrefix(rawLines[index]);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(bodySize);
            doc.setTextColor(...bodyColor);
            const wrappedLines = doc.splitTextToSize(bulletText, bulletTextWidth);
            wrappedLines.forEach((wrapLine, wrapIndex) => {
              ensureSpace(summaryLineHeight);
              if (wrapIndex === 0) {
                doc.text(bulletSymbol, margin + 1, y);
                doc.text(wrapLine, margin + bulletIndent, y);
              } else {
                doc.text(wrapLine, margin + bulletIndent, y);
              }
              y += summaryLineHeight;
            });
            index += 1;
          }
          if (index < rawLines.length && !isBulletLine(rawLines[index])) {
            y += (6 * 25.4) / 96;
          }
        } else {
          addBodyParagraph(line, { spacing: summaryLineHeight });
          index += 1;
        }
      }
    }

    function measureLeftBorderedBlockHeight(text, options = {}) {
      const { italic = false, borderWidth = 0.25 } = options;
      const textPadFromBorder = (8 * 25.4) / 96;
      const textWidth = contentWidth - borderWidth - textPadFromBorder;

      doc.setFont("helvetica", italic ? "italic" : "normal");
      doc.setFontSize(bodySize);
      const lines = doc.splitTextToSize(String(text || "—"), textWidth);
      const textHeight = doc.getTextDimensions(lines).h;
      const labelHeight = 4.5;

      return labelHeight + textHeight + 4;
    }

    function measureTicketBlockHeight(ticket) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(ticketHeadingSize);
      const nameLines = doc.splitTextToSize(getTicketTitle(ticket) || "—", contentWidth);
      const headingLineHeight = doc.getTextDimensions("Mg").h;
      const headingHeight = nameLines.length * headingLineHeight + 2;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(metaSize);
      const metaLineHeight = doc.getTextDimensions("Mg").h;
      const metadataHeight = metaLineHeight + 4;

      const sectionGapPx = (8 * 25.4) / 96;
      const featureBlockHeight = measureLeftBorderedBlockHeight(ticket.feature_request_description);
      const impactBlockHeight = measureLeftBorderedBlockHeight(ticket.priority_justification, {
        italic: true,
      });

      return headingHeight + metadataHeight + featureBlockHeight + sectionGapPx + impactBlockHeight;
    }

    function ensureSpaceForTicketBlock(ticket) {
      const needed = measureTicketBlockHeight(ticket);
      if (y + needed > contentBottom) {
        doc.addPage();
        y = contentTop;
      }
    }

    function drawTicketMetadataLine(ticket) {
      const segments = [
        { text: ticket.id || "—", color: metaGrey },
        { text: ticket.account_name || "—", color: metaGrey },
        { text: ticket.account_tier || "Free", color: metaGrey },
        { text: ticket.priority || "Low", color: pdfPriorityRgb(ticket.priority) },
        { text: formatTicketDate(ticket.date), color: metaGrey },
      ];
      const dotSeparator = " · ";

      doc.setFont("helvetica", "normal");
      doc.setFontSize(metaSize);
      const metaLineHeight = doc.getTextDimensions("Mg").h;
      ensureSpace(metaLineHeight);
      const rowY = y;
      let x = margin;

      segments.forEach((segment, index) => {
        if (index > 0) {
          doc.setTextColor(...metaGrey);
          doc.text(dotSeparator, x, rowY);
          x += doc.getTextWidth(dotSeparator);
        }
        doc.setTextColor(...segment.color);
        doc.text(segment.text, x, rowY);
        x += doc.getTextWidth(segment.text);
      });

      y = rowY + metaLineHeight;
    }

    function addLeftBorderedBlock(label, text, options = {}) {
      const { italic = false, borderColor = ruleGrey, borderWidth = 0.25 } = options;
      const textPadFromBorder = (8 * 25.4) / 96;
      const borderX = margin;
      const textX = borderX + borderWidth + textPadFromBorder;
      const textWidth = contentWidth - borderWidth - textPadFromBorder;

      addUppercaseLabel(label);

      doc.setFont("helvetica", italic ? "italic" : "normal");
      doc.setFontSize(bodySize);
      const lines = doc.splitTextToSize(String(text || "—"), textWidth);
      const textHeight = doc.getTextDimensions(lines).h;

      ensureSpace(textHeight + 2);
      const blockTop = y;

      doc.setDrawColor(...borderColor);
      doc.setLineWidth(borderWidth);
      doc.line(borderX, blockTop, borderX, blockTop + textHeight);

      doc.setTextColor(...bodyColor);
      doc.text(lines, textX, blockTop, { baseline: "top" });

      y = blockTop + textHeight + 4;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(titleSize);
    doc.setTextColor(...navy);
    const themeTitleLines = doc.splitTextToSize(cluster.name || "Theme", contentWidth);
    for (const line of themeTitleLines) {
      ensureSpace(8);
      doc.text(line, margin, y);
      y += 8;
    }
    y += sectionGap;

    renderThemeDescriptionFull(themeDescriptionFull);
    y += sectionGap;

    addUppercaseLabel("Requesting accounts");
    addBodyParagraph(accountsLine || "—");
    y += sectionGap;

    addUppercaseLabel("Recommended action");
    const actionPadding = 4;
    const actionTextWidth = contentWidth - actionPadding - borderPad - 2;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(bodySize);
    const actionLines = doc.splitTextToSize(recommendedDescription || "—", actionTextWidth);
    const actionBoxHeight = actionPadding * 2 + actionLines.length * lineHeight;
    ensureSpace(actionBoxHeight + 2);
    doc.setFillColor(...lightBlue);
    doc.rect(margin, y, contentWidth, actionBoxHeight, "F");
    doc.setDrawColor(...accentBlue);
    doc.setLineWidth(blueBorderWidth);
    doc.line(margin, y, margin, y + actionBoxHeight);
    doc.setTextColor(...bodyColor);
    doc.text(actionLines, margin + actionPadding + borderPad, y + actionPadding + 4);
    y += actionBoxHeight + sectionGap;

    ensureSpace(4);
    doc.setDrawColor(...ruleGrey);
    doc.setLineWidth(0.2);
    doc.line(margin, y, pageWidth - margin, y);
    y += sectionGap + 2;

    addUppercaseLabel("Tickets");

    linkedTickets.forEach((ticket, index) => {
      ensureSpaceForTicketBlock(ticket);

      const featureName = getTicketTitle(ticket) || "—";
      doc.setFont("helvetica", "bold");
      doc.setFontSize(ticketHeadingSize);
      doc.setTextColor(...navy);
      const nameLines = doc.splitTextToSize(featureName, contentWidth);
      const headingLineHeight = doc.getTextDimensions("Mg").h;
      for (const line of nameLines) {
        ensureSpace(headingLineHeight);
        doc.text(line, margin, y);
        y += headingLineHeight;
      }
      y += 2;

      drawTicketMetadataLine(ticket);
      y += 4;

      addLeftBorderedBlock("Feature request", ticket.feature_request_description, {
        borderColor: ruleGrey,
        borderWidth: 0.25,
      });

      y += (8 * 25.4) / 96;

      addLeftBorderedBlock("Why this matters to the customer", ticket.priority_justification, {
        italic: true,
        borderColor: accentBlue,
        borderWidth: blueBorderWidth,
      });

      if (index < linkedTickets.length - 1) {
        y += (20 * 25.4) / 96;
        ensureSpace(2);
        doc.setDrawColor(...ruleGrey);
        doc.setLineWidth(0.15);
        doc.line(margin, y, pageWidth - margin, y);
        y += (12 * 25.4) / 96;
      }
    });

    const totalPages = doc.internal.getNumberOfPages();
    for (let page = 1; page <= totalPages; page += 1) {
      doc.setPage(page);
      drawPageHeader();
      drawPageFooter(page);
    }

    doc.save(themeBriefFilename());
  }

  const CSV_COLUMN_ALIASES = {
    id: ["id", "ticket_id", "ticket id", "ticket"],
    feature_request_name: ["feature_request_name", "feature request", "feature request name", "title", "summary"],
    category: ["category", "product_area", "product area", "request type", "request_type"],
    account_name: ["account_name", "account name", "account", "company"],
    account_tier: ["account_tier", "account tier", "tier", "plan"],
    submitted_by: ["submitted_by", "submitted by", "requester", "email", "submitter"],
    date: ["date", "submitted", "created", "created_at"],
    priority: ["priority", "severity"],
    feature_request_description: [
      "feature_request_description",
      "feature request description",
      "description",
      "details",
    ],
    priority_justification: [
      "priority_justification",
      "priority justification",
      "business_impact",
      "business impact",
      "justification",
    ],
  };

  const CSV_TEMPLATE_ROW = {
    id: "#184521",
    feature_request_name: "IdP group sync for permissions",
    category: "Authentication",
    account_name: "Shopify",
    account_tier: "Enterprise",
    submitted_by: "dev.tools@shopify.com",
    date: "2026-05-28",
    priority: "Critical",
    feature_request_description:
      "When engineers move teams in our identity provider we want workspace permissions to update automatically.",
    priority_justification:
      "We cannot scale team restructures without creating compliance gaps.",
  };

  function normalizeCsvHeader(header) {
    return String(header || "")
      .trim()
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mapCsvHeaders(headerRow) {
    const indexByField = {};
    const normalizedHeaders = headerRow.map(normalizeCsvHeader);

    for (const [field, aliases] of Object.entries(CSV_COLUMN_ALIASES)) {
      const aliasSet = aliases.map(normalizeCsvHeader);
      const index = normalizedHeaders.findIndex((header) => aliasSet.includes(header));
      if (index >= 0) indexByField[field] = index;
    }

    return indexByField;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (char === '"' && next === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field.trim());
        field = "";
      } else if (char === "\n" || (char === "\r" && next === "\n")) {
        row.push(field.trim());
        field = "";
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        if (char === "\r") i += 1;
      } else if (char !== "\r") {
        field += char;
      }
    }

    if (field.length || row.length) {
      row.push(field.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
    }

    return rows;
  }

  function normalizeTier(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const match = TIERS.find((tier) => tier.toLowerCase() === raw.toLowerCase());
    return match || null;
  }

  function normalizePriority(value) {
    const raw = String(value || "").trim();
    if (!raw) return "Medium";
    const match = raw.match(/^(Critical|High|Medium|Low)/i);
    return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() : "Medium";
  }

  function normalizeCategory(value) {
    const raw = String(value || "").trim();
    if (!raw) return { category: "", warning: null };
    const mapped = LEGACY_CATEGORY_MAP[raw] || raw;
    const warning =
      LEGACY_CATEGORY_MAP[raw] && LEGACY_CATEGORY_MAP[raw] !== raw
        ? `Category "${raw}" mapped to ${LEGACY_CATEGORY_MAP[raw]}`
        : null;
    const known = CATEGORIES.includes(mapped);
    return {
      category: known ? mapped : mapped,
      warning: warning || (!known ? `Unknown category "${raw}" — kept as-is` : null),
    };
  }

  function normalizeImportDate(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return { date: new Date().toISOString().slice(0, 10), warning: "Missing date — used today" };
    }
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return { date: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`, warning: null };
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return { date: parsed.toISOString().slice(0, 10), warning: null };
    }
    return { date: new Date().toISOString().slice(0, 10), warning: `Invalid date "${raw}" — used today` };
  }

  function formatTicketId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.startsWith("#") ? raw : `#${raw.replace(/^#/, "")}`;
  }

  function getCell(row, indexByField, field) {
    const index = indexByField[field];
    if (index == null) return "";
    return row[index] == null ? "" : String(row[index]).trim();
  }

  function parseCsvTickets(text) {
    const rows = parseCsv(text);
    if (!rows.length) {
      return { tickets: [], errors: ["CSV file is empty."], warnings: [] };
    }

    const indexByField = mapCsvHeaders(rows[0]);
    const missingRequired = ["feature_request_name", "category", "account_tier"].filter(
      (field) => indexByField[field] == null
    );

    if (missingRequired.length) {
      return {
        tickets: [],
        errors: [
          `Missing required column(s): ${missingRequired
            .map((field) => CSV_COLUMN_ALIASES[field][0])
            .join(", ")}.`,
        ],
        warnings: [],
      };
    }

    const tickets = [];
    const errors = [];
    const warnings = [];
    const seenIds = new Set();
    const dataRows = rows.slice(1);

    if (dataRows.length > IMPORT_MAX_ROWS) {
      return {
        tickets: [],
        errors: [`CSV exceeds the ${IMPORT_MAX_ROWS}-row limit.`],
        warnings: [],
      };
    }

    let nextId = generateTicketId();

    dataRows.forEach((row, rowIndex) => {
      if (!row.some((cell) => String(cell).trim() !== "")) return;

      const lineNumber = rowIndex + 2;
      const featureRequestName = getCell(row, indexByField, "feature_request_name");
      const categoryRaw = getCell(row, indexByField, "category");
      const tierRaw = getCell(row, indexByField, "account_tier");

      if (!featureRequestName) {
        errors.push(`Row ${lineNumber}: feature request name is required.`);
        return;
      }
      if (!categoryRaw) {
        errors.push(`Row ${lineNumber}: category is required.`);
        return;
      }

      const tier = normalizeTier(tierRaw);
      if (!tier) {
        errors.push(`Row ${lineNumber}: account tier must be Enterprise, Pro, or Free.`);
        return;
      }

      const { category, warning: categoryWarning } = normalizeCategory(categoryRaw);
      const { date, warning: dateWarning } = normalizeImportDate(getCell(row, indexByField, "date"));

      let id = formatTicketId(getCell(row, indexByField, "id"));
      if (!id) {
        id = nextId;
        nextId = `#${parseTicketIdNumber(nextId) + 1}`;
        warnings.push(`Row ${lineNumber}: generated ticket ID ${id}.`);
      } else if (seenIds.has(id)) {
        id = nextId;
        nextId = `#${parseTicketIdNumber(nextId) + 1}`;
        warnings.push(`Row ${lineNumber}: duplicate ticket ID — assigned ${id}.`);
      }
      seenIds.add(id);

      if (categoryWarning) warnings.push(`Row ${lineNumber}: ${categoryWarning}.`);
      if (dateWarning) warnings.push(`Row ${lineNumber}: ${dateWarning}.`);

      const priority = normalizePriority(getCell(row, indexByField, "priority"));
      const description = getCell(row, indexByField, "feature_request_description");
      const justification = getCell(row, indexByField, "priority_justification");

      tickets.push(
        normalizeTicket({
          id,
          category,
          account_name: getCell(row, indexByField, "account_name") || "Unknown account",
          account_tier: tier,
          submitted_by: getCell(row, indexByField, "submitted_by") || "import@workspace.local",
          date,
          priority,
          feature_request_name: featureRequestName,
          feature_request_description: description || featureRequestName,
          feature_request_priority: priority,
          priority_justification: justification || "",
          sentiment: "Neutral",
          sentiment_score: 5,
          source: "import",
        })
      );
    });

    if (!tickets.length && !errors.length) {
      errors.push("No ticket rows found in CSV.");
    }

    return { tickets, errors, warnings };
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function downloadCsvTemplate() {
    const headers = Object.keys(CSV_TEMPLATE_ROW);
    const lines = [
      headers.join(","),
      headers.map((key) => csvEscape(CSV_TEMPLATE_ROW[key])).join(","),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "feedback-loop-ticket-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function bindImportUi({
    dropzone,
    fileInput,
    templateBtn,
    statusEl,
    previewWrap,
    previewBody,
    cancelBtn,
    submitBtn,
    footerWrap,
    onImportSuccess,
  }) {
    if (!dropzone || !fileInput) return null;

    let pendingTickets = [];

    function showFooter() {
      if (footerWrap) footerWrap.hidden = false;
    }

    function hideFooter() {
      if (footerWrap) footerWrap.hidden = true;
    }

    function resetImportState() {
      pendingTickets = [];
      fileInput.value = "";
      if (statusEl) {
        statusEl.hidden = true;
        statusEl.textContent = "";
        statusEl.className = "import-status";
      }
      if (previewWrap) previewWrap.hidden = true;
      if (previewBody) previewBody.innerHTML = "";
      if (cancelBtn) cancelBtn.disabled = !footerWrap;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Import tickets";
      }
      dropzone.classList.remove("import-dropzone--active");
      hideFooter();
    }

    function renderImportPreview(tickets) {
      if (!previewWrap || !previewBody) return;
      const previewRows = tickets.slice(0, 3);
      previewBody.innerHTML = previewRows
        .map(
          (ticket) => `
          <tr>
            <td>${escapeHtml(ticket.id)}</td>
            <td>${escapeHtml(getTicketTitle(ticket))}</td>
            <td><span class="badge ${categoryBadgeClass(getTicketCategory(ticket))}">${escapeHtml(getTicketCategory(ticket))}</span></td>
            <td><span class="badge ${tierBadgeClass(ticket.account_tier)}">${escapeHtml(ticket.account_tier || "—")}</span></td>
          </tr>`
        )
        .join("");
      previewWrap.hidden = previewRows.length === 0;
    }

    function renderImportStatus(result) {
      if (!statusEl) return;

      const { tickets, errors, warnings } = result;
      const readyCount = tickets.length;
      const errorCount = errors.length;
      const warningCount = warnings.length;

      statusEl.hidden = false;

      if (errorCount && !readyCount) {
        statusEl.className = "import-status import-status--error";
        statusEl.innerHTML = `<span class="import-status__icon" aria-hidden="true">!</span><span>${escapeHtml(errors[0])}</span>`;
        return;
      }

      if (errorCount) {
        statusEl.className = "import-status import-status--warning";
      } else if (warningCount) {
        statusEl.className = "import-status import-status--warning";
      } else {
        statusEl.className = "import-status import-status--success";
      }

      const icon = errorCount && readyCount ? "!" : warningCount ? "!" : "✓";
      const summary = `${readyCount} ticket${readyCount === 1 ? "" : "s"} ready to import · ${errorCount} error${errorCount === 1 ? "" : "s"} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
      statusEl.innerHTML = `<span class="import-status__icon" aria-hidden="true">${icon}</span><span>${escapeHtml(summary)}</span>`;
    }

    function handleCsvText(text) {
      const result = parseCsvTickets(text);
      pendingTickets = result.tickets;
      showFooter();
      renderImportStatus(result);
      renderImportPreview(result.tickets);

      const canImport = result.tickets.length > 0;
      if (cancelBtn) cancelBtn.disabled = false;
      if (submitBtn) {
        submitBtn.disabled = !canImport;
        submitBtn.textContent = canImport
          ? `Import ${result.tickets.length} ticket${result.tickets.length === 1 ? "" : "s"}`
          : "Import tickets";
      }
    }

    function handleFile(file) {
      if (!file) return;
      if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
        pendingTickets = [];
        showFooter();
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = "import-status import-status--error";
          statusEl.innerHTML =
            '<span class="import-status__icon" aria-hidden="true">!</span><span>Please upload a .csv file.</span>';
        }
        if (previewWrap) previewWrap.hidden = true;
        if (cancelBtn) cancelBtn.disabled = false;
        if (submitBtn) submitBtn.disabled = true;
        return;
      }

      const reader = new FileReader();
      reader.onload = () => handleCsvText(String(reader.result || ""));
      reader.onerror = () => {
        showFooter();
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = "import-status import-status--error";
          statusEl.innerHTML =
            '<span class="import-status__icon" aria-hidden="true">!</span><span>Could not read the CSV file.</span>';
        }
        if (cancelBtn) cancelBtn.disabled = false;
        if (submitBtn) submitBtn.disabled = true;
      };
      reader.readAsText(file);
    }

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("import-dropzone--active");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("import-dropzone--active");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("import-dropzone--active");
      const file = e.dataTransfer?.files?.[0];
      handleFile(file);
    });

    fileInput.addEventListener("change", () => {
      handleFile(fileInput.files?.[0]);
    });

    if (templateBtn) {
      templateBtn.addEventListener("click", downloadCsvTemplate);
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", resetImportState);
    }

    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        if (!pendingTickets.length) return;
        replaceImportedTickets(pendingTickets);
        const count = pendingTickets.length;
        resetImportState();
        if (typeof onImportSuccess === "function") {
          onImportSuccess(count);
        }
      });
    }

    resetImportState();
    return { resetImportState, openFilePicker: () => fileInput.click() };
  }

  function initSettings() {
    const dataSourceMerge = document.getElementById("data-source-merge");
    const dataSourceImportOnly = document.getElementById("data-source-import-only");
    const statusEl = document.getElementById("import-status");
    const cancelBtn = document.getElementById("import-cancel-btn");
    const submitBtn = document.getElementById("import-submit-btn");

    function setDataSourceRadios() {
      const mode = getDataSourceMode();
      if (dataSourceMerge) dataSourceMerge.checked = mode === "merge";
      if (dataSourceImportOnly) dataSourceImportOnly.checked = mode === "import-only";
    }

    bindImportUi({
      dropzone: document.getElementById("import-dropzone"),
      fileInput: document.getElementById("import-file-input"),
      templateBtn: document.getElementById("import-template-btn"),
      statusEl,
      previewWrap: document.getElementById("import-preview-wrap"),
      previewBody: document.getElementById("import-preview-body"),
      cancelBtn,
      submitBtn,
      onImportSuccess(count) {
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = "import-status import-status--success";
          statusEl.innerHTML = `<span class="import-status__icon" aria-hidden="true">✓</span><span>${count} ticket${count === 1 ? "" : "s"} imported — <a href="dashboard.html">view on dashboard</a></span>`;
        }
        if (cancelBtn) cancelBtn.disabled = true;
        if (submitBtn) submitBtn.disabled = true;
      },
    });

    document.querySelectorAll('input[name="data-source"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        setDataSourceMode(input.value);
      });
    });

    setDataSourceRadios();
  }

  function initDashboardImportModal(onImportComplete) {
    const modal = document.getElementById("import-modal");
    const backdrop = document.getElementById("import-modal-backdrop");
    const closeBtn = document.getElementById("import-modal-close");
    const importBtn = document.getElementById("dashboard-import-btn");
    const insightsImportBtn = document.getElementById("insights-import-btn");
    const dropzone = document.getElementById("import-modal-dropzone");

    if (!modal) return;

    function openModal() {
      modal.hidden = false;
      document.body.classList.add("import-modal-open");
      if (dropzone) dropzone.focus();
    }

    function closeModal() {
      modal.hidden = true;
      document.body.classList.remove("import-modal-open");
      importUi?.resetImportState();
    }

    const importUi = bindImportUi({
      dropzone,
      fileInput: document.getElementById("import-modal-file-input"),
      templateBtn: document.getElementById("import-modal-template-btn"),
      statusEl: document.getElementById("import-modal-status"),
      previewWrap: document.getElementById("import-modal-preview-wrap"),
      previewBody: document.getElementById("import-modal-preview-body"),
      cancelBtn: document.getElementById("import-modal-cancel-btn"),
      submitBtn: document.getElementById("import-modal-submit-btn"),
      footerWrap: document.getElementById("import-modal-footer"),
      onImportSuccess() {
        closeModal();
        if (typeof onImportComplete === "function") {
          onImportComplete();
        }
      },
    });

    importBtn?.addEventListener("click", openModal);
    insightsImportBtn?.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    backdrop?.addEventListener("click", closeModal);

    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  function getInsightsTierColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      Enterprise: styles.getPropertyValue("--chart-tier-enterprise").trim() || "#1e3a5f",
      Pro: styles.getPropertyValue("--chart-tier-pro").trim() || "#2a6fc0",
      Free: styles.getPropertyValue("--chart-tier-free").trim() || "#e5e7eb",
    };
  }

  const INSIGHTS_TIER_LABEL_COLORS = {
    Enterprise: "#ffffff",
    Pro: "#ffffff",
    Free: "#374151",
  };

  const tierSegmentLabelsPlugin = {
    id: "tierSegmentLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      const dataset = chart.data.datasets[0];
      const labels = chart.data.labels || [];
      const total = dataset.data.reduce((sum, value) => sum + value, 0);
      if (!total) return;

      meta.data.forEach((arc, index) => {
        const value = dataset.data[index];
        if (!value) return;

        const percent = Math.round((value / total) * 100);
        if (percent < 4) return;

        const { x, y } = arc.tooltipPosition();
        const tier = labels[index];
        ctx.fillStyle = INSIGHTS_TIER_LABEL_COLORS[tier] || "#ffffff";
        ctx.font = "600 13px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${percent}%`, x, y);
      });
    },
  };

  const stackedBarSegmentLabelsPlugin = {
    id: "stackedBarSegmentLabels",
    afterDatasetsDraw(chart) {
      const { ctx, data } = chart;
      if (chart.config.type !== "bar") return;

      data.datasets.forEach((dataset, datasetIndex) => {
        const tier = dataset.label || TIERS[datasetIndex];
        const meta = chart.getDatasetMeta(datasetIndex);

        meta.data.forEach((bar) => {
          const value = dataset.data[bar.index];
          if (!value) return;

          const { x, y, base } = bar.getProps(["x", "y", "base"], true);
          const segmentWidth = Math.abs(x - base);
          if (segmentWidth < 16) return;

          const centerX = (x + base) / 2;
          ctx.fillStyle = INSIGHTS_TIER_LABEL_COLORS[tier] || "#ffffff";
          ctx.font = "600 11px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(value), centerX, y);
        });
      });
    },
  };

  function computeInsightsData(tickets) {
    const categoryCounts = {};
    const categoryTierCounts = {};
    const tierCounts = { Enterprise: 0, Pro: 0, Free: 0 };

    for (const ticket of tickets) {
      const category = getTicketCategory(ticket);
      const tier = TIERS.includes(ticket.account_tier) ? ticket.account_tier : "Free";

      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      if (!categoryTierCounts[category]) {
        categoryTierCounts[category] = { Enterprise: 0, Pro: 0, Free: 0 };
      }
      categoryTierCounts[category][tier] += 1;
      tierCounts[tier] += 1;
    }

    let topCategory = "—";
    let topCategoryCount = 0;
    for (const [category, count] of Object.entries(categoryCounts)) {
      if (count > topCategoryCount) {
        topCategory = category;
        topCategoryCount = count;
      }
    }

    const categoryLabels = Object.keys(categoryCounts)
      .filter((category) => categoryCounts[category] > 0)
      .sort((a, b) => categoryCounts[b] - categoryCounts[a]);

    return {
      total: tickets.length,
      topCategory,
      topCategoryCount,
      categoryCounts,
      categoryTierCounts,
      tierCounts,
      categoryLabels,
    };
  }

  async function initDashboard() {
    const analyzeBtnEmpty = document.getElementById("analyze-btn-empty");
    const loading = document.getElementById("loading");
    const clusterAlert = document.getElementById("cluster-alert");
    const ticketGrid = document.getElementById("ticket-grid");
    const slidePanel = document.getElementById("ticket-slide-panel");
    const slidePanelBackdrop = document.getElementById("ticket-slide-panel-backdrop");
    const slidePanelLinkedView = document.getElementById("ticket-slide-panel-linked");
    const slidePanelDetailView = document.getElementById("ticket-slide-panel-detail");
    const ticketDetailClose = document.getElementById("ticket-detail-close");
    const ticketDetailPrev = document.getElementById("ticket-detail-prev");
    const ticketDetailNext = document.getElementById("ticket-detail-next");
    const ticketDetailDelete = document.getElementById("ticket-detail-delete");
    const insightsView = document.getElementById("dashboard-insights");
    const analysisView = document.getElementById("dashboard-analysis");
    const viewTabs = document.querySelectorAll("[data-dashboard-view]");
    const insightsTotalEl = document.getElementById("insights-total");
    const insightsTopCategoryEl = document.getElementById("insights-top-category");
    const insightsTopCategoryMetaEl = document.getElementById("insights-top-category-meta");
    const insightsEmptyEl = document.getElementById("insights-empty");
    const insightsChartsEl = document.querySelector(".insights-charts");
    const categoryChartCanvas = document.getElementById("insights-category-chart");
    const tierChartCanvas = document.getElementById("insights-tier-chart");
    const tierLegendEl = document.getElementById("insights-tier-legend");

    let allTickets = [];
    let dashboardView = "insights";
    let categoryChart = null;
    let tierChart = null;
    let insightsCategoryLabels = [];
    let ticketFilters = { category: null, tier: null, priority: null, days: 90 };
    let ticketPage = 1;
    let ticketSort = { column: "date", order: "desc" };
    let ticketDetailQueue = [];
    let ticketDetailIndex = -1;
    let scrollDetailToTicketGrid = true;
    let lastClusters = [];
    let lastLinkedTicketIds = [];

    function getVisibleTickets() {
      const filtered = applyTicketFilters(allTickets, ticketFilters);
      return sortTickets(filtered, ticketSort.column, ticketSort.order);
    }

    function toggleTicketSort(column) {
      if (ticketSort.column === column) {
        ticketSort.order = ticketSort.order === "asc" ? "desc" : "asc";
      } else {
        ticketSort.column = column;
        ticketSort.order = "asc";
      }
      ticketPage = 1;
      const activeId =
        ticketDetailIndex >= 0 && ticketDetailQueue[ticketDetailIndex]
          ? ticketDetailQueue[ticketDetailIndex].id
          : null;
      refreshTicketViews(activeId);
    }

    function refreshTicketViews(activeTicketId = null) {
      pruneSelectedTickets(allTickets, ticketFilters);
      const visible = getVisibleTickets();
      const totalPages = Math.max(1, Math.ceil(visible.length / TICKET_PAGE_SIZE));
      if (ticketPage > totalPages) ticketPage = totalPages;
      renderFilterBar(allTickets, ticketFilters, applyTicketFiltersChange);
      renderTicketPanel(allTickets, ticketFilters);
      renderTicketGrid(visible, activeTicketId, ticketPage, ticketSort);
      renderTicketPagination(visible.length, ticketPage, TICKET_PAGE_SIZE, (page) => {
        ticketPage = page;
        refreshTicketViews(activeTicketId);
      });

      if (ticketGrid) {
        ticketGrid.scrollTop = 0;
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          layoutTicketTableArea();
        });
      });
    }

    function layoutTicketTableArea() {
      if (!ticketGrid || dashboardView !== "analysis") return;

      const panelCard = ticketGrid.closest(".panel-card");
      if (!panelCard) return;

      const header = panelCard.querySelector(".panel-card__header");
      const filterBar = panelCard.querySelector(".filter-bar");
      const pagination = panelCard.querySelector(".ticket-pagination");

      const reservedHeight =
        (header?.offsetHeight || 0) +
        (filterBar?.offsetHeight || 0) +
        (pagination && !pagination.hidden ? pagination.offsetHeight : 0);

      const availableHeight = panelCard.clientHeight - reservedHeight;
      if (availableHeight > 0) {
        ticketGrid.style.height = `${availableHeight}px`;
        ticketGrid.style.maxHeight = "";
      } else {
        ticketGrid.style.height = "";
        ticketGrid.style.maxHeight = "calc(100vh - 18rem)";
      }
    }

    function resolveTicket(ticketId) {
      if (!ticketId) return null;
      const direct = allTickets.find((t) => t.id === ticketId);
      if (direct) return direct;

      const numeric = String(ticketId).replace(/^#/, "");
      return (
        allTickets.find((t) => t.id === `#${numeric}` || String(t.id).replace(/^#/, "") === numeric) ||
        null
      );
    }

    function scrollActiveTicketIntoView() {
      requestAnimationFrame(() => {
        const active = document.querySelector(".ticket-table__row--active");
        if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }

    function prepareSynthesisView() {
      const panel = document.getElementById("theme-panel");
      const results = document.getElementById("cluster-results");
      if (panel) panel.innerHTML = "";
      if (results) results.hidden = true;
      setThemesEmptyVisible(false);
    }

    function renderThemeResults(clusters) {
      const panel = document.getElementById("theme-panel");
      const results = document.getElementById("cluster-results");
      const stepThemesSubtitle = document.getElementById("step-themes-subtitle");
      if (!panel) return;

      lastClusters = clusters || [];

      if (!lastClusters.length) {
        panel.innerHTML = "";
        if (results) results.hidden = true;
        if (stepThemesSubtitle) {
          stepThemesSubtitle.textContent = "Select tickets using the checkboxes, then click Analyse.";
        }
        setThemesEmptyVisible(true);
        return;
      }

      if (results) results.hidden = false;
      if (stepThemesSubtitle) {
        stepThemesSubtitle.textContent = "AI-ranked themes based on ticket insights.";
      }
      setThemesEmptyVisible(false);

      const visible = getVisibleTickets();
      panel.innerHTML = lastClusters
        .map((cluster, index) => renderThemePanelHtml(cluster, visible, resolveTicket, index))
        .join("");
    }

    function updateTicketDetailNav() {
      if (ticketDetailPrev) ticketDetailPrev.disabled = ticketDetailIndex <= 0;
      if (ticketDetailNext) {
        ticketDetailNext.disabled = ticketDetailIndex >= ticketDetailQueue.length - 1;
      }
    }

    function updateClusterTicketTagActive(activeTicketId) {
      document.querySelectorAll(".ticket-tag--link, .theme-detail-card__ticket-pill").forEach((btn) => {
        btn.classList.toggle("ticket-tag--active", btn.dataset.ticketId === activeTicketId);
      });
    }

    function isSlidePanelOpen() {
      return Boolean(slidePanel && !slidePanel.hidden);
    }

    function showSlidePanelView(view, { animate = false } = {}) {
      const showLinked = view === "linked";
      if (!slidePanelLinkedView || !slidePanelDetailView) return;

      const fromView = showLinked ? slidePanelDetailView : slidePanelLinkedView;
      const toView = showLinked ? slidePanelLinkedView : slidePanelDetailView;

      if (animate && fromView.classList.contains("ticket-slide-panel__view--active")) {
        fromView.classList.add("ticket-slide-panel__view--leaving");
        fromView.classList.remove("ticket-slide-panel__view--active");
        toView.classList.add("ticket-slide-panel__view--active");
        window.setTimeout(() => {
          fromView.classList.remove("ticket-slide-panel__view--leaving");
        }, 220);
        return;
      }

      slidePanelLinkedView.classList.toggle("ticket-slide-panel__view--active", showLinked);
      slidePanelDetailView.classList.toggle("ticket-slide-panel__view--active", !showLinked);
      slidePanelLinkedView.classList.remove("ticket-slide-panel__view--leaving");
      slidePanelDetailView.classList.remove("ticket-slide-panel__view--leaving");
    }

    function openSlidePanel(view, { animate = false } = {}) {
      if (!slidePanel) return;
      const wasOpen = isSlidePanelOpen();
      slidePanel.hidden = false;
      document.body.classList.add("ticket-slide-panel-open");
      if (!wasOpen) {
        slidePanel.classList.add("ticket-slide-panel--entering");
        window.setTimeout(() => slidePanel.classList.remove("ticket-slide-panel--entering"), 220);
      }
      showSlidePanelView(view, { animate: wasOpen && animate });
    }

    function closeSlidePanel() {
      if (!slidePanel || slidePanel.hidden) return;
      slidePanel.hidden = true;
      document.body.classList.remove("ticket-slide-panel-open");
      slidePanel.classList.remove("ticket-slide-panel--entering");
      showSlidePanelView("linked");
      lastLinkedTicketIds = [];
    }

    function closeTicketDetail() {
      if (!isSlidePanelOpen()) return;
      closeSlidePanel();
      ticketDetailIndex = -1;
      refreshTicketViews(null);
      updateClusterTicketTagActive(null);
    }

    function openTicketDetail(ticketId, queue, options = {}) {
      if (!slidePanel) return;
      const ticket = resolveTicket(ticketId);
      if (!ticket) return;

      scrollDetailToTicketGrid = options.scrollToGrid !== false;

      ticketDetailQueue = queue
        .map((item) => (typeof item === "string" ? resolveTicket(item) : item))
        .filter(Boolean);

      if (!ticketDetailQueue.length) {
        ticketDetailQueue = [ticket];
      }

      ticketDetailIndex = ticketDetailQueue.findIndex((t) => t.id === ticket.id);
      if (ticketDetailIndex < 0) {
        ticketDetailQueue = [ticket, ...ticketDetailQueue];
        ticketDetailIndex = 0;
      }

      populateTicketDetailPanel(ticketDetailQueue[ticketDetailIndex]);
      refreshTicketViews(ticket.id);

      const fromLinked =
        options.fromLinkedPanel &&
        isSlidePanelOpen() &&
        slidePanelLinkedView?.classList.contains("ticket-slide-panel__view--active");

      openSlidePanel("detail", { animate: fromLinked });
      updateTicketDetailNav();
      updateClusterTicketTagActive(ticket.id);
      if (scrollDetailToTicketGrid) scrollActiveTicketIntoView();
      if (ticketDetailClose) ticketDetailClose.focus();
    }

    function showTicketAtIndex(index) {
      if (index < 0 || index >= ticketDetailQueue.length) return;
      ticketDetailIndex = index;
      const ticket = ticketDetailQueue[ticketDetailIndex];
      populateTicketDetailPanel(ticket);
      refreshTicketViews(ticket.id);
      updateTicketDetailNav();
      updateClusterTicketTagActive(ticket.id);
      if (scrollDetailToTicketGrid) scrollActiveTicketIntoView();
    }

    function openTicketDetailFromCluster(ticketId, ticketIds) {
      const fromLinked =
        isSlidePanelOpen() &&
        slidePanelLinkedView?.classList.contains("ticket-slide-panel__view--active");
      openTicketDetail(ticketId, ticketIds, { scrollToGrid: false, fromLinkedPanel: fromLinked });
    }

    function destroyInsightsCharts() {
      if (categoryChart) {
        categoryChart.destroy();
        categoryChart = null;
      }
      if (tierChart) {
        tierChart.destroy();
        tierChart = null;
      }
      if (tierLegendEl) tierLegendEl.innerHTML = "";
    }

    function applyInsightsFilter({ category = null, tier = null } = {}) {
      ticketFilters = {
        category: category || null,
        tier: tier || null,
        priority: null,
        days: 0,
      };
      closeTicketDetail();
      hideAlert(clusterAlert);
      renderThemeResults([]);
      ticketPage = 1;
      switchDashboardView("analysis");
      refreshTicketViews(null);
      updateAnalyzeButton(allTickets, ticketFilters);
    }

    function renderInsightsView() {
      if (!insightsView) return;

      const data = computeInsightsData(allTickets);
      const hasTickets = data.total > 0;

      const insightsKpisEl = document.querySelector(".insights-kpis");
      if (insightsKpisEl) insightsKpisEl.hidden = !hasTickets;
      if (insightsEmptyEl) insightsEmptyEl.hidden = hasTickets;
      if (insightsChartsEl) insightsChartsEl.hidden = !hasTickets;

      if (insightsTotalEl) insightsTotalEl.textContent = String(data.total);

      if (insightsTopCategoryEl) {
        if (hasTickets && data.topCategory !== "—") {
          insightsTopCategoryEl.innerHTML = `<span class="badge ${categoryBadgeClass(data.topCategory)}">${escapeHtml(data.topCategory)}</span>`;
        } else {
          insightsTopCategoryEl.textContent = "—";
        }
      }

      if (insightsTopCategoryMetaEl) {
        if (hasTickets && data.topCategoryCount > 0) {
          insightsTopCategoryMetaEl.textContent = `${data.topCategoryCount} request${data.topCategoryCount === 1 ? "" : "s"}`;
          insightsTopCategoryMetaEl.hidden = false;
        } else {
          insightsTopCategoryMetaEl.hidden = true;
          insightsTopCategoryMetaEl.textContent = "";
        }
      }

      destroyInsightsCharts();

      if (!hasTickets || !window.Chart || !categoryChartCanvas || !tierChartCanvas) return;

      insightsCategoryLabels = data.categoryLabels;
      const tierColors = getInsightsTierColors();
      const categoryChartWrap = categoryChartCanvas.closest(".insights-chart-wrap");
      if (categoryChartWrap) {
        categoryChartWrap.style.minHeight = `${Math.max(140, data.categoryLabels.length * 36)}px`;
        categoryChartWrap.style.height = "";
      }

      const donutChartWrap = tierChartCanvas.closest(".insights-chart-wrap--donut");
      if (donutChartWrap) {
        donutChartWrap.style.height = "";
      }

      const tierDatasets = TIERS.map((tier) => ({
        label: tier,
        data: data.categoryLabels.map((category) => data.categoryTierCounts[category]?.[tier] || 0),
        backgroundColor: tierColors[tier],
        hoverBackgroundColor: tierColors[tier],
        borderWidth: 0,
        borderRadius: 3,
        stack: "tier",
      }));

      categoryChart = new Chart(categoryChartCanvas, {
        type: "bar",
        data: {
          labels: data.categoryLabels,
          datasets: tierDatasets,
        },
        plugins: [stackedBarSegmentLabelsPlugin],
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          datasets: {
            bar: {
              categoryPercentage: 0.72,
              barPercentage: 0.88,
            },
          },
          layout: {
            padding: { left: 4, bottom: 4, top: 4 },
          },
          scales: {
            x: {
              stacked: true,
              beginAtZero: true,
              title: {
                display: true,
                text: "Number of requests",
                color: "#787f8c",
                font: { family: "Inter, system-ui, sans-serif", size: 11, weight: "500" },
                padding: { top: 8 },
              },
              ticks: {
                precision: 0,
                stepSize: 1,
                color: "#787f8c",
                font: { family: "Inter, system-ui, sans-serif", size: 11 },
              },
              grid: { color: "rgba(64, 70, 86, 0.08)" },
            },
            y: {
              stacked: true,
              ticks: {
                autoSkip: false,
                color: "#404656",
                font: { family: "Inter, system-ui, sans-serif", size: 12, weight: "600" },
              },
              grid: { display: false },
            },
          },
          plugins: {
            legend: {
              position: "top",
              align: "end",
              labels: {
                boxWidth: 10,
                boxHeight: 10,
                useBorderRadius: true,
                borderRadius: 2,
                color: "#404656",
                font: { family: "Inter, system-ui, sans-serif", size: 12, weight: "500" },
                padding: 12,
              },
            },
            tooltip: {
              callbacks: {
                label(context) {
                  const value = context.parsed.x || 0;
                  return `${context.dataset.label}: ${value}`;
                },
              },
            },
          },
          onClick(_event, elements) {
            if (!elements.length) return;
            const { datasetIndex, index } = elements[0];
            const tier = TIERS[datasetIndex];
            const category = insightsCategoryLabels[index];
            if (!category || !tier) return;
            applyInsightsFilter({ category, tier });
          },
        },
      });

      const tierValues = TIERS.map((tier) => data.tierCounts[tier] || 0);
      const tierTotal = tierValues.reduce((sum, value) => sum + value, 0);

      if (tierLegendEl) {
        tierLegendEl.innerHTML = TIERS.map((tier, index) => {
          const value = tierValues[index];
          const percent = tierTotal ? Math.round((value / tierTotal) * 100) : 0;
          return `
            <li>
              <button type="button" class="insights-tier-legend__item" data-tier="${escapeHtml(tier)}">
                <span class="insights-tier-legend__swatch" style="background:${tierColors[tier]}" aria-hidden="true"></span>
                <span class="insights-tier-legend__label">${escapeHtml(tier)}</span>
                <span class="insights-tier-legend__value">${percent}%</span>
              </button>
            </li>`;
        }).join("");

        tierLegendEl.querySelectorAll("[data-tier]").forEach((button) => {
          button.addEventListener("click", () => {
            applyInsightsFilter({ tier: button.dataset.tier });
          });
        });
      }

      tierChart = new Chart(tierChartCanvas, {
        type: "doughnut",
        data: {
          labels: TIERS,
          datasets: [
            {
              data: tierValues,
              backgroundColor: TIERS.map((tier) => tierColors[tier]),
              hoverBackgroundColor: TIERS.map((tier) => tierColors[tier]),
              borderWidth: 0,
            },
          ],
        },
        plugins: [tierSegmentLabelsPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "58%",
          layout: {
            padding: 4,
          },
          plugins: {
            legend: {
              display: false,
            },
            tooltip: {
              callbacks: {
                label(context) {
                  const value = context.parsed || 0;
                  const percent = tierTotal ? Math.round((value / tierTotal) * 100) : 0;
                  return `${context.label}: ${value} (${percent}%)`;
                },
              },
            },
          },
          onClick(_event, elements) {
            if (!elements.length) return;
            const tier = TIERS[elements[0].index];
            if (!tier) return;
            applyInsightsFilter({ tier });
          },
        },
      });

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          layoutInsightsChartAreas();
        });
      });
    }

    function layoutInsightsChartAreas() {
      if (!categoryChartCanvas || !tierChartCanvas) return;

      const categoryCard = categoryChartCanvas.closest(".insights-chart-card");
      const categoryHeader = categoryCard?.querySelector(".insights-chart-card__header");
      const categoryWrap = categoryChartCanvas.closest(".insights-chart-wrap");
      const tierLayout = tierChartCanvas.closest(".insights-tier-chart-layout");
      const donutWrap = tierChartCanvas.closest(".insights-chart-wrap--donut");

      if (categoryCard && categoryHeader && categoryWrap) {
        const height = categoryCard.clientHeight - categoryHeader.offsetHeight;
        if (height > 0) {
          categoryWrap.style.height = `${height}px`;
        }
      }

      if (tierLayout && donutWrap) {
        const height = tierLayout.clientHeight;
        if (height > 0) {
          donutWrap.style.height = `${height}px`;
        }
      }

      categoryChart?.resize();
      tierChart?.resize();
    }

    function switchDashboardView(view) {
      dashboardView = view === "analysis" ? "analysis" : "insights";

      viewTabs.forEach((tab) => {
        const isActive = tab.dataset.dashboardView === dashboardView;
        tab.classList.toggle("dashboard-view-tab--active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
        tab.tabIndex = isActive ? 0 : -1;
      });

      if (insightsView) insightsView.hidden = dashboardView !== "insights";
      if (analysisView) analysisView.hidden = dashboardView !== "analysis";

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      if (dashboardView === "insights") {
        renderInsightsView();
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            refreshTicketViews(null);
            layoutTicketTableArea();
          });
        });
      }
    }

    async function reloadDashboardTickets() {
      allTickets = await loadAllTickets();
      renderThemeResults([]);
      ticketPage = 1;
      refreshTicketViews(null);
      updateAnalyzeButton(allTickets, ticketFilters);
      if (dashboardView === "insights") renderInsightsView();
    }

    initDashboardImportModal(() => {
      reloadDashboardTickets();
    });

    let insightsResizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(insightsResizeTimer);
      insightsResizeTimer = window.setTimeout(() => {
        if (dashboardView === "insights") {
          if (categoryChart || tierChart) {
            layoutInsightsChartAreas();
          } else {
            renderInsightsView();
          }
          return;
        }

        layoutTicketTableArea();
      }, 150);
    });

    function applyTicketFiltersChange(change) {
      if (change.reset) {
        ticketFilters = { category: null, tier: null, priority: null, days: 90 };
      } else {
        ticketFilters = { ...ticketFilters, ...change };
        if ("category" in change && !change.category) ticketFilters.category = null;
        if ("tier" in change && !change.tier) ticketFilters.tier = null;
        if ("priority" in change && !change.priority) ticketFilters.priority = null;
        if ("days" in change && change.days === 0) ticketFilters.days = 0;
      }

      closeTicketDetail();
      hideAlert(clusterAlert);
      renderThemeResults([]);
      ticketPage = 1;
      refreshTicketViews(null);
    }

    viewTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        switchDashboardView(tab.dataset.dashboardView);
      });
    });

    try {
      allTickets = await loadAllTickets();
      applyTicketFiltersChange({ reset: true });
      switchDashboardView("insights");
    } catch (err) {
      if (ticketGrid) {
        ticketGrid.innerHTML = `<div class="alert alert--error">Failed to load tickets: ${escapeHtml(err.message)}. Serve the project from the repo root (e.g. <code>npx serve .</code>).</div>`;
      }
      switchDashboardView("insights");
    }

    function openTicketFromThemePanel(ticketId, themeIndex = 0) {
      const cluster = lastClusters[themeIndex] || lastClusters[0];
      const ticketIds = cluster ? cluster.linked_tickets || cluster.ticket_ids || [] : [];
      openTicketDetailFromCluster(ticketId, ticketIds);
    }

    if (ticketGrid) {
      ticketGrid.addEventListener("change", (e) => {
        const checkbox = e.target.closest(".ticket-table__checkbox");
        if (!checkbox) return;

        const row = checkbox.closest(".ticket-table__row");
        const ticketId = row && row.dataset.ticketId;
        if (!ticketId) return;

        if (checkbox.checked) selectedTicketIds.add(ticketId);
        else selectedTicketIds.delete(ticketId);

        updateAnalyzeButton(allTickets, ticketFilters);
      });

      ticketGrid.addEventListener("click", (e) => {
        const sortHeader = e.target.closest("[data-sort-column]");
        if (sortHeader) {
          toggleTicketSort(sortHeader.dataset.sortColumn);
          return;
        }
        if (e.target.closest(".ticket-table__checkbox")) {
          e.stopPropagation();
          return;
        }
        const row = e.target.closest(".ticket-table__row");
        if (!row) return;
        const visible = getVisibleTickets();
        openTicketDetail(row.dataset.ticketId, visible);
      });

      ticketGrid.addEventListener("keydown", (e) => {
        const sortHeader = e.target.closest("[data-sort-column]");
        if (sortHeader) {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          toggleTicketSort(sortHeader.dataset.sortColumn);
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        const row = e.target.closest(".ticket-table__row");
        if (!row) return;
        e.preventDefault();
        const visible = getVisibleTickets();
        openTicketDetail(row.dataset.ticketId, visible);
      });
    }

    const linkedTicketsPanelClose = document.getElementById("linked-tickets-panel-close");
    const linkedTicketsPanelTitle = document.getElementById("linked-tickets-panel-title");
    const linkedTicketsPanelBody = document.getElementById("linked-tickets-panel-body");

    function openLinkedTicketsPanel(ticketIds) {
      if (!slidePanel || !linkedTicketsPanelBody) return;
      lastLinkedTicketIds = ticketIds;
      const tickets = ticketIds.map((id) => resolveTicket(id)).filter(Boolean);
      if (linkedTicketsPanelTitle) {
        linkedTicketsPanelTitle.textContent = `Linked tickets (${tickets.length})`;
      }
      linkedTicketsPanelBody.innerHTML = renderLinkedTicketsModalRows(ticketIds, resolveTicket);
      openSlidePanel("linked");
      if (linkedTicketsPanelClose) linkedTicketsPanelClose.focus();
    }

    function closeLinkedTicketsPanel() {
      closeSlidePanel();
    }

    if (linkedTicketsPanelClose) {
      linkedTicketsPanelClose.addEventListener("click", closeLinkedTicketsPanel);
    }
    if (slidePanelBackdrop) {
      slidePanelBackdrop.addEventListener("click", closeTicketDetail);
    }
    if (linkedTicketsPanelBody) {
      linkedTicketsPanelBody.addEventListener("click", (e) => {
        const row = e.target.closest(".linked-tickets-table__row");
        if (!row) return;
        const ticketId = row.dataset.ticketId;
        if (!ticketId || !lastLinkedTicketIds.length) return;
        openTicketDetailFromCluster(ticketId, [...lastLinkedTicketIds]);
      });

      linkedTicketsPanelBody.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const row = e.target.closest(".linked-tickets-table__row");
        if (!row) return;
        e.preventDefault();
        const ticketId = row.dataset.ticketId;
        if (!ticketId || !lastLinkedTicketIds.length) return;
        openTicketDetailFromCluster(ticketId, [...lastLinkedTicketIds]);
      });
    }

    const themePanel = document.getElementById("theme-panel");
    if (themePanel) {
      themePanel.addEventListener("click", (e) => {
        const exportBrief = e.target.closest('[data-action="export-brief-pdf"]');
        if (exportBrief) {
          e.preventDefault();
          const card = exportBrief.closest(".theme-detail-card");
          const themeIndex = Number(card?.dataset.themeIndex ?? 0);
          const cluster = lastClusters[themeIndex];
          try {
            if (cluster) exportThemeBriefAsPdf(cluster, resolveTicket);
          } catch (err) {
            showAlert(clusterAlert, err.message || "PDF export failed.", "error");
          }
          return;
        }

        const tag = e.target.closest(".ticket-tag--link");
        if (!tag) return;
        e.preventDefault();
        const card = tag.closest(".theme-detail-card");
        const themeIndex = Number(card?.dataset.themeIndex ?? 0);
        openTicketFromThemePanel(tag.dataset.ticketId, themeIndex);
      });
    }

    if (ticketDetailClose) ticketDetailClose.addEventListener("click", closeTicketDetail);
    if (ticketDetailPrev) {
      ticketDetailPrev.addEventListener("click", () => showTicketAtIndex(ticketDetailIndex - 1));
    }
    if (ticketDetailNext) {
      ticketDetailNext.addEventListener("click", () => showTicketAtIndex(ticketDetailIndex + 1));
    }

    if (ticketDetailDelete) {
      ticketDetailDelete.addEventListener("click", async () => {
        const ticket = ticketDetailQueue[ticketDetailIndex];
        if (!ticket || !isDeletableTicket(ticket)) return;
        if (!window.confirm(`Remove ${ticket.id} from the dashboard?`)) return;
        deleteStoredTicket(ticket.id);
        closeTicketDetail();
        await reloadDashboardTickets();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (isSlidePanelOpen()) {
        closeTicketDetail();
      }
    });

    async function runSynthesis() {
      hideAlert(clusterAlert);

      const visible = getVisibleTickets();
      const selectedIds = new Set(getSelectedTicketsInScope(allTickets, ticketFilters));
      const ticketsToAnalyse = visible.filter((t) => selectedIds.has(t.id));

      if (ticketsToAnalyse.length === 0) {
        showAlert(clusterAlert, "Select at least one ticket using the checkboxes before analysing.", "error");
        return;
      }

      prepareSynthesisView();

      if (analyzeBtnEmpty) analyzeBtnEmpty.disabled = true;
      if (loading) loading.hidden = false;

      try {
        const result = await clusterTicketsWithClaude(ticketsToAnalyse);
        renderThemeResults(result.clusters);
      } catch (err) {
        showAlert(clusterAlert, formatSynthesisError(err.message), "error");
        renderThemeResults([]);
      } finally {
        updateAnalyzeButton(allTickets, ticketFilters);
        if (loading) loading.hidden = true;
      }
    }

    if (analyzeBtnEmpty) analyzeBtnEmpty.addEventListener("click", runSynthesis);
  }

  // --- Boot ---

  const page = document.body && document.body.dataset.page;

  if (page === "intake") {
    initIntake();
  } else if (page === "dashboard") {
    initDashboard();
  } else if (page === "settings") {
    initSettings();
  }
})();
