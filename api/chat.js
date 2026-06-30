// /api/chat.js
// Vercel serverless function — proxies chat messages to Gemini.
// Keeps the API key server-side only; never exposed to the browser.

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

Engagement model: hourly ($125–175/hr) or fixed-scope projects ($8,000–15,000).

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
  a scoped quote — never invent a specific price for their exact project

RULES:
- Stay focused on NexLane, Sudheer's professional background, and industrial
  IT / SCADA / manufacturing data topics. If asked something unrelated
  (general trivia, personal opinions on unrelated topics, coding help for
  unrelated projects, etc.), politely redirect: mention that you're focused
  on NexLane and industrial IT topics, and offer to help with that instead.
- Never quote an exact price for a specific project — only the general
  hourly/project range above. Point them to the contact form for a real quote.
- Keep answers concise and conversational — this is a chat widget, not a report.
- Do not claim capabilities NexLane doesn't have. If unsure, say so and
  suggest reaching out directly.
`.trim();

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

    const contents = recent.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 4000) }],
    }));

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const body = JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_CONTEXT }] },
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 500,
      },
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    // Retry on 429 (rate limit) / 503 (overloaded) with short backoff.
    // Free tier limits are low, so a quick retry often succeeds.
    let geminiRes;
    let lastStatus;
    const delays = [600, 1500]; // ms — up to 2 retries beyond the first try
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      lastStatus = geminiRes.status;
      if (geminiRes.ok) break;
      if (lastStatus !== 429 && lastStatus !== 503) break; // non-retryable
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', lastStatus, errText);

      if (lastStatus === 429) {
        return res.status(429).json({
          error: 'rate_limited',
          reply:
            "I'm getting a lot of questions right now and hit a temporary limit — please try again in a few seconds, or use the contact form below.",
        });
      }
      return res.status(502).json({
        error: 'upstream_error',
        reply:
          "Sorry, I'm having trouble reaching the assistant right now. Please try again shortly or use the contact form below.",
      });
    }

    const data = await geminiRes.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ||
      "Sorry, I couldn't generate a response just now — please try again or use the contact form below.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
