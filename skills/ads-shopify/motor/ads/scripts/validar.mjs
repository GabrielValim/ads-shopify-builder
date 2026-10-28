#!/usr/bin/env node
/**
 * ADS Shopify Builder — validação de uma seção personalizada:
 *  1. schema + template contra as regras do Dawn 16 travado (reference/generator/dawn-schema.mjs): tipos, opções,
 *     limites, blocos, image_picker sem referência autorizada, links seguros;
 *  2. editabilidade: settings/blocos expostos, presets, textos visíveis vindos de settings (heurística);
 *  3. Theme Check: Dawn travado + a seção (+ template de prévia) → ofensas NOVAS em relação ao Dawn puro.
 * Uso: node validar.mjs <secao.liquid> <template.json> <saida-dir>
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(process.env.ADS_MOTOR_ROOT ?? join(import.meta.dirname, "../../../.."));
const { extractVerifiedDawn } = await import(join(ROOT, "reference/generator/dawn-base.mjs"));
const { ThemeSchema, validateTemplate } = await import(join(ROOT, "reference/generator/dawn-schema.mjs"));
const { extractSchema } = await import(join(ROOT, "experimental/cf01-code-first/lib/liquid-lite.mjs"));

const [secPath, tplPath, outDir] = process.argv.slice(2);
if (!secPath || !tplPath || !outDir) { console.error("uso: validar.mjs <secao.liquid> <template.json> <saida-dir>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const source = readFileSync(secPath, "utf8");
const type = basename(secPath, ".liquid");
const rawSchema = extractSchema(source);
const schema = rawSchema ? JSON.parse(rawSchema) : null;
const template = JSON.parse(readFileSync(tplPath, "utf8"));
const out = { kind: "AdsSectionValidation", secao: secPath, problemas: [], editabilidade: {}, themeCheck: null };

// 2. editabilidade
const settings = schema?.settings ?? [];
const byType = settings.reduce((m, s) => ((m[s.type] = (m[s.type] ?? 0) + 1), m), {});
out.editabilidade = { settings: settings.filter((s) => s.id).length, porTipo: byType, blocos: (schema?.blocks ?? []).map((b) => ({ tipo: b.type, settings: (b.settings ?? []).filter((s) => s.id).length })), maxBlocos: schema?.max_blocks ?? null, presets: (schema?.presets ?? []).length };
if (!schema) out.problemas.push("sem {% schema %}");
if (!(schema?.presets ?? []).length) out.problemas.push("sem presets: a seção não pode ser adicionada pelo Theme Editor");
if (!/#shopify-section-\{\{\s*section\.id\s*\}\}/.test(source)) out.problemas.push("CSS sem escopo #shopify-section-{{ section.id }}");
if (/<script\b/i.test(source)) out.problemas.push("JavaScript na seção");
if (/https?:\/\//.test(source.replace(/\{%-?\s*schema[\s\S]*?endschema\s*-?%\}/, ""))) out.problemas.push("URL externa no markup/CSS");
// texto visível fixo fora de settings (heurística: texto entre tags, sem Liquid)
const markup = source.replace(/\{%-?\s*schema[\s\S]*?endschema\s*-?%\}/, "").replace(/\{%-?\s*(style|stylesheet)\s*-?%\}[\s\S]*?\{%-?\s*end(style|stylesheet)\s*-?%\}/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const fixos = [...markup.matchAll(/>([^<>{}]*[A-Za-zÀ-ú]{3,}[^<>{}]*)</g)].map((m) => m[1].trim()).filter(Boolean);
if (fixos.length) out.problemas.push(`texto visível fixo (não editável): ${fixos.slice(0, 5).join(" | ")}`);

// 1 + 3. tema temporário = Dawn travado + seção (+ template de prévia como templates/index.json)
const base = await extractVerifiedDawn();
try {
    const check = () => { try { return JSON.parse(execFileSync("shopify", ["theme", "check", "--path", base.dir, "--output", "json", "--no-color"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CI: "1", SHOPIFY_CLI_NO_ANALYTICS: "1" }, encoding: "utf8", maxBuffer: 64 << 20 })); } catch (e) { return JSON.parse(e.stdout); } };
    const offenses = (data) => data.flatMap((f) => (f.offenses ?? []).map((o) => `${o.check} ${f.path.split("/").slice(-2).join("/")}: ${o.message}`));
    const before = new Set(offenses(check()));
    copyFileSync(secPath, join(base.dir, "sections", `${type}.liquid`));
    writeFileSync(join(base.dir, "templates", "index.json"), JSON.stringify(template, null, 2));
    const theme = await ThemeSchema.load(base.dir);
    const dawnData = JSON.parse(readFileSync(join(base.dir, "config", "settings_data.json"), "utf8"));
    const preset = typeof dawnData.current === "string" ? dawnData.presets[dawnData.current] : dawnData.current;
    const errors = validateTemplate(theme, template, { schemes: new Set(Object.keys(preset.color_schemes ?? {})), imageReferences: new Set() }, "templates/index.json");
    out.problemas.push(...errors);
    const after = offenses(check());
    const novas = after.filter((o) => !before.has(o));
    out.themeCheck = { dawnPuro: before.size, comSecao: after.length, novas };
    if (novas.length) out.problemas.push(...novas.map((n) => `Theme Check: ${n}`));
} finally { await base.cleanup(); }

out.ok = out.problemas.length === 0;
writeFileSync(join(outDir, "validacao.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${out.ok ? "OK" : "PROBLEMAS"} | settings ${out.editabilidade.settings} ${JSON.stringify(out.editabilidade.porTipo)} | blocos ${JSON.stringify(out.editabilidade.blocos)} | presets ${out.editabilidade.presets} | Theme Check novas ${out.themeCheck?.novas.length}`);
for (const p of out.problemas) console.log("  -", p);
process.exit(out.ok ? 0 : 1);
