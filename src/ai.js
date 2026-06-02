// Провайдер-агностичный AI-ассистент. Работает с OpenAI / Anthropic / Gemini.
// Без ключа возвращает { enabled: false } — остальное приложение не зависит от AI.

const PROVIDER = (process.env.AI_PROVIDER || '').toLowerCase();
const API_KEY = process.env.AI_API_KEY || '';

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-2.5-flash',
};

export function aiEnabled() {
  return !!(PROVIDER && API_KEY && DEFAULT_MODELS[PROVIDER]);
}

export function aiStatus() {
  return { enabled: aiEnabled(), provider: aiEnabled() ? PROVIDER : null };
}

function buildSystemPrompt(context) {
  const { plan, allocation, goals, wallets, investments, portfolio, manualPlan, itemsCount } = context || {};
  const lines = [
    'Ты — спокойный, прагматичный финансовый ассистент.',
    'Помогаешь распределить зарплату по приоритетам.',
    'Отвечай кратко, по делу, на русском. Давай конкретные рекомендации.',
    'Все суммы — в гривнах (грн).',
    '',
    '=== ТЕКУЩИЙ ПЛАН ===',
  ];
  if (plan) {
    lines.push(`Зарплата: ${plan.salary || 0} грн`);
    lines.push(`Обязательные расходы: ${plan.survivalCost || 0} грн`);
    lines.push(`Страховка/резерв: ${plan.buffer || 0} грн`);
    lines.push(`Инвестиции: ${plan.investmentFixed || 0} грн`);
    lines.push(`Дата зарплаты: ${plan.payday || '—'}`);
  }
  if (allocation) {
    const t = allocation.totals || {};
    lines.push('');
    lines.push('=== РАСПРЕДЕЛЕНИЕ ===');
    lines.push(`Доступно на желания: ${t.availableToAllocate || 0} грн`);
    if (allocation.approved?.length) {
      lines.push('Купить сейчас:');
      allocation.approved.forEach(a => lines.push(`  - ${a.title} (${a.cost} грн)`));
    }
    if (allocation.deferred?.length) {
      lines.push('Отложено:');
      allocation.deferred.forEach(d => lines.push(`  - ${d.title} (${d.cost} грн) — причина: ${d.reason}`));
    }
  }
  if (portfolio?.totalValue > 0) {
    lines.push('');
    lines.push('=== ПОРТФЕЛЬ ===');
    lines.push(`Общая стоимость: ${portfolio.totalValue} грн`);
    lines.push(`Вложено: ${portfolio.totalInvested} грн`);
    lines.push(`P&L: ${portfolio.totalPnL} грн`);
    if (portfolio.assets?.length) {
      portfolio.assets.forEach(a => lines.push(`  - ${a.name} (${a.type}): ${a.value} грн`));
    }
  }
  if (wallets?.length) {
    lines.push('');
    lines.push(`=== КОШЕЛЬКИ (${wallets.length}) ===`);
    wallets.forEach(w => lines.push(`  - ${w.name}: ${w.balance || 0} грн`));
  }
  if (manualPlan?.length) {
    lines.push('');
    lines.push('=== РУЧНОЙ ПЛАН ===');
    manualPlan.forEach(m => lines.push(`  - ${m.title || '#' + m.itemId}: ${m.amount} грн`));
  }
  lines.push('');
  lines.push(`Всего желаний: ${itemsCount || 0}`);
  lines.push(`Целей-накоплений: ${Array.isArray(goals) ? goals.length : 0}`);
  return lines.join('\n');
}

async function callOpenAI(system, messages, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function callAnthropic(system, messages, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function callGemini(system, messages, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function askAssistant(messages, context) {
  if (!aiEnabled()) {
    return { enabled: false, reply: 'AI-ассистент не настроен. Добавьте AI_PROVIDER и AI_API_KEY в окружении.' };
  }
  const model = process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER];
  const system = buildSystemPrompt(context);

  let reply;
  if (PROVIDER === 'openai') reply = await callOpenAI(system, messages, model);
  else if (PROVIDER === 'anthropic') reply = await callAnthropic(system, messages, model);
  else if (PROVIDER === 'gemini') reply = await callGemini(system, messages, model);
  else throw new Error(`Неизвестный провайдер: ${PROVIDER}`);

  return { enabled: true, reply };
}

export async function askAssistantText(prompt, context) {
  return askAssistant([{ role: 'user', content: prompt }], context);
}
