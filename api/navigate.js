// api/navigate.js - Youth Fatherless Network Resource Navigator (Vercel serverless)
//
// Hard requirements:
// - Use ONLY resources from the Google Sheet (published CSV).
// - Never show unrelated resources.
// - Ask VERY few questions, only when we truly cannot match anything.
// - Do not list example categories.
// - Do not recommend girls-only resources unless user indicates girl/female/she/her.
// - Output must be clean and UI-friendly (no markdown). We return structured cards.
// - If the user message is out of scope (ex: "tie a tie"), respond conversationally,
//   infer the likely intent, then ask ONE bridging question. Do NOT show random cards.

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 30;
const MAX_CONTEXT_CHARS = 6000;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_CLASSIFIER_MODEL = process.env.OPENAI_CLASSIFIER_MODEL || OPENAI_MODEL;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const OUT_OF_SCOPE_HINTS = [
  "fix a tire","change a tire","tie a tie","how do i tie a tie","homework answers","math problem",
  "physics problem","chemistry","solve this equation","car repair","engine","plumbing","electrician",
  "wiring","oil change","brake pads","cook this recipe","install this"
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
  const t = slice.map((m) => `${m.role}: ${m.content}`).join("\n");
  return t.slice(0, MAX_CONTEXT_CHARS);
}

function isGreeting(message) {
  const t = normalize(message);
  return t === "hi" || t === "hey" || t === "hello" || t === "yo" || t === "sup" ||
         t === "hey!" || t === "hi!" || t === "hello!";
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
    "please","help","need","want","get","give","show","tell","also","no","yes",
    "thing","stuff","someone","something"
  ]);

  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Removes model/tooling junk that sometimes leaks into sheet text
function cleanField(v) {
  let s = String(v || "");
  s = s.replace(/contentReference\s*\[[^\]]*\]/gi, "");
  s = s.replace(/\{index\s*=\s*\d+\}/gi, "");
  s = s.replace(/\[(?:source|ref|citation)[^\]]*\]/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
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
      id: cleanField(r2[col("id")]),
      title: cleanField(r2[col("title")]),
      description: cleanField(r2[col("description")]),
      best_for: cleanField(r2[col("best_for")]),
      when_to_use: cleanField(r2[col("when_to_use")]),
      not_for: cleanField(r2[col("not_for")]),
      fatherlessness_connection: cleanField(r2[col("fatherlessness_connection")]),
      url: cleanField(r2[col("url")]),
    }))
    .filter((x) => x.id && x.title && x.url);

  CACHE = { at: now, ttlMs: CACHE.ttlMs, items };
  return items;
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

// Deterministic scoring (only used to create a small candidate set).
// Final inclusion is decided by a strict relevance gate.
function scoreResource(resource, queryTokens, contextTokens) {
  const blob = `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use} ${resource.not_for} ${resource.fatherlessness_connection}`;
  const hay = tokenize(blob);

  let score = 0;

  for (const w of hay) {
    if (queryTokens.includes(w)) score += 7;
    if (contextTokens.includes(w)) score += 2;
  }

  // Encourage fatherlessness relevance
  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 5;

  // Prefer clearer rows
  if (resource.when_to_use) score += 2;
  if (resource.best_for) score += 2;
  if (resource.not_for) score += 1;

  return score;
}

