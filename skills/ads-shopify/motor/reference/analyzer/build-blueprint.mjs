/**
 * Monta o StoreBlueprint v2 a partir dos snapshots desktop e mobile.
 * Função pura e determinística: mesmas entradas, mesmo blueprint.
 *
 * Modo `reference`: nenhum texto, URL, classe ou imagem da referência é
 * copiado. Textos viram contagens/comprimentos; imagens viram papel,
 * proporção e posição relativa (para substituição por material autorizado).
 */

import { BLUEPRINT_SCHEMA_VERSION } from "../blueprint/schema.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { isOpaque, parseColor, toHex } from "./color.mjs";
import { CLASSIFY_THRESHOLD, PROVIDER, classifyBand, combineViewports } from "./classify.mjs";
import { DomIndex, area, headingTypography, isButtonLike, pathKeys, px } from "./dom-index.mjs";
import { measureBackgroundPaint } from "./paint.mjs";
import { bandFeatures, flowRole, segmentBands } from "./structure.mjs";
import {
    colorRoles,
    extractButtons,
    extractCard,
    extractContentCards,
    extractColors,
    extractInputs,
    extractLayout,
    extractTypography,
} from "./tokens.mjs";

export const ANALYZER_VERSION = "1.8.0";

const INPUT_TYPES = new Set(["email", "text", "search", "tel", "number", "password", "checkbox", "radio", "submit", "button", "select", "textarea"]);

const clamp01 = (value) => Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
const int = (value) => Math.round(value);

function normalizeAlign(value) {
    if (!value) return null;
    if (value === "start" || value === "left" || value === "-webkit-left") return "left";
    if (value === "end" || value === "right" || value === "-webkit-right") return "right";
    if (value === "center" || value === "-webkit-center") return "center";
    if (value === "justify") return "justify";
    return null;
}

function horizontalPosition(box, container) {
    const center = (box.x + box.width / 2 - container.x) / (container.width || 1);
    return center < 0.4 ? "left" : center > 0.6 ? "right" : "center";
}

function verticalPosition(box, container) {
    const center = (box.y + box.height / 2 - container.y) / (container.height || 1);
    return center < 0.38 ? "top" : center > 0.62 ? "bottom" : "middle";
}

function unionBox(boxes) {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x, y, width: right - x, height: bottom - y };
}

function buttonStyle(node) {
    const background = parseColor(node.styles.backgroundColor);
    if (isOpaque(background)) return "solid";
    return (px(node.styles.borderTopWidth) ?? 0) > 0 ? "outline" : "plain";
}

/**
 * Uma única faixa cobrindo uma página longa não é segmentação: classificá-la
 * (ex.: como rodapé) produziria um blueprint falsamente válido. Falha
 * explícita, com as evidências para diagnóstico.
 */
function assertReliableSegmentation(index, bands, viewport) {
    if (bands.length !== 1) return;
    const node = index.node(bands[0]);
    const tall = index.pageHeight > viewport.height * 2;
    if (!tall || node.box.height < index.pageHeight * 0.9) return;
    const kids = index.visibleChildren(node.id).map((id) => index.node(id));
    const roles = {};
    for (const kid of kids) roles[flowRole(index, kid)] = (roles[flowRole(index, kid)] ?? 0) + 1;
    throw new ReferenceEngineError(ErrorCodes.BLUEPRINT_INVALID, `Segmentação não confiável (${viewport.width}px): uma única faixa cobre a página inteira`, {
        issues: [`faixa <${node.tag}> com ${Math.round(node.box.height)}px de ${Math.round(index.pageHeight)}px; filhos visíveis por posição no fluxo: ${JSON.stringify(roles)}`],
    });
}

/** Analisa um viewport: faixas, características e classificações. */
function analyzeViewport(snapshot) {
    const index = new DomIndex(snapshot);
    const { bands, overlays } = segmentBands(index);
    assertReliableSegmentation(index, bands, snapshot.viewport);
    const features = bands.map((id) => bandFeatures(index, id));
    const pageMaxHeading = Math.max(0, ...features.map((f) => f.maxHeadingSize));
    const body = parseColor(index.node(0).styles.backgroundColor);
    const pageBackground = isOpaque(body) ? toHex(body) : null;

    // Em ordem de página: a página tem no máximo um cabeçalho (o primeiro).
    let headerAbove = false;
    const classified = features.map((f, position) => {
        const result = classifyBand(f, {
            position,
            count: features.length,
            pageMaxHeading,
            pageBackground,
            headerAbove,
            viewport: { width: snapshot.viewport.width, height: snapshot.viewport.height, isMobile: snapshot.viewport.isMobile },
        });
        if (result.type === "header") headerAbove = true;
        return result;
    });
    const keys = pathKeys(index);
    return { index, bands, overlays, features, classified, keys };
}

