// /api/chat.js
// Vercel serverless function — tries Gemini first, falls back to Groq
// (Llama 3.3) if Gemini is rate-limited. Keeps both API keys server-side.

const SYSTEM_CONTEXT = `
You are the assistant on the NexLane Systems website (nexlanesystems.net).

ABOUT NEXLANE SYSTEMS:
NexLane Systems is a Connecticut-based Industrial IT Modernization consultancy
serving SMB manufacturers across Connecticut and the Northeast.

Five service lines:
1. SCADA & MES Modernization
2. SQL Server & Data Infrastructure
3. Energy Intelligence Dashboards
4. Executive KPI Dashboards
5. Alarm Management & Compliance

Engagement model: hourly ($125-175/hr) or fixed-scope projects ($8,000-15,000).

ABOUT THE FOUNDER:
NexLane is run by Sudheer Godugu, a Senior Software Engineer and Lead Data
Consultant. He is the sole on-site SCADA/data engineer for a multi-line
industrial manufacturing client running Ignition (v8.1.44) and SQL Server
historian infrastructure. His core expertise spans Ignition SCADA/Vision,
React, Spring Boot, SQL Server (historian and Access-to-SQL migrations), and
ETL pipelines. He has a full-stack engineering background across enterprise
roles (Amazon, Verizon, Black Knight Financial) and holds an M.S. in Computer
Engineering, with an M.S. in Artificial Intelligence in progress.

WHAT YOU CAN HELP WITH:
- Explaining NexLane's services, approach, and pricing model in general terms
- Answering general questions about industrial IT, SCADA, MES, historians,
  OT/IT integration, and manufacturing data infrastructure
- Speaking to Sudheer's background and experience when asked
- Encouraging visitors with real project needs to use the contact form for
  a scoped quote -- never invent a specific price for their exact project

RULES:
- Stay focused on NexLane, Sudheer's professional background, and industrial
  IT / SCADA / manufacturing data topics. If asked something unrelated
  (general trivia, personal opinions on unrelated topics, coding help for
  unrelated projects, etc.), politely redirect: mention that you're focused
  on NexLane and industrial IT topics, and offer to help with that instead.
- Never quote an exact price for a specific project -- only the general
  hourly/project range above. Point them to the contact form for a real quote.
- Keep answers concise and conversational -- this is a chat widget, not a report.
- Do not claim capabilities NexLane doesn't have. If unsure, say so and
  suggest reaching out directly.
`.trim();

function buildGeminiContents(recent) {
  return recent.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').slice(0, 4000) }],
  }));
}

function buildOpenAIStyleMessages(recent) {
  // Groq's API is OpenAI-compatible: role "user"/"assistant", system separate.
  return [
    { role: 'system', content: SYSTEM_CONTEXT },
    ...recent.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000),
    })),
  ];
}

// Try Gemini, with short retries on 429/503. Returns { ok, reply } or { ok:false, status }.
async function callGemini(recent) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, status: 0, skipped: true };

  const body = JSON.stringify({
    contents: buildGeminiContents(recent),
    systemInstruction: { parts: [{ text: SYSTEM_CONTEXT }] },
    generationConfig: { temperature: 0.6, maxOutputTokens: 500 },
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let res, status;
  const delays = [600, 1500]; // two quick retries before giving up on Gemini
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    status = res.status;
    if (res.ok) break;
    if (status !== 429 && status !== 503) break; // non-retryable, bail immediately
    if (attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Gemini error:', status, errText);
    return { ok: false, status };
  }

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
  if (!reply) return { ok: false, status: 0 };
  return { ok: true, reply, provider: 'gemini' };
}

// Fallback: Groq (Llama 3.3 70B) — fast, free tier with higher RPM headroom.
async function callGroq(recent) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, status: 0, skipped: true };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: buildOpenAIStyleMessages(recent),
      temperature: 0.6,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Groq error:', res.status, errText);
    return { ok: false, status: res.status };
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) return { ok: false, status: 0 };
  return { ok: true, reply, provider: 'groq' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Cap history sent to the model to keep payloads small/cheap.
    const recent = messages.slice(-12);

    // 1) Try Gemini first (better answer quality).
    const gemini = await callGemini(recent);
    if (gemini.ok) {
      return res.status(200).json({ reply: gemini.reply, provider: 'gemini' });
    }

    // 2) Gemini failed (most likely rate-limited) -- fall back to Groq.
    const groq = await callGroq(recent);
    if (groq.ok) {
      return res.status(200).json({ reply: groq.reply, provider: 'groq' });
    }

    // 3) Both failed -- return a clear, honest message.
    if (gemini.status === 429 && groq.status === 429) {
      return res.status(429).json({
        error: 'rate_limited',
        reply:
          "Both of my assistants are getting a lot of traffic right now -- please try again in a moment, or use the contact form below.",
      });
    }

    return res.status(502).json({
      error: 'upstream_error',
      reply:
        "Sorry, I'm having trouble reaching the assistant right now. Please try again shortly or use the contact form below.",
    });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      reply: "Sorry, something went wrong on my end. Please try again or use the contact form below.",
    });
  }
}
