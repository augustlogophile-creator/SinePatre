// api/navigate.js - YFN Resource Navigator (Vercel serverless)
//
// Behavior goals:
// 1) Greetings -> polite + ask what they want (NO resources).
// 2) Specific asks -> find BEST matches from the Google Sheet (1–3).
// 3) Off-topic / no match -> gentle reminder + ask ONE clarifying question (NO guessing).
// 4) NEVER invent links. Use ONLY sheet rows.
// 5) Minimal questions. Ask only if needed.
// 6) Output format matches frontend: { mode, intro, paragraphs, resources }
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL (published CSV export link)

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 30;

const OPENAI_MODEL = "gpt-4.1";
const TEMPERATURE = 0.2;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
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
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1400) }))
    .slice(-MAX_HISTORY_ITEMS);
}

function isGreeting(messageNorm) {
  const t = messageNorm;
  if (!t) return false;
  const greetings = new Set(["hi", "hey", "hello", "yo", "sup", "hiya", "hey there"]);
  if (greetings.has(t)) return true;
  if (t.length <= 12 && (t.startsWith("hi ") || t.startsWith("hey ") || t.startsWith("hello "))) return true;
  return false;
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are","was","were","be","been","being",
    "i","me","my","you","your","we","they","this","that","it","a","an","about","from","by","at","as",
    "im","i'm","dont","don't","cant","can't","so","just","like","really","can","could","would",
    "please","help","need","want","get","give","show","tell","also","now","thanks","thank","ok","okay"
  ]);

  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

