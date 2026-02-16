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
const MAX_CONTEXT_CHARS = 6000;

// Model selection:
// Use a strong general model if available. If your Vercel logs show a model error,
// set OPENAI_MODEL to a model you have access to.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_CLASSIFIER_MODEL = process.env.OPENAI_CLASSIFIER_MODEL || OPENAI_MODEL;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

// These are only used as a weak backstop.
// The real intent decision is now handled by the classifier.
const OUT_OF_SCOPE_HINTS = [
  "fix a tire","change a tire","tie a tie","homework answers","math problem",
  "physics problem","chemistry","solve this equation","car repair","engine",
  "plumbing","electrician","wiring","oil change","brake pads",
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
  return (
    t === "hi" || t === "hey" || t === "hello" || t === "yo" || t === "sup" ||
    t === "hey!" || t === "hi!" || t === "hello!"
  );
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

// Strip common garbage that sometimes appears in pasted or model-injected text.
function cleanField(v) {
  let s = String(v || "");

  // Remove OpenAI style content reference artifacts.
  s = s.replace(/contentReference\s*\[[^\]]*\]/gi, "");
  s = s.replace(/\{index\s*=\s*\d+\}/gi, "");

  // Remove leftover bracketed tokens that look like tooling artifacts.
  s = s.replace(/\[(?:source|ref|citation)[^\]]*\]/gi, "");

  // Normalize whitespace.
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

