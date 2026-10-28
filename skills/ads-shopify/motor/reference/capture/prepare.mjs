/**
 * Preparação da página antes do DOM/screenshot finais (Capture 1.1):
 *  1. espera o conteúdo parar de montar (SPAs renderizam depois do `load`);
 *  2. rolagem progressiva, em passos de ~0,8 viewport, esperando as imagens
 *     visíveis próximas da janela (tempo limitado por passo e no total);
 *     a altura é medida de novo a cada passo (página que cresce);
 *  3. volta ao topo;
 *  4. observa textos numéricos (contadores) até estabilizarem, com limite.
 *
 * Nunca clica, nunca altera o DOM/CSS para simular carregamento e nunca
 * força valores: só rola, deixa o tempo passar e observa.
 */

import { setTimeout as delay } from "node:timers/promises";

import { contentSignature, documentMetrics, imageReport, numericTexts, scrollToY } from "./page-scripts.mjs";

export const FAKE_STEP_MS = 100;

/** Relógio da página (pausado): só avança aqui, e o gasto é contabilizado. */
function pageClock(page) {
    let spent = 0;
    return {
        async run(ms) {
            if (ms <= 0) return;
            await page.clock.runFor(ms);
            spent += ms;
        },
        spent: () => spent,
    };
}

/**
 * Espera a assinatura do conteúdo ficar igual em `contentStableReads`
 * leituras seguidas e a rede ficar quieta. A cada leitura o tempo da página
 * avança um pouco (conteúdo montado por timers), dentro do orçamento fixo.
 */
async function waitForContent(page, options, network, clock) {
    const started = Date.now();
    let last = null;
    let same = 0;
    while (Date.now() - started < options.contentTimeoutMs) {
        await clock.run(options.contentPollFakeMs);
        const current = await page.evaluate(contentSignature);
        const quiet = network.inflight() === 0 && Date.now() - network.lastActivity() >= options.networkQuietMs;
        same = last && current.height === last.height && current.elements === last.elements && current.images === last.images ? same + 1 : 0;
        last = current;
        // Conteúdo estável e rede quieta; ou estável por bem mais tempo mesmo
        // com requisições longas (SSE, long-polling, analytics) abertas.
        if (same >= options.contentStableReads && (quiet || same >= options.contentStableReads * 3)) {
            return { settled: true, networkQuiet: quiet, waitMs: Date.now() - started, ...current };
        }
        await delay(options.contentPollMs);
    }
    return { settled: false, waitMs: Date.now() - started, ...(last ?? {}) };
}

/**
 * Espera as imagens visíveis a até 1 viewport da janela, com limite. Se
 * ainda houver pendentes, deixa o tempo da página correr um pouco (loaders
 * com throttle por timer), até `stepFakeMaxMs` por passo.
 */
async function waitForImagesInRange(page, options, clock) {
    const started = Date.now();
    let stepFake = 0;
    await delay(options.scrollStepDelayMs);
    for (;;) {
        const report = await page.evaluate(imageReport, Math.round(options.viewportHeight));
        if (report.inRangePending === 0) return { waited: Date.now() - started, timedOut: false };
        if (Date.now() - started >= options.stepImageTimeoutMs) return { waited: Date.now() - started, timedOut: true };
        if (stepFake < options.stepFakeMaxMs) {
            await clock.run(FAKE_STEP_MS);
            stepFake += FAKE_STEP_MS;
        }
        await delay(100);
    }
}

/**
 * @param {import("playwright").Page} page
 * @param {object} options opções da captura (+ viewportHeight)
 * @param {{ inflight: () => number, lastActivity: () => number }} network
 * @param {Array<{ code: string, message: string }>} warnings
 */
