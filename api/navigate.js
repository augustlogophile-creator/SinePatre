// api/navigate.js
// SinePatre Resource Navigator API (Vercel serverless)
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)
//
// POST JSON:
// {
//   "message": "...",
//   "history": [{ role:"user"|"assistant", content:"..." }],
//   "selected_tags": ["talk now","therapy", ...],
//   "goal": "I want to talk privately" | "I want community" | "I want a mentor" | "I want help coping" | "I want to explore options",
//   "age_range": "13-15" | "16-18" | "" | etc
// }
//
// Returns:
// {
//   mode: "safety" | "clarify" | "recommendations" | "no_match",
//   intro: string,
//   question?: string,
//   resources: [{ title, url, why, how_to_start?: string[] }]
// }

const MAX_MESSAGE_LENGTH = 800;
const MAX_HISTORY_ITEMS = 12;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life)\b/i,
  /\b(self[- ]?harm|cut myself|cutting)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home)\b/i,
  /\b(abuse|sexual assault|rape|molested)\b/i,
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
    "the",
    "and",
    "or",
    "but",
    "if",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "i",
    "me",
    "my",
    "you",
    "your",
    "we",
    "they",
    "this",
    "that",
    "it",
    "im",
    "i'm",
    "dont",
    "don't",
    "cant",
    "can't",
    "want",
    "need",
    "help",
    "please",
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

  // Optional column support (won't break if not present)
  const howToStartCol = col("how_to_start");

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
      how_to_start: howToStartCol !== -1 ? (r2[howToStartCol] || "").trim() : "",
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

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const trimmed = history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 800),
    }));
  return trimmed.slice(-MAX_HISTORY_ITEMS);
}

