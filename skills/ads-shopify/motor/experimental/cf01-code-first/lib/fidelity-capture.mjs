/**
 * CF-01 — captura de fidelidade (núcleo do `shopify-capture.mjs`): retrato visual e verificações de interação SEPARADOS.
 *
 * 1. Retrato (DOM via `extractDom`, screenshot, fontes) é GRAVADO antes de qualquer interação.
 * 2. Interações (acordeões, alternador de menu) nunca derrubam a captura: cada uma devolve um status (`ok`,
 *    `intercepted`, `error`, `not-found`) com a evidência (elemento por cima, posição, rolagem, escala, erro).
 *    Antes de clicar: rola o elemento até o CENTRO da janela (como um usuário), espera o layout estabilizar e faz um
 *    hit-test real (`elementFromPoint`). Se outro elemento estiver por cima, registra quem e NÃO clica. Sem
 *    `force`, sem clique via JavaScript: o clique é do mouse do Playwright, com timeout curto.
 * 3. Manifesto com status verificável: `incomplete` ao começar, `complete` só no fim (com sha256 de cada arquivo),
 *    `failed` com o erro se algo fatal ocorrer. `captureIntegrity` recusa o que não for `complete` e íntegro.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

export const CAPTURER_VERSION = "cf01-fidelity-capture/11";
// /9 (22/10/2026): D-05b — a passagem de rolagem da /8 decidia "fim do documento" pela PRIMEIRA leitura; numa página
// que renderiza depois do `load` (SPA) o documento ainda tinha a altura da janela → 0 passos, imagens nunca entravam na
// janela e o orçamento inteiro ia para leituras de estabilidade. Agora: espera (limitada) o documento parar de crescer,
// recalcula o fim a cada passo e confere crescimento depois do "fim", leva à janela a mídia relevante pendente que a
// passagem não alcançou, orçamento SEPARADO e mensurado (percurso × estabilização, mesmo total de 20 s) e registro de
// passos, tempos por fase e se cada mídia foi alcançada. Regra inalterada: pendente ou falha → nunca `complete`.
// /8 (22/10/2026): D-05 — ESTABILIZAÇÃO VISUAL antes do retrato (`stabilizeMedia`): passagem de rolagem real que espera
// a mídia de cada trecho visível; mídia relevante classificada (img/picture/video renderizados e não recortados) e
// separada da ignorada (invisível, técnica, ícone pequeno, fora da área horizontal, recortada); estado pelo resultado
// real (`complete` + `naturalWidth/Height` — `complete` sozinho também vale para falha) e geometria estável em leituras
// consecutivas, dentro de um orçamento. Mídia pendente, mídia com falha ou layout instável → captura `incomplete` com o
// motivo exato (nunca `complete`); contagens e evidências em `manifest.media`. Nada é forçado: sem trocar `loading`,
// `src` ou atributos, sem contornar rede/robots.
// /7 (22/10/2026): D-04 — as QUATRO bordas CSS computadas (top, right, bottom, left: largura, estilo e cor) de cada
// elemento com caixa, em `borders-<vp>.json` (junção com o DOM por tag + caixa, como o D-03). O extrator compartilhado
// (`reference/capture/page-scripts.mjs`, só borda superior) NÃO é alterado. Capturas < /7 continuam íntegras sem o arquivo.
// /6 (22/10/2026): D-01 — barra de prévia reconhecida pela estrutura REAL (`div#PBarNextFrameWrapper >
// iframe#PBarNextFrame`, seletores antigos como alternativa); caixa medida no contêiner; resíduo de sobreposição da
// plataforma verificado depois da tentativa → `pixels` CLEAN | CONTAMINATED por viewport (comparações de pixels
// recusadas a jusante). Clique pela interface, sem force e sem remoção por JavaScript.
// D-03 — geometria do texto RENDERIZADO (`text-<vp>.json`): por elemento com texto próprio, caracteres do contexto
// inline completo (inclui strong/span/a/em…), número de linhas e caixas de linha (Range.getClientRects), sha256 do
// texto normalizado (rastreabilidade sem copiar o texto). Chave de junção com o DOM: tag + caixa (mesmo arredondamento).
// /5 (21/10/2026): barra de prévia da Shopify controlada pela PRÓPRIA interface (clique real em "Hide bar", sem
// remover nada por JavaScript), ANTES do retrato, com estado antes/depois registrado (`previewBar`).
// /4 (21/10/2026): discrepância entre viewport esperado, janela de layout e posição real dos elementos (`layout` no
// probe e no manifesto); interações com janela de layout ampliada viram `invalid-layout` (coordenadas da página ≠ tela).
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** No navegador: faces do documento e `document.fonts.check` das famílias realmente usadas em textos visíveis. */
export function fontEvidence() {
    const keys = new Set();
    for (const el of document.querySelectorAll("body *")) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(el);
        keys.add(`${cs.fontStyle}|${cs.fontWeight}|${cs.fontFamily.split(",")[0].trim()}`);
    }
    const used = [...keys].map((k) => { const [style, weight, family] = k.split("|"); return { family: family.replace(/^["']|["']$/g, ""), style, weight, check: document.fonts.check(`${style} ${weight} 16px ${family}`) }; });
    return { faces: [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ""), style: f.style, weight: f.weight, status: f.status })), used };
}

/** No navegador: centraliza o elemento, espera 2 quadros com a caixa estável e testa quem recebe o ponteiro no centro. */
async function hitTestInPage(el) {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    el.scrollIntoView({ block: "center", inline: "nearest" });
    let prev = null, rect = null, stable = false;
    for (let i = 0; i < 10 && !stable; i++) { await frame(); await frame(); rect = el.getBoundingClientRect(); stable = prev && Math.abs(prev.top - rect.top) < 0.5 && Math.abs(prev.left - rect.left) < 0.5; prev = rect; }
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    const describe = (n) => n && { tag: n.tagName.toLowerCase(), class: (n.getAttribute("class") || "").slice(0, 60), section: n.closest('[id^="shopify-section-"]')?.id.split("__").pop() ?? null, fixedAncestor: (() => { for (let q = n; q && q !== document.body; q = q.parentElement) { const p = getComputedStyle(q).position; if (p === "fixed" || p === "sticky") return { tag: q.tagName.toLowerCase(), position: p, text: (q.innerText || "").trim().slice(0, 30) }; } return null; })(), open: n.closest("details")?.open ?? null };
    return { stable, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, point: { x, y }, scrollY: window.scrollY, scale: window.visualViewport?.scale ?? 1, innerHeight, covered: !!top && top !== el && !el.contains(top), coveredBy: top && top !== el && !el.contains(top) ? describe(top) : null, inViewport: y >= 0 && y <= innerHeight };
}

/** No navegador: janela de layout × viewport esperado e elementos que ultrapassam a largura esperada. */
export function layoutEvidence(expectedWidth) {
    const vv = window.visualViewport;
    const over = [];
    for (const el of document.body.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > expectedWidth + 1) over.push({ tag: el.tagName.toLowerCase(), class: (el.getAttribute("class") || "").slice(0, 40), section: el.closest('[id^="shopify-section-"]')?.id.split("__").pop() ?? null, right: Math.round(r.right), width: Math.round(r.width) });
    }
    // texto solto direto no <body> (ex.: CSS fora de <style>) também alarga a página
    const bodyText = [...document.body.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).map((n) => { const rg = document.createRange(); rg.selectNodeContents(n); const r = rg.getBoundingClientRect(); return { right: Math.round(r.right), chars: n.nodeValue.trim().length }; }).filter((t) => t.right > expectedWidth + 1);
    const innerWidth = window.innerWidth, scrollWidth = document.documentElement.scrollWidth;
    return { expectedWidth, innerWidth, innerHeight: window.innerHeight, scrollWidth, visualWidth: vv ? Math.round(vv.width) : null, scale: vv?.scale ?? 1, expanded: innerWidth !== expectedWidth, overflowX: scrollWidth > innerWidth + 1 || innerWidth > expectedWidth, overflowing: over.sort((a, b) => b.right - a.right).slice(0, 5), looseBodyText: bodyText.slice(0, 3) };
}

