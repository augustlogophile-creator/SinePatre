// api/navigate.js - SinePatre Enhanced Resource Navigator
// Improved AI classification, better context understanding, enhanced safety

const MAX_MESSAGE_LENGTH = 1200;
const MAX_HISTORY_ITEMS = 20;
const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life|end it all)\b/i,
  /\b(self[- ]?harm|cut myself|cutting|self.?injur)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home|in danger)\b/i,
  /\b(abuse|sexual assault|rape|molested|violence)\b/i,
  /\b(overdose|poison|hang)\b/i,
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
    "this","that","it","im","i'm","dont","don't","cant","can't","a","an",
    "about","from","by","at","as","into","through","during","before","after",
  ]);
  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Enhanced CSV parser
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

async function loadResources(csvUrl) {
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error("Failed to fetch sheet CSV");
  const text = await r.text();
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("Empty CSV");
  
  const headers = rows[0].map((h) => normalize(h).replace(/\s+/g, "_"));
  const col = (name) => headers.indexOf(name);
  
  const required = [
    "id", "title", "description", "best_for", "when_to_use",
    "not_for", "fatherlessness_connection", "url",
  ];
  
  for (const c of required) {
    if (col(c) === -1) throw new Error(`Missing column: ${c}`);
  }
  
  return rows
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
}

function isCrisisResource(resource) {
  const t = `${resource.title} ${resource.description} ${resource.when_to_use}`.toLowerCase();
  return (
    t.includes("crisis") || t.includes("suicide") || t.includes("self-harm") ||
    t.includes("hotline") || t.includes("988") || t.includes("emergency")
  );
}

function scoreResource(resource, queryTokens, tagTokens, urgency) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection} ${resource.when_to_use} ${resource.not_for}`
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
  
  // Crisis resources boost for high urgency
  if (urgency === "high" && isCrisisResource(resource)) {
    score += 10;
  }
  
  return score;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const trimmed = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 1200),
    }));
  return trimmed.slice(-MAX_HISTORY_ITEMS);
}

function wantSinglePick(message) {
  const t = normalize(message);
  return (
    t.includes("which is the best") || t.includes("which one is best") ||
    t.includes("which is best") || t.includes("pick one") || t.includes("choose one") ||
    t.includes("just one") || t.includes("best one") || t.includes("the best option")
  );
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
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t);
  }
  
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
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
  
  // Hard safety gate
  if (triggeredSafety(message)) {
    return send(req, res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please reach out to someone right now.",
      resources: [
        {
          title: "988 Suicide & Crisis Lifeline",
          url: "https://988lifeline.org",
          why: "24/7 call or text support in the U.S. Immediate help from trained counselors who care.",
        },
        {
          title: "Crisis Text Line",
          url: "https://www.crisistextline.org",
          why: "Text HOME to 741741. Confidential support with crisis counselors available 24/7.",
        },
        {
          title: "Teen Line",
          url: "https://teenline.org",
          why: "Teens helping teens. Call 1-800-852-8336 or text TEEN to 839863.",
        },
        {
          title: "Childhelp Hotline",
          url: "https://www.childhelp.org/hotline/",
          why: "1-800-422-4453. Support for abuse, neglect, or unsafe situations.",
        },
      ],
    });
  }
  
  try {
    const resources = await loadResources(csvUrl);
    
    // Enhanced classification with multi-turn context
    const classification = await openaiJSON(apiKey, [
      {
        role: "system",
        content: `You are an expert intake assistant for teens from fatherless backgrounds seeking support resources.
        
Analyze the user's message in context of their conversation history. Output JSON only:
{
  "need_tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "urgency": "low|medium|high",
  "intent": "explore|pick_best|compare|ask_followup|clarify",
  "emotional_tone": "struggling|hopeful|confused|determined",
  "practical_barriers": ["barrier1", "barrier2"],
  "notes": "2-3 sentence summary"
}

Be specific. Use tags like: mentorship, grief-processing, father-wound, school-stress, mental-health, identity, loneliness, academic-support, career-guidance, trauma-recovery, anger-management, trust-building, spiritual-support.`,
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
        intro: "I want to help. Tell me a bit more—what would make things better right now?",
        resources: [],
      });
    }
    
    const intent = String(classification.intent || "").toLowerCase();
    const limit = intent === "pick_best" || wantSinglePick(message) ? 1 : 3;
    const top = ranked.slice(0, Math.max(limit, 3)).map((x) => x.r);
    
    // Enhanced response generation with better conversational grounding
    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content: `You are SinePatre—a compassionate, direct guide for fatherless teens. You ground recommendations in real resources.

Output JSON only:
{
  "intro": "1-2 sentences, warm and specific to what they shared",
  "resources": [{ "title": "...", "url": "...", "why": "..." }]
}

Rules:
- Use ONLY provided resources
- If asking for the best option: return exactly 1 resource
- Otherwise: return up to 3 resources, ranked by fit
- Each "why" is 4-5 sentences, including: what it is, why it fits their situation, concrete next steps
- Be warm but direct. Assume they're smart. No generic therapy language.
- If they asked a follow-up, answer directly and explain your reasoning`,
      },
      ...history,
      {
        role: "user",
        content: JSON.stringify({
          message,
          urgency,
          need_tags: classification.need_tags || [],
          emotional_tone: classification.emotional_tone || "unknown",
          intent,
          practical_barriers: classification.practical_barriers || [],
          show_count: limit,
          resources: top,
        }),
      },
    ]);
    
    const outResources = Array.isArray(response.resources) ? response.resources : [];
    const clipped = outResources.slice(0, limit);
    
    return send(req, res, 200, {
      mode: "recommendations",
      intro: response.intro || "Here's what I think fits best based on what you shared.",
      resources: clipped,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("insufficient_quota")) {
      return send(req, res, 402, {
        error: "OpenAI billing not active",
        detail: "Your API key has no available quota. Confirm billing is enabled.",
      });
    }
    return send(req, res, 500, {
      error: "Server error",
      detail: msg,
    });
  }
}
