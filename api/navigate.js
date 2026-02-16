// api/navigate.js - Youth Fatherless Network Resource Navigator (Vercel serverless)
//
// Hard requirements:
// - Use ONLY resources from the Google Sheet (published CSV).
// - Always attempt to return specific matching resources when the user asks, or when intent is clear.
// - Ask VERY few questions, only when we truly cannot match anything.
// - Do not list example categories like "school stress, anxiety...".
// - Do not recommend girls-only resources unless user indicates girl/female/she/her.
// - Output must be clean and UI-friendly (no markdown **). We return structured cards.
// - If the user message is out of scope (ex: "fix a tire"), do a short redirect and ask what support they want.

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 30;

// Use a stronger reasoning model if available on your account.
// If this model name errors in your logs, switch back to "gpt-4o".
const OPENAI_MODEL = "gpt-4.1";

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const RESOURCE_INTENT_KEYWORDS = [
  "resource","resources","recommend","recommendation","options","program","programs",
  "support","support group","community","mentor","mentorship","hotline","helpline",
  "talk to someone","someone to talk to","counsel","counseling","therapist","therapy",
  "find me","show me","give me","list","help me find",
  "confidence","grief","lonely","friends","friendship","dad","father","fatherless",
  "stress","sad","depressed","anxious","panic","overwhelmed","breakup","relationship",
];

const OUT_OF_SCOPE_HINTS = [
  "fix a tire","change a tire","tie a tie","homework answers","math problem",
  "physics problem","chemistry","solve this equation",
];

async function ensureFetch() {
  if (typeof globalThis.fetch === "function") return;
  const undici = await import("undici");
  globalThis.fetch = undici.fetch;
}
void ensureFetch();

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

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }))
    .slice(-MAX_HISTORY_ITEMS);
}

function recentContextText(history, maxTurns = 10) {
  const slice = Array.isArray(history) ? history.slice(-maxTurns) : [];
  return slice.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 5000);
}

function isGreeting(message) {
  const t = normalize(message);
  return (
    t === "hi" || t === "hey" || t === "hello" || t === "yo" || t === "sup" ||
    t === "hey!" || t === "hi!" || t === "hello!"
  );
}

function hasResourceIntent(message, contextText) {
  const t = normalize(message + " " + (contextText || ""));
  return RESOURCE_INTENT_KEYWORDS.some((kw) => t.includes(kw));
}

function looksOutOfScope(message) {
  const t = normalize(message);
  return OUT_OF_SCOPE_HINTS.some((kw) => t.includes(kw));
}

function userIndicatesGirl(message, contextText) {
  const t = normalize(message + " " + (contextText || ""));
  return (
    t.includes("i am a girl") ||
    t.includes("im a girl") ||
    t.includes("i'm a girl") ||
    t.includes("female") ||
    t.includes("she/her") ||
    t.includes("as a girl") ||
    t.includes("as a female")
  );
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are",
    "was","were","be","been","being","i","me","my","you","your","we","they",
    "this","that","it","a","an","about","from","by","at","as","im","i'm",
    "dont","don't","cant","can't","so","just","like","really","can","could","would",
    "please","help","need","want","get","give","show","tell","also","no","yes"
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

  const required = ["id","title","description","best_for","when_to_use","not_for","fatherlessness_connection","url"];
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
  const t = `${resource.title} ${resource.description} ${resource.when_to_use} ${resource.best_for}`.toLowerCase();
  return (
    t.includes("crisis") ||
    t.includes("suicide") ||
    t.includes("self-harm") ||
    t.includes("hotline") ||
    t.includes("988")
  );
}

function looksGirlsOnly(resource) {
  const t = `${resource.title} ${resource.description} ${resource.best_for}`.toLowerCase();
  return (
    t.includes("girls only") ||
    t.includes("for girls") ||
    t.includes("girls in") ||
    t.includes("young girls") ||
    t.includes("girl up") ||
    t.includes("girls on the run")
  );
}

