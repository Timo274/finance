import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, checkPrice } from "../src/pricecheck.js";

describe("pricecheck SSRF guard", () => {
  it("отклоняет не-http(s) протоколы", async () => {
    await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /unsupported_protocol/);
    await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/x"), /unsupported_protocol/);
    await assert.rejects(() => assertPublicHttpUrl("gopher://example.com"), /unsupported_protocol/);
  });

  it("отклоняет кривые URL", async () => {
    await assert.rejects(() => assertPublicHttpUrl("not a url"), /invalid_url/);
  });

  it("блокирует localhost и приватные IP", async () => {
    const blocked = [
      "http://127.0.0.1/admin",
      "http://localhost:3000/api/export",
      "http://10.0.0.5/",
      "http://172.16.1.1/",
      "http://192.168.1.1/router",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://100.64.0.1/", // CGNAT
    ];
    for (const url of blocked) {
      await assert.rejects(() => assertPublicHttpUrl(url), /blocked_host/, url);
    }
  });

  it("блокирует hostnames внутренних зон", async () => {
    await assert.rejects(() => assertPublicHttpUrl("http://printer.local/"), /blocked_host/);
    await assert.rejects(() => assertPublicHttpUrl("http://db.internal/"), /blocked_host/);
  });

  it("пропускает публичные IP без DNS-резолва", async () => {
    const u = await assertPublicHttpUrl("https://1.1.1.1/page");
    assert.equal(u.hostname, "1.1.1.1");
  });

  it("checkPrice возвращает ошибку вместо исключения для заблокированного URL", async () => {
    const result = await checkPrice("http://127.0.0.1/secret");
    assert.equal(result.found, false);
    assert.equal(result.error, "blocked_host");
  });
});
