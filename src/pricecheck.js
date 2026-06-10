// Проверка цены по ссылке на товар: вытаскиваем цену из структурированных
// данных страницы (JSON-LD, meta-теги). Best-effort: часть магазинов закрыта от ботов.

import { lookup } from "node:dns/promises";
import net from "node:net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 600 * 1024;
const MAX_REDIRECTS = 5;

// SSRF-защита: сервер ходит по URL из пользовательского ввода, поэтому
// запрещаем всё, что резолвится в приватные/служебные адреса (localhost,
// 10/8, 172.16/12, 192.168/16, link-local, метаданные облаков и т.п.).
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd"))
      return true;
    // IPv4-mapped (::ffff:127.0.0.1)
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true; // не похоже на нормальный IPv4 — не рискуем
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

export async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("unsupported_protocol");
  // У IPv6 в URL hostname приходит в скобках: [::1]
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked_host");
    return u;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new Error("blocked_host");
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("dns_failed");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new Error("blocked_host");
  return u;
}

async function fetchHtml(url) {
  // Редиректы обрабатываем вручную, чтобы перепроверять каждый hop
  // (иначе публичный URL может средиректить на 169.254.169.254).
  let current = url;
  let res;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    res = await fetch(current, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`http_${res.status}`);
      current = new URL(loc, current).href;
      try {
        await res.body?.cancel();
      } catch {}
      continue;
    }
    break;
  }
  if (res.status >= 300 && res.status < 400) throw new Error("too_many_redirects");
  if (!res.ok) throw new Error(`http_${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try {
    await reader.cancel();
  } catch {}
  return Buffer.concat(chunks).toString("utf8");
}

function parseNumber(raw) {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(/\s|&nbsp;|\u00a0/g, "")
    .replace(/,(\d{1,2})$/, ".$1")
    .replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fromJsonLd(html) {
  const scripts = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of scripts) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
      for (const node of nodes) {
        const offers = node?.offers;
        const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const offer of offerList) {
          const price = parseNumber(offer?.price ?? offer?.lowPrice);
          if (price) return { price, currency: offer?.priceCurrency || null, source: "json-ld" };
        }
      }
    } catch {}
  }
  return null;
}

function fromMeta(html) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i,
    /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i,
    /itemprop=["']price["'][^>]*>([^<]+)</i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const price = parseNumber(m?.[1]);
    if (price) {
      const cur = html.match(
        /<meta[^>]+(?:property|name|itemprop)=["'](?:product:price:currency|og:price:currency|priceCurrency)["'][^>]+content=["']([^"']+)["']/i,
      );
      return { price, currency: cur?.[1] || null, source: "meta" };
    }
  }
  return null;
}

/**
 * @returns {Promise<{found:boolean, price?:number, currency?:string|null, source?:string, error?:string}>}
 */
export async function checkPrice(url) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return { found: false, error: e?.message || "fetch_failed" };
  }
  const result = fromJsonLd(html) || fromMeta(html);
  if (!result) return { found: false, error: "price_not_found" };
  return { found: true, ...result };
}