// More robust scoring, still deterministic and sheet-only.
function scoreResource(resource, queryTokens, contextTokens) {
  const blob = `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use} ${resource.not_for} ${resource.fatherlessness_connection}`;
  const hay = tokenize(blob);

  let score = 0;

  // Token overlaps
  for (const w of hay) {
    if (queryTokens.includes(w)) score += 7;
    if (contextTokens.includes(w)) score += 2;
  }

  // Phrase boosts (cheap but effective)
  const q = normalize(queryTokens.join(" "));
  const titleN = normalize(resource.title);
  const bestN = normalize(resource.best_for);
  if (q && titleN.includes(q)) score += 18;
  if (q && bestN.includes(q)) score += 10;

  // Fatherlessness relevance boost
  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 5;

  // Slight preference for completeness
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

function buildFallbackCards(top, userNeed) {
  return top.map((r) => {
    const desc = r.description ? r.description : "Visit the link for details.";
    const why = r.best_for
      ? `This fits because it is meant for: ${r.best_for}.`
      : `This was selected as one of the closest matches to what you asked for.`;
    const next = r.when_to_use
      ? `Use it when: ${r.when_to_use}. Start by opening the link and following their steps to join or reach out.`
      : `Open the link, read the overview, and follow their steps to join or contact them.`;

    return {
      title: r.title,
      url: r.url,
      description: cleanField(desc),
      why: cleanField(why),
      next_steps: cleanField(next),
    };
  });
}

function clampOneLine(s, max = 220) {
  const t = cleanField(s).replace(/\n+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + "…";
}

function safeReply(text) {
  const t = clampOneLine(text, 260);
  return t || "Here are the closest matches from the database.";
}

async function classifyIntent(apiKey, message, contextText) {
  // Goal: decide whether to (a) recommend resources now, (b) ask ONE clarifying question,
  // (c) short out-of-scope redirect, or (d) brief chat response that stays on track.
  //
  // No examples lists. No long back-and-forth.
  const payload = await openaiJSON(
    apiKey,
    [
      {
        role: "system",
        content:
          "You are an intent classifier for a teen-facing support resource navigator.\n" +
          "Return JSON only.\n" +
          "Decide the best next action.\n\n" +
          "Outputs:\n" +
          "{\n" +
          '  "mode": "resource" | "clarify" | "chat" | "out_of_scope",\n' +
          '  "need": string,\n' +
          '  "clarifying_question": string,\n' +
          '  "chat_reply": string\n' +
          "}\n\n" +
          "Rules:\n" +
          "- mode=resource when the user is asking for support, coping, feelings, relationships, grief, identity, family issues, or wants resources.\n" +
          "- mode=out_of_scope when the user is asking for mechanical, homework-solving, or unrelated tasks.\n" +
          "- mode=clarify only if you truly cannot tell what kind of support they want.\n" +
          "- mode=chat when they are talking conversationally, but it could relate to support. Keep it short and on track.\n" +
          "- need must be 1 short sentence summarizing what they want.\n" +
          "- clarifying_question must be 1 short question.\n" +
          "- chat_reply must be 1 sentence, calm, and it should invite them to say what they want help with.\n" +
          "- Do not include example categories.\n"
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: message,
          recent_context: contextText
        })
      }
    ],
    { model: OPENAI_CLASSIFIER_MODEL, temperature: 0.0, timeoutMs: 18000 }
  );

  const mode = String(payload?.mode || "").trim();
  const need = cleanField(payload?.need || "");
  const clarifying = clampOneLine(payload?.clarifying_question || "", 160);
  const chatReply = clampOneLine(payload?.chat_reply || "", 220);

  const allowed = new Set(["resource", "clarify", "chat", "out_of_scope"]);
  return {
    mode: allowed.has(mode) ? mode : "resource",
    need: need || cleanField(message),
    clarifying_question: clarifying || "What kind of support do you want right now?",
    chat_reply: chatReply || "Tell me what you want help with, and I’ll pull the closest matches from the database.",
  };
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

  // Greeting: short and on-track.
  if (isGreeting(message)) {
    return send(res, 200, {
      reply: "Hi. Tell me what you want help with, and I’ll pull the closest matches from the database.",
      cards: [],
    });
  }

  try {
    // Intent classification (makes it feel smarter and prevents nonsense matches)
    const intent = await classifyIntent(apiKey, message, contextText);

    // Quick deterministic out-of-scope backstop, in case the classifier misses something obvious.
    const backupOutOfScope = looksOutOfScope(message);

    if (intent.mode === "out_of_scope" || backupOutOfScope) {
      return send(res, 200, {
        reply: "I can only recommend support resources from Youth Fatherless Network’s database. What kind of support are you looking for?",
        cards: [],
      });
    }

    if (intent.mode === "clarify") {
      return send(res, 200, {
        reply: intent.clarifying_question,
        cards: [],
      });
    }

    if (intent.mode === "chat") {
      return send(res, 200, {
        reply: intent.chat_reply,
        cards: [],
      });
    }

    // mode === "resource"
    const resources = await loadResources(csvUrl);

    const queryTokens = tokenize(message);
    const contextTokens = tokenize(contextText);

    const girlAllowed = userIndicatesGirl(message, contextText);

    // Deterministic ranking
    let ranked = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, contextTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    // If we got nothing, do ONE short question.
    if (!ranked.length) {
      return send(res, 200, {
        reply: "I’m not finding a close match in the database for that phrasing. What should the resource help you handle?",
        cards: [],
      });
    }

    // Pull a slightly bigger pool, then filter
    const pool = ranked.slice(0, 10).map((x) => x.r);

    // Filter girls-only unless user indicates
    let filtered = pool.filter((r) => (girlAllowed ? true : !looksGirlsOnly(r)));
    if (!filtered.length) filtered = pool;

    // Avoid crisis items unless the match is very strong or user message suggests urgency.
    // We do this gently: only remove crisis cards if we still have good non-crisis options.
    const urgency = normalize(message + " " + contextText);
    const seemsUrgent =
      urgency.includes("right now") ||
      urgency.includes("immediate") ||
      urgency.includes("panic") ||
      urgency.includes("can't do this") ||
      urgency.includes("unsafe") ||
      urgency.includes("self harm") ||
      urgency.includes("suicide");

    let top = filtered.slice(0, 5);
    if (!seemsUrgent) {
      const nonCrisis = top.filter((r) => !isCrisisResource(r));
      if (nonCrisis.length >= 2) top = nonCrisis;
    }

    // Final top N cards
    top = top.slice(0, 3);

    if (!top.length) {
      return send(res, 200, {
        reply: "I’m not finding a close match in the database for that. What should the resource help you do?",
        cards: [],
      });
    }

    // Rewrite step: clean, UI-friendly, strictly based on provided fields
    const rewrite = await openaiJSON(
      apiKey,
      [
        {
          role: "system",
          content:
            "You write short, clear resource cards for a teen-facing support resource navigator.\n" +
            "ABSOLUTE RULES:\n" +
            "- Use ONLY the provided resource fields.\n" +
            "- Do NOT add new resources.\n" +
            "- Do NOT add new links.\n" +
            "- Do NOT use markdown.\n" +
            "- Do NOT include citations or bracketed reference tokens.\n" +
            "- Keep it calm, direct, and specific.\n\n" +
            "Output JSON only:\n" +
            '{ "reply": string, "cards": [{"title":string,"url":string,"description":string,"why":string,"next_steps":string}] }\n\n' +
            "Length rules per card:\n" +
            "- description: 1 to 2 sentences.\n" +
            "- why: 1 to 2 sentences.\n" +
            "- next_steps: 1 to 2 sentences.\n" +
            "Reply rules:\n" +
            "- 1 sentence max.\n" +
            "- Do not include a list of example topics.\n"
        },
        {
          role: "user",
          content: JSON.stringify({
            user_message: message,
            recent_context: contextText,
            need_summary: intent.need,
            resources: top
          })
        }
      ],
      { model: OPENAI_MODEL, temperature: 0.2, timeoutMs: 24000 }
    );

    const replyText = safeReply(rewrite?.reply || "Here are the closest matches from the database.");
    const cards = Array.isArray(rewrite?.cards) ? rewrite.cards : [];

    // Validate: URLs must match our chosen top list exactly.
    const allowedUrls = new Set(top.map((r) => r.url));
    const safeCards = cards
      .map((c) => ({
        title: cleanField(c?.title || ""),
        url: cleanField(c?.url || ""),
        description: cleanField(c?.description || ""),
        why: cleanField(c?.why || ""),
        next_steps: cleanField(c?.next_steps || ""),
      }))
      .filter((c) => c.url && allowedUrls.has(c.url))
      .slice(0, 3);

    if (safeCards.length) {
      return send(res, 200, { reply: replyText, cards: safeCards });
    }

    // Fallback if model output is unusable
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
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, and model access. If the model name is invalid, set OPENAI_MODEL in Vercel env vars."
          : msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : "Check Vercel function logs for details.",
    });
  }
}
