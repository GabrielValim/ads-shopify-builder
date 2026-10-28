/**
 * Ativos visuais locais: validação de SVG e rasterização determinística.
 *
 * Validar um arquivo NÃO o autoriza: este módulo produz o estado "arquivo
 * local validado" (identidade, hash, tipo, dimensões) e derivados
 * rasterizados. Autorização e upload são estados separados, no ContentPack.
 *
 * Segurança:
 *  - só caminhos RELATIVOS à raiz do projeto, dentro de uma raiz permitida;
 *    nada de "..", symlinks (no arquivo ou em diretórios), hardlinks,
 *    arquivos especiais ou acima do limite de tamanho;
 *  - SVG estático por lista de PERMISSÃO de elementos (sem texto, scripts,
 *    animação, imagens embutidas ou objetos); atributos de evento, DOCTYPE,
 *    entidades, href/url() externos, data:/javascript: e CSS com @import são
 *    recusados;
 *  - rasterização no Chromium sem rede (resolvedor de nomes e proxy mortos,
 *    contexto offline), sem JavaScript, com a SVG em <img> (modo seguro: sem
 *    scripts e sem recursos externos), e verificação de que nenhuma
 *    requisição foi feita;
 *  - PNG reescrito pelo codificador do projeto (saída determinística).
 */

