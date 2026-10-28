/**
 * Reference Capture (M2): captura desktop/mobile de uma URL autorizada.
 *
 * Sequência: política de URL -> robots.txt -> run isolado -> proxy de
 * saída -> Chromium -> por viewport: navegação, estabilização, screenshot
 * e extração de DOM -> validação -> gravação.
 *
 * Garantia de não-parcialidade: os artefatos de captura só são gravados
 * depois que TODOS os viewports terminaram e foram validados. Em falha,
 * o run recebe apenas o log de rede (diagnóstico) e o manifesto com
 * status "failed" e o código do erro.
 */

import { errors as playwrightErrors } from "playwright";
import { setTimeout as delay } from "node:timers/promises";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { checkRobots } from "../core/robots.mjs";
import { DEFAULT_RUNS_DIR, createRun } from "../core/run-store.mjs";
import { DEFAULT_POLICY, isPreviewOrigin, parseTargetUrl } from "../core/url-policy.mjs";
import { VIEWPORTS, launchCaptureBrowser, newCaptureContext } from "./browser.mjs";
import { domSnapshotSchema } from "./dom-schema.mjs";
import { BLOCKED_HEADER, startEgressProxy } from "./egress-proxy.mjs";
import {
    detectAccessGate,
    detectChallenge,
    deterministicInit,
    documentMetrics,
    extractDom,
    fontStatus,
    freezeDynamicContent,
    contentSignature,
    imageReport,
} from "./page-scripts.mjs";
import { preparePage } from "./prepare.mjs";
import { attachRequestLog } from "./request-log.mjs";

/**
 * Versão do comportamento da captura (registrada no manifesto).
 * 1.1.0 (M7.3): espera o conteúdo montar antes de rolar; rolagem que espera
 * as imagens visíveis de cada passo; classificação das imagens (pendente,
 * falha, oculta, placeholder); observação de textos numéricos; estados ARIA
 * no DOM; registro de requisições do navegador por viewport.
 */
export const CAPTURE_VERSION = "1.1.0";

export const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
    viewports: ["desktop", "mobile"],
    navigationTimeoutMs: 30_000,
    loadTimeoutMs: 30_000,
    fontsTimeoutMs: 5_000,
    imagesTimeoutMs: 10_000,
    networkIdleTimeoutMs: 5_000,
    networkQuietMs: 500,
    settleMs: 1_500,
    scrollStepDelayMs: 100,
    // Preparação (Capture 1.1).
    contentTimeoutMs: 10_000,
    contentPollMs: 200,
    contentStableReads: 3,
    stepImageTimeoutMs: 2_500,
    prepareBudgetMs: 60_000,
    animationBudgetMs: 3_000,
    animationStepMs: 200,
    // Tempo total da página gasto na preparação (espera de conteúdo +
    // rolagem + saldo no fim): fixo, para os timers terminarem no mesmo estado.
    prepareFakeMs: 8_000,
    contentPollFakeMs: 100,
    stepFakeMaxMs: 500,
    screenshotTimeoutMs: 30_000,
    captureTimeoutMs: 180_000,
    maxScrollSteps: 40,
    // Altura máxima capturada (configurável). 20000 px verificado no
    // Chromium do Playwright 1.64 (sem repetição/vazio além de 16384 px).
    maxPageHeight: 20_000,
    maxNodes: 6_000,
    maxDepth: 80,
    maxTextLength: 300,
    maxDomBytes: 25 * 1024 * 1024,
    randomSeed: 20261012,
    clockTime: "2026-01-01T12:00:00.000Z",
    jsHeapMb: 512,
    sandbox: true,
    proxyLimits: {},
});

const RESTRICTED_STATUSES = new Set([401, 403, 407, 429]);

function fail(code, message, details) {
    return new ReferenceEngineError(code, message, details);
}

async function pollUntil(check, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await check()) return true;
        if (Date.now() >= deadline) return false;
        await delay(intervalMs);
    }
}

/**
 * Converte uma falha de navegação em código estável, usando o log do
 * proxy para identificar bloqueios de política.
 */