/** Clique REAL (mouse do Playwright) só se o hit-test mostrar que o elemento recebe o ponteiro; nunca lança. */
export async function realClick(handle, { timeoutMs = 3000, expectedWidth = null } = {}) {
    if (expectedWidth != null) {
        const iw = await handle.evaluate(() => window.innerWidth).catch(() => null);
        if (iw != null && iw !== expectedWidth) return { status: "invalid-layout", stage: "layout", error: `janela de layout ampliada (${iw}px ≠ ${expectedWidth}px esperados): coordenadas da página e da tela divergem, clique não é confiável`, hit: null };
    }
    let hit;
    try { hit = await handle.evaluate(hitTestInPage); } catch (e) { return { status: "error", stage: "hit-test", error: String(e.message).split("\n")[0].slice(0, 200) }; }
    if (!hit.inViewport || !hit.rect.width || !hit.rect.height) return { status: "error", stage: "hit-test", error: "elemento fora da janela ou sem caixa", hit };
    if (hit.covered) return { status: "intercepted", stage: "hit-test", hit };
    try { await handle.click({ timeout: timeoutMs }); return { status: "ok", hit }; } catch (e) {
        const lines = String(e.message).split("\n");
        return { status: /intercepts pointer events/.test(e.message) ? "intercepted" : "error", stage: "click", error: (lines.find((l) => /intercepts|not visible|not stable|detached|Timeout/.test(l)) ?? lines[0]).trim().slice(0, 240), hit };
    }
}

/**
 * Modo OPCIONAL "url-pb0": a Shopify documenta `pb=0` ("preview bar off") nas URLs de prévia `*.shopifypreview.com`
 * para testes (shopify.dev/docs/storefronts/themes/best-practices/performance/testing-for-performance). Acrescenta o
 * parâmetro por `URL.searchParams` (host, caminho, demais parâmetros e fragmento preservados; `pb` existente vira 0).
 * Só aceita https e o host documentado; qualquer outro alvo é recusado (o mecanismo não se aplica).
 */
export const PB0_DOC = "https://shopify.dev/docs/storefronts/themes/best-practices/performance/testing-for-performance";
export function previewUrlWithBarOff(url, { hostPattern = /\.shopifypreview\.com$/i, allowHttp = false } = {}) {
    const u = new URL(url);
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Error("pb=0: URL da prévia não é https");
    if (!hostPattern.test(u.hostname)) throw new Error("pb=0: host fora do mecanismo documentado (*.shopifypreview.com)");
    const before = [...u.searchParams.keys()].filter((k) => k !== "pb");
    const hadPb = u.searchParams.has("pb");
    u.searchParams.set("pb", "0");
    return { url: u.href, transform: { param: "pb", value: "0", replacedExisting: hadPb, preservedParams: before.length, path: u.pathname, fragment: u.hash !== "" } };
}

/** Método de comparação textual da identidade (registrado no manifesto). */
export const IDENTITY_TEXT_METHOD = "textContent-renderizado/1: nós de texto de elementos com caixa > 0 e checkVisibility(visibility, opacity, content-visibility); exclui script/style/noscript/template; grafia exata (espaços normalizados)";

/**
 * No navegador: evidência de identidade (textos e seções esperados; id do tema que a Shopify expõe em window.Shopify).
 * D-07: NÃO usa `innerText` (texto renderizado, com `text-transform` aplicado → falso negativo em textos em caixa alta
 * por CSS). Usa a grafia ORIGINAL dos nós de texto, mas só de elementos efetivamente renderizados: texto oculto
 * (display:none, visibility:hidden, opacity 0, <details> fechado) e conteúdo de script/style não contam. O texto
 * esperado tem de estar no texto renderizado de UM elemento (o próprio ou a concatenação dos descendentes renderizados).
 */
export function identityEvidence({ texts = [], sections = [] }) {
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    const memo = new Map();
    const rendered = (el) => {
        if (memo.has(el)) return memo.get(el);
        let ok = !el.closest("script, style, noscript, template");
        if (ok) { const r = el.getBoundingClientRect(); ok = r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }); }
        memo.set(el, ok);
        return ok;
    };
    const visibleText = new Map(); // elemento renderizado → concatenação dos seus nós de texto renderizados (ordem do documento)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const p = t.parentElement;
        if (!p || SKIP.has(p.tagName) || !rendered(p)) continue;
        for (let q = p; q && rendered(q); q = q.parentElement) { visibleText.set(q, (visibleText.get(q) ?? "") + t.nodeValue); if (q === document.body) break; }
    }
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const candidates = [...visibleText.values()].map(norm);
    const ids = [...document.querySelectorAll('[id^="shopify-section-"]')].map((e) => e.id);
    return { missingTexts: texts.filter((t) => !candidates.some((c) => c.includes(norm(t)))), missingSections: sections.filter((s) => !ids.some((id) => id.endsWith(`__${s}`) || id === s)), themeId: window.Shopify?.theme?.id ?? null, themeRole: window.Shopify?.theme?.role ?? null };
}

/** Variantes conhecidas da barra de prévia (a primeira é a estrutura real observada em 21/10/2026). */
export const PREVIEW_BARS = [
    { variant: "pbar-next", container: "#PBarNextFrameWrapper", frame: "iframe#PBarNextFrame" },
    { variant: "legado", container: null, frame: 'iframe#preview-bar-iframe, iframe[src*="preview_bar"], iframe[title*="preview" i]' },
];
/** Ids de sobreposição da plataforma que contaminam pixels quando visíveis. */
export const OVERLAY_ID = /^(PBar|preview-bar)/i;

/** No navegador: sobreposições da plataforma ainda visíveis (id reconhecido, caixa > 0, dentro da janela). */
export function overlayResidue(pattern) {
    const re = new RegExp(pattern, "i");
    return [...document.querySelectorAll("[id]")].filter((e) => re.test(e.id)).map((e) => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return { id: e.id, tag: e.tagName.toLowerCase(), position: cs.position, box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, visible: cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight };
    }).filter((x) => x.visible);
}

/** Nome acessível do controle de recolher e de um eventual menu da barra (o menu só é DIAGNOSTICADO, nunca clicado). */
export const PREVIEW_BAR_HIDE = /hide bar|hide|ocultar|esconder|minimi[sz]e|collapse/i;
export const PREVIEW_BAR_MENU = /more|menu|op[cç][oõ]es|options|mais/i;

/** No iframe da barra: o próprio controle recebe o ponteiro no centro da sua caixa (coordenadas do iframe)? */
function innerHitTest(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const own = !!top && (top === el || el.contains(top));
    return { own, inFrameViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight, topmost: top ? { tag: top.tagName.toLowerCase(), id: top.id || null, text: (top.textContent || "").trim().slice(0, 30) } : null };
}

/**
 * D-06 (/10): diagnóstico de UM candidato da barra. Elegível só se TODOS valem:
 *   (a) `isVisible()` do Playwright (necessário, não suficiente: fora da tela/recortado ainda conta como "visível");
 *   (b) caixa inteira dentro do contêiner da barra E da janela (o ponto de clique está na faixa visível da barra);
 *   (c) no documento principal, `elementFromPoint` no centro = o próprio iframe da barra (nada cobre o ponto);
 *   (d) dentro do iframe, `elementFromPoint` no centro = o controle ou um descendente (não recortado/coberto).
 * Nada é alterado na página: só leituras.
 */
async function previewBarCandidate(page, frameEl, loc, i, kind, container, viewport) {
    const c = { index: i, kind, selector: `iframe getByRole(button, ${kind === "hide" ? PREVIEW_BAR_HIDE : PREVIEW_BAR_MENU}).nth(${i})`, name: null, visible: false, box: null, insideBar: false, insideViewport: false, barIntersection: 0, hitTop: null, hitInFrame: null, eligible: false, rejected: null };
    try {
        c.name = await loc.evaluate((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 60));
        c.visible = await loc.isVisible();
        const b = await loc.boundingBox();
        c.box = b && { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, width: Math.round(b.width * 100) / 100, height: Math.round(b.height * 100) / 100 };
        if (b && container) {
            const ix = Math.max(0, Math.min(b.x + b.width, container.x + container.width) - Math.max(b.x, container.x)), iy = Math.max(0, Math.min(b.y + b.height, container.y + container.height) - Math.max(b.y, container.y));
            c.barIntersection = b.width && b.height ? Math.round((ix * iy) / (b.width * b.height) * 1000) / 1000 : 0;
            c.insideBar = c.barIntersection >= 0.999;
            c.insideViewport = b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= viewport.width + 0.5 && b.y + b.height <= viewport.height + 0.5;
        }
        if (b && b.width > 0 && b.height > 0) {
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            const frameHandle = await frameEl.elementHandle();
            c.hitTop = await page.evaluate(([x, y, f]) => { const t = document.elementFromPoint(x, y); return { isBarFrame: t === f, topmost: t ? { tag: t.tagName.toLowerCase(), id: t.id || null } : null }; }, [cx, cy, frameHandle]);
            c.hitInFrame = await loc.evaluate(innerHitTest);
        }
        c.rejected = !c.visible ? "invisível (Playwright)" : !c.box || !c.box.width || !c.box.height ? "sem caixa" : !c.insideViewport ? "fora da janela" : !c.insideBar ? `fora da faixa visível da barra (interseção ${c.barIntersection})` : !c.hitTop?.isBarFrame ? `ponto de clique coberto no documento principal (${c.hitTop?.topmost?.tag ?? "nada"})` : !c.hitInFrame?.own ? `ponto de clique não pertence ao controle dentro do iframe (${c.hitInFrame?.topmost?.tag ?? "nada"})` : null;
        c.eligible = c.rejected === null;
    } catch (e) { c.rejected = `erro no diagnóstico: ${String(e.message).split("\n")[0].slice(0, 120)}`; }
    return c;
}

