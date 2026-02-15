// api/navigate.js - YFN Resource Navigator (Vercel serverless)
//
// Non-negotiables (per your requirements):
// - Use ONLY resources from your Google Sheet (no browsing, no invented links).
// - If the user asks "how do I..." / "how to..." / "fix..." treat it as a resource request.
// - Recommend ONLY the best matches (1 to 3). If nothing matches, say so and ask for clarification.
// - Output formatting is structured (no "**"). Frontend renders bold labels.
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 30;

const OPENAI_MODEL = "gpt-4o";

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const RESOURCE_REQUEST_KEYWORDS = [
  "resources","resource","recommend","recommendation","options","program","programs",
  "support group","support-group","group therapy","therapy","therapist","counseling","counsellor",
  "mentor","mentorship","hotline","helpline","crisis line","text line",
  "where can i get help","where do i go","who can i talk to",
  "find me","show me","give me","list",
];

// Treat “how do I / how to / fix / learn” as resource intent too
function looksLikeHowTo(message) {
  const t = normalize(message);
  return (
    t.startsWith("how do i ") ||
    t.startsWith("how to ") ||
    t.includes("how do i ") ||
    t.includes("how to ") ||
    t.includes("fix ") ||
    t.includes("repair ") ||
    t.includes("learn ") ||
    t.includes("tutorial ")
  );
}

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

function isSimpleGreeting(message) {
  const t = normalize(message);
  return t === "hey" || t === "hi" || t === "hello" || t === "yo" || t === "sup" || t === "hey there";
}

function looksLikeSmallTalk(message) {
  const t = normalize(message);
  if (isSimpleGreeting(t)) return true;
  return (
    t.includes("how are you") ||
    t.includes("hows it going") ||
    t.includes("what's up") ||
    t.includes("whats up") ||
    t.includes("good morning") ||
    t.includes("good afternoon") ||
    t.includes("good evening")
  );
}

function userExplicitlyAskedForResources(message) {
  const lower = String(message || "").toLowerCase();
  return RESOURCE_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are",
    "was","were","be","been","being","i","me","my","you","your","we","they",
    "this","that","it","a","an","about","from","by","at","as","im","i'm",
    "dont","don't","cant","can't","so","just","like","really","can","could","would",
    "please","help","need","want","get","give","show","tell","also",
    "how","do","does","did","fix","repair","learn","make"
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

function scoreResource(resource, queryTokens, contextTokens, tagTokens, urgency) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
  );

  let score = 0;

  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 5;     // current request matters most
    if (tagTokens.includes(w)) score += 6;       // model tags matter
    if (contextTokens.includes(w)) score += 2;   // prior context softer
  }

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 4;

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

function recentContextText(history, maxTurns = 8) {
  const slice = Array.isArray(history) ? history.slice(-maxTurns) : [];
  return slice
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);
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

