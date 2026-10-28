#!/usr/bin/env node
/**
 * ADS Shopify Builder — PROJETO de loja completa (ver ../ARQUITETURA.md).
 * Projetos ficam SÓ em runs/ads-shopify/projetos/<slug>/; este script nunca escreve no núcleo da Skill.
 *
 *   iniciar   <slug> --loja <x.myshopify.com> (--url <url> | --captura <dir>) [--conteudo <content-pack.json>]
 *   estado    <slug>
 *   validar   <slug>                       tema inteiro: schema Dawn de todos os templates/grupos, settings_data,
 *                                          seções ads-* (escopo, sem JS/URL externa, presets), Theme Check sem ofensas novas
 *   versao    <slug> --nota "<texto>" [--solicitacao "<pedido do operador>"]   (exige validar OK)
 *   diff      <slug> [vA] [vB]
 *   rollback  <slug> <vNNN> [--incluir-editor]   restaura vNNN como NOVA versão (histórico preservado); edições do
 *                                          Theme Editor posteriores a vNNN são mantidas, salvo --incluir-editor
 *   preflight <slug> [--fixar-publicado <id>]   verificação antes do envio; Shopify SÓ leitura (theme list)
 *   autorizar <slug> --operacao criar|atualizar --citacao "<palavras do operador>" [--horas 8] [--uso-unico] [--arquivos a,b]
 *   enviar    <slug>                       cria o rascunho (tema NOVO, unpublished)       — exige autorização "criar"
 *   atualizar <slug>                       atualiza O MESMO rascunho (backup, editor preservado) — exige "atualizar"
 *   instalar  <slug> <ads-componente> [--regiao section-NN] [--substituir]   copia da biblioteca do núcleo para o tema do projeto
 *   reconciliar <slug>                     refaz a conferência do envio inicial com o pull já baixado (sem rede)
 *   abrir     <slug>                       links de prévia e editor do rascunho
 * Shopify: CLI autenticada do operador (`shopify`); ADS_SHOPIFY_STUB=<script> usa uma loja SIMULADA (testes).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.env.ADS_MOTOR_ROOT ?? join(import.meta.dirname, "../../../.."));
const PROJETOS = resolve(process.env.ADS_PROJETOS_DIR ?? join(ROOT, "runs/ads-shopify/projetos"));
const STUB = process.env.ADS_SHOPIFY_STUB ?? null;
const SHOPIFY = STUB ? [process.execPath, STUB] : ["shopify"];

const [cmd, slug, ...rest] = process.argv.slice(2);
const opt = (k, d = null) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const die = (msg, code = 1) => { console.error(`[ERRO] ${msg}`); process.exit(code); };
const now = () => new Date().toISOString();
const stamp = () => now().replace(/[-:]/g, "").replace(/\.\d+/, "");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

if (!cmd || !slug) die("uso: projeto.mjs <comando> <slug> [opções] — ver cabeçalho do script", 2);
if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) die("slug inválido (a-z, 0-9, hífen)");
const P = join(PROJETOS, slug);
if (!P.startsWith(PROJETOS + sep)) die("projeto fora de runs/ads-shopify/projetos");
const pj = (...x) => join(P, ...x);
const TEMA = pj("tema");
const historico = (evento) => appendFileSync(pj("historico.jsonl"), JSON.stringify({ em: now(), ...evento }) + "\n");
const projeto = () => (existsSync(pj("projeto.json")) ? readJson(pj("projeto.json")) : die(`projeto ${slug} não existe`));
const salvarProjeto = (p) => writeJson(pj("projeto.json"), p);

function arquivos(dir) {
    const out = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) out.push(relative(dir, f).split(sep).join("/")); } };
    if (existsSync(dir)) walk(dir);
    return out.sort();
}
const manifesto = (dir) => Object.fromEntries(arquivos(dir).map((f) => [f, sha(readFileSync(join(dir, f)))]));
// a Shopify só aceita as pastas de tema; o resto (README, .github, LICENSE…) fica só no projeto
const DIRS_TEMA = /^(assets|config|layout|locales|sections|snippets|templates|blocks)\//;
const deTema = (m) => Object.fromEntries(Object.entries(m).filter(([f]) => DIRS_TEMA.test(f)));
function pacote(dir, nome) {
    const d = pj("remoto", `${stamp()}-${nome}`);
    for (const f of Object.keys(deTema(manifesto(dir)))) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(dir, f), join(d, f)); }
    return d;
}
// mesma normalização que a Shopify aplica a JSON (comentário inicial, objetos/listas vazios) — ver painel/comparar-pull.py
const prune = (o) => (Array.isArray(o) ? o.map(prune) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, prune(v)]).filter(([, v]) => !(v && typeof v === "object" && Object.keys(v).length === 0))) : o);
function mesmoConteudo(f, a, b) {
    if (a.equals(b)) return true;
    if (!f.endsWith(".json")) return false;
    const norm = (x) => {
        const j = JSON.parse(x.toString("utf8").replace(/^\s*\/\*[\s\S]*?\*\//, ""));
        // Dawn 16: a Shopify descarta 2 settings fora do schema do bloco de anúncio (mesma regra do painel/comparar-pull.py)
        if (f === "sections/header-group.json") for (const blk of Object.values(j.sections?.["announcement-bar"]?.blocks ?? {})) for (const k of ["text_alignment", "color_scheme"]) delete blk.settings?.[k];
        const canon = (o) => (Array.isArray(o) ? o.map(canon) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])])) : o);
        return JSON.stringify(canon(prune(j)));
    };
    try { return norm(a) === norm(b); } catch { return false; }
}
const versoes = () => (existsSync(pj("versoes")) ? readdirSync(pj("versoes")).filter((v) => /^v\d{3}$/.test(v)).sort() : []);
const proximaVersao = () => `v${String(versoes().length + 1).padStart(3, "0")}`;

function cli(args, { timeout = 900_000 } = {}) {
    const r = spawnSync(process.execPath, [join(ROOT, "reference/cli.mjs"), ...args], { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 64 << 20 });
    const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (r.status !== 0) die(`reference/cli.mjs ${args[0]} falhou:\n${log.trim().split("\n").slice(-8).join("\n")}`);
    return log;
}
const pick = (log, re) => { const m = log.match(re); return m ? relative(ROOT, resolve(ROOT, m[1].trim())) : null; };

// ---------------- validação do tema inteiro ----------------
async function validarTema(dir, base) {
    const { ThemeSchema, validateTemplate, validateSettingsData } = await import(join(ROOT, "reference/generator/dawn-schema.mjs"));
    const { runThemeCheck, compareOffenses } = await import(join(ROOT, "reference/generator/theme-check.mjs"));
    const problemas = [];
    const theme = await ThemeSchema.load(dir);
    const data = readJson(join(dir, "config/settings_data.json"));
    problemas.push(...validateSettingsData(theme, data));
    const preset = typeof data.current === "string" ? data.presets[data.current] : data.current;
    const context = { schemes: new Set(Object.keys(preset?.color_schemes ?? {})), imageReferences: new Set(base.imagens ?? []) };
    // regras por arquivo: só o que mudou desde a base ACEITA (Dawn travado + gerador, aprovados pelo verify-theme)
    const atual = manifesto(dir);
    const mudou = (f) => !base.manifesto || base.manifesto[f] !== atual[f];
    const jsons = Object.keys(atual).filter((f) => (/^templates\/[^/]+\.json$/.test(f) || /^sections\/[^/]+\.json$/.test(f)) && mudou(f));
    for (const f of jsons) problemas.push(...validateTemplate(theme, readJson(join(dir, f)), context, f));
    // seções próprias (ads-*): regras da Skill (REGRAS.md)
    const proprias = Object.keys(atual).filter((f) => /^sections\/ads-[a-z0-9-]+\.liquid$/.test(f) && mudou(f));
    for (const f of proprias) {
        const src = readFileSync(join(dir, f), "utf8");
        const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(src);
        let schema = null; try { schema = m && JSON.parse(m[1]); } catch { problemas.push(`${f}: schema JSON inválido`); }
        if (!schema) { problemas.push(`${f}: sem {% schema %}`); continue; }
        if (!(schema.presets ?? []).length) problemas.push(`${f}: sem presets (não pode ser adicionada pelo editor)`);
        if ((schema.settings ?? []).length > 40) problemas.push(`${f}: ${schema.settings.length} settings (máximo 40)`);
        // regras que a Shopify aplica no upload e que o Theme Check não verifica (envio real de 28/10)
        for (const st of [...(schema.settings ?? []), ...(schema.blocks ?? []).flatMap((b) => b.settings ?? [])].filter((x) => x.type === "range")) {
            const n = (st.max - st.min) / st.step;
            if (!Number.isInteger(n) || n < 3 || n > 101) problemas.push(`${f}: range "${st.id}" com ${n} passos (a Shopify exige de 3 a 101)`);
            if (st.default !== undefined && (st.default < st.min || st.default > st.max || !Number.isInteger((st.default - st.min) / st.step))) problemas.push(`${f}: range "${st.id}" com padrão fora do passo/limites`);
        }
        if (!/#shopify-section-\{\{\s*section\.id\s*\}\}/.test(src)) problemas.push(`${f}: CSS sem escopo #shopify-section-{{ section.id }}`);
        const markup = src.replace(m[0], "");
        if (/<script\b/i.test(markup)) problemas.push(`${f}: JavaScript na seção`);
        if (/https?:\/\//.test(markup)) problemas.push(`${f}: URL externa no markup/CSS`);
    }
    // arquivos só nas pastas de tema
    for (const f of Object.keys(atual).filter(mudou)) if (!/^(assets|config|layout|locales|sections|snippets|templates|blocks)\/|^(LICENSE\.md|README\.md|release-notes\.md)$/.test(f)) problemas.push(`arquivo fora das pastas do tema: ${f}`);
    const offenses = await runThemeCheck(dir);
    const cmp = compareOffenses(base.themeCheck ?? [], offenses);
    for (const o of cmp.newOffenses) problemas.push(`Theme Check ${o.check} ${o.path}${o.line ? `:${o.line}` : ""}: ${o.message}`);
    return { ok: problemas.length === 0, problemas, templates: jsons.length, secoesProprias: proprias, themeCheck: { base: cmp.baseline, atual: cmp.generated, novas: cmp.newOffenses.length }, offenses };
}

function salvarVersao(p, { nota, solicitacao = null, validacao, origem = "edicao" }) {
    const v = proximaVersao();
    const d = pj("versoes", v);
    cpSync(TEMA, join(d, "tema"), { recursive: true });
    const man = manifesto(join(d, "tema"));
    const anterior = p.versaoAtual ? readJson(pj("versoes", p.versaoAtual, "versao.json")).manifesto : {};
    const alterados = Object.keys({ ...anterior, ...man }).filter((f) => anterior[f] !== man[f]).sort();
    writeJson(join(d, "versao.json"), { versao: v, criadaEm: now(), origem, nota, solicitacao, anterior: p.versaoAtual ?? null, alterados, validacao: { ok: validacao.ok, problemas: validacao.problemas, themeCheck: validacao.themeCheck }, manifesto: man });
    p.versaoAtual = v; salvarProjeto(p);
    historico({ evento: "versao", versao: v, origem, nota, solicitacao, alterados: alterados.length });
    return { v, alterados };
}

// ---------------- Shopify ----------------
function shopify(args, logName, timeout = 900_000) {
    const r = spawnSync(SHOPIFY[0], [...SHOPIFY.slice(1), ...args], { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 64 << 20, env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", SHOPIFY_CLI_NO_ANALYTICS: "1", ...(STUB ? { ADS_STUB_LOJA: process.env.ADS_STUB_LOJA ?? "" } : {}) } });
    mkdirSync(pj("remoto", "logs"), { recursive: true });
    writeFileSync(pj("remoto", "logs", `${stamp()}-${logName}.log`), `$ ${STUB ? "STUB-shopify" : "shopify"} ${args.join(" ")}\n--- stdout\n${r.stdout ?? ""}\n--- stderr\n${r.stderr ?? ""}\n`);
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function listar(loja) {
    const r = shopify(["theme", "list", "--store", loja, "--json"], "lista", 120_000);
    try { const v = JSON.parse(r.stdout.trim()); if (Array.isArray(v) && v.every((t) => Number.isSafeInteger(t.id) && typeof t.role === "string")) return v; } catch {}
    die("não foi possível listar os temas (a Shopify CLI está autenticada nesta loja? `shopify theme list --store …`)");
}
function autorizacaoValida(p, operacao) {
    if (!existsSync(pj("autorizacao.json"))) return "sem autorização registrada para este projeto";
    const a = readJson(pj("autorizacao.json"));
    if (!a.operacoes?.includes(operacao)) return `a autorização não cobre "${operacao}"`;
    if (a.loja !== p.loja) return "a autorização é de outra loja";
    if (Date.parse(a.expiraEm) < Date.now()) return `autorização expirada em ${a.expiraEm}`;
    if (operacao === "atualizar" && a.temaId !== p.rascunho?.id) return `a autorização é do tema ${a.temaId}, não do rascunho ${p.rascunho?.id}`;
    if (a.usoUnico && a.consumidaEm) return `autorização de uso único já consumida em ${a.consumidaEm}`;
    return null;
}
const links = (p) => {
    const h = p.loja.replace(/\.myshopify\.com$/, "");
    return { previa: `https://${p.loja}/?preview_theme_id=${p.rascunho.id}`, editor: `https://admin.shopify.com/store/${h}/themes/${p.rascunho.id}/editor` };
};
function pull(p, nome) {
    const d = pj("remoto", `${stamp()}-${nome}`);
    mkdirSync(d, { recursive: true });
    const r = shopify(["theme", "pull", "--store", p.loja, "--theme", String(p.rascunho.id), "--path", d], `pull-${nome}`);
    if (!r.ok) die(`pull (${nome}) falhou; nada alterado no rascunho por este passo`);
    return d;
}
// o tema publicado observado tem de ser o fixado no preflight (nunca alvo; nunca pode ter mudado)
function conferirPublicado(p, lista) {
    const live = lista.find((t) => t.role === "live");
    if (!p.publicadoEsperado) die("tema publicado esperado não fixado; rode: preflight <slug> --fixar-publicado <id>");
    if (live?.id !== p.publicadoEsperado.id) die(`tema publicado ${live?.id} ≠ esperado ${p.publicadoEsperado.id}; nada enviado`);
    return live;
}
// a lista de temas confirma: alvo existe, é unpublished e não é o publicado
function conferirAlvo(p, lista) {
    const live = conferirPublicado(p, lista);
    const alvo = lista.find((t) => t.id === p.rascunho.id);
    if (!alvo) die(`o rascunho ${p.rascunho.id} não existe mais na loja; nada enviado`);
    if (alvo.role !== "unpublished") die(`o tema ${alvo.id} tem papel "${alvo.role}" (só "unpublished" é alvo); nada enviado`);
    if (live && live.id === alvo.id) die("o alvo é o tema publicado; nada enviado");
    return live;
}

// ---------------- comandos ----------------
const C = {};

C.iniciar = async () => {
    if (existsSync(P)) die(`projeto ${slug} já existe`);
    const loja = opt("--loja"), url = opt("--url");
    let captura = opt("--captura");
    const conteudo = opt("--conteudo");
    if (!loja || !/^[a-z0-9-]+\.myshopify\.com$/.test(loja)) die("--loja <x.myshopify.com> obrigatório");
    if (!url && !captura) die("--url ou --captura obrigatório");
    if (!captura) { cli(["check-url", url], { timeout: 120_000 }); captura = pick(cli(["capture", url]), /Execução:\s*(\S+)/) ?? die("captura sem diretório"); }
    const cap = readJson(join(ROOT, captura, "manifest.json"));
    const ana = pick(cli(["analyze", captura]), /Análise:\s*(\S+)/) ?? die("análise sem diretório");
    const gen = pick(cli(["generate", ana, ...(conteudo ? ["--content", conteudo] : []), "--apply"]), /\[OK\] Tema gerado:\s*(\S+)\/theme/) ?? die("geração sem diretório");
    const ver = cli(["verify-theme", gen, ...(conteudo ? ["--content", conteudo] : [])]);
    if (!/Tema apto para prévia/.test(ver)) die("o tema gerado não passou no verify-theme");
    mkdirSync(P, { recursive: true });
    cpSync(join(ROOT, gen, "theme"), TEMA, { recursive: true });
    // componentes: região da referência → arquivo/seção do tema
    const map = readJson(join(ROOT, gen, "generation-map.json"));
    const bp = readJson(join(ROOT, ana, "blueprint.json"));
    writeJson(pj("componentes.json"), { fonte: { analise: ana, geracao: gen }, componentes: bp.sections.map((s) => {
        const g = map.sections.find((x) => x.blueprintSectionId === s.id) ?? {};
        return { regiao: s.id, tipoReferencia: s.type, status: g.status ?? "unknown", arquivo: g.shopify?.file ?? null, chave: g.shopify?.key ?? null, secao: g.shopify?.type ?? null, origem: !g.shopify ? "nao-gerado" : g.shopify.type.startsWith("ads-") ? "componente-registrado" : "nativo-dawn",
            caixas: { desktop: s.viewports?.desktop?.box ?? null, mobile: s.viewports?.mobile?.box ?? null } };
    }) });
    const imagens = [...new Set(arquivos(TEMA).filter((f) => f.endsWith(".json")).flatMap((f) => readFileSync(join(TEMA, f), "utf8").match(/shopify:\/\/shop_images\/[^"]+/g) ?? []))];
    const { runThemeCheck } = await import(join(ROOT, "reference/generator/theme-check.mjs"));
    const base = { themeCheck: await runThemeCheck(TEMA), imagens, manifesto: manifesto(TEMA) };
    const p = { schema: 1, slug, criadoEm: now(), loja, referencia: { url: url ?? cap.source?.url ?? null, captura }, base: { analise: ana, geracao: gen, conteudo, aceitos: "verify-theme: Tema apto para prévia" }, rascunho: null, versaoAtual: null };
    writeJson(pj("base.json"), base);
    salvarProjeto(p);
    historico({ evento: "iniciar", referencia: p.referencia, base: p.base });
    const val = await validarTema(TEMA, base);
    if (!val.ok) die(`tema base inválido: ${val.problemas.slice(0, 5).join(" | ")}`);
    const { v } = salvarVersao(p, { nota: "tema base (gerador determinístico + conteúdo autorizado)", validacao: val, origem: "base" });
    console.log(`[OK] projeto ${slug}: ${v} | ${arquivos(TEMA).length} arquivos | ${val.templates} templates/grupos | Theme Check base ${val.themeCheck.atual}`);
    console.log(`     tema de trabalho: ${relative(ROOT, TEMA)}`);
};

C.estado = async () => {
    const p = projeto();
    const comps = readJson(pj("componentes.json")).componentes;
    const aut = existsSync(pj("autorizacao.json")) ? readJson(pj("autorizacao.json")) : null;
    const pend = existsSync(pj("pendencias.json")) ? readJson(pj("pendencias.json")) : [];
    const atual = p.versaoAtual ? readJson(pj("versoes", p.versaoAtual, "versao.json")).manifesto : {};
    const trabalho = manifesto(TEMA);
    const naoVersionado = Object.keys({ ...atual, ...trabalho }).filter((f) => atual[f] !== trabalho[f]);
    console.log(`projeto ${slug} | loja ${p.loja} | referência ${p.referencia.url}`);
    console.log(`versão atual ${p.versaoAtual} (${versoes().length} versões)${naoVersionado.length ? ` | ${naoVersionado.length} arquivo(s) alterado(s) sem versão: ${naoVersionado.slice(0, 6).join(", ")}` : ""}`);
    console.log(`rascunho: ${p.rascunho ? `${p.rascunho.id} "${p.rascunho.nome}" — versão enviada ${p.rascunho.versaoEnviada}${STUB || p.rascunho.simulado ? " [LOJA SIMULADA]" : ""}` : "não criado"}`);
    console.log(`autorização: ${aut ? `${aut.operacoes.join("+")} tema ${aut.temaId ?? "(novo)"} até ${aut.expiraEm}${Date.parse(aut.expiraEm) < Date.now() ? " — EXPIRADA" : ""}` : "nenhuma"}`);
    console.log("componentes:");
    for (const c of comps) console.log(`  ${c.regiao} ${c.tipoReferencia.padEnd(14)} → ${c.arquivo ?? "-"}${c.chave ? `#${c.chave}` : ""} (${c.secao ?? c.status}, ${c.origem})`);
    if (pend.length) { console.log("pendências:"); for (const x of pend) console.log(`  ${x.regiao}: ${x.texto}`); }
};

C.validar = async () => {
    projeto();
    const val = await validarTema(TEMA, readJson(pj("base.json")));
    writeJson(pj("trabalho", "validacao-atual.json"), val);
    console.log(`${val.ok ? "OK" : "PROBLEMAS"} | templates/grupos ${val.templates} | seções próprias ${val.secoesProprias.length} | Theme Check ${val.themeCheck.atual} (base ${val.themeCheck.base}, novas ${val.themeCheck.novas})`);
    for (const x of val.problemas) console.log("  -", x);
    process.exitCode = val.ok ? 0 : 1;
};

C.versao = async () => {
    const p = projeto();
    const nota = opt("--nota") ?? die("--nota obrigatório");
    const val = await validarTema(TEMA, readJson(pj("base.json")));
    if (!val.ok) die(`validação falhou; versão NÃO criada:\n  - ${val.problemas.join("\n  - ")}`);
    const { v, alterados } = salvarVersao(p, { nota, solicitacao: opt("--solicitacao"), validacao: val });
    console.log(`[OK] ${v}: ${alterados.length} arquivo(s) alterado(s)${alterados.length ? ": " + alterados.slice(0, 10).join(", ") : ""}`);
};

C.diff = async () => {
    projeto();
    const vs = versoes();
    const [a, b] = [rest[0] ?? vs.at(-2), rest[1] ?? vs.at(-1)];
    const ma = readJson(pj("versoes", a, "versao.json")).manifesto, mb = readJson(pj("versoes", b, "versao.json")).manifesto;
    for (const f of Object.keys({ ...ma, ...mb }).sort()) if (ma[f] !== mb[f]) console.log(`${!ma[f] ? "+" : !mb[f] ? "-" : "M"} ${f}`);
};

C.rollback = async () => {
    const p = projeto();
    const alvo = rest[0];
    if (!versoes().includes(alvo)) die(`versão inexistente: ${alvo}`);
    const d = pj("versoes", alvo, "tema");
    const val = await validarTema(d, readJson(pj("base.json")));
    if (!val.ok) die(`a versão ${alvo} não passa mais na validação; rollback recusado`);
    // edições do Theme Editor importadas DEPOIS de alvo: mantidas, salvo --incluir-editor
    const depois = versoes().filter((x) => x > alvo).map((x) => readJson(pj("versoes", x, "versao.json")));
    const doEditor = [...new Set(depois.filter((x) => x.origem === "theme-editor").flatMap((x) => x.alterados))];
    const manter = rest.includes("--incluir-editor") ? [] : doEditor.filter((f) => existsSync(join(TEMA, f)));
    const guardados = Object.fromEntries(manter.map((f) => [f, readFileSync(join(TEMA, f))]));
    rmSync(TEMA, { recursive: true, force: true });
    cpSync(d, TEMA, { recursive: true });
    for (const [f, buf] of Object.entries(guardados)) { mkdirSync(dirname(join(TEMA, f)), { recursive: true }); writeFileSync(join(TEMA, f), buf); }
    const val2 = manter.length ? await validarTema(TEMA, readJson(pj("base.json"))) : val;
    if (!val2.ok) die(`rollback com as edições do editor mantidas não valida (${val2.problemas.slice(0, 3).join(" | ")}); use --incluir-editor para reverter também`);
    const { v, alterados } = salvarVersao(p, { nota: `rollback para ${alvo}${manter.length ? ` (mantidas edições do Theme Editor: ${manter.join(", ")})` : ""}`, validacao: val2, origem: `rollback:${alvo}` });
    console.log(`[OK] ${v} = conteúdo de ${alvo} (${alterados.length} arquivo(s) revertido(s)). Para o rascunho: atualizar ${slug}`);
    if (manter.length) console.log(`[INFO] edições do Theme Editor mantidas: ${manter.join(", ")} (--incluir-editor reverte também)`);
};

C.autorizar = async () => {
    const p = projeto();
    const operacao = opt("--operacao"), citacao = opt("--citacao"), horas = Number(opt("--horas", "8"));
    if (!["criar", "atualizar"].includes(operacao)) die("--operacao criar|atualizar");
    if (!citacao || citacao.trim().length < 8) die("--citacao com as palavras do operador é obrigatória");
    if (!(horas > 0 && horas <= 24)) die("--horas entre 1 e 24");
    if (operacao === "atualizar" && !p.rascunho) die("não há rascunho para atualizar; autorize \"criar\" primeiro");
    const arquivosEsperados = opt("--arquivos") ? opt("--arquivos").split(",").map((x) => x.trim()).filter(Boolean).sort() : null;
    const a = { projeto: slug, loja: p.loja, operacoes: operacao === "criar" ? ["criar"] : ["atualizar"], temaId: operacao === "atualizar" ? p.rascunho.id : null,
        usoUnico: rest.includes("--uso-unico"), ...(arquivosEsperados ? { arquivosEsperados } : {}),
        concedidaEm: now(), expiraEm: new Date(Date.now() + horas * 3_600_000).toISOString(), citacao,
        exclui: ["tema publicado", "publish", "delete", "--live/--allow-live", "qualquer outro tema"] };
    writeJson(pj("autorizacao.json"), a);
    historico({ evento: "autorizacao", ...a });
    console.log(`[OK] autorização: ${a.operacoes.join("+")} | loja ${a.loja} | tema ${a.temaId ?? "(novo)"} | até ${a.expiraEm}`);
};

C.enviar = async () => {
    const p = projeto();
    if (p.rascunho) die(`já existe rascunho ${p.rascunho.id}; use "atualizar"`);
    const bloq = autorizacaoValida(p, "criar"); if (bloq) die(bloq);
    const v = p.versaoAtual;
    const dv = pj("versoes", v, "tema");
    const man = readJson(pj("versoes", v, "versao.json")).manifesto;
    if (JSON.stringify(manifesto(dv)) !== JSON.stringify(man)) die(`snapshot ${v} alterado depois de criado; nada enviado`);
    if (JSON.stringify(manifesto(TEMA)) !== JSON.stringify(man)) die(`o tema de trabalho tem alterações sem versão; crie a versão antes (versao ${slug} --nota …)`);
    const nome = `ADS ${slug.slice(0, 24)} ${v}-${stamp().slice(4, 13)}`;
    const antes = listar(p.loja);
    const live = conferirPublicado(p, antes);
    if (antes.some((t) => t.name === nome)) die("já existe um tema com este nome; nada enviado");
    const envio = pacote(dv, "envio-criar");
    historico({ evento: "envio-iniciado", versao: v, nome, publicado: live?.id ?? null, arquivos: arquivos(envio).length });
    const r = shopify(["theme", "push", "--store", p.loja, "--path", envio, "--unpublished", "--theme", nome, "--json"], "push-criar");
    let novo = null; try { novo = JSON.parse(r.stdout.trim()).theme; } catch {}
    if (!r.ok || !novo || !Number.isSafeInteger(novo.id)) die("o envio falhou ou a resposta não foi reconhecida; confira a loja (theme list) antes de tentar de novo");
    if (novo.role !== "unpublished" || antes.some((t) => t.id === novo.id)) die(`resultado inesperado: tema ${novo.id} papel ${novo.role}; confira a loja`);
    const recusados = Object.keys(novo.errors ?? {});
    p.rascunho = { id: novo.id, nome, criadoEm: now(), versaoEnviada: v, simulado: Boolean(STUB), conferencia: "pendente", ...(recusados.length ? { recusadosPelaShopify: novo.errors } : {}) };
    salvarProjeto(p);
    const depois = listar(p.loja);
    const sumidos = antes.filter((a) => !depois.some((b) => b.id === a.id && b.role === a.role));
    if (depois.find((t) => t.role === "live")?.id !== live?.id || sumidos.length) die("divergência na lista de temas após o envio; confira a loja");
    const dp = pull(p, "conferencia-criar");
    const div = arquivos(envio).filter((f) => !existsSync(join(dp, f)) || !mesmoConteudo(f, readFileSync(join(envio, f)), readFileSync(join(dp, f))));
    registrarConferencia(p, envio, dp, div);
    if (recusados.length || div.length) die(`rascunho ${novo.id} criado PARCIALMENTE: ${recusados.map((f) => `${f}: ${[].concat(novo.errors[f]).join(" ")}`).join(" | ") || ""}${div.length ? ` | não confere: ${div.slice(0, 5).join(", ")}` : ""}. Estado real registrado em enviado.json; nada reenviado.`);
    historico({ evento: "envio", versao: v, temaId: novo.id, nome, conferencia: "ok" });
    console.log(`[OK] rascunho criado: ${novo.id} "${nome}" (${v})${STUB ? " [LOJA SIMULADA]" : ""}`);
    const l = links(p); console.log(`     prévia: ${l.previa}\n     editor: ${l.editor}`);
};

// enviado.json = o que REALMENTE está no rascunho (só arquivos que conferem); divergentes/ausentes serão reenviados por "atualizar"
function registrarConferencia(p, envio, dp, div) {
    const man = Object.fromEntries(arquivos(envio).filter((f) => !div.includes(f)).map((f) => [f, sha(readFileSync(join(envio, f)))]));
    p.rascunho.conferencia = div.length ? "parcial" : "ok";
    if (div.length) p.rascunho.naoConfere = div;
    salvarProjeto(p);
    writeJson(pj("enviado.json"), { versao: p.rascunho.versaoEnviada, temaId: p.rascunho.id, em: now(), conferencia: p.rascunho.conferencia, naoConfere: div, pull: relative(P, dp), manifesto: man });
    historico({ evento: "conferencia", temaId: p.rascunho.id, versao: p.rascunho.versaoEnviada, resultado: p.rascunho.conferencia, naoConfere: div, recusados: p.rascunho.recusadosPelaShopify ?? null });
}

// refaz a conferência do envio inicial a partir do pull JÁ baixado (sem operação remota)
C.reconciliar = async () => {
    const p = projeto();
    if (!p.rascunho) die("não há rascunho");
    const ls = readdirSync(pj("remoto"));
    const envio = pj("remoto", ls.filter((d) => d.endsWith("-envio-criar")).sort().at(-1) ?? die("sem pacote de envio"));
    const dp = pj("remoto", ls.filter((d) => d.endsWith("-conferencia-criar")).sort().at(-1) ?? die("sem pull de conferência"));
    const div = arquivos(envio).filter((f) => !existsSync(join(dp, f)) || !mesmoConteudo(f, readFileSync(join(envio, f)), readFileSync(join(dp, f))));
    registrarConferencia(p, envio, dp, div);
    console.log(`[OK] conferência local do rascunho ${p.rascunho.id}: ${p.rascunho.conferencia}${div.length ? ` — não confere: ${div.join(", ")}` : ""}`);
};

C.atualizar = async () => {
    const p = projeto();
    if (!p.rascunho) die("não há rascunho; use enviar");
    if (!["ok", "parcial"].includes(p.rascunho.conferencia) || !existsSync(pj("enviado.json"))) die("o envio inicial do rascunho não foi conferido; rode reconciliar antes de atualizar");
    const bloq = autorizacaoValida(p, "atualizar"); if (bloq) die(bloq);
    const v = p.versaoAtual;
    const man = readJson(pj("versoes", v, "versao.json")).manifesto;
    if (JSON.stringify(manifesto(TEMA)) !== JSON.stringify(man)) die(`o tema de trabalho tem alterações sem versão; crie a versão antes`);
    const enviado = readJson(pj("enviado.json"));
    const ultimoEnviado = pj("versoes", enviado.versao, "tema");
    const live = conferirAlvo(p, listar(p.loja));
    // 1. backup do rascunho ANTES de qualquer alteração
    const bk = pull(p, "backup-antes");
    // 2. edições feitas no Theme Editor (remoto ≠ último enviado) — preservadas
    const remotoAlterado = arquivos(bk).filter((f) => !enviado.manifesto[f] || !existsSync(join(ultimoEnviado, f)) || !mesmoConteudo(f, readFileSync(join(ultimoEnviado, f)), readFileSync(join(bk, f))));
    const localAlterado = Object.keys({ ...deTema(man), ...enviado.manifesto }).filter((f) => DIRS_TEMA.test(f) && man[f] !== enviado.manifesto[f]);
    const conflitos = remotoAlterado.filter((f) => localAlterado.includes(f) && !mesmoConteudo(f, readFileSync(join(TEMA, f)), readFileSync(join(bk, f))));
    if (conflitos.length) {
        historico({ evento: "atualizacao-bloqueada", motivo: "conflito com edições do Theme Editor", conflitos, backup: relative(P, bk) });
        die(`conflito: alterado no Theme Editor E nesta versão: ${conflitos.join(", ")}. Nada enviado. Backup: ${relative(ROOT, bk)}`);
    }
    const importados = remotoAlterado.filter((f) => !localAlterado.includes(f));
    if (importados.length) {
        for (const f of importados) { mkdirSync(dirname(join(TEMA, f)), { recursive: true }); cpSync(join(bk, f), join(TEMA, f)); }
        const val = await validarTema(TEMA, readJson(pj("base.json")));
        if (!val.ok) die(`as edições do Theme Editor importadas não passam na validação local: ${val.problemas.slice(0, 3).join(" | ")}. Nada enviado.`);
        salvarVersao(p, { nota: `edições do Theme Editor importadas do rascunho ${p.rascunho.id}`, validacao: val, origem: "theme-editor" });
        console.log(`[INFO] ${importados.length} arquivo(s) editado(s) no Theme Editor importado(s) e preservado(s): ${importados.slice(0, 6).join(", ")}`);
    }
    const enviar = localAlterado.filter((f) => !importados.includes(f) && existsSync(join(TEMA, f)));
    const removidosLocal = localAlterado.filter((f) => !existsSync(join(TEMA, f)));
    const nova = p.versaoAtual;
    if (!enviar.length) {
        writeJson(pj("enviado.json"), { versao: nova, temaId: p.rascunho.id, em: now(), manifesto: deTema(manifesto(TEMA)) });
        historico({ evento: "atualizacao", versao: nova, enviados: 0, importados, backup: relative(P, bk) });
        console.log(`[OK] nada a enviar: o rascunho já tem ${nova}${importados.length ? " (com as edições do editor)" : ""}`);
        return;
    }
    // autorização restrita a um conjunto exato de arquivos
    const aut = readJson(pj("autorizacao.json"));
    if (aut.arquivosEsperados && JSON.stringify([...enviar].sort()) !== JSON.stringify(aut.arquivosEsperados)) die(`arquivos a enviar (${enviar.join(", ")}) ≠ autorizados (${aut.arquivosEsperados.join(", ")}); nada enviado`);
    // 3. push SÓ dos arquivos alterados, sem apagar nada remoto
    historico({ evento: "atualizacao-iniciada", versao: nova, arquivos: enviar, backup: relative(P, bk) });
    if (aut.usoUnico) writeJson(pj("autorizacao.json"), { ...aut, consumidaEm: now() }); // consumida ao tentar: nunca repetir sozinho
    const r = shopify(["theme", "push", "--store", p.loja, "--theme", String(p.rascunho.id), "--path", TEMA, "--nodelete", ...enviar.flatMap((f) => ["--only", f]), "--json"], "push-atualizar");
    if (!r.ok) die(`push falhou; backup do estado anterior em ${relative(ROOT, bk)}; confira o rascunho`);
    // a CLI sai com 0 mesmo quando a Shopify recusa arquivos ("pushed with errors")
    let resp = null; try { resp = JSON.parse(r.stdout.trim()).theme; } catch {}
    if (!resp || resp.id !== p.rascunho.id) die(`resposta do push não reconhecida ou de outro tema (${resp?.id}); confira o rascunho; backup em ${relative(ROOT, bk)}`);
    if (resp.role !== "unpublished") die(`o rascunho respondeu com papel "${resp.role}"; confira a loja`);
    if (resp.warning || Object.keys(resp.errors ?? {}).length) { historico({ evento: "atualizacao-com-erros", errors: resp.errors ?? null, warning: resp.warning ?? null }); die(`a Shopify recusou arquivos: ${Object.entries(resp.errors ?? {}).map(([f, e]) => `${f}: ${[].concat(e).join(" ")}`).join(" | ") || resp.warning}; nada reenviado; backup em ${relative(ROOT, bk)}`); }
    const lista = listar(p.loja);
    if (lista.find((t) => t.role === "live")?.id !== live?.id) die("o tema publicado mudou durante a atualização; confira a loja");
    // 4. conferência: enviados = local; o resto = backup (inclui o que foi editado no editor)
    const dp = pull(p, "conferencia-atualizar");
    const erros = [];
    for (const f of Object.keys(deTema(manifesto(TEMA)))) {
        if (!existsSync(join(dp, f))) { erros.push(`ausente ${f}`); continue; }
        const esperado = enviar.includes(f) ? readFileSync(join(TEMA, f)) : existsSync(join(bk, f)) ? readFileSync(join(bk, f)) : readFileSync(join(TEMA, f));
        if (!mesmoConteudo(f, esperado, readFileSync(join(dp, f)))) erros.push(`divergente ${f}`);
    }
    if (erros.length) die(`o rascunho não confere após a atualização: ${erros.slice(0, 5).join(", ")}; backup em ${relative(ROOT, bk)}`);
    p.rascunho.versaoEnviada = nova; p.rascunho.atualizadoEm = now(); p.rascunho.conferencia = "ok"; delete p.rascunho.naoConfere; salvarProjeto(p);
    writeJson(pj("enviado.json"), { versao: nova, temaId: p.rascunho.id, em: now(), manifesto: deTema(manifesto(TEMA)) });
    historico({ evento: "atualizacao", versao: nova, enviados: enviar, importados, removidosLocalMantidosNoRascunho: removidosLocal, backup: relative(P, bk), conferencia: "ok" });
    console.log(`[OK] rascunho ${p.rascunho.id} atualizado para ${nova}: ${enviar.length} arquivo(s) enviado(s) (${enviar.slice(0, 8).join(", ")})${STUB ? " [LOJA SIMULADA]" : ""}`);
    if (removidosLocal.length) console.log(`[AVISO] removidos localmente e MANTIDOS no rascunho (--nodelete): ${removidosLocal.join(", ")}`);
    console.log(`     backup anterior: ${relative(ROOT, bk)}`);
    const l = links(p); console.log(`     prévia: ${l.previa}\n     editor: ${l.editor}`);
};

// verificação antes do 1º envio: SÓ leitura na Shopify (theme list); grava preflight.json (e o publicado esperado, se pedido)
C.preflight = async () => {
    const p = projeto();
    const v = p.versaoAtual, dv = pj("versoes", v, "tema");
    const vj = readJson(pj("versoes", v, "versao.json"));
    const out = { em: now(), projeto: slug, versao: v, loja: p.loja, ok: true, itens: [] };
    const item = (nome, ok, detalhe) => { out.itens.push({ nome, ok, detalhe }); if (!ok) out.ok = false; console.log(`${ok ? "OK  " : "FALHA"} ${nome}: ${detalhe}`); };
    // 1. integridade + validação
    const snap = manifesto(dv), trab = manifesto(TEMA);
    item("snapshot íntegro", JSON.stringify(snap) === JSON.stringify(vj.manifesto), `${v}: ${Object.keys(snap).length} arquivos, sha256 do manifesto ${sha(JSON.stringify(vj.manifesto)).slice(0, 16)}`);
    const pend = Object.keys({ ...snap, ...trab }).filter((f) => snap[f] !== trab[f]);
    item("sem alterações pendentes", pend.length === 0, pend.length ? `tema de trabalho ≠ ${v}: ${pend.slice(0, 5).join(", ")}` : `tema de trabalho = ${v}`);
    const val = await validarTema(dv, readJson(pj("base.json")));
    item("validação do tema", val.ok, val.ok ? `schemas/regras OK; Theme Check ${val.themeCheck.atual} (base ${val.themeCheck.base}, novas ${val.themeCheck.novas})` : val.problemas.slice(0, 3).join(" | "));
    // 2. o que será enviado
    const envio = Object.keys(deTema(snap)), fora = Object.keys(snap).filter((f) => !DIRS_TEMA.test(f));
    item("arquivos a enviar", envio.length > 0, `${envio.length} arquivos de tema; ${fora.length} fora das pastas de tema NÃO enviados (${fora.slice(0, 4).join(", ")}${fora.length > 4 ? ", …" : ""})`);
    const base = readJson(pj("base.json")).manifesto;
    const mudados = envio.filter((f) => base[f] !== snap[f]);
    item("diferença para a base gerada (v001)", true, mudados.join(", ") || "nenhuma");
    for (const f of envio.filter((x) => /^sections\/ads-[a-z0-9-]+\.liquid$/.test(x) && base[x] !== snap[x])) {
        const src = readFileSync(join(dv, f), "utf8");
        const sc = JSON.parse(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(src)[1]);
        const lib = join(import.meta.dirname, "..", "componentes", f.slice(9));
        const daBiblioteca = existsSync(lib) && readFileSync(lib).equals(readFileSync(join(dv, f)));
        item(`componente ${f}`, (sc.settings ?? []).length <= 40 && (sc.presets ?? []).length > 0, `${(sc.settings ?? []).length} settings, blocos ${(sc.blocks ?? []).map((b) => `${b.type}(${(b.settings ?? []).length})`).join(" ")}, presets ${(sc.presets ?? []).length}; ${daBiblioteca ? "idêntico à biblioteca" : "DIFERENTE da biblioteca atual"}`);
    }
    // 3. loja: leitura apenas
    const lista = listar(p.loja);
    const live = lista.find((t) => t.role === "live");
    out.loja_temas = lista.map(({ id, name, role }) => ({ id, name, role }));
    item("tema publicado", Boolean(live), `${live?.id} "${live?.name}" (${lista.length} temas na loja; ${lista.filter((t) => t.role === "unpublished").length} não publicados)`);
    const fixar = opt("--fixar-publicado");
    if (fixar) {
        if (Number(fixar) !== live?.id) item("fixar publicado", false, `informado ${fixar} ≠ observado ${live?.id}; nada fixado`);
        else { p.publicadoEsperado = { id: live.id, nome: live.name, fixadoEm: now() }; salvarProjeto(p); historico({ evento: "publicado-fixado", ...p.publicadoEsperado }); }
    }
    item("publicado esperado fixado", p.publicadoEsperado?.id === live?.id, p.publicadoEsperado ? `${p.publicadoEsperado.id}: enviar/atualizar abortam se o publicado mudar` : "não fixado (use --fixar-publicado <id>)");
    // 4. destino e mecanismo
    item("destino", !p.rascunho, p.rascunho ? `já existe rascunho ${p.rascunho.id}: o próximo passo é atualizar` : `${p.loja}: tema NOVO com --unpublished; nome "ADS ${slug.slice(0, 24)} ${v}-<data>"; nunca --live/publish/delete`);
    const aut = existsSync(pj("autorizacao.json")) ? readJson(pj("autorizacao.json")) : null;
    item("autorização", true, aut ? `${aut.operacoes.join("+")} até ${aut.expiraEm}` : "nenhuma registrada (enviar será recusado até a sua autorização)");
    item("mecanismo de atualização", true, "atualizar: list → alvo unpublished e publicado = fixado → pull (backup) → importa edições do Theme Editor → conflito para → push --only <alterados> --nodelete → pull de conferência");
    writeJson(pj("preflight.json"), out);
    console.log(`\n${out.ok ? "PREFLIGHT OK" : "PREFLIGHT COM FALHAS"} — nenhuma escrita na Shopify${STUB ? " [LOJA SIMULADA]" : ""}`);
    process.exitCode = out.ok ? 0 : 1;
};

// biblioteca do núcleo → projeto (cópia; o núcleo nunca é alterado por um projeto)
C.instalar = async () => {
    projeto();
    const nome = rest[0];
    if (!/^ads-[a-z0-9-]+$/.test(nome ?? "")) die("uso: instalar <slug> <componente ads-…> [--regiao section-NN]");
    const src = join(import.meta.dirname, "..", "componentes", `${nome}.liquid`);
    if (!existsSync(src)) die(`componente inexistente na biblioteca: ${nome}`);
    const dst = join(TEMA, "sections", `${nome}.liquid`);
    const ja = existsSync(dst) && readFileSync(dst).equals(readFileSync(src));
    if (existsSync(dst) && !ja && !rest.includes("--substituir")) die(`o projeto já tem uma versão de ${nome} diferente da biblioteca; use --substituir para trocar pela versão atual da biblioteca`);
    cpSync(src, dst);
    const regiao = opt("--regiao");
    if (regiao) {
        const cj = readJson(pj("componentes.json"));
        const c = cj.componentes.find((x) => x.regiao === regiao) ?? die(`região inexistente: ${regiao}`);
        Object.assign(c, { secao: nome, origem: "personalizado", biblioteca: { componente: nome, sha256: sha(readFileSync(src)) } });
        writeJson(pj("componentes.json"), cj);
    }
    historico({ evento: "instalar", componente: nome, regiao, sha256: sha(readFileSync(src)) });
    console.log(`[OK] ${nome} ${ja ? "já instalado" : "instalado"} em ${relative(ROOT, dst)}${regiao ? ` (região ${regiao})` : ""}. Configure os valores no template; depois: validar → versao.`);
};

C.abrir = async () => {
    const p = projeto();
    if (!p.rascunho) die("não há rascunho");
    const l = links(p);
    console.log(`rascunho ${p.rascunho.id} (${p.rascunho.versaoEnviada})${p.rascunho.simulado ? " [LOJA SIMULADA — links não existem]" : ""}\n  prévia: ${l.previa}\n  editor: ${l.editor}`);
    // captura da prévia real: só onde a ferramenta do painel existe (desenvolvimento); a distribuição não a inclui
    if (existsSync(join(ROOT, "experimental/painel-piloto/capturar-previa.mjs"))) console.log(`  captura da prévia real (senha da vitrine digitada pelo operador):\n  ! node experimental/painel-piloto/capturar-previa.mjs ${p.loja} ${p.rascunho.id} ${relative(ROOT, pj("trabalho", `previa-shopify-${p.rascunho.versaoEnviada}`))}`);
};

if (!C[cmd]) die(`comando desconhecido: ${cmd}`, 2);
await C[cmd]();
