#!/usr/bin/env node
/**
 * ADS Shopify Builder — ponto de entrada da Skill instalada (só módulos nativos do Node ≥ 22).
 * O usuário nunca digita estes comandos: o Claude os executa (aba Code do Claude Desktop, sessão local).
 *
 *   ambiente  [--url <referência>]            diagnóstico: onde estamos, o que falta
 *   preparar  [--pasta <área>]                copia o motor para <área>/.ads e instala dependências (uma vez)
 *   conectar  --loja <x.myshopify.com>         inicia o login da Shopify CLI (abre o navegador) e retorna
 *   conexao   --loja <x.myshopify.com>         resultado do login: loja confirmada, temas, tema publicado
 *   desconectar                               encerra a sessão da Shopify CLI e esquece a loja
 *   loja      <comando> <projeto> [opções]     comandos do projeto (iniciar, estado, validar, versao, preflight, …)
 *   ferramenta <especificacao|previa|comparar> [args]   ferramentas de medição e prévia
 * Área de trabalho FIXA (não depende da pasta atual): ~/ADS-AutoStore  (lojas em lojas/, motor em .ads/).
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const SKILL = resolve(import.meta.dirname, "..");
const MOTOR_PACOTE = join(SKILL, "motor");
const VERSAO = JSON.parse(readFileSync(join(MOTOR_PACOTE, "package.json"), "utf8")).version;
const WIN = process.platform === "win32";
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d = null) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const sem = (args, ...ks) => args.filter((x, i) => !ks.includes(x) && !ks.includes(args[i - 1]));
const die = (m, c = 1) => { console.error(`[ERRO] ${m}`); process.exit(c); };
const AREA = resolve(opt("--pasta") ?? process.env.ADS_AREA ?? join(homedir(), "ADS-AutoStore"));
if (AREA === SKILL || AREA.startsWith(SKILL + sep)) die(`a área de trabalho não pode ficar dentro da pasta da Skill (${AREA})`);
const ADS = join(AREA, ".ads"), MOTOR = join(ADS, "motor"), BROWSERS = join(ADS, "navegadores"), LOJAS = join(AREA, "lojas");
const bin = (n) => join(MOTOR, "node_modules", ".bin", WIN ? `${n}.cmd` : n);
const lojaValida = (l) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(l ?? "");
const estado = () => (existsSync(join(ADS, "estado.json")) ? JSON.parse(readFileSync(join(ADS, "estado.json"), "utf8")) : {});
const salvarEstado = (e) => { mkdirSync(ADS, { recursive: true }); writeFileSync(join(ADS, "estado.json"), JSON.stringify({ ...estado(), ...e }, null, 2) + "\n"); };
const envMotor = () => ({ ...process.env, ADS_MOTOR_ROOT: MOTOR, ADS_PROJETOS_DIR: LOJAS, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, ADS_PREVIA_PORTATIL: "1",
    PATH: `${join(MOTOR, "node_modules", ".bin")}${WIN ? ";" : ":"}${process.env.PATH}`, NO_COLOR: "1", SHOPIFY_CLI_NO_ANALYTICS: "1" });
const run = (b, args, o = {}) => spawnSync(b, args, { stdio: "inherit", shell: WIN && /\.cmd$/.test(b), ...o });
const preparado = () => existsSync(join(MOTOR, "node_modules", "playwright")) && existsSync(join(MOTOR, "themes", "dawn", "config", "settings_schema.json")) && estado().motor === VERSAO;

const C = {};

C.ambiente = async () => {
    const node = process.versions.node.split(".").map(Number);
    const nodeOk = node[0] > 22 || (node[0] === 22 && node[1] >= 12);
    // sandbox do Chat/Cowork: a Skill é montada em /mnt/… e há /mnt/user-data; fora disso, é o computador do usuário
    const sandbox = process.env.CLAUDECODE !== "1" && (SKILL.startsWith("/mnt/") || existsSync("/mnt/user-data"));
    const local = !sandbox;
    const npm = spawnSync(WIN ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: WIN });
    let rede = null;
    if (opt("--url")) {
        try { const r = await fetch(opt("--url"), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) }); rede = `acessível (HTTP ${r.status})`; }
        catch (e) { rede = `BLOQUEADA ou indisponível (${String(e.cause?.code ?? e.message).slice(0, 60)})`; }
    }
    const e = estado();
    const linhas = [
        ["onde", sandbox ? "sandbox do Chat/Cowork (sem acesso ao computador nem à internet geral)" : `computador do usuário${process.env.CLAUDECODE === "1" ? " (Claude Code)" : ""}`],
        ["sistema", `${process.platform} ${process.arch}`],
        ["node", `${process.versions.node} ${nodeOk ? "OK" : "— precisa ≥ 22.12"}`],
        ["npm", npm.status === 0 ? npm.stdout.trim() : "AUSENTE"],
        ["área de trabalho", `${AREA} ${preparado() ? `(preparada, motor ${VERSAO})` : "(não preparada)"}`],
        ["loja conectada", e.loja ? `${e.loja} (desde ${e.conectadaEm})` : "nenhuma"],
        ...(rede ? [["referência", rede]] : []),
    ];
    for (const [k, v] of linhas) console.log(`${k.padEnd(17)} ${v}`);
    const pronto = !sandbox && nodeOk && npm.status === 0;
    console.log(`\nRESULTADO: ${sandbox ? "SANDBOX — o fluxo completo (captura, geração, prévia, envio) exige a aba Code do Claude Desktop" : pronto ? (preparado() ? "PRONTO" : "PRONTO PARA PREPARAR") : "FALTAM REQUISITOS"}`);
    console.log(JSON.stringify({ sandbox, local, nodeOk, npm: npm.status === 0, preparado: preparado(), loja: e.loja ?? null, area: AREA, rede }));
};

// Dawn NÃO acompanha o pacote (código da Shopify, licença própria): é baixado do repositório oficial no commit travado
// e cada arquivo é conferido com o manifesto de sha256 do pacote. Qualquer divergência = nada é instalado.
async function garantirDawn() {
    const { createHash } = await import("node:crypto");
    const { gunzipSync } = await import("node:zlib");
    const man = JSON.parse(readFileSync(join(MOTOR, "themes", "dawn.sha256.json"), "utf8"));
    const destino = join(MOTOR, "themes", "dawn");
    const sha = (b) => createHash("sha256").update(b).digest("hex");
    const integro = () => Object.entries(man.arquivos).every(([f, h]) => existsSync(join(destino, f)) && sha(readFileSync(join(destino, f))) === h);
    if (existsSync(destino) && integro()) return console.log(`Dawn ${man.themeVersion} já presente e íntegro`);
    console.log(`baixando o Dawn ${man.themeVersion} da fonte oficial (${man.fonte})…`);
    const r = await fetch(man.fonte, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) die(`não foi possível baixar o Dawn (HTTP ${r.status})`);
    const tar = gunzipSync(Buffer.from(await r.arrayBuffer()));
    const tmp = join(MOTOR, "themes", "dawn.baixando");
    rmSync(tmp, { recursive: true, force: true });
    let longo = null, conferidos = 0;
    for (let o = 0; o + 512 <= tar.length; ) {
        const h = tar.subarray(o, o + 512);
        if (h.every((b) => b === 0)) break;
        const campo = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
        const tamanho = parseInt(campo(124, 136).trim() || "0", 8), tipo = campo(156, 157) || "0";
        const corpo = tar.subarray(o + 512, o + 512 + tamanho);
        o += 512 + Math.ceil(tamanho / 512) * 512;
        if (tipo === "L") { longo = corpo.toString("utf8").replace(/\0.*$/s, ""); continue; }
        if (tipo === "x") { const m = /\d+ path=([^\n]+)\n/.exec(corpo.toString("utf8")); if (m) longo = m[1]; continue; }
        if (tipo === "g") continue;
        const nome = longo ?? (campo(345, 500) ? `${campo(345, 500)}/${campo(0, 100)}` : campo(0, 100));
        longo = null;
        if (tipo !== "0" && tipo !== "\0") continue;
        const rel = nome.split("/").slice(1).join("/"); // remove a pasta raiz dawn-<commit>/
        if (!man.arquivos[rel]) continue; // só os arquivos do manifesto
        if (sha(corpo) !== man.arquivos[rel]) { rmSync(tmp, { recursive: true, force: true }); die(`Dawn baixado NÃO confere (hash diferente em ${rel}); nada foi instalado`); }
        mkdirSync(dirname(join(tmp, rel)), { recursive: true });
        writeFileSync(join(tmp, rel), corpo);
        conferidos++;
    }
    const total = Object.keys(man.arquivos).length;
    if (conferidos !== total) { rmSync(tmp, { recursive: true, force: true }); die(`Dawn baixado incompleto (${conferidos}/${total} arquivos); nada foi instalado`); }
    rmSync(destino, { recursive: true, force: true });
    cpSync(tmp, destino, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    console.log(`Dawn ${man.themeVersion}: ${conferidos} arquivos conferidos por sha256`);
}

C.preparar = async () => {
    mkdirSync(ADS, { recursive: true });
    // idempotente: mesma versão do motor + mesmo lock de dependências + navegador presente = nada a fazer
    const lockPacote = readFileSync(join(MOTOR_PACOTE, "package-lock.json"), "utf8");
    const navegador = existsSync(BROWSERS) && readdirSync(BROWSERS).some((d) => d.startsWith("chromium"));
    if (!rest.includes("--forcar") && preparado() && navegador && existsSync(join(MOTOR, "package-lock.json")) && readFileSync(join(MOTOR, "package-lock.json"), "utf8") === lockPacote) {
        await garantirDawn(); // reconfere (e restaura da fonte oficial, se preciso) a cada preparação
        console.log(`[OK] área de trabalho já preparada: ${AREA} (motor ${VERSAO})`);
        return;
    }
    if (estado().motor !== VERSAO || !existsSync(join(MOTOR, "package.json"))) {
        // atualização da Skill: troca SÓ o código do motor; preserva capturas (runs/) e dependências até o npm ci
        const anterior = estado().motor;
        console.log(anterior ? `atualizando o motor ${anterior} → ${VERSAO}…` : `copiando o motor ${VERSAO} para ${MOTOR}…`);
        if (existsSync(MOTOR)) for (const d of readdirSync(MOTOR)) if (!["runs", "node_modules"].includes(d)) rmSync(join(MOTOR, d), { recursive: true, force: true });
        cpSync(MOTOR_PACOTE, MOTOR, { recursive: true, force: true });
    }
    console.log("instalando dependências fixas (npm ci)…");
    let r = run(WIN ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund", "--omit=dev"], { cwd: MOTOR });
    if (r.status !== 0) die("falha no npm ci (verifique a conexão com a internet)");
    console.log("instalando o navegador de captura (Chromium do Playwright)…");
    r = run(bin("playwright"), ["install", "--only-shell", "chromium"], { cwd: MOTOR, env: envMotor() }); // captura e prévia rodam sem janela
    if (r.status !== 0) die("falha ao instalar o Chromium do Playwright");
    await garantirDawn();
    mkdirSync(LOJAS, { recursive: true });
    salvarEstado({ motor: VERSAO, preparadoEm: new Date().toISOString() });
    console.log(`[OK] área de trabalho pronta: ${AREA}`);
};

C.conectar = async () => {
    if (!preparado()) die("área de trabalho não preparada (rode preparar)");
    const loja = opt("--loja");
    if (!lojaValida(loja)) die("informe o domínio da loja no formato nome-da-loja.myshopify.com");
    const log = join(ADS, `conexao-${loja}.log`);
    writeFileSync(log, "");
    const fd = openSync(log, "a");
    // a Shopify CLI abre o navegador sozinha (login por código de ativação) e só depois lista os temas (leitura).
    // Roda desacoplada (o Claude precisa mostrar o código enquanto ela espera), com PRAZO: encerrada após 10 min sem aprovação.
    const vigia = `const {spawn}=require("node:child_process");const c=spawn(process.argv[1],process.argv.slice(2),{stdio:"inherit",shell:${WIN}});const t=setTimeout(()=>{console.error("ADS: login não aprovado em 10 min; encerrado");c.kill();},600000);c.on("exit",(k)=>{clearTimeout(t);process.exit(k??1)});`;
    const p = spawn(process.execPath, ["-e", vigia, bin("shopify"), "theme", "list", "--store", loja, "--json"], { cwd: MOTOR, env: envMotor(), detached: true, stdio: ["ignore", fd, fd] });
    p.unref();
    for (let i = 0; i < 40; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        const t = readFileSync(log, "utf8");
        const url = /https:\/\/accounts\.shopify\.com\/activate[^\s"\\]*/.exec(t)?.[0];
        const codigo = /verification code:\s*([A-Z0-9-]+)/i.exec(t)?.[1];
        if (url) { console.log(`LOGIN: o navegador foi aberto na página da Shopify.\n  código: ${codigo ?? "(na página)"}\n  link: ${decodeURIComponent(url)}\nDepois de aprovar no navegador, rode: conexao --loja ${loja}`); return; }
        if (/^\s*\[/m.test(t)) { console.log("já autenticado; rode: conexao --loja " + loja); return; }
        if (/ADS: login não aprovado|error/i.test(t) && !/diagnostic/.test(t)) break;
    }
    console.log(`aguardando a Shopify CLI; rode: conexao --loja ${loja}`);
};