/** Casa faixas desktop e mobile pelo caminho estrutural do elemento. */
function matchBands(desktop, mobile) {
    const mobileByKey = new Map(mobile.bands.map((id, i) => [mobile.keys.get(id), i]));
    const usedMobile = new Set();
    const pairs = desktop.bands.map((id, i) => {
        const m = mobileByKey.get(desktop.keys.get(id));
        if (m !== undefined && !usedMobile.has(m)) {
            usedMobile.add(m);
            return { d: i, m };
        }
        return { d: i, m: null };
    });

    // Faixas só do mobile entram após o último par com ordem mobile anterior.
    for (let m = 0; m < mobile.bands.length; m++) {
        if (usedMobile.has(m)) continue;
        let insertAt = 0;
        pairs.forEach((pair, position) => {
            if (pair.m !== null && pair.m < m) insertAt = position + 1;
        });
        pairs.splice(insertAt, 0, { d: null, m });
    }
    return pairs;
}

function imagesFor(view, featureIndex, type) {
    const f = view.features[featureIndex];
    const band = f.box;
    const repeatedItems = new Set(f.repeated?.itemIds ?? []);
    const images = [];

    if (f.backgroundImage) {
        images.push({ role: "background", kind: "background", aspectRatio: round3(band.width / band.height), position: { x: 0, y: 0, width: 1, height: 1 } });
    }

    for (const item of f.media) {
        if (images.length >= 24) break;
        const inItem = [...repeatedItems].some((itemId) => view.index.isInside(item.id, itemId));
        const role =
            item.kind === "background" || area(item.box) >= area(band) * 0.6
                ? "background"
                : inItem && type === "product-grid"
                  ? "product"
                  : type === "header"
                    ? "logo"
                    : "media";
        images.push({
            role,
            kind: item.kind === "video" ? "video" : item.kind === "background" ? "background" : "img",
            aspectRatio: round3(item.box.width / Math.max(item.box.height, 1)),
            position: {
                x: clamp01((item.box.x - band.x) / (band.width || 1)),
                y: clamp01((item.box.y - band.y) / (band.height || 1)),
                width: clamp01(item.box.width / (band.width || 1)),
                height: clamp01(item.box.height / (band.height || 1)),
            },
        });
    }
    return images;
}

function presenceFor(view, featureIndex, type) {
    const f = view.features[featureIndex];
    const c = view.classified[featureIndex];
    return {
        order: featureIndex,
        box: { x: int(f.box.x), y: int(f.box.y), width: int(f.box.width), height: int(f.box.height) },
        paddingTopPx: f.paddingTop,
        paddingBottomPx: f.paddingBottom,
        textAlign: normalizeAlign(f.textAlign),
        columns: Math.max(1, f.repeated && f.repeated.imageShare >= 0.5 ? f.repeated.columns : f.columns.columns),
        classification: { type: c.type, confidence: c.confidence, signals: c.evidence },
        images: imagesFor(view, featureIndex, type),
    };
}

function contentFor(view, featureIndex) {
    const f = view.features[featureIndex];
    const index = view.index;
    return {
        headings: f.headings.slice(0, 40).map((h) => ({ level: h.level, chars: h.chars, sizePx: h.size || null })),
        paragraphs: f.paragraphs,
        textChars: f.textChars,
        buttons: f.buttons.slice(0, 20).map((id) => {
            const node = index.node(id);
            const chars = node.textLength || [...index.descendants(id)].reduce((sum, child) => sum + child.textLength, 0);
            return { style: buttonStyle(node), chars };
        }),
        links: f.links,
        inputs: f.inputs.slice(0, 20).map((type) => (INPUT_TYPES.has(type) ? type : "other")),
        icons: f.icons,
    };
}

