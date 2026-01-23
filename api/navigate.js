// api/navigate.js
// SinePatre Resource Navigator API (Vercel serverless)
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)
//
// POST JSON:
// { "message": "..." }
//
// Returns:
// { mode, intro, resources: [{title,url,why}] }

const MAX_MESSAGE_LENGTH = 800;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life)\b/i,
  /\b(self[- ]?harm|cut myself|cutting)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home)\b/i,
  /\b(abuse|sexual assault|rape|molested)\b/i,
];

// Keep permissive for now so the Squarespace iframe works while testing.
// After the embed works, tighten this to only your domain.
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
    "a","an","at","as","by","from","into","over","than","then","so","just","like","really","very","want",
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

function scoreResource(resource, queryTokens) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
  );

  const q = new Set(queryTokens);
  let score = 0;

  for (const w of haystack) {
    if (q.has(w)) score += 3;
  }

  // Boost explicit "talk to someone" intent
  const raw = `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use}`.toLowerCase();
  if (
    raw.includes("peer") ||
    raw.includes("mentor") ||
    raw.includes("counsel") ||
    raw.includes("therap") ||
    raw.includes("support group") ||
    raw.includes("talk") ||
    raw.includes("listen")
  ) {
    score += 2;
  }

  // Small boost for explicit fatherlessness relevance
  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) {
    score += 3;
  }

  return score;
}

// We keep timeouts very generous to avoid user-facing "took too long" behavior.
// (Serverless platforms still have their own hard limits.)
async function fetchWithTimeout(url, opts = {}, ms = 90000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Cache the sheet across warm invocations to reduce latency.
async function loadResourcesCached(csvUrl) {
  const cacheKey = "__SP_RESOURCES_CACHE__";
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;

  const g = globalThis;
  const cached = g[cacheKey];

  if (cached && cached.expiresAt > now && Array.isArray(cached.data) && cached.data.length) {
    return cached.data;
  }

  const r = await fetchWithTimeout(csvUrl, {}, 90000);
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

  const data = rows
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

  g[cacheKey] = { data, expiresAt: now + ttlMs };
  return data;
}

async function openaiJSON(apiKey, messages) {
  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.55,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages,
      }),
    },
    90000
  );

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

  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support right now. Please use one of these options.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "24/7 call or text support in the U.S." },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "Text-based support with trained counselors." },
        { title: "Teen Line", url: "https://teenline.org", why: "Teens helping teens via text, call, or email." },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "Support for abuse or unsafe situations." },
      ],
    });
  }

  try {
    const resources = await loadResourcesCached(csvUrl);

    const queryTokens = tokenize(message);

    const rankedAll = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    const rankedNonCrisis = rankedAll.filter((x) => !isCrisisResource(x.r));
    const shortlist = (rankedNonCrisis.length ? rankedNonCrisis : rankedAll).slice(0, 10).map((x) => x.r);

    if (!shortlist.length) {
      return send(req, res, 200, {
        mode: "no_match",
        intro: "I could not find a strong match yet. Add one detail about what you want (someone to talk to, grief, anxiety, school stress, mentorship).",
        resources: [],
      });
    }

    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are the SinePatre Resource Navigator.\n" +
          "Purpose: Recommend support options to fatherless teens using ONLY a curated database provided in the prompt.\n\n" +
          "Rules:\n" +
          "- Use ONLY the provided resources. Do not invent names, hotlines, or websites.\n" +
          "- Do not give medical, legal, or therapeutic instructions. Do not diagnose.\n" +
          "- Be calm, respectful, and eloquent.\n" +
          "- Choose EXACTLY 3 resources.\n" +
          "- For each resource, write a comprehensive overview in 3 to 6 sentences that explains what it is, who it fits, why it matches the user's message, and what the user can do next.\n" +
          "- Return JSON only in this shape:\n" +
          '{ "intro": "string", "resources": [ { "title": "string", "url": "string", "why": "string" }, ... ] }',
      },
      {
        role: "user",
        content: JSON.stringify({
          message,
          resources: shortlist,
        }),
      },
    ]);

    const safeResources = Array.isArray(response.resources) ? response.resources.slice(0, 3) : [];

    return send(req, res, 200, {
      mode: "recommendations",
      intro: response.intro || "Here are three high-fit options from a curated database, matched to what you shared.",
      resources: safeResources,
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
