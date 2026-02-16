// api/navigate.js - YFN Resource Navigator (Vercel serverless)
//
// Guarantees:
// - ALWAYS returns 1–3 specific resources from the Google Sheet (even for "hey").
// - NEVER asks follow-up questions.
// - NEVER invents external links. URLs come ONLY from the sheet.
// - Response format matches your current frontend: { intro, paragraphs, resources }
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL (published CSV export link)

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 40;

const OPENAI_MODEL = "gpt-4.1";
const TEMPERATURE = 0.15;

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

function recentUserText(history, maxTurns = 14) {
  const slice = Array.isArray(history) ? history.slice(-maxTurns) : [];
  return slice
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n")
    .slice(0, 4500);
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

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are","was","were","be",
    "been","being","i","me","my","you","your","we","they","this","that","it","a","an","about",
    "from","by","at","as","im","i'm","dont","don't","cant","can't","so","just","like","really",
    "can","could","would","please","help","need","want","get","give","show","tell","also","now",
    "yes","yeah","ok","okay","do","it","thanks","thank","find","me","some","stuff","thing","things",
    "stop","no","nah"
  ]);

  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

function expandIntentTokens(tokens) {
  // Practical: “talk to someone” should map to support resources, not a question loop.
  const map = new Map([
    ["talk", ["talk","someone","support","listener","peer","mentor","counselor","counselling","counseling","therapy","therapist"]],
    ["support", ["support","community","peer","group","groups","help","guidance","connect","connection"]],
    ["community", ["community","peer","group","groups","belonging","local","inperson","in-person"]],
    ["confidence", ["confidence","selfesteem","self-esteem","assertiveness","motivation","courage"]],
    ["anxiety", ["anxiety","panic","worry","nervous","stress"]],
    ["stress", ["stress","overwhelmed","pressure","burnout"]],
    ["grief", ["grief","loss","mourning"]],
    ["friends", ["friends","friendship","social","lonely","loneliness"]],
    ["relationships", ["relationships","dating","breakup","family","parents"]],
    ["school", ["school","homework","grades","class","teacher","bullying"]],
    ["mentor", ["mentor","mentorship","coach","rolemodel","role-model"]],
    ["therapy", ["therapy","therapist","counseling","counselling","mentalhealth","mental-health"]],
    ["fix", ["fix","repair","howto","how-to","tutorial","guide","skills","life","life-skills"]],
  ]);

  const out = new Set(tokens.map((t) => t.replace(/[^a-z]/g, "")));
  for (const t of tokens) {
    const key = t.replace(/[^a-z]/g, "");
    if (!key) continue;

    for (const [k, syns] of map.entries()) {
      if (key === k || syns.includes(key)) {
        out.add(k);
        for (const s of syns) out.add(String(s).replace(/[^a-z]/g, ""));
      }
    }
  }
  return [...out].filter(Boolean);
}