function headerDetails(dv, di, mv, mi) {
    const nav = (view, i) => {
        if (!view || i === null) return { mode: null, items: null };
        const f = view.features[i];
        const band = f.box;
        const navs = view.index
            .visibleDescendants(f.id, { includeSelf: true })
            .filter((node) => node.tag === "nav" || node.role === "navigation");
        const items = navs.reduce(
            (sum, n) => sum + view.index.visibleDescendants(n.id).filter((node) => node.tag === "a").length,
            0
        );
        if (items >= 2) return { mode: "inline", items };
        const toggle = view.index
            .visibleDescendants(f.id)
            .some((node) => (node.tag === "button" || node.role === "button") && node.box.width <= 64 && node.box.x < band.x + band.width);
        return { mode: toggle ? "drawer" : "none", items };
    };

    const view = dv ?? mv;
    const i = dv ? di : mi;
    const f = view.features[i];
    const candidates = view.index
        .visibleDescendants(f.id)
        .filter((node) => node.tag === "a" || node.tag === "img" || (node.textLength > 0 && (px(node.styles.fontSize) ?? 0) >= 18));
    const logoNode = candidates
        .filter((node) => node.box.height >= 16)
        .sort((a, b) => a.box.x - b.box.x || a.id - b.id)
        .find((node) => node.tag === "img" || node.media || (px(node.styles.fontSize) ?? 0) >= 18 || view.index.visibleDescendants(node.id).some((d) => d.media && d.media.kind !== "svg"));
    const hasImage = logoNode && (logoNode.media?.kind === "img" || view.index.visibleDescendants(logoNode.id).some((d) => d.media?.kind === "img"));

    const desktopNav = nav(dv, di);
    const mobileNav = nav(mv, mi);
    return {
        logo: {
            kind: logoNode ? (hasImage ? "image" : "text") : null,
            position: logoNode ? horizontalPosition(logoNode.box, f.box) : null,
        },
        navigation: { desktop: desktopNav.mode, mobile: mobileNav.mode },
        navItems: { desktop: desktopNav.items, mobile: mobileNav.items },
        sticky: Boolean((dv && dv.features[di].sticky) || (mv && mv.features[mi].sticky)),
        iconCount: f.icons,
    };
}

function heroDetails(dv, di, mv, mi, screenshots) {
    const one = (view, i) => {
        if (!view || i === null) return null;
        const f = view.features[i];
        const nodes = view.index.visibleDescendants(f.id).filter(
            (node) => node.headingLevel || (node.tag === "p" && node.textLength > 0) || f.buttons.includes(node.id)
        );
        const block = unionBox(nodes.map((node) => node.box));
        const heading = nodes.find((node) => node.headingLevel === 1) ?? nodes.find((node) => node.headingLevel);
        const align = normalizeAlign(heading?.styles.textAlign);
        const headingSize = heading ? headingTypography(view.index, heading).size : 0;
        const eyebrow = heading
            ? nodes.some(
                  (node) =>
                      !node.headingLevel &&
                      node.textLength > 0 &&
                      node.textLength <= 40 &&
                      node.box.y + node.box.height <= heading.box.y &&
                      (node.styles.textTransform === "uppercase" || (px(node.styles.fontSize) ?? 99) < headingSize / 2)
              )
            : false;
        return {
            height: int(f.box.height),
            contentHeight: block ? int(block.height) : null,
            // Áreas de conteúdo, com folga, ficam fora da amostra de cor.
            exclude: nodes.map((node) => ({ x: node.box.x - 8, y: node.box.y - 8, width: node.box.width + 16, height: node.box.height + 16 })),
            position: block ? horizontalPosition(block, f.box) : null,
            alignment: align === "justify" ? "left" : align,
            vertical: block ? verticalPosition(block, f.box) : null,
            eyebrow,
            f,
        };
    };
    const d = one(dv, di);
    const m = one(mv, mi);
    const f = (d ?? m).f;
    // Pintura do fundo medida no screenshot do desktop (sem screenshot, sem
    // evidência: null — nunca um valor presumido).
    const paint = d && (f.backgroundImage || f.coverMedia || f.background.gradient)
        ? measureBackgroundPaint(screenshots?.desktop ?? null, d.f.box, d.exclude)
        : null;
    return {
        heightPx: { desktop: d?.height ?? null, mobile: m?.height ?? null },
        contentHeightPx: { desktop: d?.contentHeight ?? null, mobile: m?.contentHeight ?? null },
        backgroundPaint: paint ? { ...paint, source: "screenshot-desktop" } : null,
        background: f.backgroundImage || f.coverMedia ? "image" : f.background.gradient ? "gradient" : f.background.own ? "color" : "none",
        contentPosition: { desktop: d?.position ?? null, mobile: m?.position ?? null },
        contentAlignment: { desktop: d?.alignment ?? null, mobile: m?.alignment ?? null },
        verticalPosition: { desktop: d?.vertical ?? null, mobile: m?.vertical ?? null },
        buttons: f.buttons.length,
        hasEyebrow: Boolean(d?.eyebrow ?? m?.eyebrow),
    };
}

