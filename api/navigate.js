// api/navigate.js - YFN Resource Navigator (Vercel serverless)
//
// Goals (updated):
// - Synthesize the user’s prompt and infer what they are truly asking for.
// - Stay tightly scoped. No unrelated content, no random resources.
// - In resource mode: search the sheet, pick ONLY the best 1–3 matches, and present succinctly.
// - Every recommended item must be clearly tied to the user’s ask.
// - For “how do I do X” style requests: provide resources/places to learn (links), do not teach the steps.
// - Format each recommended item as:
//
//   **Title**
//   URL
//   **Description:** ...
//   **Why it matches what you're looking for:** ...
//   **Next steps:** ...
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

// More careful: only treat as explicit “use the database” intent when user asks for help finding support/resources.
const RESOURCE_REQUEST_KEYWORDS = [
  "resources",
  "resource",
  "recommend",
  "recommendation",
  "options",
  "program",
  "programs",
  "support group",
  "support-group",
  "group therapy",
  "therapy",
  "therapist",
  "counseling",
  "counsellor",
  "mentor",
  "mentorship",
  "hotline",
  "helpline",
  "crisis line",
  "text line",
  "where can i get help",
  "where do i go",
  "who can i talk to",
  "find me",
  "show me",
  "give me",
  "list",
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

function scoreResource(resource, queryTokens, contextTokens) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
  );

  let score = 0;

  // Current ask is highest.
  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 5;
    if (contextTokens.includes(w)) score += 2;
  }

  // Gentle boost if explicitly tied to fatherlessness in sheet.
  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 3;

  return score;
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
  return slice
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, 4500);
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
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function buildCardText({ title, url, description, why, nextSteps }) {
  const lines = [];
  lines.push(`**${title}**`);
  lines.push(url);
  lines.push(`**Description:** ${String(description || "").trim()}`);
  lines.push(`**Why it matches what you're looking for:** ${String(why || "").trim()}`);
  lines.push(`**Next steps:** ${String(nextSteps || "").trim()}`);
  return lines.join("\n");
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
  const contextText = recentContextText(history, 10);

  // Safety gate
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please contact one of these right now.",
      paragraphs: [
        buildCardText({
          title: "Teen Line",
          url: "https://didihirsch.org/teenline/",
          description: "Peer support for teens, with trained listeners and supervision.",
          why: "This is for moments when you need to talk to someone soon and you want a teen-focused option.",
          nextSteps: "Open the link and use the call, text, or email options based on what feels easiest right now.",
        }),
        buildCardText({
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          description: "Free 24/7 crisis support in the U.S. by phone or text.",
          why: "Use this if you feel unsafe, overwhelmed, or at risk right now.",
          nextSteps: "Call or text 988. If you are in immediate danger, call local emergency services.",
        }),
      ],
      resources: [
        { title: "Teen Line", url: "https://didihirsch.org/teenline/", why: "" },
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "" },
      ],
    });
  }

  // Step 1: intent synthesis and scope decision (keeps the bot from being random)
  const intent = await openaiJSON(apiKey, [
    {
      role: "system",
      content:
        "You are a careful intent analyzer for Youth Fatherless Network's Resource Navigator.\n" +
        "Your job is to: (1) restate what the user is asking for, (2) infer what they likely mean, (3) decide which mode to use.\n\n" +
        "Return JSON only:\n" +
        '{ "user_goal": string, "needs_resources": boolean, "scope": "yfn_support"|"general_howto"|"unclear", "clarifying_question": string }\n\n' +
        "Rules:\n" +
        "- user_goal: 10 to 18 words, concrete.\n" +
        "- needs_resources: true if user is asking for resources, programs, options, where to go, who to talk to, or how to find something.\n" +
        "- scope:\n" +
        "  yfn_support = fatherlessness-related support, mental health, teen support, community, guidance, programs.\n" +
        "  general_howto = unrelated skill task like tying a tie, homework, cooking, etc.\n" +
        "  unclear = too vague.\n" +
        "- clarifying_question: one short question if unclear, otherwise empty string.\n" +
        "- Do not give advice.\n",
    },
    ...history,
    { role: "user", content: safeString({ message, prior_context: contextText }) },
  ]);

  const explicitResourceAsk = userExplicitlyAskedForResources(message);
  const needsResources = Boolean(intent?.needs_resources) || explicitResourceAsk;
  const scope = String(intent?.scope || "unclear");

  try {
    // If unclear, ask ONE focused question (prevents unhelpful rambling)
    if (scope === "unclear") {
      const q = String(intent?.clarifying_question || "").trim() || "What are you trying to find help with right now?";
      return send(req, res, 200, {
        mode: "clarify",
        intro: q,
        paragraphs: [],
        resources: [],
      });
    }

    // If it's a general how-to (not YFN support), do NOT teach steps. Provide places to learn.
    if (scope === "general_howto") {
      const goal = String(intent?.user_goal || "Learn how to do something.").trim();

      const out = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are Youth Fatherless Network's Resource Navigator.\n" +
            "The request is a general how-to and NOT in the YFN support database.\n" +
            "Do NOT explain steps or give a tutorial.\n" +
            "Provide 2 to 3 reliable places (links) where the user can learn.\n" +
            "Be concise.\n\n" +
            "Return JSON only:\n" +
            '{ "intro": string, "items": [ { "title": string, "url": string, "description": string, "why": string, "nextSteps": string } ] }\n' +
            "Rules:\n" +
            "- intro: 2 sentences.\n" +
            "- items: 2 or 3 items.\n" +
            "- Each description/why/nextSteps: 1 sentence each.\n" +
            "- Avoid random links. Use broadly reliable sources.\n",
        },
        { role: "user", content: safeString({ user_goal: goal, message }) },
      ]);

      const items = Array.isArray(out?.items) ? out.items.slice(0, 3) : [];
      const paragraphs = items.map((it) =>
        buildCardText({
          title: it.title,
          url: it.url,
          description: it.description,
          why: it.why,
          nextSteps: it.nextSteps,
        })
      );

      return send(req, res, 200, {
        mode: "general_howto_resources",
        intro:
          String(out?.intro || "I can’t walk you through steps here, but these resources will help you learn.").trim(),
        paragraphs,
        resources: items.map((it) => ({ title: it.title, url: it.url, why: "" })),
      });
    }

    // YFN support scope
    // If user is not asking for resources, keep it focused and ask a pinpoint follow-up (no generic speeches).
    if (!needsResources) {
      const goal = String(intent?.user_goal || "").trim();

      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are Youth Fatherless Network's Resource Navigator.\n" +
            "Be focused and helpful.\n" +
            "Do not generate math problems.\n" +
            "Do not drift to unrelated topics.\n" +
            "If the user is vague, ask ONE specific follow-up question.\n" +
            "If the user is describing a situation, reflect it in 1 sentence, then ask 1 focused question.\n" +
            "No long speeches.\n\n" +
            "Return JSON only: { \"response\": string }\n",
        },
        ...history,
        { role: "user", content: safeString({ user_goal: goal, message }) },
      ]);

      return send(req, res, 200, {
        mode: "conversation_focused",
        intro: String(convo?.response || "What kind of support or resource are you looking for right now?").trim(),
        paragraphs: [],
        resources: [],
      });
    }

    // Resource mode: load sheet and pick ONLY best matches
    const sheetItems = await loadResources(csvUrl);

    const queryTokens = tokenize(message);
    const contextTokens = tokenize(contextText);

    const rankedAll = sheetItems
      .map((r) => ({ r, s: scoreResource(r, queryTokens, contextTokens) }))
      .sort((a, b) => b.s - a.s);

    // Take a larger candidate set, then let the model choose ONLY true matches.
    const candidates = rankedAll.slice(0, 16).map((x) => x.r);

    const selection = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are Youth Fatherless Network's Resource Navigator.\n" +
          "You must select ONLY the best matching resources from the provided sheet candidates.\n" +
          "No filler, no unrelated picks.\n\n" +
          "Return JSON only:\n" +
          '{ "chosen": [ { "id": string, "title": string, "url": string, "description": string, "why": string, "nextSteps": string } ], "intro": string }\n\n' +
          "Rules:\n" +
          "- Choose 1 to 3 resources.\n" +
          "- If NONE match well, return chosen: [] and intro that asks for the missing detail.\n" +
          "- 'description' must be a rephrase of the sheet, 1 sentence.\n" +
          "- 'why' must explicitly connect to what the user asked, 1 sentence.\n" +
          "- 'nextSteps' must be practical and specific, 1 sentence.\n" +
          "- Do not invent facts. Use only candidate fields.\n" +
          "- Keep intro to 2 sentences.\n",
      },
      {
        role: "user",
        content: safeString({
          user_message: message,
          user_goal: intent?.user_goal || "",
          prior_context: contextText,
          candidates: candidates.map((r) => ({
            id: r.id,
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

    const chosen = Array.isArray(selection?.chosen) ? selection.chosen.slice(0, 3) : [];
    const intro = String(selection?.intro || "").trim();

    // If nothing matched, ask for the missing detail instead of dumping random resources.
    if (!chosen.length) {
      return send(req, res, 200, {
        mode: "no_match_clarify",
        intro:
          intro ||
          "I’m not seeing a close match in the database yet. What city/state are you in, and what kind of help are you trying to find?",
        paragraphs: [],
        resources: [],
      });
    }

    const paragraphs = chosen.map((it) =>
      buildCardText({
        title: it.title,
        url: it.url,
        description: it.description,
        why: it.why,
        nextSteps: it.nextSteps,
      })
    );

    return send(req, res, 200, {
      mode: "recommendations_structured",
      intro: intro || "Here are the closest matches from the database for what you described.",
      paragraphs,
      resources: chosen.map((it) => ({ title: it.title, url: it.url, why: it.why || "" })),
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