/**
 * Barra de prévia da Shopify: localiza pela estrutura real (contêiner + iframe) ou pelos seletores antigos e clica DE
 * VERDADE (mouse do Playwright, sem force) no botão de recolher DENTRO do iframe. Mede o CONTÊINER antes/depois e, no
 * fim, verifica o resíduo de sobreposição: `pixels` = CLEAN só se nada da barra continuar visível. Nunca lança e
 * nunca remove nada por JavaScript.
 *
 * /10 (D-06): em vez do PRIMEIRO botão com o nome certo (/9: `.first()`, que no mobile real escolhia um controle sem
 * ponto de clique disponível → Timeout), enumera TODOS os candidatos, registra o diagnóstico de cada um (`candidates`)
 * e clica UMA vez, só se houver EXATAMENTE UM elegível; mais de um = ambíguo (não clica). Menus da barra são apenas
 * diagnosticados (`menuCandidates`). O clique bem-sucedido não decide nada: `pixels` continua vindo do resíduo.
 */
export async function hidePreviewBar(page, { timeoutMs = 4000, maxCandidates = 12 } = {}) {
    const residue = async () => page.evaluate(overlayResidue, OVERLAY_ID.source).catch(() => []);
    const finish = async (r) => { const left = await residue(); return { policy: "único-elegível/1-clique", ...r, residue: left, pixels: left.length ? "CONTAMINATED" : "CLEAN" }; };
    try {
        let hit = null;
        for (const v of PREVIEW_BARS) {
            const frameEl = page.locator(v.container ? `${v.container} ${v.frame}` : v.frame).first();
            if (await frameEl.count()) { hit = { v, frameEl, boxEl: v.container ? page.locator(v.container).first() : frameEl }; break; }
        }
        if (!hit) return finish({ found: false, action: "hide" });
        const box = async () => { const b = await hit.boxEl.boundingBox().catch(() => null); return b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; };
        const before = await box();
        const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const containerRaw = await hit.boxEl.boundingBox().catch(() => null);
        const frame = await (await hit.frameEl.elementHandle()).contentFrame();
        const base = { found: true, variant: hit.v.variant, action: "hide", before, attempts: 0 };
        if (!frame) return finish({ ...base, clicked: false, after: before, collapsed: false, candidates: [], menuCandidates: [], error: "iframe da barra sem documento acessível (limitação registrada)" });
        const enumerate = async (re, kind) => { const all = frame.getByRole("button", { name: re }); const n = Math.min(await all.count(), maxCandidates); const out = []; for (let i = 0; i < n; i++) out.push(await previewBarCandidate(page, hit.frameEl, all.nth(i), i, kind, containerRaw, viewport)); return out; };
        const candidates = await enumerate(PREVIEW_BAR_HIDE, "hide");
        const menuCandidates = await enumerate(PREVIEW_BAR_MENU, "menu");
        const eligible = candidates.filter((c) => c.eligible);
        if (!candidates.length) return finish({ ...base, clicked: false, after: before, collapsed: false, candidates, menuCandidates, error: `botão de recolher não encontrado (limitação registrada)${menuCandidates.length ? `; ${menuCandidates.length} controle(s) de menu diagnosticado(s), não clicados` : ""}` });
        if (eligible.length !== 1) return finish({ ...base, clicked: false, after: before, collapsed: false, candidates, menuCandidates, error: eligible.length ? `ambíguo: ${eligible.length} controles elegíveis (nenhum clique)` : `nenhum controle seguro: ${candidates.map((c) => `#${c.index} ${c.rejected}`).join("; ")}` });
        const chosen = eligible[0];
        const loc = frame.getByRole("button", { name: PREVIEW_BAR_HIDE }).nth(chosen.index);
        let error = null;
        // clique real no CENTRO verificado (o mesmo ponto dos testes de acerto), sem force, uma única tentativa
        await loc.click({ timeout: timeoutMs, position: { x: chosen.box.width / 2, y: chosen.box.height / 2 } }).catch((e) => { error = String(e.message).split("\n")[0].slice(0, 200); });
        await page.waitForTimeout(600);
        const after = await box();
        const collapsed = !error && (!after || after.height < (before?.height ?? 0) * 0.5);
        return finish({ ...base, attempts: 1, chosen: chosen.index, clicked: !error, after, collapsed, candidates, menuCandidates, error });
    } catch (e) { return finish({ found: null, action: "hide", clicked: false, collapsed: false, error: String(e.message).split("\n")[0].slice(0, 200) }); }
}

/**
 * Contaminação de pixels deduzida do DOM capturado (vale para QUALQUER versão do capturador, sem reclassificar o
 * manifesto): nó visível com id de sobreposição da plataforma, fixo ou dentro de um fixo.
 */
export function pixelContamination(dom) {
    const byId = new Map(dom.nodes.map((n) => [n.id, n]));
    const fixedChain = (n) => { for (let p = n; p; p = byId.get(p.parent)) if (p.styles?.position === "fixed") return true; return false; };
    const hits = dom.nodes.filter((n) => n.visible && n.box?.width > 0 && n.box?.height > 0 && OVERLAY_ID.test(n.attrs?.id ?? "") && fixedChain(n));
    return hits.length ? { status: "CONTAMINATED", overlays: hits.map((n) => ({ id: n.attrs.id, tag: n.tag, box: n.box })) } : { status: "CLEAN", overlays: [] };
}

/**
 * No navegador (D-03): geometria do texto renderizado de cada elemento com texto próprio. O contexto do elemento são
 * os nós de texto alcançáveis só por elementos INLINE (strong, span, a, em, b, i, br…): blocos descendentes ficam de
 * fora (são medidos neles mesmos). Linhas = agrupamento vertical das caixas de `Range.getClientRects`.
 */
export async function textGeometry() {
    const round = (v) => Math.round(v * 100) / 100;
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    const inlineDisplay = (el) => getComputedStyle(el).display.startsWith("inline");
    const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
        if (SKIP.has(el.tagName) || el.closest("svg")) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.display === "none" || cs.visibility === "hidden" || !r.width || !r.height) continue;
        const texts = [];
        let inlineElements = 0, br = 0;
        const walk = (node) => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) { if (c.nodeValue.trim()) texts.push(c); continue; }
                if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
                if (c.tagName === "BR") { br++; continue; }
                if (!inlineDisplay(c) || getComputedStyle(c).display === "none") continue;
                inlineElements++;
                walk(c);
            }
        };
        walk(el);
        const rects = [];
        for (const tn of texts) { const rg = document.createRange(); rg.selectNodeContents(tn); for (const q of rg.getClientRects()) if (q.width > 0.5 && q.height > 0.5) rects.push(q); }
        rects.sort((a, b) => a.top - b.top);
        const lines = [];
        for (const q of rects) {
            const L = lines.find((l) => Math.min(l.bottom, q.bottom) - Math.max(l.top, q.top) > 0.5 * Math.min(l.bottom - l.top, q.height));
            if (L) { L.left = Math.min(L.left, q.left); L.right = Math.max(L.right, q.right); L.top = Math.min(L.top, q.top); L.bottom = Math.max(L.bottom, q.bottom); }
            else lines.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom });
        }
        const text = texts.map((t) => t.nodeValue).join(" ").replace(/\s+/g, " ").trim();
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ").replace(/\s+/g, " ").trim();
        out.push({ tag: el.tagName.toLowerCase(), box: { x: round(r.left + scrollX), y: round(r.top + scrollY), width: round(r.width), height: round(r.height) }, chars: text.length, ownChars: own.length, inlineElements, br, lines: lines.length, lineBoxes: lines.map((l) => ({ x: round(l.left + scrollX), y: round(l.top + scrollY), width: round(l.right - l.left), height: round(l.bottom - l.top) })), textSha256: await hex(text) });
    }
    return { schemaVersion: 1, kind: "Cf01TextGeometry", note: "contagens e caixas; o texto não é copiado (sha256 do texto normalizado para rastreabilidade)", entries: out };
}

export const BORDER_SIDES = ["top", "right", "bottom", "left"];

/**
 * No navegador (D-04): bordas computadas nas quatro direções de cada elemento com caixa (> 0). Valores exatamente como
 * o `getComputedStyle` os serializa (largura em px, estilo, cor); nada é inferido aqui.
 */
