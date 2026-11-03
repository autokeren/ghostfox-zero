// server/inference.js — Vultr Serverless Inference client (OpenAI-compatible)
// All agent LLM calls (planning + vision verification) go through this module.

const BASE_URL = process.env.VULTR_INFERENCE_BASE_URL || 'https://api.vultrinference.com/v1';
const API_KEY = process.env.VULTR_INFERENCE_API_KEY;

const CHAT_MODEL = process.env.INFERENCE_CHAT_MODEL || 'qwen/qwen3-235b-a22b';
const VISION_MODEL = process.env.INFERENCE_VISION_MODEL || 'qwen/qwen3-vl-235b-a22b';

async function chat(messages, { model = CHAT_MODEL, maxTokens = 2048, temperature = 0.2 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
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

async function vision(prompt, imageBase64, { model = VISION_MODEL, maxTokens = 1024 } = {}) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
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

export { chat, vision, CHAT_MODEL, VISION_MODEL, BASE_URL };
