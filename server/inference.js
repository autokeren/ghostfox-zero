// server/inference.js — Vultr Serverless Inference client (OpenAI-compatible)
// All agent LLM calls (action decisions + vision verification) go through here.
// NOTE: env is read lazily because ESM import hoisting evaluates this module
// before dotenv.config() runs in index.js — reading env at module top-level
// would capture `undefined`.

const BASE_URL = () => process.env.VULTR_INFERENCE_BASE_URL || 'https://api.vultrinference.com/v1';
const API_KEY = () => process.env.VULTR_INFERENCE_API_KEY;
const CHAT_MODEL = () => process.env.INFERENCE_CHAT_MODEL || 'glm-5.3-flash';
const VISION_MODEL = () => process.env.INFERENCE_VISION_MODEL || 'glm-5.3-flash';

export function inferenceInfo() {
  return { baseUrl: BASE_URL(), chatModel: CHAT_MODEL(), visionModel: VISION_MODEL() };
}

async function chat(messages, { model = CHAT_MODEL(), maxTokens = 2048, temperature = 0.2 } = {}) {
  const res = await fetch(`${BASE_URL()}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Authorization': `Bearer ${API_KEY()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vultr Inference chat failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

async function vision(prompt, imageBase64, { model = VISION_MODEL(), maxTokens = 2048 } = {}) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];
  const res = await fetch(`${BASE_URL()}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Authorization': `Bearer ${API_KEY()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vultr Inference vision failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

export { chat, vision };
