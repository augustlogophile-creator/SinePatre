// api/navigate.js - SinePatre Resource Navigator (Vercel serverless)
//
// Goals:
// - Always respond (better error surfacing)
// - Smarter, more detailed, more resource-grounded
// - Far fewer clarifying questions
// - No generic filler intros
// - Returns paragraphs, keeps `resources` for backwards compatibility
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 30;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const RESOURCE_REQUEST_KEYWORDS = [
  "resource",
  "help",
  "recommend",
  "option",
  "program",
  "support",
  "organization",
  "where can",
  "how do i",
  "do you have",
  "know any",
  "suggest",
  "idea",
  "what would help",
  "what can",
  "show me",
  "find me",
  "who can",
  "hotline",
  "therapy",
  "mentor",
  "support group",
  "group",
  "counseling",
];

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, status, payload) {
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

function isSimpleGreeting(lower) {
  const t = normalize(lower);
  return t === "hey" || t === "hi" || t === "hello" || t === "yo" || t === "sup";
}

function isAskingForResources(message) {
  const lower = String(message || "").toLowerCase().trim();
  if (!lower) return false;
  if (isSimpleGreeting(lower)) return false;

  // Treat most real messages as resource intent.
  // If they are typing more than a greeting, the product goal is to find resources.
  if (lower.length >= 12) return true;

  return RESOURCE_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are",
    "was","were","be","been","being","i","me","my","you","your","we","they",
    "this","that","it","a","an","about","from","by","at","as","im","i'm",
    "dont","don't","cant","can't","so","just","like","really",
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

let CACHE = { at: 0, ttlMs: 2 * 60 * 1000, items: null };

async function loadResources(csvUrl) {
  const now = Date.now();
  if (CACHE.items && now - CACHE.at < CACHE.ttlMs) return CACHE.items;

  const r = await fetch(csvUrl);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`sheet_fetch_failed:${r.status}:${t.slice(0, 180)}`);
  }
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

  CACHE = { at: now, ttlMs: CACHE.ttlMs, items };
  return items;
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
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 5;

  if (urgency === "high" && isCrisisResource(resource)) score += 10;
  return score;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }))
    .slice(-MAX_HISTORY_ITEMS);
}