async function openaiJSON(apiKey, messages, { timeoutMs = 25000, model = OPENAI_MODEL, temperature = 0.2 } = {}) {
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
        model,
        temperature,
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
      throw new Error(`openai_bad_json:${String(content).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function oneLine(s, max = 240) {
  const t = cleanField(s).replace(/\n+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + "…";
}

async function classifyIntent(apiKey, message, contextText) {
  // This prevents the “random YMCA” problem by deciding: recommend vs bridge question.
  const payload = await openaiJSON(
    apiKey,
    [
      {
        role: "system",
        content:
          "You are an intent router for a teen support resource navigator.\n" +
          "Return JSON only.\n\n" +
          "Output format:\n" +
          "{\n" +
          '  "mode": "resource" | "bridge" | "chat",\n' +
          '  "need": string,\n' +
          '  "bridge_reply": string,\n' +
          '  "chat_reply": string\n' +
          "}\n\n" +
          "Rules:\n" +
          "- mode=resource only when the user is clearly asking for emotional support, guidance, coping, relationships, grief, identity, family issues, father absence, or asks for resources.\n" +
          "- mode=bridge when the user asks something out-of-scope (how-to, mechanical, homework), but you can infer a human reason behind it (confidence, school event, social pressure, independence). In bridge mode: respond conversationally and ask ONE short question to connect to support.\n" +
          "- mode=chat when the user is talking casually and you should keep it on track.\n" +
          "- No example lists.\n" +
          "- need must be one short sentence summarizing what they seem to want.\n" +
          "- bridge_reply must be 2 sentences max, and end with ONE question.\n" +
          "- chat_reply must be 1 sentence and invite them to say what they want help with.\n"
      },
      {
        role: "user",
        content: JSON.stringify({ user_message: message, recent_context: contextText })
      }
    ],
    { model: OPENAI_CLASSIFIER_MODEL, temperature: 0.0, timeoutMs: 18000 }
  );

  const mode = String(payload?.mode || "").trim();
  const allowed = new Set(["resource", "bridge", "chat"]);

  return {
    mode: allowed.has(mode) ? mode : "resource",
    need: oneLine(payload?.need || message, 200),
    bridge_reply: oneLine(payload?.bridge_reply || "That sounds like you’re trying to handle a real-life situation. What’s the part you actually want support with?", 260),
    chat_reply: oneLine(payload?.chat_reply || "Tell me what you want help with, and I’ll pull the closest matches from the database.", 220),
  };
}

async function strictSelectAndWriteCards(apiKey, message, contextText, needSummary, candidates) {
  // This is the core fix:
  // The model must EXCLUDE anything not directly relevant.
  // Returning zero cards is allowed and expected when there is no real match.
  const out = await openaiJSON(
    apiKey,
    [
      {
        role: "system",
        content:
          "You select ONLY directly relevant resources for a teen support navigator, then write clean cards.\n\n" +
          "ABSOLUTE RULES:\n" +
          "- Use ONLY the provided resources.\n" +
          "- Select a resource ONLY if it is clearly and directly relevant to the user's need.\n" +
          "- If nothing is clearly relevant, select none.\n" +
          "- Do NOT stretch meanings. Do NOT include generic 'safe space' resources unless the user asked for safety/support spaces.\n" +
          "- Do NOT add new links.\n" +
          "- Do NOT use markdown.\n" +
          "- Do NOT include citations or bracketed tokens.\n\n" +
          "Return JSON only:\n" +
          "{\n" +
          '  "reply": string,\n' +
          '  "selected_urls": string[],\n' +
          '  "cards": [{ "title": string, "url": string, "description": string, "why": string, "next_steps": string }]\n' +
          "}\n\n" +
          "Reply rules:\n" +
          "- 1 sentence max.\n" +
          "- Conversational, on task.\n\n" +
          "Card rules (only for selected ones):\n" +
          "- 1 to 2 sentences each field.\n"
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: message,
          recent_context: contextText,
          inferred_need: needSummary,
          candidates
        })
      }
    ],
    { model: OPENAI_MODEL, temperature: 0.15, timeoutMs: 24000 }
  );

  const reply = oneLine(out?.reply || "Here are the closest matches from the database.", 260);
  const selectedUrls = Array.isArray(out?.selected_urls) ? out.selected_urls.map((u) => cleanField(u)) : [];
  const cards = Array.isArray(out?.cards) ? out.cards : [];

  return { reply, selectedUrls, cards };
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

  // Safety gate
  if (triggeredSafety(message)) {
    return send(res, 200, {
      reply: "If you’re not safe right now, you deserve immediate support. Here are options you can use right now.",
      cards: [
        {
          title: "Teen Line (Didi Hirsch)",
          url: "https://didihirsch.org/teenline/",
          description: "Teen-to-teen support with trained listeners and supervision.",
          why: "This is designed for moments when you want to talk to someone soon.",
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

  if (isGreeting(message)) {
    return send(res, 200, {
      reply: "Hi. Tell me what you want help with, and I’ll pull the closest matches from the database.",
      cards: [],
    });
  }

  try {
    const intent = await classifyIntent(apiKey, message, contextText);

    // Hard out-of-scope backstop, but still respond in BRIDGE style.
    const hardOutOfScope = looksOutOfScope(message);

    if (intent.mode === "bridge" || hardOutOfScope) {
      // Key rule: NO CARDS here, unless the user actually answers with a support need later.
      return send(res, 200, {
        reply: intent.bridge_reply,
        cards: [],
      });
    }

    if (intent.mode === "chat") {
      return send(res, 200, { reply: intent.chat_reply, cards: [] });
    }

    // mode === resource
    const resources = await loadResources(csvUrl);

    const queryTokens = tokenize(message);
    const contextTokens = tokenize(contextText);
    const girlAllowed = userIndicatesGirl(message, contextText);

    let ranked = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, contextTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    // If deterministic match is weak, do not guess.
    if (!ranked.length) {
      return send(res, 200, {
        reply: "I’m not finding a close match in the database for that phrasing. What should the resource help you handle?",
        cards: [],
      });
    }

    // Candidate pool
    let pool = ranked.slice(0, 12).map((x) => x.r);

    // Filter girls-only unless user indicates
    pool = pool.filter((r) => (girlAllowed ? true : !looksGirlsOnly(r)));
    if (!pool.length) pool = ranked.slice(0, 12).map((x) => x.r);

    // STRICT relevance gate + card writing
    const { reply, selectedUrls, cards } = await strictSelectAndWriteCards(
      apiKey,
      message,
      contextText,
      intent.need,
      pool
    );

    // Validate URLs must exist in pool
    const allowedUrls = new Set(pool.map((r) => r.url));
    const finalCards = (Array.isArray(cards) ? cards : [])
      .map((c) => ({
        title: cleanField(c?.title || ""),
        url: cleanField(c?.url || ""),
        description: cleanField(c?.description || ""),
        why: cleanField(c?.why || ""),
        next_steps: cleanField(c?.next_steps || ""),
      }))
      .filter((c) => c.url && allowedUrls.has(c.url))
      .slice(0, 3);

    const finalSelected = selectedUrls.filter((u) => allowedUrls.has(u));

    // If selector picked none, do not show random cards.
    if (!finalSelected.length || !finalCards.length) {
      return send(res, 200, {
        reply: "I don’t see a clearly matching resource in the database for that. What do you want support with right now?",
        cards: [],
      });
    }

    return send(res, 200, {
      reply,
      cards: finalCards,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    return send(res, 500, {
      error: "Server error",
      detail: msg.slice(0, 600),
      hint:
        msg.includes("openai_call_failed")
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, and model access. If model name is invalid, set OPENAI_MODEL in Vercel env vars."
          : msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : "Check Vercel function logs for details.",
    });
  }
}
