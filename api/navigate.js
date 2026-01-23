// api/navigate.js
// SinePatre Resource Navigator API (Vercel serverless)
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)
//
// POST JSON:
// { "message": "...", "history": [{role:"user"|"assistant", content:"..."}] }
//
// Returns:
// { mode, intro, resources: [{title,url,why}] }

const MAX_MESSAGE_LENGTH = 800;
const MAX_HISTORY_ITEMS = 12;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life)\b/i,
  /\b(self[- ]?harm|cut myself|cutting)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home)\b/i,
  /\b(abuse|sexual assault|rape|molested)\b/i,
];

// Keep permissive for now so the Squarespace iframe works while testing.
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
    "the","and","or","but","if","to","of","in","on","for","with","is","are","was","were","be","been","being",
    "i","me","my","you","your","we","they","this","that","it","im","i'm","dont","don't","cant","can't",
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

async function loadResources(csvUrl) {
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error("Failed to fetch sheet CSV");
  const text = await r.text();

  const rows = parseCSV(text);
  if (!rows.length) throw new Error("Empty CSV");

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
    if (col(c) === -1) throw new Error(`Missing column: ${c}`);
  }

  return rows
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
}

function isCrisisResource(resource) {
  const t = `${resource.title} ${resource.description} ${resource.when_to_use}`.toLowerCase();
  return (
    t.includes("crisis") ||
    t.includes("suicide") ||
    t.includes("self-harm") ||
    t.includes("hotline") ||
    t.includes("988")
  );
}

function scoreResource(resource, queryTokens, tagTokens) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
  );

  let score = 0;
  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 3;
    if (tagTokens.includes(w)) score += 5;
  }

  // Small boost for explicit fatherlessness relevance
  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) {
    score += 4;
  }

  return score;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const trimmed = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 800),
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

// OpenAI call: returns JSON object
async function openaiJSON(apiKey, messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(t);
  }

  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
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

  // Hard safety gate: skip AI, return crisis resources only
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please use one of these resources now.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "24/7 call or text support in the U.S." },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "Text-based support with trained counselors." },
        { title: "Teen Line", url: "https://teenline.org", why: "Teens helping teens via text, call, or email." },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "Support for abuse or unsafe situations." },
      ],
    });
  }

  try {
    const resources = await loadResources(csvUrl);

    // 1) Classify need and intent using chat context
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are a precise intake assistant for a curated resource navigator for fatherless teens. Output JSON only: { need_tags: string[3-6], urgency: low|medium|high, intent: one of [explore, pick_best, compare, ask_followup], notes: string }. Keep notes short. Do not give advice.",
      },
      ...history,
      { role: "user", content: message },
    ]);

    const urgency = String(classification.urgency || "low").toLowerCase();
    const queryTokens = tokenize(message);
    const tagTokens = tokenize((classification.need_tags || []).join(" "));

    const rankedAll = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, tagTokens) }))
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
        intro: "I am not seeing a strong match yet. Add one detail about what you want (talking to someone, grief support, school stress, mentorship, therapy).",
        resources: [],
      });
    }

    // 2) Decide how many to show based on intent and phrasing
    const intent = String(classification.intent || "").toLowerCase();
    const limit =
      intent === "pick_best" || wantSinglePick(message)
        ? 1
        : 3;

    const top = ranked.slice(0, Math.max(limit, 3)).map((x) => x.r); // send a few to the writer, even if we only show 1

    // 3) Write final response, conversational but grounded in the curated database
    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are the SinePatre Resource Navigator. You help like a thoughtful guide, warm and direct. You MUST use ONLY the provided resources and their fields. No generic therapy advice, no medical claims. Output JSON only: { intro: string, resources: [{ title: string, url: string, why: string }] }. Rules: If the user asks for the single best option, return exactly 1 resource. Otherwise return up to 3 resources. Each why must be 3 to 6 sentences, specific to the user's message and the resource fields, and include what the teen can do next in a practical way (visit, sign up, how to use it). If the user asks a follow-up question about the previous list (for example which is best), answer it directly.",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          urgency,
          need_tags: classification.need_tags || [],
          intent,
          show_count: limit,
          resources: top,
        }),
      },
    ]);

    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit);

    return send(req, res, 200, {
      mode: "recommendations",
      intro: response.intro || "Here is what fits best based on what you shared.",
      resources: clipped,
    });
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg.includes("insufficient_quota")) {
      return send(req, res, 402, {
        error: "OpenAI billing not active",
        detail: "Your API key has no available quota. Confirm billing is enabled and you have remaining credits.",
      });
    }

    return send(req, res, 500, {
      error: "Server error",
      detail: msg,
    });
  }
}
