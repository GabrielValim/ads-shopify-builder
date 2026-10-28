#!/usr/bin/env node
/**
 * CLI do Reference Engine.
 *
 *   node reference/cli.mjs check-url <url> [--no-robots]
 *   node reference/cli.mjs capture <url>
 *   node reference/cli.mjs analyze <diretorio-da-captura>
 *   node reference/cli.mjs generate <diretorio-da-analise> [--content <arquivo>] [--store <dominio-da-loja>] [--apply]
 *
 * Códigos de saída: 0 sucesso, 1 bloqueado/falha, 2 uso incorreto.
 * A CLI nunca lê .env e nunca chama a Shopify (sem push, dev ou upload).
 * `capture`, `analyze` e `generate --apply` gravam somente em runs/.
 */

import { ReferenceEngineError } from "./core/errors.mjs";
import { checkRobots } from "./core/robots.mjs";
import { DEFAULT_POLICY, createUrlPolicy, parseTargetUrl, resolvePublicAddresses } from "./core/url-policy.mjs";

const USAGE = `Uso:
  node reference/cli.mjs check-url <url> [--no-robots]
  node reference/cli.mjs capture <url> [--local-preview]
  node reference/cli.mjs analyze <diretorio-da-captura>
  node reference/cli.mjs generate <diretorio-da-analise> [--content <arquivo>] [--store <dominio-da-loja>] [--apply]
  node reference/cli.mjs verify-theme <diretorio-da-geracao> [--content <arquivo>]
  node reference/cli.mjs compare --reference <captura> --candidate <captura> --analysis <analise> --generation <geracao>
  node reference/cli.mjs rasterize-asset <svg-relativo-ao-projeto> [--scale 1]
  node reference/cli.mjs prepare-assets --content <arquivo>
  node reference/cli.mjs archive-content --generation <geracao> --file <pacote> --source "<origem da cópia>"

Comandos:
  check-url   Valida a URL (SSRF), resolve o DNS e consulta o robots.txt.
              Somente leitura: nenhum arquivo é gravado.
  capture     Captura desktop (1440x900) e mobile (390x844) de uma URL
              autorizada: screenshots, DOM estruturado e manifesto em runs/.
              Todo o tráfego do navegador passa pelo proxy de saída.
              --local-preview: aceita SOMENTE a origem exata informada
              (http://127.0.0.1:<porta>), para a prévia de theme dev.
  analyze     Gera StoreBlueprint (v3) + relatório a partir de uma captura
              concluída (sem navegador). Saída em runs/analyses/.
  generate    Converte o blueprint em um tema Dawn 16 independente.
              Padrão: SIMULAÇÃO (só o plano). --apply grava um tema novo
              em runs/generated/ e roda o Theme Check local.
              --store: loja de destino; só ela recebe as imagens com
              upload verificado NESSA loja (sem --store: placeholders).
  verify-theme Pré-validação somente leitura do tema gerado (hashes, Dawn,
              schemas, imagens, URLs, credenciais, origem do conteúdo).
  compare     Compara a captura da referência com a captura do tema gerado
              renderizado; relatório HTML em runs/comparisons/ (histórico).
  rasterize-asset Valida uma SVG local (raízes permitidas, sem symlink,
              sem conteúdo ativo/externo) e grava um PNG determinístico em
              runs/assets/<run>/ com os hashes de origem e resultado.
              Validar NÃO autoriza: a autorização fica no ContentPack.
  prepare-assets Refaz OFFLINE os derivados do ContentPack v2 ausentes em
              runs/assets/sha256/, a partir da origem versionada, e só grava
              se o hash for exatamente o registrado.
  archive-content Arquiva (por hash) o ContentPack de uma geração ANTIGA sem
              cópia no run, só se os bytes tiverem exatamente o hash do plano,
              e registra a origem da recuperação. Não altera a geração e não
              torna a reprodutibilidade comprovada.`;

function usage(message) {
    if (message) console.error(`Erro: ${message}\n`);
    console.error(USAGE);
    return 2;
}

function fail(error) {
    if (error instanceof ReferenceEngineError) {
        console.error(`[BLOQUEADO] ${error.code}: ${error.message}`);
        return 1;
    }
    console.error(`[ERRO] ${error?.message ?? error}`);
    return 1;
}

