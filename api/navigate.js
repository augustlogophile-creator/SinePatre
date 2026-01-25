// api/navigate.js - SinePatre Resource Navigator
// Smart, conversational AI that listens first, recommends only when asked

const MAX_MESSAGE_LENGTH = 1200;
const MAX_HISTORY_ITEMS = 20;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const RESOURCE_REQUEST_KEYWORDS = [
  "resource", "help", "recommend", "option", "program", "support", 
  "organization", "where can", "how do i", "do you have", "know any",
  "suggest", "idea", "what would help", "what can", "show me"
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

function isAskingForResources(message) {
  const lower = message.toLowerCase();
  return RESOURCE_REQUEST_KEYWORDS.some(kw => lower.includes(kw));
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
    "this","that","it","a","an","about","from","by","at","as",
  ]);

  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

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
  if (!r.ok) throw new Error("sheet_fetch_failed");
  const text = await r.text();

  const rows = parseCSV(text);
  if (!rows.length) throw new Error("sheet_empty");

  const headers = rows[0].map((h) => normalize(h).replace(/\s+/g, "_"));
  const col = (name) => headers.indexOf(name);

  const required = ["id", "title", "description", "best_for", "when_to_use", "not_for", "fatherlessness_connection", "url"];

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
  return t.includes("crisis") || t.includes("suicide") || t.includes("self-harm") || t.includes("hotline") || t.includes("988");
}

function scoreResource(resource, queryTokens, tagTokens, urgency) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use}`
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
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }))
    .slice(-MAX_HISTORY_ITEMS);
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
      temperature: 0.7,
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

  if (/\bcall\b/.test(text) || /\bphone\b/.test(text)) steps.push("Call");
  if (/\btext\b/.test(text) || /\bsms\b/.test(text)) steps.push("Text");
  if (/\bform\b/.test(text) || /\bregister\b/.test(text) || /\bsign up\b/.test(text)) steps.push("Form");
  if (/\bwalk[- ]?in\b/.test(text) || /\bin person\b/.test(text)) steps.push("Walk-in");
  if (/\breferral\b/.test(text) || /\bdoctor\b/.test(text)) steps.push("Referral");

  return steps.length ? steps.slice(0, 4) : ["Form", "Call"];
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

  // Safety gate
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please reach out right now.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "Call or text 988, 24/7 in the U.S.", how_to_start: ["Call", "Text"] },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "Text HOME to 741741 for 24/7 support.", how_to_start: ["Text"] },
        { title: "Teen Line", url: "https://teenline.org", why: "Teens helping teens by text, call, or email.", how_to_start: ["Text", "Call"] },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "Support for abuse or unsafe situations.", how_to_start: ["Call"] },
      ],
    });
  }

  // Check if user is asking for resources
  const askingForResources = isAskingForResources(message);

  try {
    // If not asking for resources, just have a conversational response
    if (!askingForResources) {
      const conversationResponse = await openaiJSON(apiKey, [
        {
          role: "system",
          content: `You are a warm, empathetic listener for fatherless teens. You are having a real conversation, not giving advice or therapy.
          
Listen deeply to what they're sharing. Ask follow-up questions to understand better. Be genuine and relatable. Only mention resources if they explicitly ask.

Output JSON only: { "response": string }

Rules:
- Keep responses conversational and natural (2-4 sentences)
- Ask one genuine follow-up question to go deeper
- Never give unsolicited advice
- Acknowledge their feelings
- Sound like a real person, not an AI`,
        },
        ...history,
        { role: "user", content: message },
      ]);

      return send(req, res, 200, {
        mode: "conversation",
        intro: conversationResponse.response || "I hear you. Tell me more.",
        resources: [],
      });
    }

    // User asked for resources, so provide them
    const resources = await loadResources(csvUrl);

    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content: "You are an expert at understanding what kind of support a teen needs. Output JSON only: { \"need_tags\": string[], \"urgency\": \"low|medium|high\", \"notes\": string }",
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

    if (!ranked.length) {
      return send(req, res, 200, {
        mode: "no_match",
        intro: "I want to help, but I need to understand your situation better. Can you tell me more about what kind of support you're looking for?",
        resources: [],
      });
    }

    const limit = 3;
    const topForWriter = ranked.slice(0, Math.max(limit, 5)).map((x) => x.r);

    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content: `You help teens find resources. You ONLY use the provided resources. Output JSON: { "intro": string, "resources": [{ "title": string, "url": string, "why": string, "how_to_start": string[] }] }

Rules:
- Return 1-3 resources
- intro: brief, warm intro (2 sentences)
- why: 2-3 sentences, grounded in the resource
- how_to_start: only Call, Text, Form, Walk-in, Referral`,
      },
      ...history,
      {
        role: "user",
        content: `User asked for help with: "${message}"\n\nResources: ${JSON.stringify(topForWriter.map(r => ({ title: r.title, url: r.url, description: r.description, best_for: r.best_for, when_to_use: r.when_to_use })))}`,
      },
    ]);

    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit).map((x) => {
      const fallbackSteps = buildHowToStart(
        topForWriter.find((r) => r.title === x.title) || topForWriter[0]
      );

      const allowed = new Set(["Call", "Text", "Form", "Walk-in", "Referral"]);
      const provided = Array.isArray(x.how_to_start) ? x.how_to_start : [];
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
      intro: String(response.intro || "Here are some options that might help.").trim(),
      resources: clipped,
    });
  } catch (err) {
    console.error("navigate_error", err);
    return send(req, res, 500, {
      error: "Something went wrong",
      detail: "Please try again in a moment.",
    });
  }
}