function productGridDetails(dv, di, mv, mi) {
    const r = (view, i) => (view && i !== null ? view.features[i].repeated : null);
    const dr = r(dv, di);
    const mr = r(mv, mi);
    const view = dv ?? mv;
    const f = view.features[dv ? di : mi];
    const items = (dr ?? mr).itemIds;
    const outside = view.index.visibleDescendants(f.id).filter((node) => !items.some((item) => view.index.isInside(node.id, item)));
    return {
        columns: { desktop: dr?.columns ?? null, mobile: mr?.columns ?? null },
        rows: { desktop: dr?.rows ?? null, mobile: mr?.rows ?? null },
        itemCount: (dr ?? mr).count,
        gapPx: { desktop: dr?.gapX ?? null, mobile: mr?.gapX ?? null },
        hasHeading: outside.some((node) => node.headingLevel),
        hasViewAllLink: outside.some((node) => node.tag === "a"),
    };
}

/**
 * Posição GEOMÉTRICA do bloco de texto (títulos, parágrafos, botões) na
 * faixa — não o text-align: margens laterais parecidas = "center"; bloco
 * quase da largura da faixa = "full" (não conclusivo); sem texto = null.
 */
export function blockPosition(box, band) {
    if (!box || !band.width) return null;
    if (box.width >= band.width * 0.85) return "full";
    const left = box.x - band.x;
    const right = band.x + band.width - (box.x + box.width);
    if (Math.abs(left - right) <= Math.max(16, band.width * 0.05)) return "center";
    return left < right ? "left" : "right";
}

function richTextDetails(dv, di, mv, mi) {
    const view = dv ?? mv;
    const f = view.features[dv ? di : mi];
    const texts = view.index.visibleDescendants(f.id).filter((node) => node.headingLevel || node.tag === "p");
    const position = (v, i) => {
        if (!v || i === null) return null;
        const band = v.features[i];
        const nodes = v.index.visibleDescendants(band.id).filter((node) => node.headingLevel || (node.tag === "p" && node.textLength > 0) || band.buttons.includes(node.id));
        return blockPosition(unionBox(nodes.map((node) => node.box)), band.box);
    };
    return {
        alignment: normalizeAlign(f.textAlign),
        maxWidthPx: texts.length ? Math.max(...texts.map((node) => int(node.box.width))) : null,
        buttons: f.buttons.length,
        blockPosition: { desktop: position(dv, di), mobile: position(mv, mi) },
    };
}

function footerDetails(dv, di, mv, mi) {
    const view = dv ?? mv;
    const f = view.features[dv ? di : mi];
    const bottom = view.index
        .visibleDescendants(f.id)
        .some((node) => node.textLength > 0 && node.box.y >= f.box.y + f.box.height * 0.7);
    return {
        columns: {
            desktop: dv && di !== null ? dv.features[di].columns.columns : null,
            mobile: mv && mi !== null ? mv.features[mi].columns.columns : null,
        },
        linkCount: f.links,
        hasBottomRow: bottom,
    };
}

function announcementDetails(dv, di, mv, mi) {
    const f = (dv ?? mv).features[dv ? di : mi];
    return { textAlign: normalizeAlign(f.textAlign), hasLink: f.links + f.buttons.length > 0 };
}

/** Título precedido por texto curto de apoio (caixa alta ou bem menor). */
function hasEyebrowAbove(view, f) {
    const nodes = view.index.visibleDescendants(f.id).filter((node) => node.headingLevel || (node.textLength > 0 && node.tag === "p"));
    const heading = nodes.find((node) => node.headingLevel);
    if (!heading) return false;
    const headingSize = headingTypography(view.index, heading).size;
    return nodes.some(
        (node) =>
            !node.headingLevel &&
            node.textLength > 0 &&
            node.textLength <= 40 &&
            node.box.y + node.box.height <= heading.box.y &&
            (node.styles.textTransform === "uppercase" || (px(node.styles.fontSize) ?? 99) < headingSize / 2)
    );
}