// Scoring: deterministic, sheet-only
function scoreResource(resource, queryTokens, contextTokens) {
  const hay = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use} ${resource.not_for} ${resource.fatherlessness_connection}`
  );

  let score = 0;

  for (const w of hay) {
    if (queryTokens.includes(w)) score += 6;        // strong weight for current request
    if (contextTokens.includes(w)) score += 2;      // lighter weight for recent context
  }

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 4;

  // slight preference for clear fit info
  if (resource.when_to_use) score += 1;
  if (resource.best_for) score += 1;

  return score;
}

async function openaiJSON(apiKey, messages, { timeoutMs = 25000 } = {}) {
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
        model: OPENAI_MODEL,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`openai_call_failed:${r.status}:${raw.slice(0, 250)}`);

    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai_empty");

    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`openai_bad_json:${content.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function buildFallbackCards(top, userNeed) {
  // No markdown. Plain strings that UI will bold labels for.
  return top.map((r) => {
    const desc = r.description ? r.description : "Visit the link for details.";
    const why = r.best_for
      ? `This fits because it is meant for: ${r.best_for}.`
      : `This was selected as one of the closest matches to: ${userNeed}.`;
    const next = r.when_to_use
      ? `Use it when: ${r.when_to_use}. Start by opening the link and checking how to join or contact them.`
      : `Open the link, read the overview, and follow their steps to join or reach out.`;

    return {
      title: r.title,
      url: r.url,
      description: desc,
      why,
      next_steps: next,
    };
  });
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
  const contextText = recentContextText(history, 10);

  // Safety gate (still returns specific links, but this is a special mode)
  if (triggeredSafety(message)) {
    return send(res, 200, {
      reply: "If you’re not safe right now, you deserve immediate support. Here are options you can use right now.",
      cards: [
        {
          title: "Teen Line (Didi Hirsch)",
          url: "https://didihirsch.org/teenline/",
          description: "Teen-to-teen support with trained listeners and supervision.",
          why: "This is designed for moments when you need to talk to someone soon.",
          next_steps: "Open the link and use the phone, text, or email options shown there.",
        },
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          description: "24/7 support in the U.S. by call, text, or chat.",
          why: "This is for urgent emotional distress or feeling unsafe.",
          next_steps: "Call or text 988, or use the chat option on their site.",
        },
        {
          title: "Crisis Text Line",
          url: "https://www.crisistextline.org",
          description: "24/7 crisis support by text message.",
          why: "This is a fast option if you prefer texting over calling.",
          next_steps: "Open the site and follow their instructions to start a text conversation.",
        },
      ],
    });
  }

  // Greeting: 1 short reply, no examples list, no repeated prompt.
  if (isGreeting(message)) {
    return send(res, 200, {
      reply: "Hi. Tell me what you’re looking for, and I’ll pull the best matches from the database.",
      cards: [],
    });
  }

  // If clearly out of scope (mechanical/how-to) and your sheet is support-focused, redirect briefly.
  // We do NOT pretend we have tire resources unless your sheet actually contains them.
  if (looksOutOfScope(message) && !hasResourceIntent(message, contextText)) {
    return send(res, 200, {
      reply: "I can only recommend items that are in Youth Fatherless Network’s database. If you tell me what kind of support you want, I’ll pull the closest matches.",
      cards: [],
    });
  }

  // Always attempt to recommend resources when:
  // - user asks for resources/support, OR
  // - the intent is obvious from the message/context (talk to someone, community support, confidence, etc)
  const shouldRecommend = hasResourceIntent(message, contextText);

  // If not recommending, keep it short and on-track, then invite a clear ask.
  if (!shouldRecommend) {
    return send(res, 200, {
      reply: "I can help you find resources from the database. Tell me what you want help with, and I’ll pull the closest matches.",
      cards: [],
    });
  }

  try {
    const resources = await loadResources(csvUrl);

    const queryTokens = tokenize(message);
    const contextTokens = tokenize(contextText);

    const girlAllowed = userIndicatesGirl(message, contextText);

    // Rank deterministically using sheet content only
    let ranked = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, contextTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    // If not high urgency, avoid crisis items unless they match strongly
    // (We do not have an “urgency classifier” anymore because it caused stalling.)
    const topPre = ranked.slice(0, 8).map((x) => x.r);

    // Filter girls-only unless user indicates
    let filtered = topPre.filter((r) => (girlAllowed ? true : !looksGirlsOnly(r)));

    // If filtering removed everything, allow them (better than returning nothing)
    if (!filtered.length) filtered = topPre;

    // Final top N
    const top = filtered.slice(0, 3);

    // If we still have no matches, do a short redirect and ask ONE question.
    if (!top.length) {
      return send(res, 200, {
        reply: "I’m not finding a close match in the database for that phrasing. What should the resource help you do or handle?",
        cards: [],
      });
    }

    // Ask the model to write clean, slightly longer fields, but strictly from provided fields.
    // Also, we validate URLs afterward and fall back if it invents anything.
    const rewrite = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You write short, clear resource cards for a teen-facing resource navigator.\n" +
          "ABSOLUTE RULES:\n" +
          "- Use ONLY the provided resource fields.\n" +
          "- Do NOT add new resources.\n" +
          "- Do NOT add new links.\n" +
          "- Do NOT use markdown.\n" +
          "- Keep it readable and specific.\n" +
          "Output JSON only: { \"reply\": string, \"cards\": [{\"title\":string,\"url\":string,\"description\":string,\"why\":string,\"next_steps\":string}] }\n" +
          "Length rules per card:\n" +
          "- description: 2 to 3 sentences.\n" +
          "- why: 2 to 3 sentences.\n" +
          "- next_steps: 2 sentences.\n" +
          "Reply rules:\n" +
          "- 1 sentence max.\n" +
          "- No examples list.\n"
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: message,
          recent_context: contextText,
          resources: top
        })
      }
    ]);

    const replyText = String(rewrite?.reply || "Here are the closest matches from the database.").trim();
    const cards = Array.isArray(rewrite?.cards) ? rewrite.cards : [];

    // Validate: ensure URLs are exactly from our top list
    const allowedUrls = new Set(top.map((r) => r.url));
    const safeCards = cards
      .filter((c) => c && typeof c.url === "string" && allowedUrls.has(c.url))
      .slice(0, 3);

    if (safeCards.length) {
      return send(res, 200, { reply: replyText, cards: safeCards });
    }

    // Fallback if model output was bad or invented stuff
    return send(res, 200, {
      reply: "Here are the closest matches from the database.",
      cards: buildFallbackCards(top, message),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    return send(res, 500, {
      error: "Server error",
      detail: msg.slice(0, 600),
      hint:
        msg.includes("openai_call_failed")
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, and model access."
          : msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : "Check Vercel function logs for details.",
    });
  }
}