function expandIntentTokens(tokens) {
  const map = new Map([
    ["community", ["community","connection","friends","belonging","group","supportgroup","support-group","peer","peers"]],
    ["talk", ["talk","someone","listener","mentor","counselor","counselling","counseling","therapist","therapy","call","text"]],
    ["confidence", ["confidence","selfesteem","self-esteem","assertiveness","motivation"]],
    ["stress", ["stress","overwhelmed","pressure","burnout"]],
    ["anxiety", ["anxiety","panic","worry"]],
    ["grief", ["grief","loss","mourning"]],
    ["family", ["family","parents","dad","father","fatherless","fatherlessness"]],
    ["school", ["school","grades","class","teacher","bullying"]],
    ["relationships", ["relationships","dating","breakup"]],
    ["practical", ["how","howto","how-to","fix","repair","solve","tutorial","guide","steps","learn"]],
  ]);

  const out = new Set();
  for (const t of tokens) out.add(t);

  for (const t of tokens) {
    for (const [k, syns] of map.entries()) {
      if (t === k || syns.includes(t)) {
        out.add(k);
        for (const s of syns) out.add(s);
      }
    }
  }

  return [...out];
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

function resourceIsGendered(resource) {
  const t = `${resource.title} ${resource.description} ${resource.best_for}`.toLowerCase();
  return t.includes("girls") || t.includes("girl ") || t.includes("women") || t.includes("female") ||
         t.includes("boys") || t.includes("men") || t.includes("male");
}

function userIndicatedGender(messageNorm, historyNorm) {
  const t = `${messageNorm}\n${historyNorm}`.toLowerCase();
  return t.includes("i am a girl") || t.includes("i'm a girl") || t.includes("im a girl") || t.includes("female") ||
         t.includes("i am a boy") || t.includes("i'm a boy") || t.includes("im a boy") || t.includes("male");
}

function inferUrgency(messageNorm) {
  if (/\b(i want to die|kill myself|end my life|self harm|cut myself)\b/i.test(messageNorm)) return "high";
  if (/\bpanic|freaking out|urgent\b/i.test(messageNorm)) return "medium";
  return "low";
}

function scoreResource(resource, expandedTokens, allowGendered, urgency) {
  const hay = normalize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use} ${resource.not_for} ${resource.fatherlessness_connection}`
  );

  const hayTokens = new Set(tokenize(hay));
  let score = 0;

  for (const tok of expandedTokens) {
    if (hayTokens.has(tok)) score += 4;
  }

  // Prefer “talk to someone” resources when asked
  const wantsTalk = expandedTokens.includes("talk") || expandedTokens.includes("counseling") || expandedTokens.includes("therapy");
  if (wantsTalk) {
    const talkBoost = ["talk","someone","listener","mentor","therapy","therapist","counseling","counselling","peer","group","support"];
    for (const w of talkBoost) if (hayTokens.has(w)) score += 2;
  }

  // Crisis handling
  if (urgency === "high" && isCrisisResource(resource)) score += 30;
  if (urgency !== "high" && isCrisisResource(resource)) score -= 10;

  // Avoid gendered resources unless user stated gender
  if (!allowGendered && resourceIsGendered(resource)) score -= 12;

  // Small bonus for richer entries
  if ((resource.description || "").length > 40) score += 1;
  if ((resource.best_for || "").length > 20) score += 1;

  return score;
}

function stripMarkdownArtifacts(s) {
  return String(s || "").replace(/\*\*/g, "").trim();
}

function safeString(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try { return JSON.stringify(x); } catch { return String(x); }
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
        temperature: TEMPERATURE,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`openai_call_failed:${r.status}:${raw.slice(0, 250)}`);

    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai_empty");

    return JSON.parse(content);
  } finally {
    clearTimeout(t);
  }
}

function buildParagraph(resource, fields) {
  // Plain text structure that frontend will render with bold labels (frontend converts labels).
  return [
    resource.title,
    resource.url,
    `Description: ${fields.description}`,
    `Why it matches what you're looking for: ${fields.why}`,
    `Next steps: ${fields.next_steps}`,
  ].join("\n");
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
  const messageNorm = normalize(message);

  // Safety
  if (triggeredSafety(message)) {
    return send(res, 200, {
      mode: "safety",
      intro: "If you’re not safe or you might hurt yourself, please reach out right now.",
      paragraphs: [
        [
          "Teen Line (Didi Hirsch)",
          "https://didihirsch.org/teenline/",
          "Description: Peer support for teens with supervised listeners. You can call, text, or email depending on availability.",
          "Why it matches what you're looking for: This is a direct way to talk to someone right now when things feel urgent.",
          "Next steps: Open the link and choose call or text. If it’s an emergency, contact local emergency services immediately.",
        ].join("\n"),
      ],
      resources: [{ title: "Teen Line (Didi Hirsch)", url: "https://didihirsch.org/teenline/", why: "" }],
    });
  }

  // Greetings: do NOT presume resources
  if (isGreeting(messageNorm)) {
    return send(res, 200, {
      mode: "greeting",
      intro: "Hi. What are you looking for today, support, someone to talk to, confidence, school stress, grief, or something else?",
      paragraphs: [],
      resources: [],
    });
  }

  try {
    const resources = await loadResources(csvUrl);
    if (!resources.length) {
      return send(res, 200, { mode: "empty", intro: "The database is empty right now.", paragraphs: [], resources: [] });
    }

    const urgency = inferUrgency(messageNorm);
    const historyUser = history.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const historyNorm = normalize(historyUser);

    const allowGendered = userIndicatedGender(messageNorm, historyNorm);

    // Intent tokens from current message only, so we don’t “presume” based on earlier chatter.
    const baseTokens = tokenize(message);
    const expanded = expandIntentTokens(baseTokens);

    const ranked = resources
      .map((r) => ({ r, s: scoreResource(r, expanded, allowGendered, urgency) }))
      .sort((a, b) => b.s - a.s);

    const strong = ranked.filter((x) => x.s >= 10);
    const medium = ranked.filter((x) => x.s >= 6);

    // If we have strong matches, return them.
    if (strong.length) {
      const top = strong.slice(0, 3).map((x) => x.r);

      const writeups = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You write short, specific explanations for resources from a provided database.\n" +
            "Hard rules:\n" +
            "- Use ONLY the provided resource fields.\n" +
            "- Do NOT include any links or 'http' anywhere.\n" +
            "- Do NOT ask questions.\n" +
            "- No markdown.\n" +
            "Length:\n" +
            "- description: 2–3 sentences.\n" +
            "- why: 2–3 sentences.\n" +
            "- next_steps: 2–3 sentences.\n" +
            'Output JSON only: {"intro": string, "cards":[{"id":string,"description":string,"why":string,"next_steps":string}]}\n' +
            "Intro rules:\n" +
            "- 1 sentence.\n" +
            "- Must reflect the user's request.\n",
        },
        {
          role: "user",
          content: safeString({
            user_request: message,
            resources: top.map((r) => ({
              id: r.id,
              title: r.title,
              description: r.description,
              best_for: r.best_for,
              when_to_use: r.when_to_use,
              not_for: r.not_for,
              fatherlessness_connection: r.fatherlessness_connection,
            })),
          }),
        },
      ]);

      const intro = stripMarkdownArtifacts(String(writeups?.intro || "").trim()) ||
        "Here are the best matches from the database.";

      const cards = Array.isArray(writeups?.cards) ? writeups.cards : [];
      const byId = new Map(cards.map((c) => [String(c?.id || ""), c]));

      const paragraphs = top.map((r) => {
        const c = byId.get(String(r.id)) || {};
        return buildParagraph(r, {
          description: stripMarkdownArtifacts(c.description || r.description || "This resource aligns with your request based on the database."),
          why: stripMarkdownArtifacts(c.why || "It matches the keywords and intent of what you asked for."),
          next_steps: stripMarkdownArtifacts(c.next_steps || "Open the link and follow the provider’s instructions to get started."),
        });
      });

      return send(res, 200, {
        mode: "recommendations",
        intro,
        paragraphs,
        resources: top.map((r) => ({ title: r.title, url: r.url, why: "" })),
      });
    }

    // If we have medium matches and the user explicitly asked for resources, return them.
    const explicitAsk = /\b(find|give|show|list|recommend)\b/i.test(message) || /\bresources?\b/i.test(message);
    if (explicitAsk && medium.length) {
      const top = medium.slice(0, 3).map((x) => x.r);

      const intro =
        "Here are the closest matches from the database based on what you said.";

      const paragraphs = top.map((r) =>
        buildParagraph(r, {
          description: r.description ? stripMarkdownArtifacts(r.description) : "This is a database resource related to your request.",
          why: r.best_for
            ? stripMarkdownArtifacts(r.best_for)
            : "It matches the theme of what you asked for based on the database fields.",
          next_steps: r.when_to_use
            ? stripMarkdownArtifacts(r.when_to_use)
            : "Open the link, review what it offers, and choose the best fit.",
        })
      );

      return send(res, 200, {
        mode: "recommendations",
        intro,
        paragraphs,
        resources: top.map((r) => ({ title: r.title, url: r.url, why: "" })),
      });
    }

    // No match: do NOT presume. Gentle reminder + ONE question.
    return send(res, 200, {
      mode: "clarify",
      intro:
        "I can only recommend items that are in Youth Fatherless Network’s database. What type of help are you looking for, community, someone to talk to, confidence, school stress, grief, or something else?",
      paragraphs: [],
      resources: [],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    return send(res, 500, {
      error: "Server error",
      detail: msg.slice(0, 600),
      hint:
        msg.includes("sheet_fetch_failed")
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link, not the edit link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : msg.includes("openai_call_failed")
          ? "OpenAI call failed. Check OPENAI_API_KEY, billing, model access, and logs."
          : "Check function logs for details.",
    });
  }
}