async function openaiJSON(apiKey, messages, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      throw new Error(`openai_call_failed:${r.status}:${raw.slice(0, 250)}`);
    }

    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai_empty");

    // The model can still output weird JSON. Protect parsing.
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`openai_bad_json:${content.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function buildHowToStart(resource) {
  const text = `${resource.when_to_use}\n${resource.description}\n${resource.best_for}`.toLowerCase();
  const steps = [];

  if (/\bcall\b/.test(text) || /\bphone\b/.test(text)) steps.push("Call");
  if (/\btext\b/.test(text) || /\bsms\b/.test(text)) steps.push("Text");
  if (/\bform\b/.test(text) || /\bregister\b/.test(text) || /\bsign up\b/.test(text)) steps.push("Form");
  if (/\bwalk[- ]?in\b/.test(text) || /\bin person\b/.test(text)) steps.push("Walk-in");
  if (/\breferral\b/.test(text) || /\bdoctor\b/.test(text)) steps.push("Referral");

  return steps.length ? steps.slice(0, 4) : ["Form", "Call"];
}

function wantsSophisticatedStyle(message) {
  const t = normalize(message);
  return (
    t.includes("more sophisticated") ||
    t.includes("be more sophisticated") ||
    t.includes("sound more sophisticated") ||
    t.includes("formal") ||
    t.includes("more mature") ||
    t.includes("more articulate")
  );
}

function safeString(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function buildResourceParagraph(resource) {
  const steps = buildHowToStart(resource).slice(0, 4).join(", ");
  const bestFor = resource.best_for ? `Best for: ${resource.best_for}` : "";
  const when = resource.when_to_use ? `When to use: ${resource.when_to_use}` : "";
  const notFor = resource.not_for ? `Not for: ${resource.not_for}` : "";
  const father = resource.fatherlessness_connection
    ? `Connection to fatherlessness: ${resource.fatherlessness_connection}`
    : "";

  // Keep this rich but strictly grounded in sheet fields.
  const detailBits = [resource.description, bestFor, when, father, notFor].filter(Boolean);

  const detailText = detailBits.join(" ").replace(/\s+/g, " ").trim();

  return (
    `${resource.title}\n` +
    `${resource.url}\n` +
    `${detailText}\n` +
    `How to start: ${steps}`
  ).trim();
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    return send(res, 405, { error: "POST only" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

  if (!apiKey || !csvUrl) {
    return send(res, 500, {
      error: "Missing environment variables",
      detail: "Set OPENAI_API_KEY and GOOGLE_SHEET_CSV_URL in Vercel env vars, then redeploy.",
    });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return send(res, 400, { error: "Missing message" });
  if (message.length > MAX_MESSAGE_LENGTH) return send(res, 400, { error: "Message too long" });

  const history = sanitizeHistory(req.body?.history);
  const sophisticated = wantsSophisticatedStyle(message);

  // Safety gate
  if (triggeredSafety(message)) {
    return send(res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Use one of these resources right now.",
      paragraphs: [
        "988 Suicide & Crisis Lifeline\nhttps://988lifeline.org\nHow to start: Call, Text",
        "Crisis Text Line\nhttps://www.crisistextline.org\nHow to start: Text",
        "Teen Line\nhttps://teenline.org\nHow to start: Text, Call",
        "Childhelp Hotline\nhttps://www.childhelp.org/hotline/\nHow to start: Call",
      ],
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "", how_to_start: ["Call", "Text"] },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "", how_to_start: ["Text"] },
        { title: "Teen Line", url: "https://teenline.org", why: "", how_to_start: ["Text", "Call"] },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "", how_to_start: ["Call"] },
      ],
    });
  }

  const askingForResources = isAskingForResources(message);

  try {
    // Light conversation mode only for greetings.
    if (!askingForResources) {
      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are SinePatre.\n" +
            "Tone: calm, measured, mature, not overly friendly.\n" +
            "Do not give medical advice. Do not lecture. Do not discuss grammar or school topics unless asked.\n" +
            "Output JSON only: { \"response\": string }\n" +
            "Rules:\n" +
            "- 2 to 4 sentences.\n" +
            "- Ask at most one question.\n",
        },
        ...history,
        { role: "user", content: message },
      ]);

      return send(res, 200, {
        mode: "conversation",
        intro: String(convo?.response || "Hey. What are you looking for support with?").trim(),
        paragraphs: [],
        resources: [],
      });
    }

    // Resource mode
    const resources = await loadResources(csvUrl);

    // Quick classification, but do not over-clarify.
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "Classify what support the user is looking for.\n" +
          "Output JSON only:\n" +
          '{ "need_tags": string[], "urgency": "low|medium|high", "needs_clarification": boolean, "clarifying_question": string|null }\n' +
          "Rules:\n" +
          "- Tags: therapy, support-group, mentor, grief, school-stress, anxiety, depression, family, identity, talk-now.\n" +
          "- Set needs_clarification=true ONLY if it is impossible to choose.\n" +
          "- If needs_clarification=true, the question must be one short sentence.\n" +
          "- Do not give advice.\n",
      },
      ...history,
      { role: "user", content: message },
    ]);

    const urgency = String(classification.urgency || "low").toLowerCase();
    const queryTokens = tokenize(message);
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

    // If nothing scores, still return top items by weak match instead of asking lots of questions.
    if (!ranked.length) {
      const fallback = resources.slice(0, 3);
      const paragraphs = fallback.map(buildResourceParagraph);

      return send(res, 200, {
        mode: "recommendations_paragraphs",
        intro:
          sophisticated
            ? "I am not seeing a tight match from the database yet, so I am sharing a few broadly relevant options. If you tell me whether you want therapy, a group, or mentorship, I can sharpen the match."
            : "I am not seeing a tight match yet, so here are a few broadly relevant options. If you say whether you want therapy, a group, or mentorship, I can narrow it down.",
        paragraphs,
        resources: fallback.map((r) => ({ title: r.title, url: r.url, why: "", how_to_start: buildHowToStart(r) })),
      });
    }

    // Only ask a clarifying question if ambiguity is real AND scores are close/weak.
    const topScore = ranked[0]?.s || 0;
    const secondScore = ranked[1]?.s || 0;
    const weak = topScore < 8;
    const close = Math.abs(topScore - secondScore) <= 2;

    if (classification.needs_clarification && weak && close && classification.clarifying_question) {
      return send(res, 200, {
        mode: "conversation",
        intro: String(classification.clarifying_question).trim(),
        paragraphs: [],
        resources: [],
      });
    }

    const limit = 3;
    const top = ranked.slice(0, limit).map((x) => x.r);

    // Build paragraphs deterministically from the sheet so you never get [object Object]
    // and you never get generic filler.
    const paragraphs = top.map(buildResourceParagraph);

    // Generate a concise, mature intro that references the request, but never lectures.
    const introGen = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "Write a concise intro for resource recommendations.\n" +
          "Tone: mature, perceptive, not overly friendly.\n" +
          "No generic educational preambles. No lists.\n" +
          "Output JSON only: { \"intro\": string }\n" +
          "Rules:\n" +
          "- 2 to 3 sentences.\n" +
          "- Do not ask a question.\n",
      },
      ...history,
      {
        role: "user",
        content: safeString({
          message,
          sophistication: sophisticated ? "high" : "normal",
          need_tags: classification.need_tags || [],
        }),
      },
    ]);

    return send(res, 200, {
      mode: "recommendations_paragraphs",
      intro: String(introGen?.intro || "Here are a few resources from the database that fit what you described.").trim(),
      paragraphs,
      resources: top.map((r) => ({ title: r.title, url: r.url, why: "", how_to_start: buildHowToStart(r) })),
    });
  } catch (err) {
    const msg = String(err?.message || err);

    return send(res, 500, {
      error: "Server error",
      detail: msg.slice(0, 600),
      hint:
        msg.includes("openai_call_failed")
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, model access, and Vercel logs."
          : msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link, not the edit link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : "Check Vercel function logs for details.",
    });
  }
}
