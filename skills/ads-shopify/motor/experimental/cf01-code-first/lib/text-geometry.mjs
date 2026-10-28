/**
 * CF-01 — GEOMETRIA DE TEXTO do candidato renderizado (H4 da proposta v4.2, contrato v4). A referência já tem
 * `text-<vp>.json` (linhas medidas por `Range.getClientRects`); o destino só tinha linhas ESTIMADAS por altura/entrelinha.
 *
 * `measureTextGeometryPass` roda DENTRO do confinamento da renderização (render-inner.mjs), depois da captura canônica,
 * numa sessão nova com os mesmos viewports e contexto do capturador: carrega a página, espera fontes e layout estáveis
 * e executa o MESMO `textGeometry` da captura de referência. Grava em `<dir>/text-<vp>.json`, FORA do diretório da
 * captura: o auditor e o avaliador v4.1 continuam lendo exatamente os mesmos arquivos (sem mudança de métrica).
 * A junção com o DOM capturado (tag + caixa exata) é contada; caixa diferente = sem junção (cai no estimado).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { textGeometry } from "./fidelity-capture.mjs";

export const TEXT_GEOMETRY_PASS_VERSION = "cf01-target-text-geometry/1";

/** Lê a geometria gravada pela passagem (null por viewport quando ausente). */
export function loadTargetTextGeometry(dir) {
    const out = {};
    for (const vp of ["desktop", "mobile"]) { const f = join(dir, `text-${vp}.json`); out[vp] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; }
    return out;
}

/** Dentro do confinamento: `url` da página servida no loopback; `ROOT` = raiz do repositório montada (somente leitura). */
export async function measureTextGeometryPass({ url, outDir, root, sandbox = false, timeoutMs = 30_000 }) {
    const { VIEWPORTS, launchCaptureBrowser, newCaptureContext } = await import(join(root, "reference/capture/browser.mjs"));
    const { startEgressProxy } = await import(join(root, "reference/capture/egress-proxy.mjs"));
    const { createUrlPolicy } = await import(join(root, "reference/core/url-policy.mjs"));
    const { fontStatus, documentMetrics } = await import(join(root, "reference/capture/page-scripts.mjs"));
    mkdirSync(outDir, { recursive: true });
    const proxy = await startEgressProxy({ policy: createUrlPolicy({ previewOrigins: [new URL(url).origin] }) });
    let browser;
    const report = { version: TEXT_GEOMETRY_PASS_VERSION, viewports: {} };
    try {
        browser = await launchCaptureBrowser({ proxyUrl: proxy.url, sandbox });
        for (const vp of ["desktop", "mobile"]) {
            const ctx = await newCaptureContext(browser, VIEWPORTS[vp]);
            try {
                const page = await ctx.newPage();
                await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
                const t0 = Date.now(); let last = -1, stable = false;
                while (Date.now() - t0 < timeoutMs) { const h = (await page.evaluate(documentMetrics)).scrollHeight; if (h === last && (await page.evaluate(fontStatus)) === "loaded") { stable = true; break; } last = h; await page.waitForTimeout(150); }
                const geo = await page.evaluate(textGeometry);
                writeFileSync(join(outDir, `text-${vp}.json`), JSON.stringify({ ...geo, pass: TEXT_GEOMETRY_PASS_VERSION, stable }, null, 2) + "\n");
                report.viewports[vp] = { entries: geo.entries.length, stable };
            } finally { await ctx.close(); }
        }
    } finally { await browser?.close(); await proxy.close(); }
    return report;
}
