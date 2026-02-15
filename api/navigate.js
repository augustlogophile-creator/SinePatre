// api/navigate.js - YFN Resource Navigator (Vercel serverless)
//
// Key rules now enforced:
// - Uses ONLY resources from the Google Sheet CSV (never external links).
// - Always tries to interpret the user's request as a request for resources.
// - Picks ONLY the best 1–3 matches (or none if no match).
// - Avoids gender-specific resources unless the user indicates it.
// - Returns structured fields, and the frontend renders real <strong> bold (no **markdown**).
//
// Env vars required:
// - OPENAI_API_KEY
// - GOOGLE_SHEET_CSV_URL  (published CSV export link)

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 24;

// Keep a strong general model name that is likely to exist in most accounts.
// If your project has access to a newer model, you can swap it here.
const OPENAI_MODEL = "gpt-4o";

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
];

const RESOURCE_INTENT_HINTS = [
  "resources","resource","recommend","recommendation","options","program","programs",
  "support group","therapy","therapist","counseling","mentor","mentorship","hotline","helpline",
  "where can i get help","where do i go","who can i talk to","find me","show me","give me","list",
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

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }))
    .slice(-MAX_HISTORY_ITEMS);
}

function recentContextText(history, maxTurns = 8) {
  const slice = Array.isArray(history) ? history.slice(-maxTurns) : [];
  return slice.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 3600);
}

function safeString(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try { return JSON.stringify(x); } catch { return String(x); }
}

function userSignalsGirl(message, context) {
  const t = ` ${normalize(message)} ${normalize(context)} `;
  return (
    t.includes(" i am a girl ") ||
    t.includes(" i'm a girl ") ||
    t.includes(" im a girl ") ||
    t.includes(" as a girl ") ||
    t.includes(" teen girl ") ||
    t.includes(" female ") ||
    t.includes(" she/her ") ||
    t.includes(" my daughter ")
  );
}

function isGenderSpecificResource(resource) {
  const t = `${resource.title} ${resource.description} ${resource.best_for}`.toLowerCase();
  return (
    /\bgirls\b/.test(t) ||
    /\bgirl\b/.test(t) ||
    /\bwomen\b/.test(t) ||
    /\bfemale\b/.test(t)
  );
}

function interpretAsResourceSearch(message) {
  const t = normalize(message);

  // Treat common “how do I / how to / fix / learn” as resource intent
  const howTo =
    t.startsWith("how do i ") ||
    t.startsWith("how to ") ||
    t.includes(" how do i ") ||
    t.includes(" how to ");

  const fixLearn =
    t.includes(" fix ") || t.includes(" repair ") || t.includes(" learn ") || t.includes(" tutorial ") || t.includes(" guide ");

  const explicit = RESOURCE_INTENT_HINTS.some((kw) => String(message || "").toLowerCase().includes(kw));

  return explicit || (howTo && fixLearn) || howTo;
}

