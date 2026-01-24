// api/navigate.js - SinePatre Resource Navigator (Vercel serverless)
// Curated, database-grounded recommendations for teens, with strong safety gating.
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)
//
// POST JSON:
// {
//   "message": "...",
//   "history": [{ "role":"user"|"assistant", "content":"..." }],
//   "age": "13" | "14-16" | "" | null,
//   "topics": ["grief","school stress"] | []
// }
//
// Returns:
// { mode, intro, clarifying_question?: string|null, resources: [{title,url,why,how_to_start?:string[]}] }

const MAX_MESSAGE_LENGTH = 1200;
const MAX_HISTORY_ITEMS = 20;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(req, res, status, payload) {
  setCors(req, res);
  res.status(status).json(payload);
}

function triggeredSafety(message) {
  return SAFETY_REGEX.some((rx) => rx.test(message));
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are",
    "was","were","be","been","being","i","me","my","you","your","we","they",
    "this","that","it","im","i'm","dont","don't","cant","can't","a","an",
    "about","from","by","at","as","into","through","during","before","after",
  ]);

  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Minimal CSV parser (handles quotes)
function parseCSV(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    const n = csv[i + 1];

    if (c === '"' && inQuotes && n === '"') {
      field += '"';
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && n === "\n") i++;
      row.push(field);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }

  row.push(field);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

// In-memory cache to avoid re-fetching the sheet on every request
let CACHE = {
  at: 0,
  ttlMs: 2 * 60 * 1000,
  items: null,
};

async function loadResources(csvUrl) {
  const now = Date.now();
  if (CACHE.items && now - CACHE.at < CACHE.ttlMs) return CACHE.items;

  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error("sheet_fetch_failed");
  const text = await r.text();

  const rows = parseCSV(text);
  if (!rows.length) throw new Error("sheet_empty");

  const headers = rows[0].map((h) => normalize(h).replace(/\s+/g, "_"));
  const col = (name) => headers.indexOf(name);

  const required = [
    "id",
    "title",
    "description",
    "best_for",
    "when_to_use",
    "not_for",
    "fatherlessness_connection",
    "url",
  ];

  for (const c of required) {
    if (col(c) === -1) throw new Error(`missing_column:${c}`);
  }

  const items = rows
    .slice(1)
    .map((r2) => ({
      id: (r2[col("id")] || "").trim(),
      title: (r2[col("title")] || "").trim(),
      description: (r2[col("description")] || "").trim(),
      best_for: (r2[col("best_for")] || "").trim(),
      when_to_use: (r2[col("when_to_use")] || "").trim(),
      not_for: (r2[col("not_for")] || "").trim(),
      fatherlessness_connection: (r2[col("fatherlessness_connection")] || "").trim(),
      url: (r2[col("url")] || "").trim(),
    }))
    .filter((x) => x.id && x.title && x.url);

  CACHE = { ...CACHE, at: now, items };
  return items;
}

function isCrisisResource(resource) {
  const t = `${resource.title} ${resource.description} ${resource.when_to_use}`.toLowerCase();
  return (
    t.includes("crisis") ||
    t.includes("suicide") ||
    t.includes("self-harm") ||
    t.includes("hotline") ||
    t.includes("988") ||
    t.includes("emergency")
  );
}

function scoreResource(resource, queryTokens, tagTokens, urgency) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
  );

  let score = 0;
  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 3;
    if (tagTokens.includes(w)) score += 5;
  }

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) {
    score += 6;
  }

  if (urgency === "high" && isCrisisResource(resource)) score += 10;
  return score;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const trimmed = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 1200),
    }));
  return trimmed.slice(-MAX_HISTORY_ITEMS);
}

function wantSinglePick(message) {
  const t = normalize(message);
  return (
    t.includes("which is the best") ||
    t.includes("which one is best") ||
    t.includes("which is best") ||
    t.includes("pick one") ||
    t.includes("choose one") ||
    t.includes("just one") ||
    t.includes("best one") ||
    t.includes("the best option")
  );
}

async function openaiJSON(apiKey, messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!r.ok) throw new Error("openai_call_failed");

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error("openai_empty");
  return JSON.parse(content);
}