export function boxBorders() {
    const round = (v) => Math.round(v * 100) / 100;
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "BASE", "TITLE"]);
    const sides = ["top", "right", "bottom", "left"];
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const entries = [];
    for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
        if (SKIP.has(el.tagName)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        entries.push({ tag: el.tagName.toLowerCase(), box: { x: round(r.left + scrollX), y: round(r.top + scrollY), width: round(r.width), height: round(r.height) }, borders: Object.fromEntries(sides.map((d) => [d, { width: cs[`border${cap(d)}Width`], style: cs[`border${cap(d)}Style`], color: cs[`border${cap(d)}Color`] }])) });
    }
    return { schemaVersion: 1, kind: "Cf01BoxBorders", note: "bordas computadas (getComputedStyle) nas 4 direções; junção com o DOM por tag + caixa", entries };
}

/** Uma borda é VISÍVEL se tem largura > 0, estilo diferente de none/hidden e cor não totalmente transparente. */
export function borderVisible(b) {
    if (!b) return null;
    const w = Number.parseFloat(b.width) || 0;
    const alpha = /rgba?\(([^)]+)\)/.exec(b.color ?? "")?.[1].split(/[\s,/]+/).filter(Boolean)[3];
    const transparent = b.color === "transparent" || (alpha != null && Number(alpha) === 0);
    return w > 0 && !["none", "hidden"].includes(b.style) && !transparent;
}

/** Junta as bordas aos nós do DOM capturado (tag + caixa). Chave ambígua → sem junção (contada). */
export function attachBorders(dom, data) {
    if (!data?.entries) return { dom, joined: 0, ambiguous: 0, source: "ausente" };
    const key = (tag, b) => `${tag}|${b.x}|${b.y}|${b.width}|${b.height}`;
    const idx = new Map();
    for (const e of data.entries) { const k = key(e.tag, e.box); idx.set(k, idx.has(k) ? null : e); }
    let joined = 0, ambiguous = 0;
    const nodes = dom.nodes.map((n) => {
        if (!n.box) return n;
        const k = key(n.tag, n.box);
        if (!idx.has(k)) return n;
        const e = idx.get(k);
        if (!e) { ambiguous++; return n; }
        joined++;
        return { ...n, borders: e.borders };
    });
    return { dom: { ...dom, nodes }, joined, ambiguous, source: "medido (borders-<vp>.json)" };
}

/** Junta a geometria de texto aos nós do DOM capturado (tag + caixa). Chave ambígua → sem junção (registrada). */
export function attachTextGeometry(dom, geo) {
    if (!geo?.entries) return { dom, joined: 0, ambiguous: 0, source: "ausente" };
    const key = (tag, b) => `${tag}|${b.x}|${b.y}|${b.width}|${b.height}`;
    const idx = new Map();
    for (const e of geo.entries) { const k = key(e.tag, e.box); idx.set(k, idx.has(k) ? null : e); }
    let joined = 0, ambiguous = 0;
    const nodes = dom.nodes.map((n) => {
        if (!n.box || !(n.textLength > 0)) return n;
        const k = key(n.tag, n.box);
        if (!idx.has(k)) return n;
        const e = idx.get(k);
        if (!e) { ambiguous++; return n; }
        joined++;
        return { ...n, textRender: { chars: e.chars, ownChars: e.ownChars, lines: e.lines, inlineElements: e.inlineElements, br: e.br, lineBoxes: e.lineBoxes, textSha256: e.textSha256 } };
    });
    return { dom: { ...dom, nodes }, joined, ambiguous, source: "medido (text-<vp>.json)" };
}

/**
 * No navegador (D-05): fotografia da mídia da página. Relevante = renderizada (checkVisibility com opacidade e
 * visibilidade), fora de `<details>` fechado, não recortada por ancestral com overflow, dentro da área horizontal da
 * página e com tamanho de composição (caixa ≥ `min` px num eixo; ou ainda sem resultado/falha num contêiner largo — o
 * caso da imagem sem dimensões reservadas que colapsa). Estado: img → `loaded` só com complete E naturalWidth/Height > 0;
 * `failed` = complete sem dimensões naturais; `pending` = não complete. video → loaded com dimensões de mídia (readyState ≥ 1).
 */
/**
 * M2 (/11): inventário de MÍDIA da página (no navegador, só leitura): img (e img dentro de <picture>), fundos CSS
 * (background-image url) e SVG grandes (candidatos a placeholder). Por item: tipo, seletor estável (relativo à seção
 * Shopify), seção, caixa, dimensões naturais (img; fundos: não lidas — exigiriam novo carregamento), object-fit /
 * object-position, background-size / -position, estado de carregamento e ORIGEM SEGURA do recurso (caminho sem host e
 * sem query; same/cross-origin; nada de bytes, nada de hash de conteúdo). Nenhum recurso é baixado ou armazenado.
 */
export function mediaInventory(min = 24) {
    const r2 = (v) => Math.round(v * 100) / 100;
    const sectionOf = (el) => el.closest('[id^="shopify-section-"]');
    const selectorOf = (el) => {
        const sec = sectionOf(el); const parts = [];
        for (let e = el; e && e !== sec && e !== document.body; e = e.parentElement) {
            const cls = [...e.classList].find((c) => !/^(is-|js-)/.test(c));
            const same = e.parentElement ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName) : [e];
            parts.unshift(`${e.tagName.toLowerCase()}${cls ? "." + CSS.escape(cls) : ""}${same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ""}`);
        }
        return { section: sec ? sec.id.split("__").pop() : null, path: parts.join(" > ") };
    };
    const origin = (url) => { if (!url) return null; try { const u = new URL(url, location.href); return { path: u.pathname, hasQuery: u.search !== "", sameOrigin: u.origin === location.origin, scheme: u.protocol.replace(":", "") }; } catch { return { path: null, invalid: true }; } };
    const box = (r) => ({ x: r2(r.left + scrollX), y: r2(r.top + scrollY), width: r2(r.width), height: r2(r.height) });
    const shown = (el) => el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }) : true;
    const items = [];
    for (const el of document.querySelectorAll("img")) {
        const r = el.getBoundingClientRect(); if (r.width < min && r.height < min) continue; if (!shown(el)) continue;
        const cs = getComputedStyle(el), pic = el.parentElement?.tagName === "PICTURE" ? el.parentElement : null;
        items.push({ kind: pic ? "picture" : "img", ...selectorOf(el), box: box(r), natural: { width: el.naturalWidth, height: el.naturalHeight }, objectFit: cs.objectFit, objectPosition: cs.objectPosition, state: !el.complete ? "pending" : el.naturalWidth > 0 ? "loaded" : "failed", source: origin(el.currentSrc || el.src), responsive: { srcset: el.hasAttribute("srcset"), sizes: el.getAttribute("sizes") ?? null, pictureSources: pic ? pic.querySelectorAll("source").length : 0 }, loading: el.getAttribute("loading"), altPresent: el.hasAttribute("alt") });
    }
    for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el); const m = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage); if (!m) continue;
        const r = el.getBoundingClientRect(); if (r.width < min || r.height < min || !shown(el)) continue;
        items.push({ kind: "background", ...selectorOf(el), box: box(r), natural: null, naturalReason: "fundo CSS: dimensões naturais não lidas (exigiriam novo carregamento do recurso)", backgroundSize: cs.backgroundSize, backgroundPosition: cs.backgroundPosition, backgroundRepeat: cs.backgroundRepeat, state: "UNKNOWN", source: origin(m[1]) });
    }
    for (const el of document.querySelectorAll("svg")) {
        const r = el.getBoundingClientRect(); if (!shown(el) || el.parentElement?.closest("svg")) continue;
        const cls = el.getAttribute("class") || "";
        const phClass = /placeholder|(^|[\s_-])ph(\s|$)|(^|[\s_-])ph[_-]/i.test(cls);
        // SVG grande (≥ 64) ou placeholder declarado pela classe (≥ min, ex.: logo 40×40); ícones pequenos ficam de fora
        if (!(r.width >= 64 && r.height >= 64) && !(phClass && r.width >= min && r.height >= min)) continue;
        items.push({ kind: "svg", ...selectorOf(el), box: box(r), natural: null, objectFit: getComputedStyle(el).objectFit, placeholder: phClass ? "class" : "UNKNOWN", class: cls.slice(0, 80) });
    }
    return { schemaVersion: 1, kind: "Cf01MediaCapture", items };
}

