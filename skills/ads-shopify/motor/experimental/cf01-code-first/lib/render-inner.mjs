/**
 * CF-01 — processo INTERNO da renderização. Só roda dentro de render-confine.sh (raiz própria, sem rede externa, env
 * vazio, seccomp, limites) lançado por render.mjs.
 *
 * Serve UM arquivo (index.html) no loopback com CSP restritiva e captura com o capturador canônico do ADS
 * (mesmas dimensões e mesma preparação da referência). Uso: node render-inner.mjs <pageDir> <outDir>
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { captureReference } from "../../../reference/capture/capture.mjs";
import { createUrlPolicy } from "../../../reference/core/url-policy.mjs";

const [pageDir, outDir, chromeSandbox = "on", extra = ""] = process.argv.slice(2);
const page = await readFile(join(pageDir, "index.html"));
// Sem scripts: o código gerado não executa JavaScript (o capturador injeta o dele pelo protocolo do navegador, fora da CSP).
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" });
        res.end(page);
    } else {
        res.writeHead(404, { "content-security-policy": CSP });
        res.end();
    }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
    const result = await captureReference({ url: `${origin}/`, policy: createUrlPolicy({ previewOrigins: [origin] }), runsDir: outDir, options: { sandbox: chromeSandbox === "on" } });
    // contrato v4 (opcional): geometria de texto do candidato, gravada FORA da captura (<saída>/geometry)
    let geometry = null;
    if (extra === "geometry" && result.ok) {
        const { measureTextGeometryPass } = await import("./text-geometry.mjs");
        geometry = await measureTextGeometryPass({ url: `${origin}/`, outDir: join(outDir, "geometry"), root: join(import.meta.dirname, "../../.."), sandbox: chromeSandbox === "on" }).catch((e) => ({ error: String(e.message).split("\n")[0].slice(0, 200) }));
    }
    process.stdout.write(JSON.stringify({ ok: result.ok, error: result.error ? { code: result.error.code, message: result.error.message } : null, warnings: (result.warnings ?? []).map((w) => w.code), ...(geometry ? { geometry } : {}) }) + "\n");
} finally {
    server.close();
}