import { link, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

import { chromium } from "playwright";

import { decodePng, encodePng } from "../compare/png.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { DEFAULT_RUNS_DIR, PROJECT_ROOT, assertRunsRootAllowed } from "../core/run-store.mjs";
import { readRegularFile, sha256 } from "../core/safe-read.mjs";
import { ASSET_PATH } from "../generator/content-pack.mjs";

export const ASSETS_VERSION = "1.0.0";
/** Raízes de onde ativos locais podem ser lidos (relativas ao projeto). */
export const ALLOWED_ASSET_ROOTS = Object.freeze(["reference/fixtures/site/images", "assets/authorized"]);
export const MAX_SVG_BYTES = 256 * 1024;
export const MAX_RASTER_PIXELS = 4096 * 4096;
export const DEFAULT_ASSETS_DIR = join(DEFAULT_RUNS_DIR, "assets");

const fail = (message, details) => new ReferenceEngineError(ErrorCodes.ASSET_INVALID, message, details);

const ALLOWED_ELEMENTS = new Set([
    "svg", "g", "defs", "title", "desc",
    "linearGradient", "radialGradient", "stop",
    "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
    "clipPath", "mask",
]);

/**
 * Resolve um caminho relativo do projeto dentro de uma raiz permitida,
 * recusando symlinks em qualquer componente.
 * @returns {Promise<{ absolute: string, dir: string, name: string }>}
 */
export async function resolveAssetPath(relPath, { roots = ALLOWED_ASSET_ROOTS, projectRoot = PROJECT_ROOT } = {}) {
    if (typeof relPath !== "string" || !ASSET_PATH.test(relPath)) throw fail("Caminho de ativo inválido (use caminho relativo ao projeto, sem '..')", { path: String(relPath) });
    const root = roots.find((item) => relPath === item || relPath.startsWith(`${item}/`));
    if (!root) throw fail("Ativo fora das raízes permitidas", { path: relPath, roots: [...roots] });
    const absolute = resolve(projectRoot, relPath);
    // Cada componente, da raiz do projeto ao arquivo, precisa ser real (sem symlink).
    let current = resolve(projectRoot);
    for (const part of relative(projectRoot, absolute).split(sep)) {
        current = join(current, part);
        let info;
        try {
            info = await lstat(current);
        } catch {
            throw fail("Ativo inexistente", { path: relPath });
        }
        if (info.isSymbolicLink()) throw fail("Symlink não permitido no caminho do ativo", { path: relPath });
    }
    const real = await realpath(absolute);
    const rootReal = await realpath(resolve(projectRoot, root));
    if (!real.startsWith(rootReal + sep)) throw fail("Ativo fora da raiz permitida", { path: relPath });
    const dir = real.slice(0, real.lastIndexOf(sep));
    return { absolute: real, dir, name: real.slice(real.lastIndexOf(sep) + 1) };
}

const number = (value) => {
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*$/.exec(value ?? "");
    return match ? Number(match[1]) : null;
};

/**
 * Validação estrutural de SVG estático. Recusa (não "limpa") qualquer coisa
 * fora da lista de permissão.
 * @returns {{ width: number, height: number }}
 */
export function validateSvgText(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail("SVG com DOCTYPE/entidades não é permitido");
    if (/<\?(?!xml\s)/.test(text)) throw fail("SVG com instruções de processamento não é permitido");
    if (/<!\[CDATA\[/.test(text)) throw fail("SVG com CDATA não é permitido");
    const body = text.replace(/^﻿?\s*(<\?xml[^?]*\?>\s*)?/, "").replace(/<!--[\s\S]*?-->/g, "");
    if (!/^<svg[\s>]/.test(body)) throw fail("Arquivo não começa com <svg>");

    let root = null;
    for (const match of body.matchAll(/<\s*([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/g)) {
        const [, name, attrText] = match;
        if (!ALLOWED_ELEMENTS.has(name)) throw fail(`Elemento SVG não permitido: <${name}>`);
        const attrs = {};
        for (const attr of attrText.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
            const key = attr[1];
            const value = attr[2] ?? attr[3] ?? "";
            if (/^on/i.test(key)) throw fail(`Atributo de evento não permitido: ${key}`);
            if (/^(?:xlink:)?href$/i.test(key) && !/^#[A-Za-z][\w.-]*$/.test(value)) throw fail("Referência externa (href) não permitida");
            if (/javascript:|data:|vbscript:/i.test(value)) throw fail("URI ativa ou embutida não permitida");
            for (const url of value.matchAll(/url\(\s*([^)]*)\)/gi)) {
                if (!/^["']?#[A-Za-z][\w.-]*["']?$/.test(url[1].trim())) throw fail("url() externa não permitida");
            }
            if (/@import|expression\s*\(/i.test(value)) throw fail("CSS ativo não permitido");
            attrs[key] = value;
        }
        if (!root && name === "svg") root = attrs;
    }
    // Nenhuma marcação fora das tags reconhecidas (ex.: "<" solto escondendo algo).
    const leftovers = body.replace(/<\s*\/?\s*[A-Za-z][\w:.-]*(?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*\/?>/g, "");
    if (/[<>]/.test(leftovers)) throw fail("Marcação SVG não reconhecida");

    let width = number(root?.width);
    let height = number(root?.height);
    if ((!width || !height) && root?.viewBox) {
        const box = root.viewBox.trim().split(/[\s,]+/).map(Number);
        if (box.length === 4 && box.every(Number.isFinite)) [width, height] = [box[2], box[3]];
    }
    if (!width || !height || width > 8192 || height > 8192) throw fail("Dimensões do SVG ausentes ou fora do limite");
    return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Arquivo local validado (estado 1). Não implica autorização.
 * @returns {Promise<{ path: string, sha256: string, mime: "image/svg+xml", bytes: number, width: number, height: number, buffer: Buffer }>}
 */
export async function validateLocalSvg(relPath, options = {}) {
    if (!relPath.toLowerCase().endsWith(".svg")) throw fail("Formato inesperado: só .svg é aceito como origem", { path: relPath });
    const { dir, name } = await resolveAssetPath(relPath, options);
    let buffer;
    try {
        buffer = await readRegularFile(dir, name, options.maxBytes ?? MAX_SVG_BYTES);
    } catch (error) {
        throw fail(`Arquivo de ativo recusado: ${error.message}`, { path: relPath, cause: error.code });
    }
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
        throw fail("SVG não é UTF-8 válido", { path: relPath });
    }
    const { width, height } = validateSvgText(text);
    return { path: relPath, sha256: sha256(buffer), mime: "image/svg+xml", bytes: buffer.length, width, height, buffer };
}

/**
 * Rasteriza uma SVG validada em PNG, sem rede e sem JavaScript.
 * @returns {Promise<{ png: Buffer, width: number, height: number, renderer: string, requests: string[] }>}
 */
export async function renderSvgToPng(svgBuffer, { width, height, scale = 1 }) {
    const outWidth = Math.round(width * scale);
    const outHeight = Math.round(height * scale);
    if (!Number.isInteger(scale * 4) || scale <= 0 || scale > 4 || outWidth * outHeight > MAX_RASTER_PIXELS) throw fail("Escala ou tamanho de saída fora do limite", { scale, outWidth, outHeight });

    const offline = await openOfflinePage({ width: outWidth, height: outHeight });
    const { browser, page, requests } = offline;
    try {
        const src = `data:image/svg+xml;base64,${Buffer.from(svgBuffer).toString("base64")}`;
        await page.setContent(
            `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;background:transparent}img{display:block}</style></head><body><img alt="" width="${outWidth}" height="${outHeight}" src="${src}"></body></html>`,
            { waitUntil: "load" }
        );
        const shot = await page.locator("img").screenshot({ omitBackground: true, animations: "disabled" });
        // Reescrita pelo codificador do projeto: mesmo pixel -> mesmos bytes.
        const image = decodePng(shot);
        if (image.width !== outWidth || image.height !== outHeight) throw fail("Renderização com dimensões inesperadas", { width: image.width, height: image.height });
        const renderer = `chromium ${browser.version()} via playwright`;
        return { png: Buffer.from(encodePng(image)), width: outWidth, height: outHeight, renderer, requests: [...requests] };
    } finally {
        await offline.close();
    }
}

/**
 * Página do Chromium sem rede e sem JavaScript, com registro de toda
 * requisição não-data: (que também é abortada).
 * @returns {Promise<{ browser: import("playwright").Browser, page: import("playwright").Page, requests: string[], close: () => Promise<void> }>}
 */
export async function openOfflinePage({ width, height }) {
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        // Sem rede: nenhum nome resolve e o único proxy é uma porta morta.
        proxy: { server: "http://127.0.0.1:9" },
        args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--disable-background-networking", "--disable-component-update", "--no-pings", "--font-render-hinting=none", "--force-color-profile=srgb"],
    });
    const requests = [];
    try {
        const context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 1,
            javaScriptEnabled: false,
            offline: true,
            serviceWorkers: "block",
            acceptDownloads: false,
        });
        const page = await context.newPage();
        page.on("request", (request) => {
            if (!request.url().startsWith("data:")) requests.push(request.url());
        });
        await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
        return { browser, page, requests, close: () => browser.close() };
    } catch (error) {
        await browser.close();
        throw error;
    }
}

/**
 * Valida uma SVG local e grava o PNG derivado em uma pasta NOVA de
 * runs/assets/, com registro de origem, derivado e hashes.
 */
export async function rasterizeLocalSvg({ path: relPath, scale = 1, outputDir = DEFAULT_ASSETS_DIR, origin = null, roots, projectRoot }) {
    const source = await validateLocalSvg(relPath, { roots, projectRoot });
    const rendered = await renderSvgToPng(source.buffer, { width: source.width, height: source.height, scale });
    if (rendered.requests.length) throw fail("A rasterização tentou acessar a rede", { requests: rendered.requests.slice(0, 5) });

    await assertRunsRootAllowed(outputDir);
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "T").slice(0, 18);
    const runId = `${stamp}Z-${randomBytes(4).toString("hex")}`;
    const dir = join(resolve(outputDir), runId);
    await mkdir(resolve(outputDir), { recursive: true });
    await mkdir(dir); // falha se existir: nunca sobrescreve

    const base = relPath.split("/").pop().replace(/\.svg$/i, "");
    // Nome dentro do conjunto de caracteres aceito pelo contrato de ativos (ASSET_PATH).
    const pngName = `${base}-${scale}x.png`;
    const pngSha = sha256(rendered.png);
    const record = {
        schemaVersion: 1,
        kind: "AssetDerivation",
        tool: { name: "ads-assets", version: ASSETS_VERSION, renderer: rendered.renderer, encoder: "reference/compare/png.mjs", scale },
        source: { path: source.path, sha256: source.sha256, mime: source.mime, bytes: source.bytes, width: source.width, height: source.height, origin },
        derivative: { file: pngName, sha256: pngSha, mime: "image/png", bytes: rendered.png.length, width: rendered.width, height: rendered.height, fromSha256: source.sha256 },
        network: { requests: 0 },
        // Validado e derivado; NÃO autorizado nem enviado.
        state: { localValidated: true, authorized: false, uploaded: false },
    };
    const recordText = JSON.stringify(record, null, 2) + "\n";
    await writeFile(join(dir, pngName), rendered.png, { flag: "wx" });
    await writeFile(join(dir, "asset-record.json"), recordText, { flag: "wx" });
    const manifest = {
        schemaVersion: 1,
        kind: "AssetRun",
        runId,
        status: "ok",
        artifacts: [
            { path: pngName, sha256: pngSha, bytes: rendered.png.length },
            { path: "asset-record.json", sha256: sha256(recordText), bytes: Buffer.byteLength(recordText) },
        ],
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return { dir, runId, record, manifest };
}

/** Raiz dos derivados gerados (runs/assets/<run>/...). */
export const DERIVATIVE_ROOTS = Object.freeze(["runs/assets"]);

/**
 * Integridade dos arquivos locais declarados no ContentPack v2: cada origem e
 * cada derivado precisa existir na raiz permitida, sem symlink, com o hash, o
 * tamanho e as dimensões registrados. Não diz nada sobre autorização.
 * @returns {Promise<{ checked: number, problems: string[] }>}
 */
export async function verifyPackAssets(pack, { projectRoot = PROJECT_ROOT, roots = ALLOWED_ASSET_ROOTS } = {}) {
    const problems = [];
    let checked = 0;
    for (const [name, slot] of Object.entries(pack?.images ?? {})) {
        const files = [
            ...(slot.source ? [{ ...slot.source, roots, label: "origem" }] : []),
            ...(slot.derivatives ?? []).map((item) => ({ ...item, roots: DERIVATIVE_ROOTS, label: "derivado" })),
        ];
        for (const file of files) {
            checked++;
            try {
                const { dir, name: base } = await resolveAssetPath(file.path, { roots: file.roots, projectRoot });
                const buffer = await readRegularFile(dir, base, 20 * 1024 * 1024);
                if (sha256(buffer) !== file.sha256 || buffer.length !== file.bytes) {
                    problems.push(`${name}: ${file.label} ${file.path} não confere com o hash registrado`);
                    continue;
                }
                const size = file.mime === "image/svg+xml" ? validateSvgText(buffer.toString("utf8")) : file.mime === "image/png" ? decodePng(buffer) : null;
                if (size && (size.width !== file.width || size.height !== file.height)) problems.push(`${name}: ${file.label} ${file.path} com dimensões diferentes das registradas`);
            } catch (error) {
                problems.push(`${name}: ${file.label} ${file.path} inválido (${String(error.message).split("\n")[0]})`);
            }
        }
    }
    return { checked, problems };
}

/**
 * Prepara (offline) os derivados declarados no ContentPack v2.
 *
 * Para cada derivado:
 *  - presente no caminho registrado e com o hash certo -> "present";
 *  - ausente, com receita, em endereço de conteúdo (runs/assets/sha256/...)
 *    -> refeito a partir da ORIGEM versionada (validada e com o hash
 *    registrado) e gravado SÓ se o resultado tiver exatamente o hash
 *    registrado -> "rebuilt";
 *  - qualquer outro caso -> problema (nada é gravado).
 * Nunca acessa rede; nunca sobrescreve arquivo existente.
 * @returns {Promise<{ results: Array<{ slot: string, path: string, status: "present" | "rebuilt" | "failed", detail?: string }>, ok: boolean }>}
 */
export async function prepareDerivatives(pack, { projectRoot = PROJECT_ROOT, roots = ALLOWED_ASSET_ROOTS } = {}) {
    const { ASSET_STORE_ROOT, contentAddressedPath } = await import("../generator/content-pack.mjs");
    const results = [];
    for (const [name, slot] of Object.entries(pack?.images ?? {})) {
        for (const item of slot.derivatives ?? []) {
            const done = (status, detail) => results.push({ slot: name, path: item.path, status, ...(detail ? { detail } : {}) });
            const existing = await verifyPackAssets({ images: { [name]: { source: null, derivatives: [item] } } }, { projectRoot, roots });
            if (!existing.problems.length) {
                done("present");
                continue;
            }
            if (!/inexistente/.test(existing.problems[0])) {
                done("failed", existing.problems[0]);
                continue;
            }
            if (!item.recipe) {
                done("failed", "derivado ausente e sem receita de reconstrução");
                continue;
            }
            if (item.path !== contentAddressedPath(item.sha256, item.mime) || !item.path.startsWith(`${ASSET_STORE_ROOT}/`)) {
                done("failed", "derivado ausente fora do endereço de conteúdo (runs/assets/sha256/): não é reconstruído");
                continue;
            }
            try {
                const source = await validateLocalSvg(slot.source.path, { roots, projectRoot });
                if (source.sha256 !== slot.source.sha256 || source.sha256 !== item.fromSha256) {
                    done("failed", "origem difere do hash registrado: reconstrução recusada");
                    continue;
                }
                const rendered = await renderSvgToPng(source.buffer, { width: source.width, height: source.height, scale: item.recipe.scale });
                if (rendered.requests.length) {
                    done("failed", "a rasterização tentou acessar a rede");
                    continue;
                }
                const digest = sha256(rendered.png);
                if (digest !== item.sha256 || rendered.png.length !== item.bytes || rendered.width !== item.width || rendered.height !== item.height) {
                    done("failed", `resultado ${digest.slice(0, 12)}… difere do registrado ${item.sha256.slice(0, 12)}…: nada gravado`);
                    continue;
                }
                const target = resolve(projectRoot, item.path);
                await mkdir(resolve(projectRoot, ASSET_STORE_ROOT), { recursive: true });
                const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
                await writeFile(temporary, rendered.png, { flag: "wx" });
                await link(temporary, target); // falha se o destino já existir
                await unlink(temporary);
                done("rebuilt", `${rendered.renderer}`);
            } catch (error) {
                done("failed", String(error.message).split("\n")[0]);
            }
        }
    }
    return { results, ok: results.every((item) => item.status !== "failed") };
}