function safeString(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try { return JSON.stringify(x); } catch { return String(x); }
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
    return send(req, res, 500, {
      error: "Missing environment variables",
      detail: "Set OPENAI_API_KEY and GOOGLE_SHEET_CSV_URL in Vercel env vars, then redeploy.",
    });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return send(req, res, 400, { error: "Missing message" });
  if (message.length > MAX_MESSAGE_LENGTH) return send(req, res, 400, { error: "Message too long" });

  const history = sanitizeHistory(req.body?.history);

  // Safety gate
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      intro: "If you’re not safe or might hurt yourself, please use one of these right now.",
      items: [
        {
          title: "Teen Line (Didi Hirsch)",
          url: "https://didihirsch.org/teenline/",
          description: "Peer support for teens, with supervised listeners.",
          why: "This is the fastest way to talk to someone immediately.",
          next_steps: "Open the link and use the call, text, or chat options.",
        },
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          description: "24/7 crisis support in the U.S. by phone or text.",
          why: "Immediate crisis support, any time.",
          next_steps: "Call or text 988, or use the website chat.",
        },
      ],
      resources: [
        { title: "Teen Line (Didi Hirsch)", url: "https://didihirsch.org/teenline/", why: "" },
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "" },
      ],
    });
  }

  const explicitResourceAsk = userExplicitlyAskedForResources(message);
  const implicitHowToAsk = looksLikeHowTo(message);
  const resourceMode = explicitResourceAsk || implicitHowToAsk;

  try {
    // Small talk stays conversational ONLY if it isn't a “how-to” ask
    if (looksLikeSmallTalk(message) && !resourceMode) {
      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are Youth Fatherless Network’s Resource Navigator.\n" +
            "You are calm, concise, and helpful.\n" +
            "Output JSON only: { \"response\": string }\n" +
            "Rules:\n" +
            "- 1 to 3 sentences.\n" +
            "- No resource links unless the user asks for resources.\n",
        },
        ...history,
        { role: "user", content: message },
      ]);

      return send(req, res, 200, { response: String(convo?.response || "Hey. What do you want help finding?").trim() });
    }

    // If not in resource mode, keep it short and steer toward describing needs
    if (!resourceMode) {
      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are Youth Fatherless Network’s Resource Navigator.\n" +
            "Your job is to guide the user toward asking for the right type of resource.\n" +
            "Do NOT provide tutorials or step-by-step instructions.\n" +
            "Do NOT list resources unless the user asks for resources.\n" +
            "Output JSON only: { \"response\": string }\n" +
            "Rules:\n" +
            "- 3 to 5 sentences.\n" +
            "- Ask ONE clarifying question about what they need.\n",
        },
        ...history,
        { role: "user", content: message },
      ]);

      return send(req, res, 200, { response: String(convo?.response || "Tell me what you’re looking for, and I can pull the best matches from the database.").trim() });
    }

    // RESOURCE MODE: ONLY from the sheet
    const resources = await loadResources(csvUrl);
    const contextText = recentContextText(history, 10);

    // Ask the model to synthesize what the user is really asking for (no advice)
    const intent = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are extracting intent for a resource-matching system.\n" +
          "Use current request + prior context.\n" +
          "Output JSON only:\n" +
          '{ "focus_summary": string, "need_tags": string[], "urgency":"low|medium|high", "search_terms": string[] }\n' +
          "Rules:\n" +
          "- focus_summary: 8 to 16 words.\n" +
          "- need_tags: choose from: practical-life, school, relationships, confidence, grief, anxiety, depression, support, mentoring, crisis.\n" +
          "- search_terms: 5 to 12 concrete keywords (no filler).\n" +
          "- Do not give advice.\n",
      },
      ...history,
      {
        role: "user",
        content: safeString({
          current_request: message,
          prior_context: contextText,
        }),
      },
    ]);

    const urgency = String(intent?.urgency || "low").toLowerCase();
    const queryTokens = tokenize([message, ...(intent?.search_terms || [])].join(" "));
    const contextTokens = tokenize(contextText);
    const tagTokens = tokenize((intent?.need_tags || []).join(" "));

    const rankedAll = resources
      .map((r) => ({ r, s: scoreResource(r, queryTokens, contextTokens, tagTokens, urgency) }))
      .sort((a, b) => b.s - a.s);

    // Remove crisis resources unless urgency is high
    let ranked = rankedAll;
    if (urgency !== "high") {
      ranked = rankedAll.filter((x) => !isCrisisResource(x.r));
      if (!ranked.length) ranked = rankedAll;
    }

    // Enforce “ONLY BEST MATCHES”, no random picks
    const MIN_SCORE = 8;
    const candidates = ranked.filter((x) => x.s >= MIN_SCORE);

    if (!candidates.length) {
      return send(req, res, 200, {
        intro:
          "I don’t have a close match for that in YFN’s database yet. " +
          "Tell me what kind of support you want (for example, relationships, confidence, grief, school, anxiety), and I’ll try again.",
        items: [],
        resources: [],
      });
    }

    const top = candidates.slice(0, 3).map((x) => x.r);

    // Create succinct, structured output for the frontend (no markdown **)
    const write = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are Youth Fatherless Network’s Resource Navigator.\n" +
          "IMPORTANT: You may ONLY use the provided resources. Do not add any other links.\n" +
          "Write succinct, specific matches.\n" +
          "Output JSON only:\n" +
          '{ "intro": string, "items": [{ "title": string, "url": string, "description": string, "why": string, "next_steps": string }] }\n' +
          "Rules:\n" +
          "- intro: 1 to 2 sentences.\n" +
          "- items: 1 to 3 items, ONLY from the provided list.\n" +
          "- Each field must be plain text, no markdown, no asterisks.\n" +
          "- description: 1 sentence.\n" +
          "- why: 1 sentence, explicitly tied to the user’s request.\n" +
          "- next_steps: 1 sentence, action-oriented.\n" +
          "- If the user asked a 'how do I / fix / learn' question: do NOT teach them how, only point to the best matching resource(s).\n",
      },
      ...history,
      {
        role: "user",
        content: safeString({
          current_request: message,
          focus_summary: intent?.focus_summary || "",
          prior_context: contextText,
          resources: top.map((r) => ({
            title: r.title,
            url: r.url,
            description: r.description,
            best_for: r.best_for,
            when_to_use: r.when_to_use,
            not_for: r.not_for,
            fatherlessness_connection: r.fatherlessness_connection,
          })),
        }),
      },
    ]);

    const items = Array.isArray(write?.items) ? write.items.slice(0, 3) : [];
    const safeItems = items
      .filter((x) => x && typeof x.title === "string" && typeof x.url === "string")
      .map((x) => ({
        title: String(x.title).trim(),
        url: String(x.url).trim(),
        description: String(x.description || "").trim(),
        why: String(x.why || "").trim(),
        next_steps: String(x.next_steps || "").trim(),
      }))
      .filter((x) => x.title && x.url);

    return send(req, res, 200, {
      intro: String(write?.intro || "Here are the closest matches from YFN’s database.").trim(),
      items: safeItems,
      // keep for backwards compatibility
      resources: safeItems.map((x) => ({ title: x.title, url: x.url, why: "" })),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    return send(req, res, 500, {
      error: "Server error",
      detail: msg.slice(0, 600),
      hint:
        msg.includes("openai_call_failed")
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, model access, and Vercel logs."
          : msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link, not the edit link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : msg.includes("openai_bad_json")
          ? "Model returned malformed JSON. Try again or lower temperature further."
          : "Check Vercel function logs for details.",
    });
  }
}
