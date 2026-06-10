// DOM-утилиты без обращения к state: селекторы, тост, конфетти.
// Вынесено из app.js (план 11.1, этап 1).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, opts = {}) {
  const t = $("#toast");
  t.textContent = msg;
  if (opts.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      t.classList.add("hidden");
      clearTimeout(toast._t);
      opts.action.onClick();
    });
    t.appendChild(btn);
  }
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), opts.duration || 2400);
}

// --- конфетти при покупках и закрытии месяца ---
export function confettiBurst(x, y, count = 26) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = document.createElement("div");
  host.className = "confetti-host";
  const colors = ["#f8d29a", "#0e5f68", "#d33223", "#0c7a55", "#b5710a", "#2f6bff", "#7aa2ff"];
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 140;
    p.style.setProperty("--dx", `${(Math.cos(ang) * dist).toFixed(0)}px`);
    p.style.setProperty("--dy", `${(Math.sin(ang) * dist - 90).toFixed(0)}px`);
    p.style.setProperty("--rot", `${Math.round(Math.random() * 720 - 360)}deg`);
    p.style.background = colors[i % colors.length];
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.animationDelay = `${(Math.random() * 0.1).toFixed(2)}s`;
    if (Math.random() < 0.35) p.style.borderRadius = "50%";
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1400);
}
