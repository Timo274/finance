// Canvas-графики (vanilla, без библиотек): донат, линия, бары.
// Чистые функции — данные приходят параметрами. Вынесено из app.js (план 11.1, этап 1).
import { fmtShort } from "./format.js?v=__STATIC_VERSION__";

export function cssVar(name, fallback = "#888") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
export function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
export function drawDonut(canvas, segments, center = null) {
  const { ctx, w, h } = setupCanvas(canvas);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;
  const cx = w / 2,
    cy = h / 2;
  const r = Math.min(w, h) / 2 - 6;
  const inner = r * 0.62;
  let a = -Math.PI / 2;
  segments.forEach((seg) => {
    const ang = (seg.value / total) * Math.PI * 2;
    if (ang <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a + ang);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    a += ang;
  });
  // вырезаем центр (донат)
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  // подпись в центре
  ctx.fillStyle = cssVar("--text", "#111");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 18px Inter, sans-serif";
  ctx.fillText(center?.title ?? fmtShort(total), cx, cy - 4);
  ctx.fillStyle = cssVar("--muted", "#888");
  ctx.font = "500 11px Inter, sans-serif";
  ctx.fillText(center?.sub ?? "грн всего", cx, cy + 13);
}
export function drawLine(canvas, points, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (points.length < 2) return;
  const padL = 8,
    padR = 8,
    padT = 14,
    padB = 22;
  const vals = points.map((p) => p.value);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = maxV - minV || 1;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - ((v - minV) / span) * innerH;
  const accent = cssVar("--accent", "#2f6bff");
  // нулевая линия
  if (minV < 0) {
    ctx.strokeStyle = cssVar("--border", "#ddd");
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(0));
    ctx.lineTo(w - padR, y(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // smooth curve helper
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.value) }));
  function smoothPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const cx = (pts[i].x + pts[i + 1].x) / 2;
      const cy = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, cx, cy);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  // заливка под линией
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, accent + "55");
  grad.addColorStop(1, accent + "00");
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.lineTo(pts[pts.length - 1].x, padT + innerH);
  ctx.lineTo(pts[0].x, padT + innerH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // линия
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  // точки
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = points[i].value < 0 ? cssVar("--color-risk", "#e44") : accent;
    ctx.fill();
    ctx.strokeStyle = cssVar("--panel", "#fff");
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  // Подписи осей: без min/max и последнего значения график нечитаем (аудит 8.1).
  ctx.fillStyle = cssVar("--muted", "#888");
  ctx.font = "500 10px Inter, sans-serif";
  ctx.textBaseline = "alphabetic";
  if (maxV !== minV) {
    ctx.textAlign = "left";
    ctx.fillText(fmtShort(maxV), padL, padT - 4);
    ctx.fillText(fmtShort(minV), padL, h - padB + 12);
  }
  if (opts.xStart || opts.xEnd) {
    ctx.textAlign = "center";
    if (opts.xStart) {
      ctx.textAlign = "left";
      ctx.fillText(String(opts.xStart), padL, h - 2);
    }
    if (opts.xEnd) {
      ctx.textAlign = "right";
      ctx.fillText(String(opts.xEnd), w - padR, h - 2);
    }
  }
  // Текущее значение у последней точки.
  const lastP = pts[pts.length - 1];
  ctx.textAlign = lastP.x > w - 60 ? "right" : "center";
  ctx.font = "700 11px Inter, sans-serif";
  ctx.fillStyle = cssVar("--text", "#111");
  ctx.fillText(
    fmtShort(points[points.length - 1].value),
    Math.min(lastP.x, w - padR),
    Math.max(10, lastP.y - 8),
  );
}
export function drawBars(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const maxV = Math.max(...segments.map((s) => s.value), 1);
  const pad = 18;
  const gap = 10;
  const barW = (w - pad * 2 - gap * (segments.length - 1)) / Math.max(segments.length, 1);
  segments.forEach((seg, i) => {
    const x = pad + i * (barW + gap);
    const bh = ((h - 44) * seg.value) / maxV;
    const y = h - 26 - bh;
    ctx.fillStyle = seg.color || cssVar("--accent", "#2f6bff");
    ctx.fillRect(x, y, Math.max(8, barW), bh);
    ctx.fillStyle = cssVar("--muted", "#888");
    ctx.textAlign = "center";
    ctx.font = "600 10px Inter, sans-serif";
    ctx.fillText(seg.label, x + barW / 2, h - 8);
  });
}