function inferUrgency(messageNorm) {
  if (/\b(i want to die|kill myself|end my life|self harm|cut myself)\b/i.test(messageNorm)) return "high";
  if (/\bpanic|can t breathe|freaking out|urgent\b/i.test(messageNorm)) return "medium";
  return "low";
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

function scoreResource(resource, intentTokensExpanded, historyNorm, allowGendered, urgency) {
  const hayText = normalize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.when_to_use} ${resource.not_for} ${resource.fatherlessness_connection}`
  );
  const hayTokens = new Set(tokenize(hayText).map((t) => t.replace(/[^a-z]/g, "")));

  let score = 0;

  for (const tok of intentTokensExpanded) {
    const clean = String(tok).replace(/[^a-z]/g, "");
    if (clean && hayTokens.has(clean)) score += 4;
  }

  // If they want to "talk to someone", heavily prefer support/peer/mentor/therapy style entries
  const wantsTalk = intentTokensExpanded.includes("talk") || intentTokensExpanded.includes("support");
  if (wantsTalk) {
    const talkWords = ["talk","support","peer","mentor","therapy","therapist","counseling","counselling","group","listener"];
    for (const w of talkWords) {
      const c = w.replace(/[^a-z]/g, "");
      if (hayTokens.has(c)) score += 3;
    }
  }

  // Light context assist
  const ctxTokens = tokenize(historyNorm).map((t) => t.replace(/[^a-z]/g, ""));
  const ctxSet = new Set(ctxTokens);
  for (const tok of intentTokensExpanded) {
    const clean = String(tok).replace(/[^a-z]/g, "");
    if (clean && ctxSet.has(clean) && hayTokens.has(clean)) score += 1;
  }

  // Crisis handling
  if (urgency === "high" && isCrisisResource(resource)) score += 30;
  if (urgency !== "high" && isCrisisResource(resource)) score -= 10;

  // Gendered penalty unless user indicated
  if (!allowGendered && resourceIsGendered(resource)) score -= 12;

  // Small quality tie-breaks
  if ((resource.description || "").length > 30) score += 1;
  if ((resource.best_for || "").length > 20) score += 1;

  return score;
}

function stripBadFormatting(s) {
  let out = String(s || "").trim();
  out = out.replace(/\*\*/g, "");
  out = out.replace(/https?:\/\/\S+/gi, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
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

    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`openai_bad_json:${content.slice(0, 220)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function buildParagraphFromCard(resource, fields) {
  // No markdown. Your UI can’t render bold unless you switch to innerHTML.
  // This is clean and readable with line breaks.
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
  const historyUserText = recentUserText(history, 14);
  const historyNorm = normalize(historyUserText);

  // Safety gate
  if (triggeredSafety(message)) {
    return send(res, 200, {
      intro: "If you’re not safe or you might hurt yourself, please reach out right now.",
      paragraphs: [
        [
          "Teen Line (Didi Hirsch)",
          "https://didihirsch.org/teenline/",
          "Description: Peer support for teens with supervised listeners. You can call, text, or email depending on availability.",
          "Why it matches what you're looking for: This is the fastest option for talking to someone right now when things feel overwhelming or unsafe.",
          "Next steps: Open the link and choose call or text. If it’s an emergency, contact local emergency services immediately.",
        ].join("\n"),
      ],
      resources: [{ title: "Teen Line (Didi Hirsch)", url: "https://didihirsch.org/teenline/", why: "" }],
    });
  }

  try {
    const resources = await loadResources(csvUrl);
    if (!resources.length) {
      return send(res, 200, {
        intro: "I couldn’t find any usable resources in the database right now.",
        paragraphs: [],
        resources: [],
      });
    }

    const urgency = inferUrgency(messageNorm);

    // Match against message + recent user intent so “hey” doesn’t dead-end.
    const intentText = `${message}\n${historyUserText}`.trim();
    const intentTokens = tokenize(intentText);
    const expanded = expandIntentTokens(intentTokens);

    const allowGendered = userIndicatedGender(messageNorm, historyNorm);

    const ranked = resources
      .map((r) => ({
        r,
        s: scoreResource(r, expanded, historyNorm, allowGendered, urgency),
      }))
      .sort((a, b) => b.s - a.s);

    // Pick top 1–3 real matches. If nothing scores, still return 3 general non-crisis items.
    let top = ranked.filter((x) => x.s >= 8).slice(0, 3).map((x) => x.r);

    if (!top.length) {
      top = ranked
        .filter((x) => !isCrisisResource(x.r))
        .slice(0, 3)
        .map((x) => x.r);
      if (!top.length) top = ranked.slice(0, 3).map((x) => x.r);
    }

    // Generate slightly longer, specific fields for each selected resource.
    // Model is NOT allowed to output URLs or markdown.
    const writeups = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You write concise, specific blurbs for resources from a provided database.\n" +
          "Hard rules:\n" +
          "- Use ONLY the provided fields.\n" +
          "- Do NOT add external resources.\n" +
          "- Do NOT include any links or 'http' anywhere.\n" +
          "- Do NOT ask questions.\n" +
          "- No markdown (no **, no bullets).\n" +
          "Length rules:\n" +
          "- description: 2–3 sentences.\n" +
          "- why: 2–3 sentences.\n" +
          "- next_steps: 2–3 sentences.\n" +
          'Output JSON only: {"intro": string, "cards":[{"id":string,"description":string,"why":string,"next_steps":string}]}\n' +
          "Intro rules:\n" +
          "- 1–2 sentences.\n" +
          "- Must acknowledge what the user asked for.\n" +
          "- Must NOT ask for location/age.\n",
      },
      {
        role: "user",
        content: safeString({
          user_request: message,
          inferred_intent_text: intentText,
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

    const intro =
      String(writeups?.intro || "").trim() ||
      "Here are the best matches from Youth Fatherless Network’s database.";

    const draftCards = Array.isArray(writeups?.cards) ? writeups.cards : [];
    const byId = new Map(draftCards.map((c) => [String(c?.id || ""), c]));

    const paragraphs = top.map((r) => {
      const d = byId.get(String(r.id)) || {};
      const fields = {
        description: stripBadFormatting(d.description || r.description || "This is a resource from the YFN database that aligns with your request."),
        why: stripBadFormatting(d.why || "It matches the theme of what you asked for based on the database fields."),
        next_steps: stripBadFormatting(d.next_steps || "Open the link, review what it offers, and choose the closest fit for you."),
      };
      return buildParagraphFromCard(r, fields);
    });

    return send(res, 200, {
      intro,
      paragraphs,
      resources: top.map((r) => ({ title: r.title, url: r.url, why: "" })),
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
          ? "Sheet fetch failed. GOOGLE_SHEET_CSV_URL must be a published CSV export link (CSV export), not the edit link."
          : msg.includes("missing_column")
          ? "Your sheet headers do not match the required columns."
          : msg.includes("openai_bad_json")
          ? "Model returned malformed JSON. Try again or lower temperature further."
          : "Check Vercel function logs for details.",
    });
  }
}