export function mediaSnapshot(min = 24) {
    const r1 = (v) => Math.round(v * 2) / 2;
    const items = [], ignored = {};
    const ign = (why) => { ignored[why] = (ignored[why] ?? 0) + 1; };
    const clipped = (el, r) => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.position === "fixed") return false;
            if (/(hidden|clip|auto|scroll)/.test(cs.overflow)) { const q = a.getBoundingClientRect(); if (r.bottom <= q.top + 0.5 || r.top >= q.bottom - 0.5 || r.right <= q.left + 0.5 || r.left >= q.right - 0.5) return true; }
        }
        return false;
    };
    for (const el of document.querySelectorAll("img, video")) {
        const r = el.getBoundingClientRect();
        const visible = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).display !== "none";
        if (!visible) { ign("invisível (display/visibility/opacity)"); continue; }
        if (el.closest("details:not([open])") && !el.closest("summary")) { ign("dentro de <details> fechado"); continue; }
        const dw = Number(el.getAttribute("width")) || 0, dh = Number(el.getAttribute("height")) || 0;
        if ((dw && dw <= 2) || (dh && dh <= 2)) { ign("pixel técnico (≤ 2 px declarados)"); continue; }
        if (r.right <= 0 || r.left >= innerWidth) { ign("fora da área horizontal (ex.: slide de carrossel)"); continue; }
        if (clipped(el, r)) { ign("recortada por ancestral com overflow"); continue; }
        const isImg = el.tagName === "IMG";
        const state = isImg ? (!el.complete ? "pending" : el.naturalWidth > 0 && el.naturalHeight > 0 ? "loaded" : "failed") : el.error ? "failed" : el.readyState >= 1 && el.videoWidth > 0 ? "loaded" : "pending";
        const big = r.width >= min || r.height >= min;
        const declaredSmall = dw && dh && dw < min && dh < min;
        const collapsed = !big && state !== "loaded" && !declaredSmall && (el.parentElement?.getBoundingClientRect().width ?? 0) >= min;
        if (!big && !collapsed) { ign(state === "loaded" ? "ícone pequeno (< 24 px)" : "pequena sem contêiner de composição"); continue; }
        const src = isImg ? el.currentSrc || el.src : el.currentSrc || el.poster || "";
        const timing = src ? performance.getEntriesByName(src).at(-1) : null;
        items.push({ tag: el.tagName.toLowerCase(), src: src.replace(/^https?:\/\/[^/]+/, "").slice(0, 160), loading: el.getAttribute("loading"), box: { x: r1(r.left + scrollX), y: r1(r.top + scrollY), width: r1(r.width), height: r1(r.height) }, natural: isImg ? { width: el.naturalWidth, height: el.naturalHeight } : { width: el.videoWidth, height: el.videoHeight }, state, collapsed, timing: timing ? { startMs: Math.round(timing.startTime), durationMs: Math.round(timing.duration), transferSize: timing.transferSize ?? null } : null });
    }
    // blocos de composição (seções empilhadas): desce do <body> enquanto houver um único filho dominante; registra y/altura
    let host = document.body;
    for (;;) { const kids = [...host.children].filter((c) => c.getBoundingClientRect().height > 0.5 * Math.max(1, host.getBoundingClientRect().height)); if (kids.length !== 1) break; host = kids[0]; }
    const blocks = [...host.children].map((c) => c.getBoundingClientRect()).filter((q) => q.height > 0 && q.width > 0).map((q) => [r1(q.top + scrollY), r1(q.height)]);
    return { scrollHeight: document.documentElement.scrollHeight, scrollY: scrollY, innerHeight, items, ignored, blocks };
}

const geometryKey = (snap) => JSON.stringify([snap.scrollHeight, snap.blocks, snap.items.map((i) => [i.src, i.state, i.box.y, i.box.width, i.box.height])]);

/**
 * Estabilização visual (D-05, /9). Orçamento total `budgetMs` (padrão 20 s) dividido em PERCURSO (`traverseShare`,
 * padrão 70 %) e ESTABILIZAÇÃO (o resto, mínimo `stableReads × intervalMs`), cada um com prazo próprio:
 *  1. prontidão: lê a altura do documento até ela se repetir (o conteúdo de SPA aparece depois do `load`);
 *  2. percurso por ROLAGEM REAL (roda do mouse; programática se a roda não rolar), RECALCULANDO o fim a cada passo e
 *     conferindo, ao chegar ao fim, se o documento cresceu; em cada trecho espera a mídia relevante visível;
 *  3. alvo dirigido: mídia relevante ainda pendente que nenhum trecho visitado cobriu é levada à janela;
 *  4. volta ao topo e leituras até `stableReads` geometrias iguais sem pendência.
 * Registra passos (y, altura, espera, pendências), tempos por fase e, por mídia, se foi alcançada. Não altera atributos
 * nem força carregamento. Veredito: STABLE | PENDING_MEDIA | FAILED_MEDIA | UNSTABLE_LAYOUT.
 */