async function checkUrl(args) {
    const flags = args.filter((arg) => arg.startsWith("--"));
    const positional = args.filter((arg) => !arg.startsWith("--"));

    const unknown = flags.filter((flag) => flag !== "--no-robots");
    if (unknown.length) return usage(`opção desconhecida: ${unknown.join(", ")}`);
    if (positional.length !== 1) return usage("informe exatamente uma URL");

    const skipRobots = flags.includes("--no-robots");

    console.log("\nADS AutoStore Reference | check-url | SOMENTE LEITURA\n");

    let url;
    try {
        url = parseTargetUrl(positional[0], DEFAULT_POLICY);
        console.log(`[OK] URL aceita: ${url.href}`);

        const addresses = await resolvePublicAddresses(url);
        console.log(
            `[OK] DNS público: ${addresses.map((entry) => entry.address).join(", ")}`
        );
    } catch (error) {
        return fail(error);
    }

    if (skipRobots) {
        console.log("[PULADO] robots.txt não consultado (--no-robots)");
        return 0;
    }

    const decision = await checkRobots(url);
    const status = decision.status ?? "sem resposta";

    if (!decision.allowed) {
        console.error(
            `[BLOQUEADO] robots.txt (${decision.source}, ${status}): ${decision.reason}`
        );
        return 1;
    }

    console.log(`[OK] robots.txt permite (${decision.source}, ${status})`);
    return 0;
}

/**
 * Política para --local-preview: a origem EXATA da URL (http, loopback,
 * porta explícita) vira a única exceção. Qualquer outra URL local continua
 * bloqueada.
 */
function localPreviewPolicy(input) {
    let url;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password) {
        return null;
    }
    return createUrlPolicy({ previewOrigins: [url.origin] });
}

async function capture(args) {
    const flags = args.filter((arg) => arg.startsWith("--"));
    const positional = args.filter((arg) => !arg.startsWith("--"));
    const unknown = flags.filter((flag) => flag !== "--local-preview");
    if (unknown.length) return usage(`opção desconhecida: ${unknown.join(", ")}`);
    if (positional.length !== 1) return usage("informe exatamente uma URL");

    let policy = DEFAULT_POLICY;
    if (flags.includes("--local-preview")) {
        policy = localPreviewPolicy(positional[0]);
        if (!policy) return usage("--local-preview exige http://127.0.0.1:<porta>/ (origem loopback exata)");
    }

    // Validação antes de carregar o Playwright.
    try {
        parseTargetUrl(positional[0], policy);
    } catch (error) {
        return fail(error);
    }

    const { captureReference } = await import("./capture/capture.mjs");
    const { printCaptureResult } = await import("./capture/report.mjs");

    console.log(`\nADS AutoStore Reference | capture${policy === DEFAULT_POLICY ? "" : " | prévia local " + new URL(positional[0]).origin}\n`);
    const result = await captureReference({ url: positional[0], policy });
    return printCaptureResult(result);
}

async function analyze(args) {
    const flags = args.filter((arg) => arg.startsWith("--"));
    if (flags.length) return usage(`opção desconhecida: ${flags.join(", ")} (v1 suporta apenas o modo reference)`);
    if (args.length !== 1) return usage("informe exatamente um diretório de captura");

    const { analyzeCapture } = await import("./analyzer/analyze.mjs");
    const { printAnalysisResult } = await import("./analyzer/summary.mjs");

    console.log("\nADS AutoStore Reference | analyze | modo reference\n");
    const result = await analyzeCapture({ captureDir: args[0] });
    return printAnalysisResult(result);
}

async function generate(args) {
    let apply = false;
    let contentPath;
    let store = null;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--apply") apply = true;
        else if (arg === "--store") {
            store = args[++i];
            if (!store || store.startsWith("--")) return usage("--store exige o domínio canônico da loja (subdomínio myshopify)");
        } else if (arg === "--content") {
            contentPath = args[++i];
            if (!contentPath || contentPath.startsWith("--")) return usage("--content exige um arquivo");
        } else if (arg.startsWith("--")) return usage(`opção desconhecida: ${arg}`);
        else positional.push(arg);
    }
    if (positional.length !== 1) return usage("informe exatamente um diretório de análise");

    const { generateTheme } = await import("./generator/generate.mjs");
    const { printGeneration } = await import("./generator/report.mjs");

    console.log(`\nADS AutoStore Reference | generate | ${apply ? "APLICAR" : "SIMULAÇÃO"}\n`);
    const result = await generateTheme({ analysisDir: positional[0], contentPath, apply, store });
    return printGeneration(result);
}