C.conexao = async () => {
    const loja = opt("--loja");
    if (!lojaValida(loja)) die("informe --loja nome-da-loja.myshopify.com");
    const log = join(ADS, `conexao-${loja}.log`);
    if (!existsSync(log)) die("conexão não iniciada (rode conectar)");
    const t = readFileSync(log, "utf8");
    const i = t.search(/^\s*\[/m);
    if (i < 0) { console.log(/error|fail/i.test(t.replace(/"level":"info"[^\n]*/g, "")) ? `FALHA na conexão:\n${t.slice(-600)}` : "AGUARDANDO: aprove o acesso no navegador e tente de novo em alguns segundos"); return; }
    let temas; try { temas = JSON.parse(t.slice(i)); } catch { console.log("AGUARDANDO: resposta incompleta da Shopify CLI"); return; }
    const live = temas.find((x) => x.role === "live");
    salvarEstado({ loja, conectadaEm: new Date().toISOString(), publicado: live ? { id: live.id, nome: live.name } : null });
    console.log(`CONECTADO: ${loja}\n  temas na loja: ${temas.length} (${temas.filter((x) => x.role === "unpublished").length} não publicados)\n  tema publicado (NUNCA será alterado): "${live?.name}"`);
};

C.desconectar = async () => {
    if (!preparado()) die("área de trabalho não preparada");
    const r = run(bin("shopify"), ["auth", "logout"], { cwd: MOTOR, env: envMotor() });
    const e = estado(); delete e.loja; delete e.conectadaEm; delete e.publicado;
    writeFileSync(join(ADS, "estado.json"), JSON.stringify(e, null, 2) + "\n");
    console.log(r.status === 0 ? "[OK] sessão da Shopify encerrada neste computador; nenhuma loja conectada" : "[AVISO] a Shopify CLI não confirmou o logout; a loja foi esquecida pelo ADS");
};

const projetoLoja = (slug) => { const f = join(LOJAS, slug ?? "-", "projeto.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).loja : null; };
C.loja = async () => {
    if (!preparado()) die("área de trabalho não preparada (rode preparar)");
    const [sub, slug] = rest;
    const conectada = estado().loja;
    // trabalho EXCLUSIVO na loja confirmada: todo projeto precisa ser da loja conectada
    if (sub === "iniciar") {
        if (!conectada) die("nenhuma loja conectada (rode conectar e conexao)");
        if (opt("--loja") && opt("--loja") !== conectada) die(`a loja informada (${opt("--loja")}) não é a conectada (${conectada})`);
    } else if (slug && projetoLoja(slug) && conectada && projetoLoja(slug) !== conectada) die(`o projeto ${slug} é da loja ${projetoLoja(slug)}, mas a loja conectada é ${conectada}`);
    let args = sub === "iniciar" ? [...sem(rest, "--loja"), "--loja", conectada] : [...rest];
    // sem conteúdo do usuário: conteúdo demonstrativo NEUTRO da distribuição (textos de espaço reservado, sem números/pessoas)
    if (sub === "iniciar" && !rest.includes("--conteudo")) args = [...args, "--conteudo", join(MOTOR, "ads/conteudo/demonstrativo.json")];
    // o tema publicado é fixado a partir da conexão confirmada (o preflight confere com a loja)
    if (sub === "preflight" && !rest.includes("--fixar-publicado") && estado().publicado) args = [...args, "--fixar-publicado", String(estado().publicado.id)];
    const r = run(process.execPath, [join(MOTOR, "ads/scripts/projeto.mjs"), ...sem(args, "--pasta")], { cwd: MOTOR, env: envMotor() });
    process.exit(r.status ?? 1);
};

C.ferramenta = async () => {
    if (!preparado()) die("área de trabalho não preparada (rode preparar)");
    const [nome, ...args] = rest;
    if (!["especificacao", "previa", "comparar"].includes(nome)) die("ferramentas: especificacao | previa | comparar");
    // o motor roda com cwd = motor: caminhos relativos vêm da pasta da sessão e são convertidos em absolutos
    const abs = sem(args, "--pasta").map((x) => (!x.startsWith("--") && /[\\/]|\.(json|liquid|png)$/.test(x) ? resolve(process.cwd(), x) : x));
    const r = run(process.execPath, [join(MOTOR, "ads/scripts", `${nome}.mjs`), ...abs], { cwd: MOTOR, env: envMotor() });
    process.exit(r.status ?? 1);
};

if (!C[cmd]) die("comandos: ambiente | preparar | conectar | conexao | desconectar | loja | ferramenta", 2);
await C[cmd]();
