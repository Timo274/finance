// Автотест контраста палитр (аудит 4.2): прогоняем все комбинации
// тема × палитра по ключевым парам текст/фон и проверяем WCAG-пороги.
// Без браузера: парсим styles.css и резолвим var()-каскад так же, как CSS.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

const THEMES = ["light", "dark", "cockpit"];
const PALETTES = [
  "ocean",
  "sapphire",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "slate",
  "forest",
  "mono",
];

// --- мини-парсер: собираем все блоки `selector { декларации }` верхнего уровня
function parseBlocks(src) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const selector = m[1].trim();
    const vars = {};
    for (const decl of m[2].split(";")) {
      const i = decl.indexOf(":");
      if (i === -1) continue;
      const prop = decl.slice(0, i).trim();
      if (!prop.startsWith("--")) continue;
      vars[prop] = decl.slice(i + 1).trim();
    }
    if (Object.keys(vars).length) blocks.push({ selector, vars });
  }
  return blocks;
}
const blocks = parseBlocks(css);

function collectVars(theme, palette) {
  // Каскад как в CSS: база (:root/light) → тема → палитра → тема+палитра.
  const layers = [
    (sel) => sel.includes(":root") && !sel.includes("[data-palette"),
    (sel) => sel.includes(`[data-theme='${theme}']`) && !sel.includes("[data-palette"),
    (sel) =>
      (sel.includes(`[data-palette='${palette}']`) && !sel.includes("[data-theme")) ||
      (palette === "ocean" && sel.includes(":root:not([data-palette])")),
    (sel) => sel.includes(`[data-theme='${theme}'][data-palette='${palette}']`),
  ];
  const out = {};
  for (const match of layers) {
    for (const b of blocks) {
      // только «чистые» токен-блоки без вложенных классов
      const simple = b.selector
        .split(",")
        .some(
          (s) => match(s.trim()) && !/\s\.|\s\w/.test(s.trim().replace(/:root|\[[^\]]*\]/g, "")),
        );
      if (simple) Object.assign(out, b.vars);
    }
  }
  return out;
}

function resolveVar(vars, value, depth = 0) {
  if (depth > 10 || !value) return value;
  const m = value.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/);
  if (m) return resolveVar(vars, vars[m[1]] ?? m[2], depth + 1);
  return value;
}

function parseColor(raw) {
  if (!raw) return null;
  raw = raw.trim();
  let m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
  m = raw.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").map((x) => parseFloat(x));
    return parts.slice(0, 3);
  }
  return null; // gradients, color-mix и т.п. — пропускаем
}

function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(c1, c2) {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Пары: [передний план, фон, минимальный порог]
// 4.5 — обычный текст (WCAG AA), 3.0 — крупный/вторичный UI-текст.
const PAIRS = [
  ["--text", "--bg", 4.5],
  ["--text", "--panel", 4.5],
  ["--muted", "--panel", 4.0],
  ["--muted", "--bg", 4.0],
  ["--accent-num", "--panel", 3.0],
  ["--nav-active-text", "--nav-active-bg", 4.5],
];

test("контраст: все комбинации тема × палитра проходят пороги", () => {
  const failures = [];
  for (const theme of THEMES) {
    for (const palette of PALETTES) {
      const vars = collectVars(theme, palette);
      for (const [fgVar, bgVar, min] of PAIRS) {
        const fg = parseColor(resolveVar(vars, vars[fgVar]));
        const bg = parseColor(resolveVar(vars, vars[bgVar]));
        if (!fg || !bg) continue; // нечисловые значения пропускаем
        const ratio = contrast(fg, bg);
        if (ratio < min) {
          failures.push(
            `${theme}/${palette}: ${fgVar} на ${bgVar} = ${ratio.toFixed(2)} (< ${min})`,
          );
        }
      }
    }
  }
  assert.deepStrictEqual(failures, [], "Низкий контраст:\n" + failures.join("\n"));
});