export async function preparePage(page, options, network, warnings) {
    const started = Date.now();
    const clock = pageClock(page);
    const content = await waitForContent(page, options, network, clock);
    if (!content.settled) warnings.push({ code: "CONTENT_NOT_SETTLED", message: `Conteúdo ainda mudando após ${content.waitMs} ms; a preparação pode não cobrir o que montar depois` });
    const imagesInitial = await page.evaluate(imageReport, 0);

    // --- Rolagem progressiva ------------------------------------------------
    let metrics = await page.evaluate(documentMetrics);
    const initialHeight = metrics.scrollHeight;
    let maxHeight = metrics.scrollHeight;
    let growthEvents = 0;
    let y = 0;
    let steps = 0;
    let stepTimeouts = 0;
    let stop = null;
    while (y + metrics.innerHeight < Math.min(metrics.scrollHeight, options.maxPageHeight)) {
        if (steps >= options.maxScrollSteps) {
            stop = "steps";
            break;
        }
        if (Date.now() - started >= options.prepareBudgetMs) {
            stop = "budget";
            break;
        }
        y += Math.floor(metrics.innerHeight * 0.8);
        await page.evaluate(scrollToY, y);
        await clock.run(FAKE_STEP_MS);
        const wait = await waitForImagesInRange(page, { ...options, viewportHeight: metrics.innerHeight }, clock);
        if (wait.timedOut) stepTimeouts++;
        steps++;
        metrics = await page.evaluate(documentMetrics);
        if (metrics.scrollHeight > maxHeight) {
            growthEvents++;
            maxHeight = metrics.scrollHeight;
        }
    }
    if (stop === "steps") warnings.push({ code: "SCROLL_LIMIT", message: `Rolagem interrompida após ${steps} passos` });
    if (stop === "budget") warnings.push({ code: "PREPARATION_BUDGET", message: `Preparação interrompida após ${Date.now() - started} ms` });
    if (metrics.scrollHeight > options.maxPageHeight && growthEvents > 0) {
        warnings.push({ code: "PAGE_GROWTH_LIMIT", message: `Página cresceu durante a rolagem até ${metrics.scrollHeight}px (limite ${options.maxPageHeight}px)` });
    }
    const visitedBottom = y + metrics.innerHeight;

    // --- Topo + orçamento fixo de tempo da página ---------------------------
    // O total é fixo, qualquer que seja o número de leituras e passos:
    // timers (carrosséis, relógios) terminam no mesmo estado. Estouro é
    // registrado (o estado final pode então variar com a rede).
    await page.evaluate(scrollToY, 0);
    const remainder = options.prepareFakeMs - clock.spent();
    await clock.run(remainder);
    const fakeOverrunMs = remainder < 0 ? -remainder : 0;

    // --- Conteúdo animado (contadores) --------------------------------------
    const animation = await observeNumericText(page, options, visitedBottom);
    if (animation.status === "changing") {
        warnings.push({ code: "ANIMATION_UNSTABLE", message: `Textos numéricos ainda mudando após ${animation.fakeMs} ms de tempo da página` });
    }

    const prepared = await page.evaluate(contentSignature);
    return {
        content,
        prepared,
        imagesInitial,
        scroll: { steps, stepTimeouts, stop, initialHeight, finalHeight: metrics.scrollHeight, growthEvents, visitedBottom },
        pageTime: { budgetMs: options.prepareFakeMs, spentMs: clock.spent(), overrunMs: fakeOverrunMs },
        animation,
        durationMs: Date.now() - started,
    };
}

/**
 * Deixa o tempo da página correr em passos curtos até os textos numéricos
 * ficarem iguais em 3 amostras seguidas (ou o orçamento acabar).
 * `unobserved`: textos numéricos abaixo da parte da página percorrida.
 */
async function observeNumericText(page, options, visitedBottom) {
    const signature = (entries) => entries.map((entry) => `${entry.y}:${entry.text}`).join("|");
    let entries = await page.evaluate(numericTexts);
    const unobserved = entries.filter((entry) => entry.y > visitedBottom).length;
    if (!entries.length) return { status: "none", samples: 0, fakeMs: 0, changed: false, unobserved };
    let previous = signature(entries);
    let same = 0;
    let changed = false;
    let fakeMs = 0;
    let samples = 0;
    while (fakeMs < options.animationBudgetMs) {
        await page.clock.runFor(options.animationStepMs);
        fakeMs += options.animationStepMs;
        await delay(20);
        entries = await page.evaluate(numericTexts);
        samples++;
        const current = signature(entries);
        if (current === previous) {
            same++;
            if (same >= 3) return { status: changed ? "settled" : "stable", samples, fakeMs, changed, unobserved };
        } else {
            same = 0;
            changed = true;
        }
        previous = current;
    }
    return { status: "changing", samples, fakeMs, changed, unobserved };
}
