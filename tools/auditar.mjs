#!/usr/bin/env node
/**
 * Auditoria de publicação do repositório ADS Shopify Builder (só módulos nativos do Node).
 * Falha se houver: credenciais/segredos, arquivos fora da lista permitida, dados locais (runs/, node_modules, .env),
 * arquivos do Dawn no repositório (são baixados da fonte oficial na preparação), versões inconsistentes ou licença fora do MIT.
 * Uso: node tools/auditar.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const RAIZ = resolve(import.meta.dirname, "..");
const SKILL = join(RAIZ, "skills/ads-shopify");
const problemas = [];
const walk = (d) => { const o = []; const w = (x) => { for (const e of readdirSync(x, { withFileTypes: true })) { if (e.name === ".git" && x === RAIZ) continue; const f = join(x, e.name); e.isDirectory() ? w(f) : o.push(f); } }; w(d); return o; };
const arquivos = walk(RAIZ).map((f) => relative(RAIZ, f).split(sep).join("/"));

// 1. somente arquivos esperados
const permitidos = [/^README\.md$/, /^LICENSE$/, /^THIRD_PARTY_NOTICES\.md$/, /^CHANGELOG\.md$/, /^\.gitattributes$/, /^\.gitignore$/,
    /^\.claude-plugin\/(plugin|marketplace)\.json$/, /^tools\/auditar\.mjs$/, /^skills\/ads-shopify\//];
for (const f of arquivos) if (!permitidos.some((r) => r.test(f))) problemas.push(`arquivo não permitido: ${f}`);
for (const f of arquivos) if (/(^|\/)(runs|node_modules|\.ads|lojas)\/|(^|\/)\.env|\.pem$|\.key$|\.p12$|historico\.jsonl$|autorizacao\.json$|enviado\.json$/.test(f)) problemas.push(`dado local/sensível: ${f}`);
for (const f of arquivos) if (statSync(join(RAIZ, f)).size > 2 * 1024 * 1024) problemas.push(`arquivo grande demais (>2 MB): ${f}`);

// 2. segredos (padrões de tokens conhecidos e chaves privadas)
const segredos = [/shp(at|ca|pa|ss)_[0-9a-f]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];
for (const f of arquivos) {
    const t = readFileSync(join(RAIZ, f), "latin1");
    for (const r of segredos) if (r.test(t)) problemas.push(`possível segredo em ${f} (${r})`);
}

// 3. Dawn: NÃO pode estar no repositório (código da Shopify); só o manifesto de hashes apontando para a fonte oficial
const man = JSON.parse(readFileSync(join(SKILL, "motor/themes/dawn.sha256.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(SKILL, "motor/themes/ads-base.lock.json"), "utf8"));
const presentes = arquivos.filter((f) => f.startsWith("skills/ads-shopify/motor/themes/dawn/"));
if (presentes.length) problemas.push(`arquivos do Dawn no repositório (devem ser baixados na preparação): ${presentes.length}`);
if (man.commit !== lock.upstream.commit) problemas.push("manifesto do Dawn de outro commit que o lock");
if (man.fonte !== `https://codeload.github.com/Shopify/dawn/tar.gz/${lock.upstream.commit}`) problemas.push(`fonte do Dawn não oficial: ${man.fonte}`);
if (Object.keys(man.arquivos ?? {}).length < 300 || !Object.values(man.arquivos).every((h) => /^[0-9a-f]{64}$/.test(h))) problemas.push("manifesto do Dawn incompleto ou inválido");
if (arquivos.some((f) => f.endsWith(".patch"))) problemas.push("patch de personalização presente");

// 4. versões consistentes
const versoes = {
    plugin: JSON.parse(readFileSync(join(RAIZ, ".claude-plugin/plugin.json"), "utf8")).version,
    marketplace: JSON.parse(readFileSync(join(RAIZ, ".claude-plugin/marketplace.json"), "utf8")).plugins.find((p) => p.name === "ads-shopify")?.version,
    motor: JSON.parse(readFileSync(join(SKILL, "motor/package.json"), "utf8")).version,
};
if (new Set(Object.values(versoes)).size !== 1) problemas.push(`versões divergentes: ${JSON.stringify(versoes)}`);
if (!readFileSync(join(RAIZ, "CHANGELOG.md"), "utf8").includes(`## ${versoes.plugin}`)) problemas.push(`CHANGELOG sem a versão ${versoes.plugin}`);

// 5. SKILL.md conforme o formato
const sk = readFileSync(join(SKILL, "SKILL.md"), "utf8");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(sk)?.[1] ?? "";
if (/^name:\s*(.+)$/m.exec(fm)?.[1].trim() !== "ads-shopify") problemas.push("SKILL.md: name ≠ ads-shopify");
if (((/^description:\s*(.+)$/m.exec(fm)?.[1] ?? "").trim().length || 999) > 200) problemas.push("SKILL.md: description > 200 caracteres");

// 6. licença definida
const lic = readFileSync(join(RAIZ, "LICENSE"), "utf8");
if (!/^MIT License\n\nCopyright \(c\) \d{4} \S/.test(lic) || !lic.includes("THE SOFTWARE IS PROVIDED \"AS IS\"")) problemas.push("LICENSE não é o texto MIT esperado com titular identificado");
if (JSON.parse(readFileSync(join(RAIZ, ".claude-plugin/plugin.json"), "utf8")).license !== "MIT") problemas.push("plugin.json sem license MIT");

if (problemas.length) { console.error(`AUDITORIA REPROVADA (${problemas.length}):\n  - ${problemas.join("\n  - ")}`); process.exit(1); }
console.log(`AUDITORIA OK — ${arquivos.length} arquivos, versão ${versoes.plugin}, licença MIT, Dawn fora do repositório (manifesto de ${Object.keys(man.arquivos).length} hashes, commit ${man.commit.slice(0, 7)})`);
