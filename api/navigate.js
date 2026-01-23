// api/navigate.js
// SinePatre Resource Navigator
// Model: gpt-5.0-mini

const MAX_MESSAGE_LENGTH = 800;

const SAFETY_REGEX = [
  /\b(suicide|kill myself|end my life)\b/i,
  /\b(self[- ]?harm|cut myself|cutting)\b/i,
  /\b(i am not safe|i'm not safe|unsafe at home)\b/i,
  /\b(abuse|sexual assault|rape|molested)\b/i,
];

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
    "this","that","it","im","i'm","dont","don't","cant","can't"
  ]);

  return normalize(text)
    .split(" ")
    .filter(w => w.length > 2 && !stop.has(w));
}

function triggeredSafety(message) {
  return SAFETY_REGEX.some(rx => rx.test(message));
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

async function loadResources(csvUrl) {
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error("Failed to fetch sheet CSV");

  const text = await r.text();
  const rows = parseCSV(text);
  const headers = rows[0].map(h => normalize(h).replace(/\s+/g, "_"));

  const col = name => headers.indexOf(name);

  const required = [
    "id","title","description","best_for",
    "when_to_use","not_for","fatherlessness_connection","url"
  ];

  required.forEach(c => {
    if (col(c) === -1) throw new Error(`Missing column: ${c}`);
  });

  return rows.slice(1).map(r => ({
    id: r[col("id")]?.trim(),
    title: r[col("title")]?.trim(),
    description: r[col("description")]?.trim(),
    best_for: r[col("best_for")]?.trim(),
    when_to_use: r[col("when_to_use")]?.trim(),
    not_for: r[col("not_for")]?.trim(),
    fatherlessness_connection: r[col("fatherlessness_connection")]?.trim(),
    url: r[col("url")]?.trim(),
  })).filter(x => x.id && x.title);
}

async function openaiJSON(apiKey, messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.0-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(t);
  }

  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

function scoreResource(resource, queryTokens, tagTokens) {
  const haystack = tokenize(
    `${resource.title} ${resource.description} ${resource.best_for} ${resource.fatherlessness_connection}`
  );

  let score = 0;
  haystack.forEach(w => {
    if (queryTokens.includes(w)) score += 3;
    if (tagTokens.includes(w)) score += 5;
  });

  return score;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { error: "POST only" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

  if (!apiKey || !csvUrl) {
    return send(res, 500, { error: "Missing environment variables" });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return send(res, 400, { error: "Missing message" });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return send(res, 400, { error: "Message too long" });
  }

  if (triggeredSafety(message)) {
    return send(res, 200, {
      mode: "safety",
      intro: "You deserve immediate support. Please use one of these resources now.",
      resources: [
        { title: "988 Suicide & Crisis Lifeline", url: "https://988lifeline.org" },
        { title: "Crisis Text Line", url: "https://www.crisistextline.org" },
        { title: "Teen Line", url: "https://teenline.org" },
        { title: "Childhelp Hotline", url: "https://www.childhelp.org/hotline/" }
      ]
    });
  }

  const resources = await loadResources(csvUrl);

  const classification = await openaiJSON(apiKey, [
    {
      role: "system",
      content:
        "You classify a fatherless teen's need. Output JSON with need_tags (3-6 short phrases), urgency (low|medium|high). Do not give advice."
    },
    { role: "user", content: message }
  ]);

  const queryTokens = tokenize(message);
  const tagTokens = tokenize((classification.need_tags || []).join(" "));

  const ranked = resources
    .map(r => ({ r, s: scoreResource(r, queryTokens, tagTokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.r);

  if (!ranked.length) {
    return send(res, 200, {
      mode: "no_match",
      intro: "I could not find a strong match yet. Try describing what you are feeling or what kind of help you want.",
      resources: []
    });
  }

  const response = await openaiJSON(apiKey, [
    {
      role: "system",
      content:
        "You recommend resources. Use only the provided list. No advice. For each, explain why it fits in one sentence."
    },
    {
      role: "user",
      content: JSON.stringify({ message, resources: ranked })
    }
  ]);

  send(res, 200, {
    mode: "recommendations",
    intro: response.intro || "Here are resources that best match what you shared.",
    resources: response.resources || []
  });
}