function imageWithTextDetails(dv, di, mv, mi) {
    const one = (view, i) => {
        if (!view || i === null) return null;
        const f = view.features[i];
        const split = f.split;
        const media = split ? view.index.node(split.mediaId) : null;
        const heading = f.headings[0] ? view.index.node(f.headings[0].id) : null;
        const align = normalizeAlign(heading?.styles.textAlign);
        return {
            f,
            arrangement: split?.arrangement === "side-by-side" || split?.arrangement === "stacked" ? split.arrangement : null,
            mediaPosition: split?.mediaPosition ?? null,
            mediaWidthShare: split?.mediaWidthShare ?? null,
            mediaHeightPx: media ? int(media.box.height) : null,
            aspectRatio: split?.aspectRatio ?? null,
            textVertical: split?.textVertical ?? null,
            contentAlignment: align === "justify" ? "left" : align,
            gapPx: split?.gapPx !== null && split?.gapPx !== undefined ? Math.max(0, split.gapPx) : null,
            eyebrow: hasEyebrowAbove(view, f),
        };
    };
    const d = one(dv, di);
    const m = one(mv, mi);
    const primary = d ?? m;
    const pick = (key) => ({ desktop: d?.[key] ?? null, mobile: m?.[key] ?? null });
    return {
        arrangement: pick("arrangement"),
        mediaPosition: pick("mediaPosition"),
        mediaWidthShare: pick("mediaWidthShare"),
        mediaHeightPx: pick("mediaHeightPx"),
        // Vem do viewport classificado (sempre há um com mídia medida).
        mediaAspectRatio: d?.aspectRatio ?? m?.aspectRatio,
        textVertical: pick("textVertical"),
        contentAlignment: pick("contentAlignment"),
        gapPx: pick("gapPx"),
        hasEyebrow: Boolean(d?.eyebrow ?? m?.eyebrow),
        buttons: primary.f.buttons.length,
    };
}

function newsletterDetails(dv, di, mv, mi) {
    const signup = (view, i) => {
        if (!view || i === null) return null;
        return view.features[i].forms.find((form) => form.emailFields === 1 && form.otherFields === 0 && form.submits >= 1) ?? null;
    };
    const d = signup(dv, di);
    const m = signup(mv, mi);
    const view = dv ?? mv;
    const f = view.features[dv ? di : mi];
    const form = d ?? m;
    const texts = view.index.visibleDescendants(f.id).filter((node) => node.headingLevel || node.tag === "p" || node.tag === "form");
    return {
        alignment: normalizeAlign(f.textAlign),
        formLayout: { desktop: d?.layout ?? null, mobile: m?.layout ?? null },
        emailFields: form.emailFields,
        consentFields: form.consentFields,
        hasHeading: f.headings.length > 0,
        hasText: f.paragraphs > 0,
        maxWidthPx: texts.length ? Math.max(...texts.map((node) => int(node.box.width))) : null,
        buttons: form.submits,
    };
}

/** Título da seção ACIMA de um grupo (fora dele): presença e alinhamento. */
function headingAbove(view, f, top) {
    const heading = view.index
        .visibleDescendants(f.id)
        .filter((node) => node.headingLevel && node.box.y + node.box.height <= top + 1)
        .sort((a, b) => a.box.y - b.box.y)[0];
    return heading ? { hasHeading: true, alignment: normalizeAlign(heading.styles.textAlign === "start" ? "left" : heading.styles.textAlign) } : { hasHeading: false, alignment: null };
}

/**
 * Acordeão/FAQ: só estrutura. Linhas e painéis vêm do viewport principal
 * (desktop); divergência de contagem entre viewports é registrada pelo chamador.
 */
function collapsibleDetails(dv, di, mv, mi) {
    const d = dv && di !== null ? dv.features[di].disclosure : null;
    const m = mv && mi !== null ? mv.features[mi].disclosure : null;
    const view = d ? dv : mv;
    const f = view.features[d ? di : mi];
    const g = d ?? m;
    const heading = headingAbove(view, f, g.top);
    return {
        trigger: g.trigger,
        rows: g.rows,
        openRows: g.openRows,
        firstRowOpen: g.firstRowOpen,
        capturedPanels: g.capturedPanels,
        panelContent: { ...g.panelContent },
        hasHeading: heading.hasHeading,
        headingAlignment: heading.alignment,
        rowWidthPx: { desktop: d ? int(d.width) : null, mobile: m ? int(m.width) : null },
    };
}

/**
 * Colunas: estrutura do desktop (decisivo); colunas do mobile só quando o
 * mobile tem os MESMOS itens — senão null (não inventamos estrutura comum).
 */
