// Единая версия статики: вычисляется из содержимого файлов, подставляется
// в index.html и sw.js вместо __STATIC_VERSION__. Меняется код → меняется
// версия везде одновременно, без ручного дрейфа.
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import express from "express";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, "..", "public");

// JS-модули фронтенда: app.js + всё из lib/ и views/. Они проходят через
// renderStatic (подстановка __STATIC_VERSION__ в import-URL) и участвуют
// в хэше версии (план 11.1: распил монолита на ES-модули).
function jsModuleFiles() {
  const files = ["app.js"];
  for (const dir of ["lib", "views"]) {
    try {
      for (const f of readdirSync(path.join(PUBLIC_DIR, dir))) {
        if (f.endsWith(".js")) files.push(`${dir}/${f}`);
      }
    } catch {}
  }
  return files;
}

function computeStaticVersion() {
  const hash = crypto.createHash("sha256");
  for (const name of [...jsModuleFiles(), "styles.css", "index.html", "sw.js"]) {
    try {
      hash.update(readFileSync(path.join(PUBLIC_DIR, name)));
    } catch {}
  }
  return hash.digest("hex").slice(0, 12);
}
export const STATIC_VERSION = computeStaticVersion();

const renderedStatic = new Map();
function renderStatic(name) {
  if (!renderedStatic.has(name)) {
    renderedStatic.set(
      name,
      readFileSync(path.join(PUBLIC_DIR, name), "utf8").replaceAll(
        "__STATIC_VERSION__",
        STATIC_VERSION,
      ),
    );
  }
  return renderedStatic.get(name);
}
function sendRendered(res, name, type) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.setHeader("Content-Type", type);
  res.send(renderStatic(name));
}

export function registerStatic(app) {
  app.get(["/", "/index.html"], (req, res) =>
    sendRendered(res, "index.html", "text/html; charset=utf-8"),
  );
  app.get("/sw.js", (req, res) =>
    sendRendered(res, "sw.js", "application/javascript; charset=utf-8"),
  );
  // JS-модули рендерятся (подстановка версии в import-URL). URL версионирован
  // через ?v= → можно кэшировать надолго; без ?v= — no-store (dev).
  for (const name of jsModuleFiles()) {
    app.get(`/${name}`, (req, res) => {
      res.setHeader(
        "Cache-Control",
        req.query.v ? "public, max-age=604800, immutable" : "no-store, must-revalidate",
      );
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.send(renderStatic(name));
    });
  }
  // Статика версионируется через ?v=STATIC_VERSION → можно кэшировать
  // надолго: смена кода меняет URL (аудит 17.4).
  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: "7d",
      setHeaders(res, filePath) {
        if (/\.(?:png|svg|webmanifest|woff2?)$/.test(filePath))
          res.setHeader("Cache-Control", "public, max-age=2592000");
      },
    }),
  );
  // SPA-fallback только для «страничных» путей: запросы файлов с расширением
  // должны получать честный 404, а не index.html (аудит 12.5).
  app.get("*", (req, res) => {
    if (path.extname(req.path)) return res.status(404).send("Not found");
    sendRendered(res, "index.html", "text/html; charset=utf-8");
  });
}
