// Провайдер-агностичный AI-ассистент. Работает с OpenAI / Anthropic / Gemini.
// Без ключа возвращает { enabled: false } — остальное приложение не зависит от AI.

const PROVIDER = (process.env.AI_PROVIDER || "").toLowerCase();
const API_KEY = process.env.AI_API_KEY || "";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  gemini: "gemini-2.5-flash",
};

export function aiEnabled() {
  return !!(PROVIDER && API_KEY && DEFAULT_MODELS[PROVIDER]);
}

export function aiStatus() {
  return { enabled: aiEnabled(), provider: aiEnabled() ? PROVIDER : null };
}

function buildSystemPrompt(context) {
  const {
    plan,
    allocation,
    goals,
    wallets,
    investments,
    portfolio,
    manualPlan,
    itemsCount,
  } = context || {};
  const lines = [
    "Ты — спокойный, прагматичный финансовый ассистент.",
    "Помогаешь распределить зарплату по приоритетам.",
    "Отвечай кратко, по делу, на русском. Давай конкретные рекомендации.",
    "Все суммы — в гривнах (грн).",
    "",
    "=== ТЕКУЩИЙ ПЛАН ===",
  ];
  if (plan) {
    lines.push(`Зарплата: ${plan.salary || 0} грн`);
    lines.push(`Обязательные расходы: ${plan.survivalCost || 0} грн`);
    lines.push(`Страховка/резерв: ${plan.buffer || 0} грн`);
    lines.push(`Инвестиции: ${plan.investmentFixed || 0} грн`);
    lines.push(`Дата зарплаты: ${plan.payday || "—"}`);
  }
  if (allocation) {
    const t = allocation.totals || {};
    lines.push("");
    lines.push("=== РАСПРЕДЕЛЕНИЕ ===");
    lines.push(`Доступно на желания: ${t.availableToAllocate || 0} грн`);
    if (allocation.approved?.length) {
      lines.push("Купить сейчас:");
      allocation.approved.forEach((a) =>
        lines.push(`  - ${a.title} (${a.cost} грн)`),
      );
    }
    if (allocation.deferred?.length) {
      lines.push("Отложено:");
      allocation.deferred.forEach((d) =>
        lines.push(`  - ${d.title} (${d.cost} грн) — причина: ${d.reason}`),
      );
    }
  }
  if (portfolio?.totalValue > 0) {
    lines.push("");
    lines.push("=== ПОРТФЕЛЬ ===");
    lines.push(`Общая стоимость: ${portfolio.totalValue} грн`);
    lines.push(`Вложено: ${portfolio.totalInvested} грн`);
    lines.push(`P&L: ${portfolio.totalPnL} грн`);
    if (portfolio.assets?.length) {
      portfolio.assets.forEach((a) =>
        lines.push(`  - ${a.name} (${a.type}): ${a.value} грн`),
      );
    }
  }
  if (wallets?.length) {
    lines.push("");
    lines.push(`=== КОШЕЛЬКИ (${wallets.length}) ===`);
    wallets.forEach((w) => lines.push(`  - ${w.name}: ${w.amount || 0} грн`));
  }
  if (manualPlan?.length) {
    lines.push("");
    lines.push("=== РУЧНОЙ ПЛАН ===");
    manualPlan.forEach((m) =>
      lines.push(`  - ${m.title || "#" + m.itemId}: ${m.amount} грн`),
    );
  }
  lines.push("");
  lines.push(`Всего желаний: ${itemsCount || 0}`);
  lines.push(`Целей-накоплений: ${Array.isArray(goals) ? goals.length : 0}`);
  return lines.join("\n");
}