async function verifyTheme(args) {
    let contentPath;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--content") {
            contentPath = args[++i];
            if (!contentPath || contentPath.startsWith("--")) return usage("--content exige um arquivo");
        } else if (args[i].startsWith("--")) return usage(`opção desconhecida: ${args[i]}`);
        else positional.push(args[i]);
    }
    if (positional.length !== 1) return usage("informe exatamente um diretório de geração");

    const { verifyGeneratedTheme } = await import("./preview/verify-theme.mjs");
    console.log("\nADS AutoStore Reference | verify-theme | SOMENTE LEITURA\n");
    const result = await verifyGeneratedTheme({ generationDir: positional[0], contentPath });
    for (const check of result.checks) console.log(`${check.ok ? "[OK]   " : "[FALHA]"} ${check.id}${check.detail ? ` — ${check.detail}` : ""}`);
    if (result.integrity) {
        const a = result.availability;
        console.log(`\nIntegridade:        ${!result.integrity.ok ? `FALHA (${result.integrity.failed.join(", ")})` : result.integrity.complete ? "OK — artefatos conferem com os manifestos" : `INCOMPLETA — conferido o que existe; não feito sem o ContentPack: ${result.integrity.notPerformed.join(", ")}`}`);
        if (a) console.log(`Disponibilidade:    ContentPack ${a.content}${a.sharedArchive ? ` · arquivo por hash: ${a.sharedArchive}` : ""} · análise ${a.analysis} · Dawn ${a.dawn}${a.recovery ? ` · recuperação registrada (${a.recovery.source})` : ""}`);
        console.log(`Reprodutibilidade:  ${result.reproducibility.proven ? "COMPROVADA" : "NÃO COMPROVADA"}${result.reproducibility.reasons.length ? ` — ${result.reproducibility.reasons.join("; ")}` : ""}${result.reproducibility.notes.length ? ` (${result.reproducibility.notes.join("; ")})` : ""}`);
        for (const item of result.comparisons ?? []) console.log(item.error ? `Comparação:         ContentPack externo inválido (${item.error})` : `Comparação:         ContentPack externo sha256 ${item.sha256.slice(0, 12)}… ${item.matchesGeneration ? "igual ao da geração" : "DIFERENTE do usado na geração (não é adulteração do run)"}`);
    }
    console.log(result.ok ? "\nTema apto para prévia." : "\nTema NÃO apto para prévia.");
    return result.ok ? 0 : 1;
}

async function compare(args) {
    const options = {};
    const names = { "--reference": "referenceDir", "--candidate": "candidateDir", "--analysis": "analysisDir", "--generation": "generationDir" };
    for (let i = 0; i < args.length; i++) {
        const key = names[args[i]];
        if (!key) return usage(`opção desconhecida: ${args[i]}`);
        const value = args[++i];
        if (!value || value.startsWith("--")) return usage(`${args[i - 1]} exige um diretório`);
        options[key] = value;
    }
    if (Object.keys(options).length !== 4) return usage("compare exige --reference, --candidate, --analysis e --generation");

    const { compareRender } = await import("./compare/compare.mjs");
    console.log("\nADS AutoStore Reference | compare\n");
    const result = await compareRender(options);
    if (!result.ok) {
        console.error(`[FALHA] ${result.error.code}: ${result.error.message}`);
        return 1;
    }
    const { scores, viewports, recommendations } = result.result;
    console.log(`[OK] Comparação: ${result.run.dir}`);
    console.log(`Pontuação: desktop ${scores.desktop} · mobile ${scores.mobile} · média ${scores.overall} (cobertura ${scores.coverage.desktop} / ${scores.coverage.mobile})`);
    for (const name of ["desktop", "mobile"]) {
        console.log(`\n${name}:`);
        for (const s of viewports[name].sections) {
            console.log(`  ${s.blueprintSectionId} ${s.blueprintType.padEnd(16)} ${String(s.status).padEnd(11)} ${s.score === null || s.score === undefined ? "  -  " : s.score.toFixed(3)}${s.candidate ? `  altura ${s.reference.height}→${s.candidate.height}` : ""}`);
        }
    }
    console.log("\nRecomendações:");
    for (const r of recommendations.slice(0, 8)) console.log(`  ${r.priority}. [${r.category}] ${r.text} (impacto ${r.impact})`);
    return 0;
}

async function rasterizeAsset(args) {
    const path = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--scale");
    const scaleIndex = args.indexOf("--scale");
    const scale = scaleIndex >= 0 ? Number(args[scaleIndex + 1]) : 1;
    if (!path || !Number.isFinite(scale)) return usage("informe o caminho da SVG (relativo ao projeto)");
    console.log("\nADS AutoStore Reference | rasterize-asset | somente local, sem rede\n");
    try {
        const { rasterizeLocalSvg } = await import("./assets/assets.mjs");
        const result = await rasterizeLocalSvg({ path, scale });
        const { source, derivative, tool } = result.record;
        console.log(`[OK] Origem validada: ${source.path} · ${source.width}x${source.height} · ${source.bytes} bytes · sha256 ${source.sha256}`);
        console.log(`[OK] Derivado: ${derivative.file} · ${derivative.width}x${derivative.height} · ${derivative.bytes} bytes · sha256 ${derivative.sha256}`);
        console.log(`Renderizador: ${tool.renderer} · requisições de rede: 0`);
        console.log(`Execução: ${result.dir}`);
        console.log("Estado: arquivo local validado — NÃO autorizado, NÃO enviado à Shopify.");
        return 0;
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        console.error(`[FALHA] ${error.code}: ${error.message}`);
        return 1;
    }
}

