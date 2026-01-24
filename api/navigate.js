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
//   "history": [{role:"user"|"assistant", content:"..."}],
//   "filters": {
//     "tags": ["therapy","grief"],
//     "goal": "I want to talk privately",
//     "age_range": "13-15"
//   }
// }
//
// Returns:
// {
//   mode: "recommendations"|"clarify"|"safety"|"no_match",
//   intro: string,
//   question?: string,
//   resources: [{ title, url, summary, match, how_to_start }]
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

  const howToStartIdx = col("how_to_start"); // optional column

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
      how_to_start: howToStartIdx !== -1 ? (r2[howToStartIdx] || "").trim() : "",
      url: (r2[col("url")] || "").trim(),
    }))
    .filter((x) => x.id && x.title && x.url);
}

function isCrisisResource(resource) {
  const t = `${resource.title} ${resource.description} ${resource.when_to_use} ${resource.best_for}`.toLowerCase();
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
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for} ${resource.how_to_start || ""}`
  );

  let score = 0;
  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 3;
    if (tagTokens.includes(w)) score += 5;
  }

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

function normalizeFilters(filters) {
  const f = filters && typeof filters === "object" ? filters : {};
  const tags = Array.isArray(f.tags) ? f.tags.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8) : [];
  const goal = typeof f.goal === "string" ? f.goal.trim().slice(0, 80) : "";
  const age_range = typeof f.age_range === "string" ? f.age_range.trim().slice(0, 40) : "";
  return { tags, goal, age_range };
}

function isMissingCoreContext(message, filters) {
  const t = normalize(message);
  const hasMeaningfulText = t.split(" ").filter(Boolean).length >= 3;

  const hasTags = (filters.tags || []).length > 0;
  const hasGoal = Boolean(filters.goal);
  const hasAge = Boolean(filters.age_range);

  // If they typed basically nothing AND chose nothing, we need 1 clarifying question.
  if (!hasMeaningfulText && !hasTags && !hasGoal && !hasAge) return true;

  // If they typed "help" or "idk" and no tags, also clarify.
  const tooVague =
    (t === "help" || t === "idk" || t === "i dont know" || t === "i don't know" || t === "hey" || t === "hi") &&
    !hasTags &&
    !hasGoal;

  return tooVague;
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
  const filters = normalizeFilters(req.body?.filters);

  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please use one of these right now.",
      resources: [
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          summary: "24/7 call or text support in the U.S.",
          match: "If you are in danger or feel like you might hurt yourself, this is the fastest place to start. You can call or text 988 to reach trained counselors any time. If you cannot stay safe right now, call your local emergency number.",
          how_to_start: "Call or text 988. If you are in immediate danger, call 911.",
        },
        {
          title: "Crisis Text Line",
          url: "https://www.crisistextline.org",
          summary: "Text-based support with trained counselors.",
          match: "If talking out loud feels hard, text support can be easier and more private. A trained counselor can help you slow things down and make a safe plan for the next hour. This is a good option if you want to stay on your phone and not make a call.",
          how_to_start: "Use the Crisis Text Line website to start a text conversation (instructions vary by country).",
        },
        {
          title: "Teen Line",
          url: "https://teenline.org",
          summary: "Teens helping teens via text, call, or email.",
          match: "If you want someone closer to your age who gets what being a teen feels like, Teen Line can help. It can feel less intense than adult-led options while still being real support. This is a strong fit when you want to talk without being judged.",
          how_to_start: "Visit TeenLine.org and choose phone, text, or email options listed there.",
        },
      ],
    });
  }

  // One clarifying question only if needed.
  if (isMissingCoreContext(message, filters)) {
    return send(req, res, 200, {
      mode: "clarify",
      intro: "I can help, I just need one quick detail first.",
      question:
        "Which of these fits best right now: talk now, therapy, support group, mentor, grief, or school stress? If you want, add your age range too.",
      resources: [],
    });
  }

  try {
    const resources = await loadResources(csvUrl);

    // 1) Intake: map message + UI filters into need tags and urgency
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are a precise intake assistant for a curated resource navigator for fatherless teens. Output JSON only as: { need_tags: string[3-8], urgency: low|medium|high, intent: one of [explore, pick_best, compare, ask_followup], should_ask_one_question: boolean, one_question: string, notes: string }. Use the user's UI filters (tags/goal/age_range) as strong signals. Keep notes short. Do not give advice.",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          filters,
        }),
      },
    ]);

    const urgency = String(classification.urgency || "low").toLowerCase();
    const intent = String(classification.intent || "").toLowerCase();
    const shouldAsk = Boolean(classification.should_ask_one_question);
    const oneQuestion = typeof classification.one_question === "string" ? classification.one_question.trim() : "";

    // If the model thinks we should ask 1 question, do it only if the question is actually useful.
    if (shouldAsk && oneQuestion && oneQuestion.length <= 160) {
      return send(req, res, 200, {
        mode: "clarify",
        intro: "One quick question so I can match you correctly.",
        question: oneQuestion,
        resources: [],
      });
    }

    const queryTokens = tokenize(message);
    const tagTokens = tokenize([...(classification.need_tags || []), ...(filters.tags || []), filters.goal || "", filters.age_range || ""].join(" "));

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
          "I am not seeing a strong match yet. Pick a category above (therapy, mentor, grief, talk now) or add one detail about what you want next.",
        resources: [],
      });
    }

    const single = intent === "pick_best" || wantSinglePick(message);
    const limit = single ? 1 : 3;

    // Give the writer a few candidates, even if we only show 1.
    const candidates = ranked.slice(0, 5).map((x) => x.r);

    // 2) Write response grounded in curated DB
    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are the SinePatre Resource Navigator. Be warm and direct. You MUST use ONLY the provided resources and their fields. No generic therapy advice, no medical claims. Output JSON only as: { intro: string, resources: [{ title: string, url: string, summary: string, match: string, how_to_start: string }] }.\n\nRules:\n- If the user asks for the single best option, return exactly 1 resource. Otherwise return 1 to 3.\n- summary must be 1 sentence.\n- match must be exactly 3 sentences, explaining why it fits THIS teen based on their message and filters.\n- how_to_start must be concrete steps (call, text, form, walk-in, referral, website). If the resource has a how_to_start field, use it. Otherwise infer steps only from the resource fields and URL.\n- Keep intro to 1 to 2 sentences.\n- Do not mention that you used a database, CSV, or internal tools.",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          filters,
          urgency,
          intent,
          show_count: limit,
          resources: candidates,
        }),
      },
    ]);

    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit).map((r) => ({
      title: String(r.title || "").trim(),
      url: String(r.url || "").trim(),
      summary: String(r.summary || "").trim(),
      match: String(r.match || "").trim(),
      how_to_start: String(r.how_to_start || "").trim(),
    })).filter((x) => x.title && x.url);

    return send(req, res, 200, {
      mode: "recommendations",
      intro: (response.intro || "Here is what fits best based on what you shared.").trim(),
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