function classifyNavigationError(error, startUrl, proxy, eventsBefore) {
    if (error instanceof playwrightErrors.TimeoutError) {
        return fail(ErrorCodes.TIMEOUT, "Navegação excedeu o prazo", { url: startUrl.href });
    }
    const blocked = proxy.events
        .slice(eventsBefore)
        .find((event) => event.decision === "blocked" || event.code === ErrorCodes.DNS_FAILED);
    if (blocked) {
        const sameHost = blocked.target.includes(startUrl.host);
        return fail(
            sameHost ? blocked.code : ErrorCodes.REDIRECT_BLOCKED,
            `Navegação bloqueada pelo proxy (${blocked.code})`,
            { url: startUrl.href, target: blocked.target, reason: blocked.code }
        );
    }
    return fail(ErrorCodes.NAVIGATION_FAILED, `Falha de navegação: ${String(error?.message ?? error).split("\n")[0]}`, {
        url: startUrl.href,
    });
}

/**
 * Captura um viewport. Lança ReferenceEngineError em qualquer falha.
 */
async function captureViewport({ browser, viewport, url, policy, proxy, options }) {
    const context = await newCaptureContext(browser, viewport);
    const warnings = [];
    const timings = {};
    const started = Date.now();
    let popupsClosed = 0;
    let inflight = 0;
    let lastActivity = Date.now();

    try {
        await context.addInitScript(deterministicInit, { seed: options.randomSeed });
        const page = await context.newPage();

        context.on("page", (other) => {
            if (other !== page) {
                popupsClosed++;
                other.close().catch(() => {});
            }
        });
        page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
        page.on("request", () => {
            inflight++;
            lastActivity = Date.now();
        });
        const settle = () => {
            inflight = Math.max(0, inflight - 1);
            lastActivity = Date.now();
        };
        page.on("requestfinished", settle);
        page.on("requestfailed", settle);
        const requestLog = attachRequestLog(page, { blockedHeader: BLOCKED_HEADER });

        // Relógio controlado: timers só avançam quando mandamos. `install`
        // sozinho deixa o tempo da página correr junto com o tempo real; a
        // pausa é o que torna o estado dos timers independente das esperas.
        await page.clock.install({ time: new Date(options.clockTime) });
        await page.clock.pauseAt(new Date(options.clockTime));

        // --- Navegação -------------------------------------------------------
        const eventsBefore = proxy.events.length;
        let response;
        try {
            response = await page.goto(url.href, {
                waitUntil: "domcontentloaded",
                timeout: options.navigationTimeoutMs,
            });
        } catch (error) {
            throw classifyNavigationError(error, url, proxy, eventsBefore);
        }
        if (!response) {
            throw fail(ErrorCodes.NAVIGATION_FAILED, "Navegação sem resposta", { url: url.href });
        }

        const redirects = [];
        for (let request = response.request().redirectedFrom(); request; request = request.redirectedFrom()) {
            redirects.unshift(request.url());
        }

        const headers = await response.allHeaders();
        if (headers[BLOCKED_HEADER]) {
            const reason = headers[BLOCKED_HEADER];
            throw fail(
                redirects.length ? ErrorCodes.REDIRECT_BLOCKED : reason,
                `Documento bloqueado pelo proxy (${reason})`,
                { url: response.url(), reason, redirects }
            );
        }

        const status = response.status();
        if (RESTRICTED_STATUSES.has(status)) {
            throw fail(ErrorCodes.ACCESS_RESTRICTED, `Acesso negado: HTTP ${status}`, { url: response.url(), status });
        }
        if (status >= 400) {
            throw fail(ErrorCodes.HTTP_ERROR, `HTTP ${status}`, { url: response.url(), status });
        }

        // Defesa adicional: a URL final também precisa obedecer à política.
        const finalUrl = parseTargetUrl(page.url(), policy);
        timings.navigationMs = Date.now() - started;

        try {
            await page.waitForLoadState("load", { timeout: options.loadTimeoutMs });
        } catch {
            throw fail(ErrorCodes.TIMEOUT, "Evento load não ocorreu no prazo", { url: finalUrl.href });
        }

        const gate = await page.evaluate(detectAccessGate);
        if (gate.length) {
            throw fail(ErrorCodes.ACCESS_RESTRICTED, "Loja protegida por senha; a captura não tenta autenticar", {
                url: finalUrl.href,
                signals: gate,
            });
        }

        const challenge = await page.evaluate(detectChallenge);
        if (challenge.length) {
            throw fail(ErrorCodes.CHALLENGE_DETECTED, "Página de desafio/anti-bot detectada; captura não prossegue", {
                url: finalUrl.href,
                signals: challenge,
            });
        }

        // --- Estabilização ---------------------------------------------------
        await page.clock.runFor(options.settleMs);

        const fontsReady = await pollUntil(
            async () => (await page.evaluate(fontStatus)) === "loaded",
            options.fontsTimeoutMs
        );
        if (!fontsReady) warnings.push({ code: "FONTS_TIMEOUT", message: "Fontes não carregaram no prazo" });

        // Preparação: conteúdo montado, rolagem progressiva com espera das
        // imagens de cada passo, volta ao topo e contadores estabilizados.
        const network = { inflight: () => inflight, lastActivity: () => lastActivity };
        const preparation = await preparePage(page, options, network, warnings);
        let metrics;

        // Imagens: só as renderizadas com URL real contam como pendentes;
        // ocultas e placeholders embutidos são registrados à parte.
        const imagesReady = await pollUntil(
            async () => (await page.evaluate(imageReport, 0)).pending === 0,
            options.imagesTimeoutMs
        );
        const report = await page.evaluate(imageReport, 0);
        const failedCauses = report.failedSrc.map((src) => requestLog.outcomeOf(src));
        const images = {
            total: report.total,
            loaded: report.loaded,
            pending: report.pending,
            failed: report.failed,
            hidden: report.hidden,
            placeholder: report.placeholder,
            initialPending: preparation.imagesInitial.pending,
            initialTotal: preparation.imagesInitial.total,
            failedCauses,
            pendingCauses: report.pendingSrc.map((src) => requestLog.outcomeOf(src)),
        };
        if (!imagesReady) {
            warnings.push({ code: "IMAGES_INCOMPLETE", message: `${report.pending} imagens visíveis não carregaram no prazo` });
        }
        if (report.failed) {
            const kinds = [...new Set(failedCauses.map((cause) => cause.outcome))].join(", ");
            warnings.push({ code: "IMAGES_FAILED", message: `${report.failed} imagens falharam (${kinds})` });
        }

        // Layout estável: altura igual em leituras consecutivas e fontes prontas.
        let lastHeight = -1;
        const stable = await pollUntil(async () => {
            const { scrollHeight } = await page.evaluate(documentMetrics);
            const fonts = await page.evaluate(fontStatus);
            const same = scrollHeight === lastHeight && fonts === "loaded";
            lastHeight = scrollHeight;
            return same;
        }, options.fontsTimeoutMs, 150);
        if (!stable) warnings.push({ code: "LAYOUT_UNSTABLE", message: "Altura da página ou fontes ainda mudando" });

        const idle = await pollUntil(
            async () => inflight === 0 && Date.now() - lastActivity >= options.networkQuietMs,
            options.networkIdleTimeoutMs
        );
        if (!idle) warnings.push({ code: "NETWORK_NOT_IDLE", message: `${inflight} requisições ainda abertas` });

        // Conteúdo que montou DEPOIS da preparação não foi rolado nem
        // esperado: registrar, em vez de declarar a captura completa.
        const final = await page.evaluate(contentSignature);
        const before = preparation.prepared;
        if (final.images > before.images || Math.abs(final.height - before.height) > Math.max(1, before.height) * 0.1) {
            warnings.push({
                code: "LATE_CONTENT",
                message: `Conteúdo mudou depois da preparação (imagens ${before.images}→${final.images}, altura ${before.height}→${final.height}px)`,
            });
        }

        await page.evaluate(freezeDynamicContent);
        // Tempo da página efetivamente aplicado = o registrado (relógio pausado).
        const pageNow = () => page.evaluate(() => Date.now());
        const clockStart = Date.parse(options.clockTime);
        const expectedPageMs = options.settleMs + preparation.pageTime.spentMs + preparation.animation.fakeMs;
        const beforeDomMs = (await pageNow()) - clockStart;
        timings.stabilizeMs = Date.now() - started - timings.navigationMs;

        // --- DOM ---------------------------------------------------------------
        // Extraído ANTES da screenshot: a captura de página inteira redimensiona
        // o viewport temporariamente, e o DOM deve refletir o estado estável.
        const extracted = await page.evaluate(extractDom, {
            maxNodes: options.maxNodes,
            maxTextLength: options.maxTextLength,
            maxDepth: options.maxDepth,
        });

        const parsed = domSnapshotSchema.safeParse({
            schemaVersion: 1,
            viewport: {
                name: viewport.name,
                width: viewport.width,
                height: viewport.height,
                deviceScaleFactor: viewport.deviceScaleFactor,
                isMobile: viewport.isMobile,
            },
            ...extracted,
        });
        if (!parsed.success) {
            throw fail(ErrorCodes.CAPTURE_INVALID, "Snapshot de DOM fora do contrato", {
                issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message),
            });
        }
        if (parsed.data.stats.truncated) {
            warnings.push({ code: "DOM_TRUNCATED", message: `DOM limitado a ${options.maxNodes} nós` });
        }

        const domJson = JSON.stringify(parsed.data, null, 2) + "\n";
        if (Buffer.byteLength(domJson) > options.maxDomBytes) {
            throw fail(ErrorCodes.RESOURCE_LIMIT, "Snapshot de DOM excede o limite de bytes", {
                bytes: Buffer.byteLength(domJson),
            });
        }

        // --- Screenshot ------------------------------------------------------
        metrics = await page.evaluate(documentMetrics);
        const screenshotTruncated = metrics.scrollHeight > options.maxPageHeight;
        if (screenshotTruncated) {
            warnings.push({
                code: "PAGE_HEIGHT_LIMIT",
                message: `Página com ${metrics.scrollHeight}px; screenshot limitado a ${options.maxPageHeight}px`,
            });
        }

        const screenshot = await page.screenshot({
            type: "png",
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            scale: "css",
            timeout: options.screenshotTimeoutMs,
            ...(screenshotTruncated
                ? { clip: { x: 0, y: 0, width: metrics.innerWidth, height: options.maxPageHeight } }
                : {}),
        });

        const afterScreenshotMs = (await pageNow()) - clockStart;
        const pageClock = { expectedMs: expectedPageMs, beforeDomMs, afterScreenshotMs };
        if (beforeDomMs !== expectedPageMs || afterScreenshotMs !== beforeDomMs) {
            warnings.push({ code: "CLOCK_MISMATCH", message: `Tempo da página ${beforeDomMs}/${afterScreenshotMs} ms difere do registrado (${expectedPageMs} ms)` });
        }

        timings.totalMs = Date.now() - started;

        const requests = JSON.stringify({ schemaVersion: 1, viewport: viewport.name, ...requestLog.snapshot() }, null, 2) + "\n";

        return {
            screenshot,
            domJson,
            requests,
            info: {
                status,
                finalUrl: finalUrl.href,
                redirects,
                pageHeight: metrics.scrollHeight,
                screenshotHeight: screenshotTruncated ? options.maxPageHeight : metrics.scrollHeight,
                screenshotTruncated,
                truncation: screenshotTruncated ? { reason: "maxPageHeight", limit: options.maxPageHeight, pageHeight: metrics.scrollHeight, capturedHeight: options.maxPageHeight } : null,
                pageClock,
                scrollSteps: preparation.scroll.steps,
                popupsClosed,
                images,
                preparation,
                warnings,
                timings,
            },
        };
    } finally {
        await context.close().catch(() => {});
    }
}