function tokenize(text) {
  const stop = new Set([
    "the","and","or","but","if","to","of","in","on","for","with","is","are","was","were",
    "be","been","being","i","me","my","you","your","we","they","this","that","it","a","an",
    "about","from","by","at","as","im","i'm","dont","don't","cant","can't","so","just","like",
    "really","can","could","would","please","help","need","want","get","give","show","tell","also",
    "how","do","does","did","what","why","when","where","who"
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

  const items = rows.slice(1).map((r2) => ({
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

function scoreResource(resource, queryTokens, contextTokens, tagTokens, urgency, allowGenderSpecific) {
  const hay = tokenize(`${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`);
  let score = 0;

  for (const w of hay) {
    if (queryTokens.includes(w)) score += 5;
    if (tagTokens.includes(w)) score += 6;
    if (contextTokens.includes(w)) score += 2;
  }

  const fatherText = (resource.fatherlessness_connection || "").toLowerCase();
  if (fatherText.includes("father") || fatherText.includes("dad") || fatherText.includes("fatherless")) score += 3;

  if (urgency === "high" && isCrisisResource(resource)) score += 10;
  if (!allowGenderSpecific && isGenderSpecificResource(resource)) score -= 8;

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
    return JSON.parse(content);
  } finally {
    clearTimeout(t);
  }
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

  // Safety gate (still allowed to show safety resources)
  if (triggeredSafety(message)) {
    return send(res, 200, {
      mode: "safety",
      intro: "If you’re in danger or might hurt yourself, please contact support right now.",
      items: [
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          description: "24/7 free support in the U.S. by call or text.",
          why: "This is the fastest way to reach immediate, trained help.",
          next_steps: "Call or text 988 now. If you’re in immediate danger, call emergency services."
        },
        {
          title: "Teen Line (Didi Hirsch)",
          url: "https://didihirsch.org/teenline/",
          description: "Teen-to-teen support with trained listeners and supervision.",
          why: "If you want to talk to someone who understands being a teen, this is a strong option.",
          next_steps: "Open the site and choose the best way to reach them (text, call, or email)."
        }
      ],
      resources: []
    });
  }

  try {
    const resources = await loadResources(csvUrl);

    const allowGenderSpecific = userSignalsGirl(message, contextText);

    // If user is not clearly asking for recommendations, keep it focused and steer to resource matching.
    const resourceIntent = interpretAsResourceSearch(message);

    if (!resourceIntent) {
      const convo = await openaiJSON(apiKey, [
        {
          role: "system",
          content:
            "You are the Youth Fatherless Network Resource Navigator.\n" +
            "You do NOT give long advice or unrelated explanations.\n" +
            "Your job is to quickly clarify what resources the person wants from the database.\n" +
            "Output JSON only: { \"intro\": string }\n" +
            "Rules:\n" +
            "- 2 to 4 sentences.\n" +
            "- Ask ONE focused follow-up question that helps you pick resources.\n" +
            "- Examples of good clarifiers: location, age range, topic area, what outcome they want.\n" +
            "- Do not mention the spreadsheet. Do not mention models.\n"
        },
        ...history,
        { role: "user", content: message }
      ]);

      return send(res, 200, {
        mode: "clarify",
        intro: String(convo?.intro || "Tell me what kind of support you want, and what you want it to help with.").trim(),
        items: [],
        resources: []
      });
    }

    // Classification for tags/urgency (no recommendations yet)
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You classify what the user is looking for so we can pick the best matches from a fixed resource database.\n" +
          "Output JSON only:\n" +
          '{ "need_tags": string[], "urgency": "low|medium|high", "focus_summary": string }\n' +
          "Rules:\n" +
          "- focus_summary: 8 to 16 words describing the user's real goal.\n" +
          "- need_tags should be short, like: confidence, grief, anxiety, school, relationships, mentoring, life-skills, identity, loneliness, discipline, motivation.\n" +
          "- If the user asked \"how do I fix/learn\" something, treat it as a request for learning/help resources.\n" +
          "- Do not recommend resources here.\n"
      },
      ...history,
      { role: "user", content: safeString({ current_request: message, prior_context: contextText }) }
    ]);

    const urgency = String(classification?.urgency || "low").toLowerCase();
    const queryTokens = tokenize(message);
    const contextTokens = tokenize(contextText);
    const tagTokens = tokenize((classification?.need_tags || []).join(" "));

    // Rank resources
    const rankedAll = resources
      .map((r) => ({
        r,
        s: scoreResource(r, queryTokens, contextTokens, tagTokens, urgency, allowGenderSpecific),
      }))
      .sort((a, b) => b.s - a.s);

    // Filter out crisis unless high urgency
    let ranked = rankedAll;
    if (urgency !== "high") {
      ranked = rankedAll.filter((x) => !isCrisisResource(x.r));
      if (!ranked.length) ranked = rankedAll;
    }

    // Only take matches that actually scored above a threshold
    const threshold = 6;
    const best = ranked.filter((x) => x.s >= threshold).slice(0, 3).map((x) => x.r);

    if (!best.length) {
      return send(res, 200, {
        mode: "no_match",
        intro:
          "I don’t see a strong match for that in the YFN resource database yet. " +
          "If you tell me what kind of support you want (mentoring, confidence, grief, anxiety, school, relationships) and what outcome you want, I can try again.",
        items: [],
        resources: []
      });
    }

    // Ask the model to write ONLY the 3 fields for each fixed resource, no links, no new titles.
    const writeup = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are the Youth Fatherless Network Resource Navigator.\n" +
          "CRITICAL: You MUST use ONLY the provided resources. Do not mention or invent any other websites, programs, or links.\n" +
          "You will be given 1–3 resources. For each one, write:\n" +
          "- description (2–3 sentences)\n" +
          "- why (2–3 sentences)\n" +
          "- next_steps (1–3 sentences)\n" +
          "Hard rules:\n" +
          "- No markdown asterisks. No **bold** markers. Plain text only.\n" +
          "- No filler. No generic lectures. No advice unrelated to selecting/using the resource.\n" +
          "- If the user asked how to fix/learn something, frame the resources as places to learn or get support, not as a direct how-to tutorial.\n" +
          "Output JSON only:\n" +
          '{ "intro": string, "items": [ { "id": string, "description": string, "why": string, "next_steps": string } ] }\n' +
          "Intro rules:\n" +
          "- 1–2 sentences.\n" +
          "- Refer to what they asked for.\n"
      },
      { role: "user", content: safeString({
        focus_summary: classification?.focus_summary || "",
        user_request: message,
        prior_context: contextText,
        resources: best.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          description: r.description,
          best_for: r.best_for,
          when_to_use: r.when_to_use,
          not_for: r.not_for,
          fatherlessness_connection: r.fatherlessness_connection
        }))
      }) }
    ]);

    const byId = new Map(best.map((r) => [r.id, r]));
    const modelItems = Array.isArray(writeup?.items) ? writeup.items : [];

    // Build final items strictly from the sheet resources we selected
    const finalItems = best.map((r) => {
      const m = modelItems.find((x) => String(x?.id || "").trim() === r.id) || {};
      return {
        title: r.title,
        url: r.url,
        description: String(m.description || "").trim().slice(0, 600),
        why: String(m.why || "").trim().slice(0, 600),
        next_steps: String(m.next_steps || "").trim().slice(0, 420),
      };
    });

    return send(res, 200, {
      mode: "recommendations_structured",
      intro: String(writeup?.intro || "Here are the best matches from the YFN resource database.").trim(),
      items: finalItems,
      resources: best.map((r) => ({ title: r.title, url: r.url, why: "" }))
    });

  } catch (err) {
    const msg = String(err?.message || err);

    return send(res, 500, {
      error: "Server error",
      detail: msg.slice(0, 700),
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