async function callOpenAI(system, messages, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function callAnthropic(system, messages, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

async function callGemini(system, messages, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

export async function askAssistant(messages, context) {
  if (!aiEnabled()) {
    return {
      enabled: false,
      reply:
        "AI-ассистент не настроен. Добавьте AI_PROVIDER и AI_API_KEY в окружении.",
    };
  }
  const model = process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER];
  const system = buildSystemPrompt(context);

  let reply;
  if (PROVIDER === "openai") reply = await callOpenAI(system, messages, model);
  else if (PROVIDER === "anthropic")
    reply = await callAnthropic(system, messages, model);
  else if (PROVIDER === "gemini")
    reply = await callGemini(system, messages, model);
  else throw new Error(`Неизвестный провайдер: ${PROVIDER}`);

  return { enabled: true, reply };
}

export async function askAssistantText(prompt, context) {
  return askAssistant([{ role: "user", content: prompt }], context);
}

// ---------- Реальный стриминг (SSE от провайдеров → колбэк по кускам) ----------

async function* sseLines(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer) yield buffer;
}

function sseData(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function streamOpenAI(system, messages, model, onDelta) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  for await (const line of sseLines(res)) {
    const data = sseData(line);
    const delta = data?.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  }
}

async function streamAnthropic(system, messages, model, onDelta) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      stream: true,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  for await (const line of sseLines(res)) {
    const data = sseData(line);
    if (data?.type === "content_block_delta" && data.delta?.text)
      onDelta(data.delta.text);
  }
}

async function streamGemini(system, messages, model, onDelta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${API_KEY}`;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  for await (const line of sseLines(res)) {
    const data = sseData(line);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) onDelta(text);
  }
}

/**
 * Стриминговый ответ ассистента: куски текста приходят в onDelta по мере генерации.
 * Возвращает полный собранный ответ.
 */
export async function askAssistantStream(messages, context, onDelta) {
  if (!aiEnabled()) throw new Error("ai_disabled");
  const model = process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER];
  const system = buildSystemPrompt(context);
  let full = "";
  const emit = (text) => {
    full += text;
    onDelta(text);
  };
  if (PROVIDER === "openai") await streamOpenAI(system, messages, model, emit);
  else if (PROVIDER === "anthropic")
    await streamAnthropic(system, messages, model, emit);
  else if (PROVIDER === "gemini")
    await streamGemini(system, messages, model, emit);
  else throw new Error(`Неизвестный провайдер: ${PROVIDER}`);
  return full;
}

// ---------- Промпты «ритуалов» ----------

export function monthReviewPrompt(plan) {
  const s = plan?.snapshot || {};
  const t = s.totals || {};
  const purchased = (s.approved || [])
    .map((x) => `${x.title} (${x.cost} грн)`)
    .join(", ");
  const deferred = (s.deferred || [])
    .map((x) => `${x.title} (${x.cost} грн)`)
    .join(", ");
  return [
    `Месяц «${plan?.name || ""}» закрыт. Сделай короткий разбор месяца (5-7 предложений).`,
    `Зарплата: ${t.salary ?? plan?.salary ?? 0} грн, распределено: ${t.allocated ?? 0} грн, свободный остаток: ${t.remaining ?? 0} грн.`,
    `Куплено: ${purchased || "ничего"}.`,
    `Отложено: ${deferred || "ничего"}.`,
    "Отметь: что было сильным решением, где возможна утечка денег, и один конкретный совет на следующий месяц. Без воды.",
  ].join("\n");
}

export function talkMeOutPrompt(item) {
  return [
    `Я хочу купить: «${item.title}» за ${item.cost} грн (категория: ${item.category}, тип: ${item.type}, приоритет ${item.priority}/5, эмоциональность ${item.emotional}/5).`,
    item.notes ? `Мои заметки: ${item.notes}` : "",
    "Твоя задача — попробовать отговорить меня от этой покупки: приведи 3-4 сильных рациональных аргумента против, предложи дешёвую альтернативу и вопрос-проверку «нужно ли это мне через месяц». Будь честным: если покупка объективно разумная — так и скажи в конце.",
  ]
    .filter(Boolean)
    .join("\n");
}