export async function stabilizeMedia(page, { budgetMs = 20000, traverseShare = 0.7, stepWaitMs = 1500, intervalMs = 250, stableReads = 3, minSize = 24, readyReads = 2, readyIntervalMs = 200, maxSteps = 400 } = {}) {
    const t0 = Date.now();
    const minStab = stableReads * intervalMs;
    const traverseBudgetMs = Math.max(0, Math.min(Math.round(budgetMs * traverseShare), budgetMs - minStab));
    const stabilizeBudgetMs = budgetMs - traverseBudgetMs;
    const T1 = t0 + traverseBudgetMs;
    const snap = () => page.evaluate(mediaSnapshot, minSize);
    const heights = [], visited = [], steps = [];
    const timing = { readyMs: 0, traverseMs: 0, waitInViewMs: 0, targetedMs: 0, reentryMs: 0, stabilizeMs: 0 };
    const note = (h) => { if (heights.at(-1) !== h) heights.push(h); };
    let method = "roda do mouse", exhausted = false, blocked = false;
    const vp = page.viewportSize() ?? { width: 800, height: 600 };
    await page.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2)).catch(() => {});
    const waitInView = async (s) => {
        const inView = (i) => i.box.y < s.scrollY + s.innerHeight * 1.5 && i.box.y + i.box.height > s.scrollY - s.innerHeight * 0.5;
        const t = Date.now();
        for (let cur = s; cur.items.some((i) => i.state === "pending" && inView(i)) && Date.now() - t < stepWaitMs && Date.now() < T1;) { await page.waitForTimeout(100); cur = await snap(); }
        return Date.now() - t;
    };
    // 1. prontidão: altura do documento repetida em leituras consecutivas (limitada ao prazo do percurso)
    const tr = Date.now();
    for (let last = -1, same = 0; Date.now() < T1;) { const h = await page.evaluate(() => document.documentElement.scrollHeight); note(h); same = h === last ? same + 1 : 1; last = h; if (same >= readyReads) break; await page.waitForTimeout(readyIntervalMs); }
    timing.readyMs = Date.now() - tr;
    // 2. percurso com fim recalculado (também retomado a partir do último trecho visitado se o documento crescer depois)
    const tt = Date.now();
    const traverse = async (fromY = 0) => {
        if (fromY > 0) { await page.evaluate((y) => window.scrollTo(0, y), fromY); await page.waitForTimeout(80); }
        for (let n = 0; n < maxSteps; n++) {
            const s = await snap();
            note(s.scrollHeight);
            visited.push([s.scrollY, s.scrollY + s.innerHeight]);
            const waited = await waitInView(s);
            timing.waitInViewMs += waited;
            steps.push({ y: Math.round(s.scrollY), scrollHeight: s.scrollHeight, waitedMs: waited, pendingInView: s.items.filter((i) => i.state === "pending" && i.box.y < s.scrollY + s.innerHeight && i.box.y + i.box.height > s.scrollY).length, ...(fromY > 0 && n === 0 ? { resumedFrom: fromY } : {}) });
            if (Date.now() >= T1) { exhausted = true; break; }
            const cur = await page.evaluate(() => ({ y: scrollY, h: document.documentElement.scrollHeight, ih: innerHeight }));
            note(cur.h);
            if (cur.y + cur.ih >= cur.h - 1) {
                // "fim": confere se o documento cresceu (mídia carregada, conteúdo tardio) antes de encerrar
                await page.waitForTimeout(readyIntervalMs);
                const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
                note(h2);
                if (h2 <= cur.h) break;
                continue;
            }
            const target = cur.y + Math.floor(cur.ih * 0.8);
            await page.mouse.wheel(0, Math.floor(cur.ih * 0.8)).catch(() => {});
            await page.waitForTimeout(80);
            let after = await page.evaluate(() => scrollY);
            if (after <= cur.y) { method = "programática (a roda não rolou o documento)"; await page.evaluate((y) => window.scrollTo(0, y), target); await page.waitForTimeout(80); after = await page.evaluate(() => scrollY); }
            if (after <= cur.y) { blocked = true; break; } // o documento não rola mais embora não esteja no fim
        }
    };
    const visitedBottom = () => Math.max(0, ...visited.map(([, b]) => b));
    await traverse(0);
    // 3. alvo dirigido: pendentes que nenhum trecho visitado cobriu (reutilizado na estabilização, ver 4)
    const covered = (i) => visited.some(([a, b]) => i.box.y < b && i.box.y + i.box.height > a);
    const targetMissing = async () => {
        const tg = Date.now();
        let n = 0;
        for (let guard = 0; guard < 50 && Date.now() < T1; guard++) {
            const s = await snap();
            const miss = s.items.find((i) => i.state === "pending" && !covered(i));
            if (!miss) break;
            await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, miss.box.y - Math.floor(s.innerHeight / 3)));
            await page.waitForTimeout(80);
            const s2 = await snap();
            visited.push([s2.scrollY, s2.scrollY + s2.innerHeight]);
            steps.push({ y: Math.round(s2.scrollY), scrollHeight: s2.scrollHeight, waitedMs: await waitInView(s2), pendingInView: null, targeted: miss.src });
            n++;
        }
        timing.targetedMs += Date.now() - tg;
        return n;
    };
    await targetMissing();
    if (Date.now() >= T1) exhausted = true;
    timing.traverseMs = Date.now() - tt;
    // 4. posição do retrato (topo) e estabilização com prazo próprio. Se aparecer mídia relevante pendente que a rolagem
    //    nunca alcançou (ex.: conteúdo de SPA renderizado depois da passagem), volta a rolar até ela — esse tempo é
    //    cobrado do orçamento do PERCURSO (o prazo da estabilização é estendido pelo mesmo tanto; o total não muda).
    await page.evaluate(() => window.scrollTo(0, 0));
    const ts = Date.now();
    let T2 = ts + stabilizeBudgetMs, reentries = 0;
    let last = null, same = 0, reads = 0, s = null;
    while (Date.now() < T2) {
        s = await snap(); reads++; note(s.scrollHeight);
        const tail = s.scrollHeight - visitedBottom() > 1;
        if (Date.now() < T1 && (tail || s.items.some((i) => i.state === "pending" && !covered(i)))) {
            const tr2 = Date.now();
            if (tail) await traverse(Math.max(0, visitedBottom() - s.innerHeight));
            if ((await targetMissing()) || tail) { reentries++; await page.evaluate(() => window.scrollTo(0, 0)); last = null; same = 0; timing.reentryMs += Date.now() - tr2; T2 += Date.now() - tr2; continue; }
        }
        const k = geometryKey(s);
        same = k === last ? same + 1 : 1; last = k;
        if (same >= stableReads && !s.items.some((i) => i.state === "pending")) break;
        await page.waitForTimeout(intervalMs);
    }
    if (reentries && Date.now() >= T1 && s?.items.some((i) => i.state === "pending" && !covered(i))) exhausted = true;
    s ??= await snap();
    timing.stabilizeMs = Date.now() - ts - timing.reentryMs;
    for (const i of s.items) i.reached = covered(i) || i.box.y < s.innerHeight;
    const count = (st) => s.items.filter((i) => i.state === st).length;
    const pending = count("pending"), failed = count("failed");
    const stable = same >= stableReads;
    const verdict = failed ? "FAILED_MEDIA" : pending ? "PENDING_MEDIA" : !stable ? "UNSTABLE_LAYOUT" : "STABLE";
    return {
        verdict, budgetMs, budgets: { traverseMs: traverseBudgetMs, stabilizeMs: stabilizeBudgetMs }, elapsedMs: Date.now() - t0, timing,
        scroll: { method, steps: steps.length, maxY: Math.max(0, ...steps.map((x) => x.y)), exhausted, blocked, reentries, timeline: steps.slice(0, 200) },
        counts: { relevant: s.items.length, loaded: count("loaded"), pending, failed, ignored: Object.values(s.ignored).reduce((a, b) => a + b, 0), notReached: s.items.filter((i) => !i.reached).length },
        ignored: s.ignored, geometry: { reads, consecutiveStableReads: same, requiredStableReads: stableReads, stable, scrollHeightHistory: heights, blocks: s.blocks.length, finalKey: last }, items: s.items,
        problems: s.items.filter((i) => i.state !== "loaded").map((i) => `${i.state === "failed" ? "falhou" : "pendente"}${i.reached ? "" : " (NUNCA alcançada pela rolagem)"}: ${i.tag} ${i.src || "(sem src)"} (caixa ${i.box.width}×${i.box.height} em y ${i.box.y}${i.collapsed ? ", colapsada" : ""}${i.state === "pending" && i.natural.width > 0 ? ", dimensões naturais já conhecidas mas `complete` falso" : ""})`),
    };
}

/** Motivo legível de um veredito de estabilização diferente de STABLE. */
export const stabilityReason = (vp, m) => ({ FAILED_MEDIA: `${vp}: ${m.counts.failed} mídia(s) relevante(s) com FALHA de carregamento`, PENDING_MEDIA: `${vp}: ${m.counts.pending} mídia(s) relevante(s) ainda PENDENTE(S) após ${m.budgetMs} ms (percurso ${m.timing?.traverseMs ?? "?"} ms em ${m.scroll?.steps ?? "?"} passos${m.scroll?.exhausted ? ", orçamento do percurso ESGOTADO" : ""}${m.scroll?.blocked ? ", rolagem BLOQUEADA" : ""}; ${m.counts.notReached ?? 0} nunca alcançada(s))`, UNSTABLE_LAYOUT: `${vp}: layout INSTÁVEL (${m.geometry.consecutiveStableReads}/${m.geometry.requiredStableReads} leituras iguais em ${m.budgetMs} ms; alturas ${m.geometry.scrollHeightHistory.slice(-4).join(" → ")})` })[m.verdict] + (m.problems.length ? ` — ${m.problems.slice(0, 4).join("; ")}${m.problems.length > 4 ? "; …" : ""}` : "");

/** Acordeões: abre e fecha o primeiro `details` fechado de cada seção; cada passo com status próprio. */
export async function probeAccordions(page, sections, { expectedWidth = null } = {}) {
    const out = [];
    for (const sec of sections) {
        const s = await page.locator(`[id$="__${sec}"] details:not([open]) > summary`).first().elementHandle({ timeout: 1000 }).catch(() => null);
        if (!s) { out.push({ sec, status: "not-found" }); continue; }
        const open = await realClick(s, { expectedWidth });
        await page.waitForTimeout(250);
        const opened = open.status === "ok" ? await s.evaluate((e) => e.parentElement.open).catch(() => null) : null;
        const close = open.status === "ok" ? await realClick(s, { expectedWidth }) : null;
        if (close) await page.waitForTimeout(250);
        const closedAgain = close?.status === "ok" ? await s.evaluate((e) => !e.parentElement.open).catch(() => null) : null;
        out.push({ sec, status: open.status !== "ok" ? open.status : close.status !== "ok" ? close.status : opened && closedAgain ? "ok" : "error", opened, closedAgain, open, close });
    }
    return out;
}

/** Alternador de menu (button/summary sem texto no topo): conta links visíveis DENTRO da janela antes/depois do clique real. */
export async function probeMenu(page, { expectedWidth = null } = {}) {
    const count = () => page.evaluate(() => [...document.querySelectorAll("a[href]")].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0; }).length);
    try {
        await page.evaluate(() => window.scrollTo(0, 0));
        const h = await page.evaluateHandle(() => [...document.querySelectorAll("button, summary, [role=button]")].find((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.top < 100 && r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !e.innerText.trim(); }) ?? null);
        const el = h.asElement();
        if (!el) return { found: false, status: "not-found" };
        const tag = await el.evaluate((e) => e.tagName.toLowerCase());
        const visibleLinks = await count();
        const click = await realClick(el, { expectedWidth });
        await page.waitForTimeout(400);
        const visibleLinksAfter = await count();
        const opened = click.status === "ok" && visibleLinksAfter > visibleLinks;
        return { found: true, tag, status: click.status === "ok" ? (opened ? "ok" : "no-effect") : click.status, visibleLinks, visibleLinksAfter, opened, coveredBy: click.hit?.coveredBy ?? null, clickError: click.error ?? null, hit: click.hit ?? null };
    } catch (e) { return { found: null, status: "error", opened: false, clickError: String(e.message).split("\n")[0].slice(0, 200) }; }
}

/**
 * Captura um alvo. `browser`/`viewports`/`opt` vêm do pipeline (reference/capture); `pageScripts` = { deterministicInit,
 * extractDom, freezeDynamicContent }; `getPassword()` devolve a senha (ou null = sem sessão). `hooks.afterVisual(page, vp)`
 * só para testes (simular falhas DEPOIS do retrato). Grava em <outDir>/<label>/.
 */
