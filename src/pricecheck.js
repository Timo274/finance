// Проверка цены по ссылке на товар: вытаскиваем цену из структурированных
// данных страницы (JSON-LD, meta-теги). Best-effort: часть магазинов закрыта от ботов.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 600 * 1024;

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
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