function normalizeTagList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function deriveHowToStart(resource) {
  // Prefer explicit sheet column if present
  const raw = String(resource.how_to_start || "").trim();
  if (raw) {
    return raw
      .split(/[,;|]/g)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 5);
  }

  // Otherwise infer from text (always from this fixed set)
  const text = `${resource.title} ${resource.description} ${resource.when_to_use} ${resource.best_for}`.toLowerCase();
  const steps = [];
  const add = (s) => {
    if (!steps.includes(s)) steps.push(s);
  };

  // Look for hints, but always output from allowed set:
  // call, text, form, walk-in, referral
  if (/\btext\b|\bsms\b|\bchat\b/.test(text)) add("text");
  if (/\bcall\b|\bphone\b|\bhotline\b/.test(text)) add("call");
  if (/\bapply\b|\bapplication\b|\bintake form\b|\bform\b|\bsign up\b/.test(text))
    add("form");
  if (/\bwalk[- ]?in\b|\bin person\b|\bclinic\b/.test(text)) add("walk-in");
  if (/\breferral\b|\breferred\b|\bparent\b|\bschool counselor\b/.test(text))
    add("referral");

  // If still empty, default to "form" (most universal for links)
  if (!steps.length) steps.push("form");

  return steps.slice(0, 5);
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

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (
    fatherText.includes("father") ||
    fatherText.includes("dad") ||
    fatherText.includes("fatherless")
  ) {
    score += 4;
  }

  return score;
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
  if (message.length > MAX_MESSAGE_LENGTH) {
    return send(req, res, 400, { error: "Message too long" });
  }

  const history = sanitizeHistory(req.body?.history);
  const selectedTags = normalizeTagList(req.body?.selected_tags);
  const goal = String(req.body?.goal || "").trim().slice(0, 80);
  const ageRange = String(req.body?.age_range || "").trim().slice(0, 40);

  const combinedUserText = [
    message,
    selectedTags.length ? `Selected topics: ${selectedTags.join(", ")}.` : "",
    goal ? `Goal: ${goal}.` : "",
    ageRange ? `Age range: ${ageRange}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Hard safety gate: skip AI, return crisis resources only
  if (triggeredSafety(combinedUserText)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support right now. Please use one of these options.",
      resources: [
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          why: "Available 24/7 in the U.S. You can call or text 988 to reach trained counselors who can help in the moment. If you are in immediate danger, call local emergency services.",
          how_to_start: ["call", "text"],
        },
        {
          title: "Crisis Text Line",
          url: "https://www.crisistextline.org",
          why: "Text-based support with trained counselors. This is helpful if speaking out loud feels hard. The site explains the exact steps to start.",
          how_to_start: ["text", "form"],
        },
        {
          title: "Teen Line",
          url: "https://teenline.org",
          why: "A teen-to-teen support option that can feel less intimidating. You can reach out by phone or text depending on availability. Use the website to see current hours and steps.",
          how_to_start: ["call", "text"],
        },
        {
          title: "Childhelp Hotline",
          url: "https://www.childhelp.org/hotline/",
          why: "Support if you are unsafe at home or dealing with abuse. The website lists ways to connect right away. You can also ask about next steps and referrals.",
          how_to_start: ["call", "text", "referral"],
        },
      ],
    });
  }

  // If they gave zero message but did pick filters, we still proceed.
  if (!combinedUserText) {
    return send(req, res, 400, { error: "Missing message or selections" });
  }

  try {
    const resources = await loadResources(csvUrl);

    // 1) Classify need and whether a single clarifying question is needed
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          'You are a precise intake assistant for a curated resource navigator for fatherless teens. Output JSON only with this exact schema: {"need_tags": string[], "urgency": "low"|"medium"|"high", "intent": "explore"|"pick_best"|"compare"|"ask_followup", "needs_clarifying_question": boolean, "clarifying_question": string, "notes": string}. Rules: need_tags must be 3-6 short tags. Only ask a clarifying question if the user message is too vague to match. If asking, write ONE short question. notes must be under 20 words. Do not give advice.',
      },
      ...history,
      { role: "user", content: combinedUserText },
    ]);

    const urgency = String(classification.urgency || "low").toLowerCase();
    const intent = String(classification.intent || "explore").toLowerCase();

    if (classification.needs_clarifying_question) {
      const q = String(classification.clarifying_question || "").trim();
      if (q) {
        return send(req, res, 200, {
          mode: "clarify",
          intro: "One quick question so I can match you well.",
          question: q,
          resources: [],
        });
      }
    }

    const queryTokens = tokenize(combinedUserText);
    const aiTagTokens = tokenize((classification.need_tags || []).join(" "));
    const selectedTagTokens = tokenize(selectedTags.join(" "));
    const goalTokens = tokenize(goal);
    const tagTokens = [...new Set([...aiTagTokens, ...selectedTagTokens, ...goalTokens])];

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
        intro:
          "I am not seeing a strong match yet. Pick a topic above or add one detail (talk now, grief, school stress, therapy, mentor, support group).",
        resources: [],
      });
    }

    // 2) Decide how many to show: 1–3 only
    const limit = intent === "pick_best" || wantSinglePick(combinedUserText) ? 1 : 3;
    const top = ranked.slice(0, 6).map((x) => ({
      ...x.r,
      how_to_start_steps: deriveHowToStart(x.r),
    }));

    // 3) Write final response, short and specific, and include How to start steps
    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          'You are the SinePatre Resource Navigator. You MUST use ONLY the provided resources and their fields. Output JSON only: {"intro": string, "resources": [{"title": string, "url": string, "why": string, "how_to_start": string[]}]}.\nRules:\n- Return 1-3 resources only, matching show_count.\n- Each why must be exactly 3 sentences.\n- why must explain the match (based on the user message, selected topics, goal, and the resource fields) and avoid generic therapy advice.\n- Include practical next steps, and include the How to start steps as a short list in how_to_start using only: ["call","text","form","walk-in","referral"].\n- If show_count is 1, return exactly 1.\n- Keep intro to 1-2 sentences.\n',
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message: message || "",
          selected_tags: selectedTags,
          goal,
          age_range: ageRange,
          urgency,
          intent,
          show_count: limit,
          resources: top,
        }),
      },
    ]);

    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit).map((r) => ({
      title: String(r.title || "").trim(),
      url: String(r.url || "").trim(),
      why: String(r.why || "").trim(),
      how_to_start: Array.isArray(r.how_to_start)
        ? r.how_to_start
            .map((s) => String(s || "").trim().toLowerCase())
            .filter((s) => ["call", "text", "form", "walk-in", "referral"].includes(s))
            .slice(0, 5)
        : [],
    }));

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
        detail:
          "Your API key has no available quota. Confirm billing is enabled and you have remaining credits.",
      });
    }

    return send(req, res, 500, {
      error: "Server error",
      detail: msg,
    });
  }
}