async function prepareAssets(args) {
    const index = args.indexOf("--content");
    const path = index >= 0 ? args[index + 1] : null;
    if (!path) return usage("informe --content <arquivo>");
    console.log("\nADS AutoStore Reference | prepare-assets | somente local, sem rede\n");
    try {
        const { loadContentPackWithHash } = await import("./generator/content-pack.mjs");
        const { prepareDerivatives } = await import("./assets/assets.mjs");
        const { pack } = await loadContentPackWithHash(path);
        const report = await prepareDerivatives(pack);
        for (const item of report.results) console.log(`[${item.status === "failed" ? "FALHA" : "OK"}] ${item.slot}: ${item.path} — ${item.status}${item.detail ? ` (${item.detail})` : ""}`);
        if (!report.results.length) console.log("Nenhum derivado declarado.");
        return report.ok ? 0 : 1;
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        console.error(`[FALHA] ${error.code}: ${error.message}`);
        return 1;
    }
}

async function archiveContent(args) {
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const key = { "--generation": "generation", "--file": "file", "--source": "source" }[args[i]];
        if (!key || !args[i + 1]) return usage(`opção inválida: ${args[i]}`);
        options[key] = args[++i];
    }
    if (!options.generation || !options.file || !options.source) return usage("archive-content exige --generation, --file e --source");
    console.log("\nADS AutoStore Reference | archive-content | somente local\n");
    try {
        const { loadGeneration } = await import("./preview/load-generation.mjs");
        const { readStandaloneFile, sha256 } = await import("./core/safe-read.mjs");
        const { parseContentPack } = await import("./generator/content-pack.mjs");
        const { archiveBySha, recordRecovery, DEFAULT_CONTENT_ARCHIVE } = await import("./core/content-archive.mjs");
        const generation = await loadGeneration(options.generation);
        const expected = generation.plan.provenance.contentSha256;
        if (!expected) throw new ReferenceEngineError("RUN_INVALID", "A geração não usou ContentPack");
        if (generation.contentPackBuffer) throw new ReferenceEngineError("RUN_INVALID", "A geração já tem cópia imutável do ContentPack: recuperação desnecessária");
        const buffer = await readStandaloneFile(options.file, 2 * 1024 * 1024);
        const actual = sha256(buffer);
        if (actual !== expected) throw new ReferenceEngineError("ARTIFACT_TAMPERED", `Bytes (${actual.slice(0, 12)}…) diferentes do hash registrado na geração (${expected.slice(0, 12)}…): nada arquivado`);
        const parsed = parseContentPack(JSON.parse(buffer.toString("utf8")));
        if (!parsed.success) throw new ReferenceEngineError("CONTENT_INVALID", "Arquivo não é um ContentPack válido");
        const archived = await archiveBySha(buffer, { root: DEFAULT_CONTENT_ARCHIVE, expectedSha256: expected });
        const record = await recordRecovery({
            schemaVersion: 1,
            kind: "ContentRecovery",
            generationRunId: generation.manifest.runId,
            contentSha256: expected,
            source: options.source,
            proof: "SHA-256 dos bytes recuperados igual ao contentSha256 registrado no plano da geração",
            recordedOn: new Date().toISOString().slice(0, 10),
            limitations: ["recuperação posterior à geração", "a geração não registrou a identidade do código: reprodutibilidade exata NÃO comprovada"],
        });
        console.log(`[OK] ContentPack ${expected} ${archived.status === "archived" ? "arquivado" : "já presente"} em ${archived.path}`);
        console.log(`[OK] Registro de recuperação: ${record.path} (sha256 ${record.sha256.slice(0, 12)}…)`);
        console.log("A geração original não foi alterada; reprodutibilidade continua NÃO comprovada.");
        return 0;
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        console.error(`[FALHA] ${error.code}: ${error.message}`);
        return 1;
    }
}

async function main(argv) {
    const [command, ...rest] = argv;

    switch (command) {
        case "check-url":
            return checkUrl(rest);
        case "capture":
            return capture(rest);
        case "analyze":
            return analyze(rest);
        case "generate":
            return generate(rest);
        case "verify-theme":
            return verifyTheme(rest);
        case "compare":
            return compare(rest);
        case "rasterize-asset":
            return rasterizeAsset(rest);
        case "prepare-assets":
            return prepareAssets(rest);
        case "archive-content":
            return archiveContent(rest);
        case undefined:
        case "help":
        case "--help":
            return usage();
        default:
            return usage(`comando desconhecido: ${command}`);
    }
}

process.exitCode = await main(process.argv.slice(2));