function multicolumnDetails(dv, di, mv, mi) {
    const d = dv && di !== null ? dv.features[di].columnGroup : null;
    const m = mv && mi !== null ? mv.features[mi].columnGroup : null;
    const view = d ? dv : mv;
    const f = view.features[d ? di : mi];
    const g = d ?? m;
    const heading = headingAbove(view, f, g.top);
    return {
        columns: { desktop: d ? d.columns : null, mobile: m && (!d || m.count === d.count) ? m.columns : null },
        itemCount: g.count,
        itemsWithIcon: g.itemsWithIcon,
        itemsWithMedia: g.itemsWithMedia,
        itemsWithTitle: g.itemsWithTitle,
        itemsWithNumericLead: g.itemsWithNumericLead,
        itemsWithLink: g.itemsWithLink,
        alignment: normalizeAlign(f.textAlign),
        hasHeading: heading.hasHeading,
    };
}

/**
 * Depoimentos: estrutura dos cartões (do desktop, decisivo; os dois
 * viewports já têm a mesma contagem). Nenhum texto, nome ou nota.
 */
function testimonialsDetails(dv, di, mv, mi) {
    const d = dv && di !== null ? dv.features[di].testimonials : null;
    const m = mv && mi !== null ? mv.features[mi].testimonials : null;
    const view = d ? dv : mv;
    const f = view.features[d ? di : mi];
    const g = d ?? m;
    const heading = headingAbove(view, f, g.top);
    return {
        itemCount: g.count,
        columns: { desktop: d ? d.columns : null, mobile: m ? m.columns : null },
        itemsWithAuthor: g.itemsWithAuthor,
        authorLines: g.authorLines,
        avatar: { ...g.avatar },
        glyphs: { ...g.glyphs },
        itemsWithDivider: g.itemsWithDivider,
        quoteStyle: g.quoteStyle,
        cardSurface: g.cardSurface,
        hasHeading: heading.hasHeading,
        headingAlignment: heading.alignment,
    };
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

/**
 * @param {object} input
 * @param {import("../capture/dom-schema.mjs").DomSnapshot} input.desktop
 * @param {import("../capture/dom-schema.mjs").DomSnapshot} input.mobile
 * @param {object} input.source Proveniência (run, hashes).
 */
export function buildBlueprint({ desktop, mobile, source, screenshots = null }) {
    const dv = analyzeViewport(desktop);
    const mv = analyzeViewport(mobile);
    const pairs = matchBands(dv, mv);
    const unknowns = [];
    const changes = [];

    const sections = pairs.map((pair, position) => {
        const id = `section-${String(position + 1).padStart(2, "0")}`;
        const dc = pair.d !== null ? dv.classified[pair.d] : null;
        const mc = pair.m !== null ? mv.classified[pair.m] : null;
        let combined = combineViewports(dc, mc);
        // Depoimentos: quando os dois viewports existem, AMBOS precisam ter o
        // grupo de depoimentos com a MESMA quantidade de cartões; outro tipo
        // ou contagem divergente (ex.: carrossel parcial) é conflito (M7.8b).
        if (combined.type === "testimonials" && pair.d !== null && pair.m !== null && dv.features[pair.d].testimonials?.count !== mv.features[pair.m].testimonials?.count) {
            combined = { type: "unknown", confidence: 0.5, agreement: "conflict" };
        }
        // Colunas que EMPILHAM no mobile (ex.: "passos numerados", recursos): o desktop é multicolumn com itens repetidos
        // e evidência estrutural contra rich-text; o mobile, por empilhar, parece rich-text. Só aceita se cada item tiver
        // título próprio e a quantidade de títulos for a mesma nos dois viewports (mesmo conteúdo reorganizado).
        // Colunas de PROSA (sem título por item) e qualquer outro desacordo seguem conflito → unknown.
        if (combined.agreement === "conflict" && dc?.type === "multicolumn" && mc?.type === "rich-text" && dc.excludes?.includes("rich-text")
            && (dv.features[pair.d].repeated?.count ?? 0) >= 2 && dv.features[pair.d].headings.length >= dv.features[pair.d].repeated.count
            && dv.features[pair.d].headings.length === mv.features[pair.m].headings.length) { // itens com título próprio (colunas de prosa seguem conflito)
            combined = { type: "multicolumn", confidence: Math.round(dc.confidence * 0.75 * 1000) / 1000, agreement: "stacked-on-mobile" };
        }
        const type = combined.confidence >= CLASSIFY_THRESHOLD * 0.8 || combined.type === "unknown" ? combined.type : "unknown";

        let unknownReason = null;
        if (type === "unknown") {
            unknownReason = combined.agreement === "conflict" ? "conflict" : (dc ?? mc).reason ?? "insufficient-evidence";
            unknowns.push({ scope: `sections.${id}.type`, reason: unknownReason });
        }
        if (combined.agreement === "desktop-only" || combined.agreement === "mobile-only") {
            unknowns.push({ scope: `sections.${id}.viewports`, reason: "single-viewport" });
            changes.push({
                sectionId: id,
                property: "visibility",
                desktop: pair.d !== null ? "visible" : "hidden",
                mobile: pair.m !== null ? "visible" : "hidden",
            });
        }

        const hintSet = new Map();
        for (const hint of [...(dc?.hints ?? []), ...(mc?.hints ?? [])]) hintSet.set(hint.type, hint);

        const primaryView = pair.d !== null ? dv : mv;
        const primaryIndex = pair.d !== null ? pair.d : pair.m;

        const details = {};
        const args = [pair.d !== null ? dv : null, pair.d, pair.m !== null ? mv : null, pair.m];
        if (type === "header") details.header = headerDetails(...args);
        if (type === "hero") details.hero = heroDetails(...args, screenshots);
        if (type === "product-grid") details.productGrid = productGridDetails(...args);
        if (type === "rich-text") details.richText = richTextDetails(...args);
        if (type === "footer") details.footer = footerDetails(...args);
        if (type === "image-with-text") details.imageWithText = imageWithTextDetails(...args);
        if (type === "newsletter") details.newsletter = newsletterDetails(...args);
        if (type === "announcement-bar") details.announcement = announcementDetails(...args);
        if (type === "collapsible-content") {
            details.collapsibleContent = collapsibleDetails(...args);
            const d = pair.d !== null ? dv.features[pair.d].disclosure : null;
            const m = pair.m !== null ? mv.features[pair.m].disclosure : null;
            if (d && m && d.rows !== m.rows) unknowns.push({ scope: `sections.${id}.details.collapsibleContent.rows`, reason: "conflict" });
        }
        if (type === "testimonials") details.testimonials = testimonialsDetails(...args);
        if (type === "multicolumn") {
            details.multicolumn = multicolumnDetails(...args);
            if (details.multicolumn.columns.mobile === null && pair.m !== null) unknowns.push({ scope: `sections.${id}.details.multicolumn.columns.mobile`, reason: pair.d !== null ? "conflict" : "not-observed" });
        }

        return {
            id,
            type,
            confidence: combined.confidence,
            agreement: combined.agreement,
            unknownReason,
            hints: [...hintSet.values()].sort((a, b) => (a.type < b.type ? -1 : 1)),
            colorScheme: null,
            viewports: {
                desktop: pair.d !== null ? presenceFor(dv, pair.d, type) : null,
                mobile: pair.m !== null ? presenceFor(mv, pair.m, type) : null,
            },
            content: contentFor(primaryView, primaryIndex),
            details,
            _pair: pair,
        };
    });

    // --- Esquemas de cor por seção ----------------------------------------
    // Agrupa por fundo + texto; botão ausente (null) se une ao esquema
    // equivalente que tenha botão. Botões diferentes geram esquemas distintos.
    const schemes = [];
    for (const section of sections) {
        const view = section._pair.d !== null ? dv : mv;
        const f = view.features[section._pair.d !== null ? section._pair.d : section._pair.m];
        const solid = f.buttons.map((id) => view.index.node(id)).find((node) => buttonStyle(node) === "solid");
        const label = solid ? parseColor(solid.styles.color) : null;
        const candidate = {
            background: f.background.hex,
            backgroundMedia: f.background.image || f.backgroundImage ? "image" : f.background.gradient ? "gradient" : "none",
            text: f.headingColor ?? f.textColor,
            button: solid ? toHex(parseColor(solid.styles.backgroundColor)) : null,
            buttonLabel: label && isOpaque(label) ? toHex(label) : null,
        };
        const base = (s) => `${s.background}|${s.backgroundMedia}|${s.text}`;
        let scheme = schemes.find(
            (s) => base(s) === base(candidate) && (s.button === null || candidate.button === null || (s.button === candidate.button && s.buttonLabel === candidate.buttonLabel))
        );
        if (!scheme) {
            scheme = { id: `scheme-${schemes.length + 1}`, ...candidate, sections: [] };
            schemes.push(scheme);
        } else if (scheme.button === null && candidate.button !== null) {
            scheme.button = candidate.button;
            scheme.buttonLabel = candidate.buttonLabel;
        }
        scheme.sections.push(section.id);
        section.colorScheme = scheme.id;
        if (candidate.backgroundMedia === "image") {
            unknowns.push({ scope: `sections.${section.id}.background`, reason: "image-background" });
        }
    }

    // --- Mudanças responsivas --------------------------------------------
    for (const section of sections) {
        const d = section.viewports.desktop;
        const m = section.viewports.mobile;
        if (!d || !m) continue;
        // Colunas não se aplicam a barras de anúncio e headers.
        if (d.columns !== m.columns && !["header", "announcement-bar"].includes(section.type)) {
            changes.push({ sectionId: section.id, property: "columns", desktop: d.columns, mobile: m.columns });
            if (section.type !== "product-grid" && d.columns > 1 && m.columns === 1) {
                changes.push({ sectionId: section.id, property: "layout", desktop: "side-by-side", mobile: "stacked" });
            }
        }
        if (section.details.header) {
            const nav = section.details.header.navigation;
            if (nav.desktop !== nav.mobile) {
                changes.push({ sectionId: section.id, property: "navigation", desktop: nav.desktop, mobile: nav.mobile });
            }
        }
        const ratio = m.box.height / Math.max(d.box.height, 1);
        if (ratio > 1.25 || ratio < 0.8) {
            changes.push({ sectionId: section.id, property: "height", desktop: d.box.height, mobile: m.box.height });
        }
        if (d.textAlign !== m.textAlign) {
            changes.push({ sectionId: section.id, property: "alignment", desktop: d.textAlign, mobile: m.textAlign });
        }
    }

    // --- Tokens -------------------------------------------------------------
    const tally = extractColors(dv.index);
    const buttons = extractButtons(dv.index);
    const rolesEvidence = {};
    const roles = colorRoles(dv.index, tally, buttons, rolesEvidence);
    for (const [role, value] of Object.entries(roles)) {
        if (value === null) unknowns.push({ scope: `tokens.colors.roles.${role}`, reason: "not-observed" });
    }

    const palette = [];
    for (const [usage, entries] of [["background", tally.backgrounds], ["text", tally.texts]]) {
        const total = entries.total() || 1;
        for (const entry of entries.sorted().slice(0, 8)) {
            palette.push({ hex: entry.hex, share: clamp01(entry.weight / total), usage });
        }
    }

    const typographyEvidence = {};
    const typography = extractTypography(dv.index, mv.index, typographyEvidence);
    if (!typography.heading) unknowns.push({ scope: "tokens.typography.heading", reason: "not-observed" });
    if (!typography.body) unknowns.push({ scope: "tokens.typography.body", reason: "not-observed" });

    const gridSection = sections.find((s) => s.type === "product-grid" && s._pair.d !== null);
    const productCard = gridSection ? extractCard(dv.index, dv.features[gridSection._pair.d].repeated) : null;
    if (!productCard) unknowns.push({ scope: "tokens.productCard", reason: "not-observed" });

    // 1.8.0: cartões de conteúdo (colunas/depoimentos) com tratamento visual medido
    const contentCards = extractContentCards(dv.index, sections.filter((s) => ["multicolumn", "testimonials"].includes(s.type) && s._pair.d !== null).map((s) => {
        const f = dv.features[s._pair.d];
        return { id: s.id, repeated: f.repeated, sectionBackground: f.background?.hex ?? null };
    }));

    const layoutFor = (view) => extractLayout(view.index, view.bands);

    const blueprint = {
        schemaVersion: BLUEPRINT_SCHEMA_VERSION,
        kind: "StoreBlueprint",
        contentMode: "reference",
        analyzer: { providers: [PROVIDER], version: ANALYZER_VERSION },
        source,
        tokens: {
            colors: { roles, palette },
            colorSchemes: schemes,
            typography: {
                heading: typography.heading,
                body: typography.body,
                scale: typography.scale,
            },
            layout: { desktop: layoutFor(dv), mobile: layoutFor(mv) },
            buttons,
            productCard,
            input: extractInputs(dv.index),
            contentCards,
        },
        sections: sections.map(({ _pair, ...section }) => section),
        responsive: { changes },
        unknowns,
        stats: {
            sections: sections.length,
            recognized: sections.filter((s) => s.type !== "unknown").length,
            unknown: sections.filter((s) => s.type === "unknown").length,
        },
    };

    TOKEN_EVIDENCE.set(blueprint, { tipografia: typographyEvidence, fundo: rolesEvidence });
    return blueprint;
}

/** Evidência das decisões de tokens (fora do contrato estrito do blueprint; gravada no analysis.json). */
export const TOKEN_EVIDENCE = new WeakMap();