function buildHowToStart(resource) {
  const text = `${resource.when_to_use}\n${resource.description}\n${resource.best_for}`.toLowerCase();

  const steps = [];
  const add = (s) => { if (!steps.includes(s)) steps.push(s); };

  if (/\bcall\b/.test(text) || /\bphone\b/.test(text) || /\bhotline\b/.test(text)) add("Call");
  if (/\btext\b/.test(text) || /\bsms\b/.test(text)) add("Text");
  if (/\bform\b/.test(text) || /\bapply\b/.test(text) || /\bsign up\b/.test(text) || /\bregister\b/.test(text)) add("Form");
  if (/\bwalk[- ]?in\b/.test(text) || /\bin person\b/.test(text)) add("Walk-in");
  if (/\breferral\b/.test(text) || /\bdoctor\b/.test(text) || /\bcounselor\b/.test(text)) add("Referral");

  // Keep your exact allowed set, always show in this order if present
  const order = ["Call", "Text", "Form", "Walk-in", "Referral"];
  const ordered = order.filter((x) => steps.includes(x));

  // If none detected, provide a safe default
  if (!ordered.length) return ["Form", "Call"];

  return ordered;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    return send(req, res, 405, { error: "POST only" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

  if (!apiKey || !csvUrl) {
    return send(req, res, 500, { error: "Missing environment variables" });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return send(req, res, 400, { error: "Missing message" });
  if (message.length > MAX_MESSAGE_LENGTH) return send(req, res, 400, { error: "Message too long" });

  const history = sanitizeHistory(req.body?.history);
  const age = String(req.body?.age || "").trim().slice(0, 24);
  const topics = Array.isArray(req.body?.topics) ? req.body.topics.slice(0, 8).map(String) : [];

  // Hard safety gate: skip AI, return crisis resources only
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please reach out right now.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "Call or text 988, 24/7 in the U.S." },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "Text HOME to 741741 for 24/7 support." },
        { title: "Teen Line", url: "https://teenline.org", why: "Teens helping teens by text, call, or email." },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "Support for abuse or unsafe situations." },
      ],
    });
  }

  try {
    const resources = await loadResources(csvUrl);

    // 1) Classification
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are an expert intake assistant for a curated resource navigator for fatherless teens. Output JSON only.\n\n" +
          "Return:\n" +
          '{ "need_tags": string[3-7], "urgency": "low|medium|high", "intent": "explore|pick_best|compare|ask_followup|clarify", "needs_one_question": boolean, "clarifying_question": string|null, "notes": string }\n\n' +
          "Rules:\n" +
          "- Use concrete tags like: talk-now, therapy, support-group, mentor, grief, school-stress, anxiety, depression, family, identity, loneliness, anger, trauma, academic, social.\n" +
          "- Ask at most one clarifying question, only if truly needed to pick among resources.\n" +
          "- Keep notes to 1-2 sentences. Do not give advice.",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({ message, age, topics }),
      },
    ]);

    const urgency = String(classification.urgency || "low").toLowerCase();
    const intent = String(classification.intent || "explore").toLowerCase();

    const queryTokens = tokenize(`${message} ${topics.join(" ")} ${age ? `age ${age}` : ""}`);
    const tagTokens = tokenize((classification.need_tags || []).join(" "));

    const rankedAll = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, tagTokens, urgency) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    let ranked = rankedAll;
    if (urgency !== "high") {
      ranked = rankedAll.filter((x) => !isCrisisResource(x.r));
      if (!ranked.length) ranked = rankedAll;
    }

    if (!ranked.length) {
      return send(req, res, 200, {
        mode: "no_match",
        intro: "I can help, but I need one detail to narrow it down. Are you looking to talk now, ongoing support, or a mentor?",
        clarifying_question: "What would help most right now: someone to talk to today, ongoing support, or mentorship?",
        resources: [],
      });
    }

    const limit = intent === "pick_best" || wantSinglePick(message) ? 1 : 3;

    const topForWriter = ranked.slice(0, Math.max(limit, 5)).map((x) => x.r);

    // 2) Response writing (database-grounded)
    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are SinePatre, a calm and direct guide for teens. You MUST use ONLY the provided resources and their fields.\n\n" +
          "Output JSON only:\n" +
          '{ "intro": string, "clarifying_question": string|null, "resources": [{ "title": string, "url": string, "why": string, "how_to_start": string[] }] }\n\n' +
          "Rules:\n" +
          "- Return 1 to 3 resources total.\n" +
          "- Each why must be exactly 3 sentences.\n" +
          "- Each why must: (1) name the fit, (2) reference a specific field (best_for/when_to_use/description/fatherlessness_connection), (3) give one concrete next step.\n" +
          "- Include how_to_start as 2 to 4 items chosen only from: Call, Text, Form, Walk-in, Referral.\n" +
          "- Ask ONE clarifying question only if needed, otherwise set clarifying_question to null.\n" +
          "- No generic mental health advice. No invented details.",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          age,
          topics,
          urgency,
          intent,
          need_tags: classification.need_tags || [],
          resources: topForWriter,
          show_count: limit,
          allow_clarify: Boolean(classification.needs_one_question),
        }),
      },
    ]);

    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit).map((x) => {
      // enforce “how_to_start” from the database signals if model misses it
      const fallbackSteps = buildHowToStart(
        topForWriter.find((r) => r.title === x.title && r.url === x.url) || topForWriter[0]
      );

      const allowed = new Set(["Call", "Text", "Form", "Walk-in", "Referral"]);
      const provided = Array.isArray(x.how_to_start) ? x.how_to_start.map(String) : [];
      const cleaned = provided.filter((s) => allowed.has(s)).slice(0, 4);

      return {
        title: String(x.title || "").trim(),
        url: String(x.url || "").trim(),
        why: String(x.why || "").trim(),
        how_to_start: cleaned.length ? cleaned : fallbackSteps,
      };
    });

    return send(req, res, 200, {
      mode: "recommendations",
      intro: String(response.intro || "Here is what fits best based on what you shared.").trim(),
      clarifying_question: response.clarifying_question ? String(response.clarifying_question).trim() : null,
      resources: clipped,
    });
  } catch (err) {
    // Keep user-facing errors calm and non-technical
    console.error("navigate_error", err);
    return send(req, res, 500, {
      error: "Something went wrong",
      detail: "Please try again in a moment.",
    });
  }
}
