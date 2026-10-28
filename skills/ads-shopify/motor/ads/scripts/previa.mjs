#!/usr/bin/env node
/**
 * ADS Shopify Builder — PRÉVIA LOCAL REAL de uma seção: interpreta o Liquid com o `liquid-lite` do projeto (valores do
 * template de prévia; sem entrada, os padrões do schema) e renderiza num Chromium CONFINADO (sem rede, CSP sem scripts),
 * capturando desktop (1440) e mobile (390) com o capturador do projeto (screenshot + DOM medido).
 * Não é a Shopify: fontes do tema vêm de --tema (variáveis CSS); o CSS do Dawn ao redor não é carregado.
 * Uso: node previa.mjs <secao.liquid> <template.json> <saida-dir> [--tema tema.json] [--chave <seção do template>]
 *   --chave: renderiza só essa seção de um template completo (ex.: templates/index.json de um projeto)
 *   template.json: { "sections": { "<chave>": { "type": "<arquivo sem .liquid>", "settings": {...}, "blocks": {...}, "block_order": [...] } }, "order": ["<chave>"] }
 *   tema.json (opcional): { "fonteTitulos": "...", "fonteCorpo": "...", "fundoPagina": "#..." }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(process.env.ADS_MOTOR_ROOT ?? join(import.meta.dirname, "../../../.."));
const { parse, render, extractSchema, sectionScope } = await import(join(ROOT, "experimental/cf01-code-first/lib/liquid-lite.mjs"));
const { renderIsolated } = await import(join(ROOT, "experimental/cf01-code-first/lib/render.mjs"));

async function renderPortatil(html, dir) {
    const { mkdirSync: mk, writeFileSync: wr, readdirSync: rd } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const pageDir = join(dir, "page"), capDir = join(dir, "capture");
    mk(pageDir, { recursive: true }); mk(capDir, { recursive: true });
    wr(join(pageDir, "index.html"), html, { flag: "wx" });
    const t = Date.now();
    const p = spawnSync(process.execPath, [join(ROOT, "experimental/cf01-code-first/lib/render-inner.mjs"), pageDir, capDir, "on"], { cwd: ROOT, encoding: "utf8", timeout: 300_000, env: process.env }); // página própria, sem scripts (CSP) e só no loopback; o Chromium precisa do ambiente do sistema (Windows/macOS)
    const runs = (() => { try { return rd(join(capDir, "127.0.0.1")); } catch { return []; } })();
    let summary = null; try { summary = JSON.parse(p.stdout.trim().split("\n").pop()); } catch {}
    return { exitCode: p.status, ms: Date.now() - t, captureDir: runs.length === 1 ? join(capDir, "127.0.0.1", runs[0]) : null, summary, stderrTail: (p.stderr ?? "").split("\n").slice(-8).join("\n"),
        isolation: { confine: "portátil (sem namespaces)", chromeSandbox: "on", csp: "script-src 'none'", rede: "só loopback (servidor local)" } };
}

const [secPath, tplPath, outDir, ...rest] = process.argv.slice(2);
if (!secPath || !tplPath || !outDir) { console.error("uso: previa.mjs <secao.liquid> <template.json> <saida-dir> [--tema tema.json]"); process.exit(2); }
const ti = rest.indexOf("--tema");
const tema = { fonteTitulos: "ui-sans-serif, system-ui, sans-serif", fonteCorpo: "ui-sans-serif, system-ui, sans-serif", fundoPagina: "#ffffff", ...(ti >= 0 ? JSON.parse(readFileSync(rest[ti + 1], "utf8")) : {}) };
if (existsSync(join(outDir, "screenshot-desktop.png"))) { console.error(`saída já existe: ${outDir} (use uma pasta nova)`); process.exit(2); }

const source = readFileSync(secPath, "utf8");
const type = basename(secPath, ".liquid");
const rawSchema = extractSchema(source);
const schema = rawSchema ? JSON.parse(rawSchema) : null;
if (!schema) { console.error("seção sem {% schema %}"); process.exit(1); }
const tplRaw = readFileSync(tplPath, "utf8");
const template = JSON.parse(tplRaw.replace(/^\s*\/\*[\s\S]*?\*\//, "")); // templates da Shopify podem começar com comentário
const ki = rest.indexOf("--chave");
const keys = ki >= 0 ? [rest[ki + 1]] : template.order ?? Object.keys(template.sections ?? {});
if (keys.some((k) => !template.sections?.[k])) { console.error(`seção inexistente no template: ${keys.join(", ")}`); process.exit(1); }
let body = "";
for (const key of keys) {
    const entry = template.sections[key];
    if (entry.type !== type) { console.error(`seção ${key} é do tipo ${entry.type}; esta prévia renderiza só ${type}`); process.exit(1); }
    const scope = sectionScope({ key, schema, entry });
    // request.design_mode = false: vitrine (moldura de imagem vazia só aparece no editor)
    const html = render(parse(source), { ...scope, request: { design_mode: false } });
    body += `<div id="shopify-section-${scope.section.id}" class="shopify-section">${html}</div>\n`;
}
const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{--font-heading-family:${tema.fonteTitulos};--font-body-family:${tema.fonteCorpo};--font-heading-weight:700;--font-body-weight:400}
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}body{background:${tema.fundoPagina};font-family:var(--font-body-family);-webkit-font-smoothing:antialiased}</style>
</head><body>${body}</body></html>`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "pagina.html"), page);
// Linux com namespaces: renderização CONFINADA (render-confine.sh). Demais sistemas (macOS/Windows) ou ADS_PREVIA_PORTATIL=1:
// o mesmo processo interno (servidor só no loopback, CSP sem scripts, capturador do motor) com a sandbox do próprio Chromium.
const portatil = process.platform !== "linux" || process.env.ADS_PREVIA_PORTATIL === "1";
const r = portatil ? await renderPortatil(page, join(outDir, "render")) : await renderIsolated({ html: page, outDir: join(outDir, "render") });
if (!r.captureDir) { console.error("renderização falhou:", r.exitCode, r.stderrTail); process.exit(1); }
for (const f of readdirSync(r.captureDir)) if (/^(screenshot|dom)-(desktop|mobile)\.(png|json)$/.test(f)) copyFileSync(join(r.captureDir, f), join(outDir, f));
writeFileSync(join(outDir, "previa.json"), JSON.stringify({ kind: "AdsLocalPreview", secao: secPath, template: tplPath, tema, render: { ms: r.ms, isolamento: r.isolation, resumo: r.summary }, aviso: "prévia LOCAL (liquid-lite + Chromium confinado); não é a renderização da Shopify" }, null, 2) + "\n");
console.log(`prévia: ${outDir} (desktop + mobile, ${r.ms} ms, ${r.summary?.ok ? "ok" : "ver render/"})`);
