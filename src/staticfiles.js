// Единая версия статики: вычисляется из содержимого файлов, подставляется
// в index.html и sw.js вместо __STATIC_VERSION__. Меняется код → меняется
// версия везде одновременно, без ручного дрейфа.
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, "..", "public");

function computeStaticVersion() {
  const hash = crypto.createHash("sha256");
  for (const name of ["app.js", "styles.css", "index.html", "sw.js"]) {
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
  app.use(express.static(PUBLIC_DIR));
  app.get("*", (req, res) =>
    sendRendered(res, "index.html", "text/html; charset=utf-8"),
  );
}
