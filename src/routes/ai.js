// AI-ассистент: объяснения, чат (включая стриминг), месячный разбор, «отговори меня».
import { rowToItem, rowToPlan } from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { aiRateLimit } from "../middleware.js";
import {
  aiStatus,
  aiEnabled,
  askAssistant,
  askAssistantText,
  askAssistantStream,
  monthReviewPrompt,
  talkMeOutPrompt,
} from "../ai.js";
import { scoreVerdict } from "../allocation.js";
import { buildAIContext } from "../store.js";
import { sanitizeMessages } from "../sanitize.js";

export default function registerAiRoutes(app) {
app.get("/api/ai/status", requireAuth, (req, res) => res.json(aiStatus()));

app.post("/api/ai/explain", requireAuth, aiRateLimit, async (req, res) => {
  try {
    const item = stmt.itemById.get(Number(req.body?.itemId));
    if (!item) return res.status(404).json({ error: "not_found" });
    const cleanItem = rowToItem(item);
    const verdict = scoreVerdict(cleanItem);
    const context = {
      ...buildAIContext(req.body?.scenario || "balanced"),
      item: cleanItem,
      verdict,
    };
    const out = await askAssistantText(
      `Объясни кратко вердикт для желания "${cleanItem.title}" и что с ним делать.`,
      context,
    );
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});

app.post("/api/ai/chat", requireAuth, aiRateLimit, async (req, res) => {
  try {
    const messages = sanitizeMessages(req.body?.messages);
    const context = buildAIContext("balanced");
    const out = await askAssistant(messages, context);
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});

app.post("/api/ai/chat/stream", requireAuth, aiRateLimit, async (req, res) => {
  // Настоящий стриминг: куски ответа провайдера летят клиенту по мере генерации.
  try {
    const messages = sanitizeMessages(req.body?.messages);
    if (!aiEnabled()) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end(
        "AI-ассистент не настроен. Добавьте AI_PROVIDER и AI_API_KEY в окружении.",
      );
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    await askAssistantStream(messages, buildAIContext("balanced"), (delta) =>
      res.write(delta),
    );
    res.end();
  } catch (e) {
    if (res.headersSent) res.end(`\n[Ошибка ассистента: ${String(e.message || e)}]`);
    else res.status(500).end(`Ошибка ассистента: ${String(e.message || e)}`);
  }
});

// «Ритуал» 1: разбор закрытого месяца.
app.post("/api/ai/month-review", requireAuth, aiRateLimit, async (req, res) => {
  try {
    const planId = Number(req.body?.planId);
    const row = planId
      ? stmt.planById.get(planId)
      : stmt.closedPlans.all()[0];
    const plan = rowToPlan(row);
    if (!plan || plan.status !== "closed")
      return res.status(404).json({ error: "closed_plan_not_found" });
    const out = await askAssistantText(
      monthReviewPrompt(plan),
      buildAIContext("balanced"),
    );
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});

// «Ритуал» 2: отговори меня от покупки.
app.post("/api/ai/talk-me-out", requireAuth, aiRateLimit, async (req, res) => {
  try {
    const item = stmt.itemById.get(Number(req.body?.itemId));
    if (!item) return res.status(404).json({ error: "not_found" });
    const out = await askAssistantText(
      talkMeOutPrompt(rowToItem(item)),
      buildAIContext("balanced"),
    );
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});
}