/**
 * @typedef {object} CaptureResult
 * @property {boolean} ok
 * @property {import("../core/run-store.mjs").Run | null} run
 * @property {{ code: string, message: string, details?: object } | null} error
 * @property {Array<{ viewport: string, code: string, message: string }>} warnings
 */

/**
 * @param {object} params
 * @param {string | URL} params.url
 * @param {Readonly<import("../core/url-policy.mjs").UrlPolicy>} [params.policy]
 * @param {string} [params.runsDir]
 * @param {typeof import("node:dns").lookup} [params.lookup] DNS injetável (testes).
 * @param {Partial<typeof DEFAULT_CAPTURE_OPTIONS>} [params.options]
 * @param {{ onProxyStarted?: (proxy: Awaited<ReturnType<typeof startEgressProxy>>) => void }} [params.hooks]
 *   Observação para testes (ex.: provar que toda conexão veio do proxy).
 * @returns {Promise<CaptureResult>}
 */
export async function captureReference({
    url: input,
    policy = DEFAULT_POLICY,
    runsDir = DEFAULT_RUNS_DIR,
    lookup,
    options = {},
    hooks = {},
}) {
    const config = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
    const asError = (error) => ({
        code: error instanceof ReferenceEngineError ? error.code : ErrorCodes.BROWSER_ERROR,
        message: String(error?.message ?? error).split("\n")[0],
        ...(error instanceof ReferenceEngineError ? { details: error.details } : {}),
    });

    for (const name of config.viewports) {
        if (!VIEWPORTS[name]) throw new Error(`Viewport desconhecido: ${name}`);
    }

    // 1. Política e robots.txt: recusas aqui não criam run.
    let url;
    try {
        url = parseTargetUrl(input, policy);
    } catch (error) {
        return { ok: false, run: null, error: asError(error), warnings: [] };
    }

    // Prévia local própria (origem exata autorizada na CLI): robots.txt não
    // se aplica. A dispensa fica registrada no manifesto.
    const robots = isPreviewOrigin(url, policy)
        ? { allowed: true, source: "skipped-local-preview", status: null }
        : await checkRobots(url, { policy, ...(lookup ? { lookup } : {}) });
    if (!robots.allowed) {
        return {
            ok: false,
            run: null,
            error: {
                code: robots.source === "restricted" ? ErrorCodes.ACCESS_RESTRICTED : ErrorCodes.ROBOTS_DISALLOWED,
                message: `robots.txt não permite a captura (${robots.source})`,
                details: robots,
            },
            warnings: [],
        };
    }

    // 2. Execução isolada.
    const run = await createRun({ url, rootDir: runsDir });
    const startedAt = new Date().toISOString();

    const proxy = await startEgressProxy({ policy, limits: config.proxyLimits, lookup });
    hooks.onProxyStarted?.(proxy);
    let browser = null;
    let browserVersion = null;
    let timedOut = false;
    const results = {};
    let failure = null;

    const deadline = setTimeout(() => {
        timedOut = true;
        browser?.close().catch(() => {});
    }, config.captureTimeoutMs);

    try {
        browser = await launchCaptureBrowser({
            proxyUrl: proxy.url,
            jsHeapMb: config.jsHeapMb,
            sandbox: config.sandbox,
        });
        browserVersion = browser.version();
        for (const name of config.viewports) {
            results[name] = await captureViewport({
                browser,
                viewport: VIEWPORTS[name],
                url,
                policy,
                proxy,
                options: config,
            });
        }
        if (proxy.stats.limitExceeded) {
            throw fail(ErrorCodes.RESOURCE_LIMIT, `Limite de rede excedido (${proxy.stats.limitExceeded})`, {
                limit: proxy.stats.limitExceeded,
            });
        }
    } catch (error) {
        failure = timedOut
            ? fail(ErrorCodes.TIMEOUT, `Captura excedeu ${config.captureTimeoutMs} ms`)
            : error;
    } finally {
        clearTimeout(deadline);
        await browser?.close().catch(() => {});
        await proxy.close();
    }

    const network = JSON.stringify(
        { schemaVersion: 1, stats: proxy.stats, events: proxy.events },
        null,
        2
    ) + "\n";
    const finishedAt = new Date().toISOString();

    if (failure) {
        const error = asError(failure);
        await run.writeArtifact("network.json", network, { kind: "network-log" });
        await run.recordStep({
            name: "capture",
            status: "failed",
            startedAt,
            finishedAt,
            error: { code: error.code, message: error.message },
            info: { details: error.details ?? {}, network: proxy.stats },
        });
        await run.finish("failed");
        return { ok: false, run, error, warnings: [] };
    }

    // 3. Tudo validado: gravar artefatos.
    const warnings = [];
    const viewportsInfo = {};
    for (const name of config.viewports) {
        const result = results[name];
        await run.writeArtifact(`screenshot-${name}.png`, result.screenshot, { kind: "screenshot" });
        await run.writeArtifact(`dom-${name}.json`, result.domJson, { kind: "dom" });
        await run.writeArtifact(`requests-${name}.json`, result.requests, { kind: "request-log" });
        viewportsInfo[name] = result.info;
        for (const warning of result.info.warnings) warnings.push({ viewport: name, ...warning });
    }
    await run.writeArtifact("network.json", network, { kind: "network-log" });

    await run.recordStep({
        name: "capture",
        status: "ok",
        startedAt,
        finishedAt,
        info: {
            complete: warnings.length === 0,
            warnings,
            viewports: viewportsInfo,
            network: proxy.stats,
            robots: { source: robots.source, status: robots.status },
            browser: { name: "chromium", version: browserVersion },
            captureVersion: CAPTURE_VERSION,
            options: config,
        },
    });
    await run.finish("ok");

    return { ok: true, run, error: null, warnings };
}