export async function captureTarget({ browser, newContext, viewports, opt, pageScripts, target, outDir, getPassword, interactions = { accordions: ["section-06", "section-11"], menu: true }, hooks = {}, meta = {}, previewBar = target.kind === "shopify-preview" ? "hide" : "none", stability = {}, identity = null, barOffUrl = previewUrlWithBarOff }) {
    const dir = join(outDir, target.label);
    // modo opt-in pb=0: só para prévia Shopify; a URL é transformada ANTES de qualquer navegação (recusa = nada criado)
    if (previewBar === "url-pb0" && target.kind !== "shopify-preview") throw new Error("pb=0 só se aplica a prévia Shopify");
    const barOff = previewBar === "url-pb0" ? barOffUrl(target.url) : null;
    const navUrl = barOff ? barOff.url : target.url;
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, "manifest.json"))) throw new Error(`destino já tem captura (${dir}); use outro diretório — capturas não são sobrescritas`);
    const host = new URL(target.url).host;
    const redact = (o) => { const s = JSON.stringify(o, null, 2); return (target.kind === "shopify-preview" ? s.split(host).join("[prévia]") : s) + "\n"; };
    const files = {};
    const manifest = { kind: "Cf01FidelityCapture", capturer: CAPTURER_VERSION, label: target.label, targetKind: target.kind, target: target.kind === "reference" ? target.url : "[prévia]", startedAt: new Date().toISOString(), status: "incomplete", reasons: [], files, interactionProblems: [] };
    if (barOff) manifest.previewBarMode = { mode: "url-pb0", doc: PB0_DOC, ...barOff.transform, clicks: 0 };
    if (identity) manifest.identity = { method: IDENTITY_TEXT_METHOD, expected: { texts: identity.texts ?? [], sections: identity.sections ?? [], themeId: identity.themeId ?? null }, viewports: {} };
    const saveManifest = () => writeFileSync(join(dir, "manifest.json"), redact(manifest));
    const write = (name, data) => { const buf = typeof data === "string" ? Buffer.from(data) : data; writeFileSync(join(dir, name), buf); files[name] = sha256(buf); saveManifest(); };
    saveManifest();
    const { deterministicInit, extractDom, freezeDynamicContent } = pageScripts;
    const environment = { capturer: CAPTURER_VERSION, browser: { name: "chromium", version: browser.version(), ...meta.browser }, os: { platform: process.platform, release: release() }, node: process.version, network: meta.network ?? null, options: { settleMs: opt.settleMs, maxNodes: opt.maxNodes, seed: opt.randomSeed }, viewports: {} };
    try {
        for (const vp of ["desktop", "mobile"]) {
            const viewport = viewports[vp];
            const ctx = await newContext(browser, viewport);
            try {
                await ctx.addInitScript(deterministicInit, { seed: opt.randomSeed });
                const page = await ctx.newPage();
                const consoleErrors = [];
                page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
                const resp = await page.goto(navUrl, { waitUntil: "load", timeout: opt.navigationTimeoutMs });
                if (await page.locator('input[type="password"]').count()) {
                    const pw = getPassword();
                    if (pw == null) { manifest.status = "BLOCKED"; manifest.reasons.push("vitrine com senha e nenhuma sessão autorizada (sem terminal para digitar a senha)"); break; }
                    await page.fill('input[type="password"]', pw);
                    await Promise.all([page.waitForLoadState("load"), page.locator('button[type="submit"], input[type="submit"]').first().click()]);
                    await page.goto(navUrl, { waitUntil: "load", timeout: opt.navigationTimeoutMs });
                    if (await page.locator('input[type="password"]').count()) { manifest.status = "BLOCKED"; manifest.reasons.push("senha recusada pela vitrine"); break; }
                }
                // ---- 0. estado controlado da barra de prévia (antes do retrato), pela interface real dela
                // url-pb0: NENHUM clique; só se registra se a barra existe e se o pb=0 sobreviveu às navegações; o resíduo decide
                const bar = previewBar === "hide" ? await hidePreviewBar(page)
                    : previewBar === "url-pb0" ? await (async () => { const left = await page.evaluate(overlayResidue, OVERLAY_ID.source).catch(() => []); const present = await page.locator('[id^="PBar"], iframe#preview-bar-iframe').count(); return { found: present > 0, action: "url-pb0", clicked: false, attempts: 0, collapsed: left.length === 0, pbInFinalUrl: new URL(page.url()).searchParams.get("pb") === "0", error: left.length ? "barra visível mesmo com pb=0" : null, residue: left, pixels: left.length ? "CONTAMINATED" : "CLEAN" }; })()
                    : { found: null, action: "none", pixels: null };
                if (bar.found && !bar.collapsed) manifest.interactionProblems.push({ viewport: vp, what: "barra de prévia", status: "not-collapsed", error: bar.error ?? "não recolheu" });
                // pixels contaminados por sobreposição da plataforma: registrados por viewport; comparações a jusante recusam
                const residue = bar.pixels ? bar.residue : await page.evaluate(overlayResidue, OVERLAY_ID.source).catch(() => []);
                manifest.pixels = { ...(manifest.pixels ?? {}), [vp]: residue.length ? { status: "CONTAMINATED", reason: `sobreposição da plataforma visível: ${residue.map((r) => `#${r.id} ${r.box.width}×${r.box.height}`).join(", ")}`, residue } : { status: "CLEAN" } };
                // ---- 1. retrato visual (gravado ANTES das interações)
                const fontsReady = await page.evaluate(() => Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]));
                // D-05: estabilização visual (mídia relevante carregada + geometria estável) ANTES do retrato
                const media = await stabilizeMedia(page, stability);
                await page.waitForTimeout(opt.settleMs);
                await page.evaluate(freezeDynamicContent);
                // conferência depois de congelar animações: nenhuma mídia relevante perdida e mesma altura do documento
                const check = await page.evaluate(mediaSnapshot, stability.minSize ?? 24);
                media.afterFreeze = { scrollHeight: check.scrollHeight, relevant: check.items.length, notLoaded: check.items.filter((i) => i.state !== "loaded").length, sameGeometry: geometryKey(check) === media.geometry.finalKey };
                if (media.verdict === "STABLE" && (media.afterFreeze.notLoaded || Math.abs(check.scrollHeight - media.geometry.scrollHeightHistory.at(-1)) > 1)) media.verdict = "UNSTABLE_LAYOUT";
                manifest.media = { ...(manifest.media ?? {}), [vp]: { verdict: media.verdict, counts: media.counts, ignored: media.ignored, budgetMs: media.budgetMs, budgets: media.budgets, timing: media.timing, elapsedMs: media.elapsedMs, scroll: media.scroll, geometry: { ...media.geometry, finalKey: undefined }, afterFreeze: media.afterFreeze, problems: media.problems, items: media.items } };
                if (media.verdict !== "STABLE") manifest.reasons.push(stabilityReason(vp, media));
                const env = await page.evaluate(() => ({ dpr: window.devicePixelRatio, zoom: window.visualViewport?.scale ?? 1, scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight, language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, userAgent: navigator.userAgent }));
                const fonts = { ready: fontsReady, ...(await page.evaluate(fontEvidence)) };
                const extracted = await page.evaluate(extractDom, { maxNodes: opt.maxNodes, maxTextLength: opt.maxTextLength, maxDepth: opt.maxDepth });
                const dom = { schemaVersion: 1, viewport: { name: viewport.name, width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.isMobile }, ...extracted };
                const png = await page.screenshot({ type: "png", fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
                const staticProbe = await page.evaluate(() => {
                    const text = document.body.innerText;
                    return { title: document.title, sections: [...document.querySelectorAll('[id^="shopify-section-"]')].map((e) => e.id.split("__").pop()), fontFaceTextVisible: /@font-face|format\(['"]?woff/.test(text), liquidErrors: text.match(/Liquid (syntax )?error[^\n]{0,160}/gi) || [], links: [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")))], details: document.querySelectorAll("details").length };
                });
                if (identity) {
                    const ev = await page.evaluate(identityEvidence, { texts: identity.texts ?? [], sections: identity.sections ?? [] });
                    const themeOk = identity.themeId == null || String(ev.themeId) === String(identity.themeId);
                    manifest.identity.viewports[vp] = { ok: !ev.missingTexts.length && !ev.missingSections.length && themeOk, ...ev, themeOk };
                }
                const text = await page.evaluate(textGeometry);
                const borders = await page.evaluate(boxBorders);
                // M2 (/11): inventário de mídia (só leitura; caminhos sem host/query; nenhum byte de imagem)
                const mediaInv = await page.evaluate(mediaInventory, 24);
                write(`dom-${vp}.json`, redact(dom));
                write(`media-${vp}.json`, redact({ ...mediaInv, viewport: { name: viewport.name, width: viewport.width, height: viewport.height } }));
                write(`text-${vp}.json`, redact(text));
                write(`borders-${vp}.json`, redact(borders));
                write(`screenshot-${vp}.png`, png);
                write(`fonts-${vp}.json`, redact(fonts));
                const { userAgent, ...rest } = env;
                environment.viewports[vp] = { viewport, ...rest };
                environment.userAgent = userAgent;
                // ---- 2. interações (isoladas: falha vira evidência no probe, nunca derruba a captura)
                const layout = await page.evaluate(layoutEvidence, viewport.width);
                if (layout.expanded || layout.overflowX) manifest.layoutDiscrepancies = [...(manifest.layoutDiscrepancies ?? []), { viewport: vp, expectedWidth: layout.expectedWidth, innerWidth: layout.innerWidth, scrollWidth: layout.scrollWidth, widest: layout.overflowing[0] ?? null, looseBodyText: layout.looseBodyText.length > 0 }];
                const probe = { ...staticProbe, httpStatus: resp?.status() ?? null, layout, previewBar: bar, interactions: { status: "ok", error: null } };
                manifest.previewBar = { ...(manifest.previewBar ?? {}), [vp]: bar };
                try {
                    if (hooks.afterVisual) await hooks.afterVisual(page, vp);
                    probe.toggles = interactions.accordions?.length ? await probeAccordions(page, interactions.accordions, { expectedWidth: viewport.width }) : [];
                    probe.menu = interactions.menu ? await probeMenu(page, { expectedWidth: viewport.width }) : { found: null, status: "not-run" };
                } catch (e) {
                    probe.interactions = { status: "error", error: String(e.message).split("\n")[0].slice(0, 240) };
                    probe.toggles ??= [];
                    probe.menu ??= { found: null, status: "error", opened: false, clickError: probe.interactions.error };
                }
                for (const t of probe.toggles) if (t.status !== "ok" && t.status !== "not-found") manifest.interactionProblems.push({ viewport: vp, what: `acordeão ${t.sec}`, status: t.status, coveredBy: t.open?.hit?.coveredBy ?? t.close?.hit?.coveredBy ?? null, error: t.open?.error ?? t.close?.error ?? null });
                if (probe.menu.status !== "ok" && probe.menu.status !== "not-found") manifest.interactionProblems.push({ viewport: vp, what: "alternador de menu", status: probe.menu.status, coveredBy: probe.menu.coveredBy ?? null, error: probe.menu.clickError ?? null });
                if (probe.interactions.status === "error") manifest.interactionProblems.push({ viewport: vp, what: "interações", status: "error", error: probe.interactions.error });
                write(`probe-${vp}.json`, redact({ ...probe, consoleErrors: [...new Set(consoleErrors)] }));
            } finally { await ctx.close().catch(() => {}); }
        }
        write("environment.json", redact(environment));
        if (manifest.status === "incomplete") {
            const missing = ["desktop", "mobile"].flatMap((vp) => ["dom", "screenshot", "fonts", "probe", "text", "borders", "media"].map((k) => `${k}-${vp}.${k === "screenshot" ? "png" : "json"}`)).filter((f) => !files[f]);
            // D-05: retrato visualmente incompleto (mídia pendente/falha, layout instável) NUNCA é `complete`
            const unstable = Object.entries(manifest.media ?? {}).filter(([, m]) => m.verdict !== "STABLE").map(([v]) => v);
            manifest.status = missing.length ? "failed" : unstable.length ? "incomplete" : "complete";
            if (missing.length) manifest.reasons.push(`arquivos ausentes: ${missing.join(", ")}`);
            if (unstable.length) manifest.visualCompleteness = { status: "INCOMPLETE", viewports: unstable, rule: "mídia relevante pendente/com falha ou layout instável: não usar como evidência de geometria/pixels" };
        }
        // identidade esperada não confirmada (outro tema, página publicada, conteúdo incompatível) → captura REJEITADA
        const badIdentity = identity ? ["desktop", "mobile"].filter((v) => manifest.identity.viewports[v] && !manifest.identity.viewports[v].ok) : [];
        if (badIdentity.length && manifest.status !== "failed") { manifest.status = "REJECTED"; manifest.reasons.push(`identidade incompatível com a esperada em ${badIdentity.join(", ")}`); }
    } catch (e) {
        manifest.status = "failed";
        manifest.reasons.push(`erro fatal: ${String(e.message).split("\n")[0].slice(0, 240)}`);
    } finally {
        manifest.finishedAt = new Date().toISOString();
        saveManifest();
    }
    return { label: target.label, kind: target.kind, status: manifest.status, reasons: manifest.reasons, interactionProblems: manifest.interactionProblems, media: Object.fromEntries(Object.entries(manifest.media ?? {}).map(([vp, m]) => [vp, { verdict: m.verdict, ...m.counts, elapsedMs: m.elapsedMs }])) };
}

/**
 * Integridade de uma captura do capturador de fidelidade: manifesto presente, status `complete` (ou `captured` da
 * versão 2, que só gravava manifesto ao terminar), todos os arquivos esperados presentes e com o sha256 registrado.
 * Capturas de OUTRO capturador (pipeline M2, render local) devolvem `{ applicable: false }`.
 */
/**
 * Restrições de uso registradas DEPOIS da captura (sem reescrever o manifesto): `<raiz da captura>/RESTRICOES.json`
 * com `{ restrictions: [{ label, viewport, scope: [...], fromRegion, reason, defect }] }`.
 */
export function restrictionsFor(dir) {
    const f = join(dir, "..", "RESTRICOES.json");
    if (!existsSync(f)) return [];
    const label = dir.replace(/\/+$/, "").split("/").pop();
    return (JSON.parse(readFileSync(f, "utf8")).restrictions ?? []).filter((r) => r.label === label);
}

export function captureIntegrity(dir) {
    const mPath = join(dir, "manifest.json");
    if (!existsSync(mPath)) return existsSync(join(dir, "dom-desktop.json")) && !existsSync(join(dir, "steps")) && existsSync(join(dir, "fonts-desktop.json")) ? { applicable: true, ok: false, status: "sem manifesto", problems: ["captura sem manifesto (interrompida ou parcial)"] } : { applicable: false };
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    // v2 gravava `kind` = tipo do alvo (defeito registrado: o status sobrescrevia o kind); o `capturer` identifica a origem
    if (m.kind !== "Cf01FidelityCapture" && !String(m.capturer ?? "").startsWith("cf01-fidelity-capture/")) return { applicable: false };
    const problems = [];
    if (!["complete", "captured"].includes(m.status)) problems.push(`status ${m.status}${m.reasons?.length ? `: ${m.reasons.join("; ")}` : ""}`);
    const version = Number(/\/(\d+)$/.exec(m.capturer ?? "")?.[1] ?? 0);
    const expected = ["desktop", "mobile"].flatMap((vp) => [`dom-${vp}.json`, `screenshot-${vp}.png`, `fonts-${vp}.json`, `probe-${vp}.json`, ...(version >= 6 ? [`text-${vp}.json`] : []), ...(version >= 7 ? [`borders-${vp}.json`] : []), ...(version >= 11 ? [`media-${vp}.json`] : [])]).concat("environment.json");
    for (const f of expected) {
        if (!m.files?.[f]) { problems.push(`arquivo não registrado: ${f}`); continue; }
        if (!existsSync(join(dir, f))) { problems.push(`arquivo ausente: ${f}`); continue; }
        if (sha256(readFileSync(join(dir, f))) !== m.files[f]) problems.push(`hash divergente: ${f}`);
    }
    if (version >= 8) for (const vp of ["desktop", "mobile"]) { const v = m.media?.[vp]?.verdict; if (v !== "STABLE") problems.push(`estabilização visual ${vp}: ${v ?? "não registrada"}`); }
    // pixels: o que o capturador /6 registrou; versões anteriores não registravam (UNKNOWN — não reclassificadas aqui;
    // a contaminação pode ser deduzida do DOM com `pixelContamination`)
    const pixels = version >= 6 ? Object.fromEntries(Object.entries(m.pixels ?? {}).map(([vp, p]) => [vp, p.status])) : { desktop: "UNKNOWN", mobile: "UNKNOWN" };
    return { applicable: true, ok: problems.length === 0, status: m.status, capturer: m.capturer ?? null, problems, interactionProblems: m.interactionProblems ?? [], pixels, textGeometry: version >= 6, borders: version >= 7, mediaInventory: version >= 11, media: version >= 8 ? Object.fromEntries(["desktop", "mobile"].map((vp) => [vp, m.media?.[vp]?.verdict ?? null])) : { desktop: "UNKNOWN", mobile: "UNKNOWN" }, restrictions: restrictionsFor(dir) };
}
