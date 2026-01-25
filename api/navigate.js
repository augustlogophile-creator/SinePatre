// api/navigate.js - SinePatre Resource Navigator
// Smart, conversational AI that listens first, recommends only when asked
// Fixed: OpenAI call + better error visibility + robust JSON parsing + fetch fallback.
// Returns PARAGRAPHS (no cards).

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
  "resource", "help", "recommend", "option", "program", "support",
  "organization", "where can", "how do i", "do you have", "know any",
  "suggest", "idea", "what would help", "what can", "show me", "find me",
  "who can", "hotline", "therapy", "mentor", "support group"
];

// If `fetch` is not available (some runtimes), fall back to undici.
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

function isAskingForResources(message) {
  const lower = String(message || "").toLowerCase();
  return RESOURCE_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
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
    throw new Error(`sheet_fetch_failed:${r.status}:${t.slice(0, 220)}`);
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
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use}`
  );

  let score = 0;
  for (const w of haystack) {
    if (queryTokens.includes(w)) score += 3;
    if (tagTokens.includes(w)) score += 5;
  }

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 6;

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

function isSimpleGreeting(message) {
  const t = normalize(message);
  return t === "hey" || t === "hi" || t === "hello" || t === "yo" || t === "sup";
}

// Extract text from Responses API result robustly
function extractResponsesText(j) {
  if (typeof j?.output_text === "string" && j.output_text.trim()) return j.output_text;

  const out = Array.isArray(j?.output) ? j.output : [];
  const chunks = [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c && typeof c.text === "string") chunks.push(c.text);
      if (c && typeof c?.text?.value === "string") chunks.push(c.text.value);
    }
  }
  return chunks.join("\n").trim();
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false, value: null };
  }
}

// OpenAI call: uses Responses API JSON mode, with a fallback to Chat Completions JSON mode.
async function openaiJSON(apiKey, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Primary: Responses API (recommended)
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: messages,
        // JSON mode (not schema), fast + strict JSON
        text: { format: { type: "json_object" } },
        temperature: 0.45,
      }),
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      // Fall through to fallback (some accounts/projects disable /responses)
      throw new Error(`openai_responses_failed:${r.status}:${raw.slice(0, 260)}`);
    }

    const j = raw ? JSON.parse(raw) : null;
    const txt = extractResponsesText(j);
    if (!txt) throw new Error("openai_empty");

    const parsed = safeJsonParse(txt);
    if (!parsed.ok) {
      // Sometimes models wrap JSON in text. Try to salvage the first {...} block.
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const maybe = txt.slice(start, end + 1);
        const parsed2 = safeJsonParse(maybe);
        if (parsed2.ok) return parsed2.value;
      }
      throw new Error(`openai_bad_json:${txt.slice(0, 260)}`);
    }

    return parsed.value;
  } catch (e) {
    // Fallback: Chat Completions JSON mode
    const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.45,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    const raw2 = await r2.text().catch(() => "");
    if (!r2.ok) {
      throw new Error(`openai_call_failed:${r2.status}:${raw2.slice(0, 260)}`);
    }

    const j2 = raw2 ? JSON.parse(raw2) : null;
    const content = j2?.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai_empty");

    const parsed = safeJsonParse(content);
    if (!parsed.ok) throw new Error(`openai_bad_json:${String(content).slice(0, 260)}`);
    return parsed.value;
  } finally {
    clearTimeout(timeout);
  }
}

async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    return send(req, res, 405, { error: "POST only" });
  }

  // Accept a couple common env var names to prevent silent misconfig.
  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI_API_TOKEN;

  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

  if (!apiKey || !csvUrl) {
    return send(req, res, 500, {
      error: "Missing environment variables",
      detail: !apiKey ? "OPENAI_API_KEY missing" : "GOOGLE_SHEET_CSV_URL missing",
    });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return send(req, res, 400, { error: "Missing message" });
  if (message.length > MAX_MESSAGE_LENGTH) return send(req, res, 400, { error: "Message too long" });

  const history = sanitizeHistory(req.body?.history);
  const sophisticated = wantsSophisticatedStyle(message);

  // Safety gate
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "I am really glad you reached out. You deserve immediate support, please use one of these right now.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org", why: "Call or text 988, 24/7 in the U.S.", how_to_start: ["Call", "Text"] },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org", why: "Text HOME to 741741 for 24/7 support.", how_to_start: ["Text"] },
        { title: "Teen Line", url: "https://teenline.org", why: "Teens helping teens by text, call, or email.", how_to_start: ["Text", "Call"] },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/", why: "Support for abuse or unsafe situations.", how_to_start: ["Call"] },
      ],
    });
  }

  const askingForResources = isAskingForResources(message);

  try {
    // Conversation mode
    if (!askingForResources) {
      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are SinePatre, a socially astute, warm, teen-friendly conversational partner.\n\n" +
            "Goal: build trust and understand what is going on before recommending anything.\n" +
            "Do not give therapy or medical advice. Do not mention external resources unless the user explicitly asks.\n\n" +
            "Style rules:\n" +
            "- If the user only says a greeting, respond with a brief greeting back and one gentle question.\n" +
            "- Otherwise respond in 1 short paragraph (2 to 5 sentences).\n" +
            "- Ask at most one question.\n" +
            "- Be specific, reflect one detail from what they said.\n" +
            "- If the user asks you to be more sophisticated, sound more mature and articulate while staying warm.\n\n" +
            'Output JSON only: { "response": string }',
        },
        ...history,
        { role: "user", content: message },
      ]);

      const responseText =
        (isSimpleGreeting(message) && !convo?.response)
          ? "Hey. What is going on today?"
          : (String(convo?.response || "Hey. What is going on?").trim());

      return send(req, res, 200, {
        mode: "conversation",
        intro: responseText,
        resources: [],
      });
    }

    // Resource mode
    const resources = await loadResources(csvUrl);

    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You identify what kind of support a teen is asking for. Output JSON only:\n" +
          '{ "need_tags": string[], "urgency": "low|medium|high", "needs_clarification": boolean, "clarifying_question": string|null }\n\n' +
          "Rules:\n" +
          "- Use short tags like: therapy, support-group, mentor, grief, school-stress, anxiety, depression, family, identity, talk-now.\n" +
          "- If multiple different needs are present and you cannot choose, set needs_clarification=true and ask ONE clarifying question.\n" +
          "- Do not give advice.",
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
        intro: sophisticated
          ? "I can absolutely help, but I need one detail to narrow the match. Are you looking for someone to talk to soon, a support group, therapy, or mentorship?"
          : "I can help, but I need one detail. Are you looking for someone to talk to soon, a support group, therapy, or a mentor?",
        resources: [],
      });
    }

    // If clarification needed, ask first (no resources yet)
    if (classification.needs_clarification && classification.clarifying_question) {
      return send(req, res, 200, {
        mode: "conversation",
        intro: String(classification.clarifying_question).trim(),
        resources: [],
      });
    }

    const limit = 3;
    const top = ranked.slice(0, Math.max(limit, 5)).map((x) => x.r);

    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are SinePatre, socially astute and direct. The user asked for resources.\n\n" +
          "You MUST use ONLY the provided resources and their fields. Do not invent details.\n" +
          "Write in paragraphs, not a list of cards.\n\n" +
          "Output JSON only: { \"intro\": string, \"paragraphs\": string[] }\n\n" +
          "Rules:\n" +
          "- intro: 1 short paragraph (2 to 4 sentences), conversational and specific.\n" +
          "- paragraphs: 1 to 3 paragraphs total, one per resource.\n" +
          "- Each resource paragraph must include:\n" +
          "  (a) the resource name,\n" +
          "  (b) the URL in plain text,\n" +
          "  (c) why it fits (2 to 3 sentences) grounded in best_for/when_to_use/description/fatherlessness_connection,\n" +
          "  (d) a 'How to start:' line using only Call, Text, Form, Walk-in, Referral (2 to 4 items).\n" +
          "- Be warm, and a little more sophisticated if the user requested that.\n" +
          "- Do not add time pressure language.\n",
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          sophistication: sophisticated ? "high" : "normal",
          urgency,
          need_tags: classification.need_tags || [],
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

    const paras = Array.isArray(response.paragraphs) ? response.paragraphs : [];
    const clippedParas = paras.slice(0, limit);

    // Keep resources array for compatibility (UI can ignore it)
    const outResources = top.slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      why: "",
      how_to_start: buildHowToStart(r),
    }));

    return send(req, res, 200, {
      mode: "recommendations_paragraphs",
      intro: String(response.intro || "Here are a few options that fit what you asked for.").trim(),
      paragraphs: clippedParas,
      resources: outResources,
    });
  } catch (err) {
    // IMPORTANT: send back a useful detail so you can see the real reason in your browser console/network tab.
    const msg = String(err?.message || err);
    return send(req, res, 500, {
      error: "Server error",
      detail: msg.slice(0, 500),
    });
  }
}

// Export for both Next.js (export default) and Vercel Functions (module.exports)
export default handler;
module.exports = handler;
