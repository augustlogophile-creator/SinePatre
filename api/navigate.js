// api/navigate.js — SinePatre Resource Navigator
// Clean, paraphrased, resource-grounded responses only

const MAX_MESSAGE_LENGTH = 1500;
const MAX_HISTORY_ITEMS = 30;

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
}

function send(res, status, payload) {
  res.status(status).json(payload);
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
    "this","that","it","a","an","about","from","by","at","as"
  ]);
  return normalize(text)
    .split(" ")
    .filter(w => w.length > 2 && !stop.has(w));
}

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
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }

  row.push(field);
  if (row.some(v => v !== "")) rows.push(row);
  return rows;
}

let CACHE = { at: 0, ttlMs: 2 * 60 * 1000, items: null };

async function loadResources(csvUrl) {
  const now = Date.now();
  if (CACHE.items && now - CACHE.at < CACHE.ttlMs) return CACHE.items;

  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error("sheet_fetch_failed");
  const text = await r.text();

  const rows = parseCSV(text);
  const headers = rows[0].map(h => normalize(h).replace(/\s+/g, "_"));
  const col = name => headers.indexOf(name);

  const items = rows.slice(1).map(r2 => ({
    title: r2[col("title")]?.trim(),
    description: r2[col("description")]?.trim(),
    best_for: r2[col("best_for")]?.trim(),
    when_to_use: r2[col("when_to_use")]?.trim(),
    not_for: r2[col("not_for")]?.trim(),
    fatherlessness_connection: r2[col("fatherlessness_connection")]?.trim(),
    url: r2[col("url")]?.trim(),
  })).filter(x => x.title && x.url);

  CACHE = { at: now, ttlMs: CACHE.ttlMs, items };
  return items;
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
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(raw);
  const j = JSON.parse(raw);
  return JSON.parse(j.choices[0].message.content);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  const apiKey = process.env.OPENAI_API_KEY;
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;
  if (!apiKey || !csvUrl) return send(res, 500, { error: "Missing env vars" });

  const message = String(req.body?.message || "").trim();
  if (!message) return send(res, 400, { error: "Missing message" });

  try {
    const resources = await loadResources(csvUrl);

    const response = await openaiJSON(apiKey, [
      {
        role: "system",
        content:
          "You are SinePatre, a calm and intelligent guide.\n\n" +
          "You ONLY use the provided resources as factual input.\n" +
          "You must REPHRASE all content in your own words. Never copy sentences verbatim.\n\n" +
          "Output JSON only: { \"intro\": string, \"paragraphs\": string[] }\n\n" +
          "Rules:\n" +
          "- Intro: 2–3 sentences, grounded and direct.\n" +
          "- Each paragraph: one resource, 4–6 sentences.\n" +
          "- Include the resource name and URL naturally.\n" +
          "- Explain what it does, who it helps, and when it fits.\n" +
          "- Do NOT include \"How to start\" or steps.\n" +
          "- Write with maturity and clarity. No emojis. No fluff.\n",
      },
      {
        role: "user",
        content: JSON.stringify({
          message,
          resources,
        }),
      },
    ]);

    return send(res, 200, {
      mode: "recommendations",
      intro: response.intro,
      paragraphs: response.paragraphs,
    });

  } catch (err) {
    return send(res, 500, {
      error: "Server error",
      detail: String(err.message || err),
    });
  }
}
