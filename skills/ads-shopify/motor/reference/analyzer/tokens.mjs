/**
 * Extração de design tokens a partir dos estilos computados.
 * Valores sem evidência suficiente ficam null e entram em `unknowns`.
 */

import { ColorTally, contrastRatio, distance, isOpaque, luminance, parseColor, toHex } from "./color.mjs";
import { area, headingOf, headingTypography, isButtonLike, px } from "./dom-index.mjs";

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]);

/** Nome de família seguro (somente caracteres usuais de nomes de fonte). */
export function sanitizeFamily(name) {
    const clean = String(name).replace(/^["'\s]+|["'\s]+$/g, "");
    return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(clean) ? clean : null;
}

// Famílias que NUNCA representam a tipografia do texto: fontes de emoji/símbolo e nomes internos de pilhas do sistema.
const NON_TEXT_FAMILY = /emoji|symbol/i;
const SYSTEM_STACK_NAMES = new Set(["blinkmacsystemfont", "-apple-system", "apple-system"]);
// Genéricas de sistema → classe que o catálogo verificado entende (a original fica na evidência).
const GENERIC_CLASS = { "ui-sans-serif": "sans-serif", "system-ui": "sans-serif", "ui-rounded": "sans-serif", "ui-serif": "serif", "ui-monospace": "monospace" };

/**
 * Pilha `font-family` → família principal, fallbacks e classe genérica.
 * Fontes de emoji/símbolo e nomes internos de pilhas do sistema são EXCLUÍDOS (nunca viram a família do texto);
 * genéricas de sistema (`ui-sans-serif`, `system-ui`…) são normalizadas para a classe CSS (`sans-serif`…).
 * `declared` e `excluded` preservam a evidência (gravada no analysis.json, fora do blueprint).
 */
export function parseFontFamily(value) {
    const declared = String(value ?? "")
        .split(",")
        .map((part) => sanitizeFamily(part))
        .filter(Boolean)
        .slice(0, 8);
    const excluded = declared.filter((family) => NON_TEXT_FAMILY.test(family) || SYSTEM_STACK_NAMES.has(family.toLowerCase()));
    const families = declared.filter((family) => !excluded.includes(family)).slice(0, 6);
    const rawGeneric = families.find((family) => GENERIC_FAMILIES.has(family.toLowerCase())) ?? null;
    const generic = rawGeneric ? GENERIC_CLASS[rawGeneric.toLowerCase()] ?? rawGeneric : null;
    const named = families.filter((family) => !GENERIC_FAMILIES.has(family.toLowerCase()));
    return { primary: named[0] ?? generic, fallbacks: named.slice(1), generic, declared, excluded, systemStack: !named.length && /^(ui-|system-ui)/i.test(rawGeneric ?? "") };
}

function mode(values) {
    const counts = new Map();
    for (const value of values) {
        if (value === null || value === undefined) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

function weightedMode(entries) {
    const tally = new Map();
    for (const [value, weight] of entries) {
        if (value === null || value === undefined) continue;
        tally.set(value, (tally.get(value) ?? 0) + weight);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1))[0]?.[0] ?? null;
}

function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);
const round3 = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

/**
 * Paleta ponderada por área (fundos) e por quantidade de texto.
 */
export function extractColors(index) {
    const backgrounds = new ColorTally();
    const texts = new ColorTally();

    for (const node of index.nodes) {
        if (!node.visible) continue;
        const background = parseColor(node.styles.backgroundColor);
        if (isOpaque(background)) {
            // Área exclusiva: descontar filhos diretos com fundo próprio.
            const covered = index
                .visibleChildren(node.id)
                .map((id) => index.node(id))
                .filter((child) => isOpaque(parseColor(child.styles.backgroundColor)))
                .reduce((sum, child) => sum + area(child.box), 0);
            backgrounds.add(background, Math.max(area(node.box) - covered, 0));
        }
        if (node.textLength > 0) texts.add(parseColor(node.styles.color), node.textLength);
    }
    return { backgrounds, texts };
}

/**
 * Papéis de cor globais (desktop como referência).
 */
// Fração mínima da área VISÍVEL da página para a cor declarada no <body> valer como fundo da página.
export const BODY_BACKGROUND_MIN_SHARE = 0.2;

export function colorRoles(index, { backgrounds, texts }, buttonVariants, evidence = null) {
    const body = index.node(0);
    const bodyBackground = parseColor(body.styles.backgroundColor);
    // O <body> pode declarar uma cor que fica quase toda coberta pelas seções. Vale a cor efetivamente visível:
    // a do <body> só se ela ocupar ao menos BODY_BACKGROUND_MIN_SHARE da área de fundo; senão, a cor dominante por área.
    const bgTotal = backgrounds.total() || 0;
    const top = backgrounds.sorted()[0] ?? null;
    const bodyEntry = isOpaque(bodyBackground) ? backgrounds.entries.find((entry) => distance(entry.color, bodyBackground) < 10) ?? null : null;
    const bodyShare = bgTotal && bodyEntry ? bodyEntry.weight / bgTotal : 0;
    const useBody = isOpaque(bodyBackground) && (bodyShare >= BODY_BACKGROUND_MIN_SHARE || !top);
    const background = useBody ? toHex(bodyBackground) : top?.hex ?? null;
    if (evidence) Object.assign(evidence, {
        bodyDeclarado: isOpaque(bodyBackground) ? toHex(bodyBackground) : null, bodyFracaoVisivel: Math.round(bodyShare * 1000) / 1000,
        dominantePorArea: top?.hex ?? null, dominanteFracao: top && bgTotal ? Math.round((top.weight / bgTotal) * 1000) / 1000 : null,
        escolhido: background, regra: useBody ? "body-visivel" : "dominante-por-area", limiar: BODY_BACKGROUND_MIN_SHARE,
    });

    // Texto principal: cor de texto mais usada sobre o fundo da página.
    const onPage = new ColorTally();
    for (const node of index.nodes) {
        if (!node.visible || node.textLength <= 0) continue;
        const effective = index.effectiveBackground(node.id);
        if (effective.color && toHex(effective.color) === background) {
            onPage.add(parseColor(node.styles.color), node.textLength);
        }
    }
    const textEntries = onPage.sorted();
    const text = textEntries[0]?.hex ?? texts.sorted()[0]?.hex ?? null;
    const total = onPage.total() || 1;
    const muted = textEntries.slice(1).find((entry) => entry.weight / total >= 0.05)?.hex ?? null;

    const solid = buttonVariants.find((variant) => variant.style === "solid");
    const primary = solid?.colors[0] ?? null;

    const surfaces = backgrounds
        .sorted()
        .filter((entry) => entry.hex !== background)
        .filter((entry) => !primary || entry.hex !== primary.background);
    const pageColor = parseColor(background);
    const inverse = surfaces.find((entry) => pageColor && Math.abs(luminance(entry.color) - luminance(pageColor)) > 0.5);
    const surface = surfaces.find((entry) => entry !== inverse && pageColor && contrastRatio(entry.color, pageColor) < 1.5);

    return {
        background,
        text,
        mutedText: muted,
        primary: primary?.background ?? null,
        onPrimary: primary?.text ?? null,
        surface: surface?.hex ?? null,
        inverseBackground: inverse?.hex ?? null,
    };
}

/**
 * Tipografia: famílias de títulos e corpo, pesos e escala por nível.
 */
export function extractTypography(desktop, mobile, evidence = null) {
    const collect = (index) => {
        const headings = [];
        const body = [];
        for (const node of index.nodes) {
            if (!node.visible) continue;
            if (node.headingLevel) {
                // Um registro por título, com a tipografia visível dominante
                // (texto próprio ou em descendentes inline).
                const t = headingTypography(index, node);
                if (t.chars > 0) headings.push({ node, family: t.family, size: t.size, weight: t.weight, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, transform: t.transform, chars: t.chars });
                continue;
            }
            if (node.textLength <= 0 || headingOf(index, node)) continue;
            const entry = {
                node,
                family: node.styles.fontFamily,
                size: px(node.styles.fontSize),
                weight: node.styles.fontWeight,
                lineHeight: px(node.styles.lineHeight),
                letterSpacing: node.styles.letterSpacing,
                transform: node.styles.textTransform,
                chars: node.textLength,
            };
            if (!["button", "input", "select", "textarea"].includes(node.tag)) body.push(entry);
        }
        return { headings, body };
    };

    const d = collect(desktop);
    const m = collect(mobile);

    const familyOf = (entries) => {
        const raw = weightedMode(entries.map((entry) => [entry.family, entry.chars]));
        return raw ? parseFontFamily(raw) : null;
    };

    const headingFamily = familyOf(d.headings);
    const bodyFamily = familyOf(d.body);
    if (evidence) for (const [role, f] of [["heading", headingFamily], ["body", bodyFamily]]) {
        evidence[role] = f && { declarado: f.declared, excluidas: f.excluded, escolhida: f.primary, classe: f.generic, pilhaDoSistema: f.systemStack };
    }
    const baseSize = weightedMode(d.body.map((entry) => [entry.size, entry.chars]));
    const bodyLineHeight = median(d.body.filter((entry) => entry.size === baseSize).map((entry) => (entry.lineHeight ?? NaN) / entry.size));

    const levels = [];
    for (let level = 1; level <= 6; level++) {
        const dl = d.headings.filter((entry) => entry.node.headingLevel === level);
        const ml = m.headings.filter((entry) => entry.node.headingLevel === level);
        if (!dl.length && !ml.length) continue;
        levels.push({
            level,
            count: dl.length,
            desktopPx: round1(median(dl.map((entry) => entry.size))),
            mobilePx: round1(median(ml.map((entry) => entry.size))),
            weight: Number(mode(dl.map((entry) => entry.weight))) || null,
            lineHeight: round3(median(dl.map((entry) => (entry.lineHeight ?? NaN) / entry.size))),
        });
    }

    const weightsOf = (entries) => [...new Set(entries.map((entry) => Number(entry.weight)).filter(Number.isFinite))].sort((a, b) => a - b);

    return {
        heading: headingFamily && {
            family: headingFamily.primary,
            fallbacks: headingFamily.fallbacks,
            generic: headingFamily.generic,
            weights: weightsOf(d.headings),
        },
        body: bodyFamily && {
            family: bodyFamily.primary,
            fallbacks: bodyFamily.fallbacks,
            generic: bodyFamily.generic,
            weights: weightsOf(d.body),
            sizePx: { desktop: baseSize, mobile: weightedMode(m.body.map((entry) => [entry.size, entry.chars])) },
            lineHeight: round3(bodyLineHeight),
        },
        scale: levels,
    };
}

/**
 * Largura de conteúdo, margens laterais e espaçamento vertical.
 */
export function extractLayout(index, bands) {
    const viewportWidth = index.viewport.width;

    // Contêiner de página: nó centralizado com padding lateral simétrico.
    // A largura inclui o padding (como o page_width do Dawn).
    const containers = index.nodes.filter((node) => {
        if (!node.visible || node.box.width < viewportWidth * 0.5) return false;
        const left = px(node.styles.paddingLeft) ?? 0;
        const right = px(node.styles.paddingRight) ?? 0;
        const center = node.box.x + node.box.width / 2;
        return left > 0 && left === right && Math.abs(center - viewportWidth / 2) <= 2 && index.visibleChildren(node.id).length > 0;
    });
    const signature = mode(containers.map((node) => `${Math.round(node.box.width)}|${px(node.styles.paddingLeft)}`));
    let containerWidth = null;
    let gutter = null;
    if (signature) {
        const [width, padding] = signature.split("|").map(Number);
        containerWidth = width < viewportWidth - 8 ? width : null; // null = fluido
        gutter = padding;
    }

    const spacing = mode(
        bands
            .flatMap((id) => [index.node(id), ...index.visibleChildren(id).map((child) => index.node(child))])
            .map((node) => px(node.styles.paddingTop))
            .filter((value) => value >= 24)
    );

    return { containerWidthPx: containerWidth, gutterPx: gutter, sectionPaddingPx: spacing };
}

/**
 * Variantes de botão agrupadas por forma; cores registradas por variante.
 */
export function extractButtons(index) {
    const groups = new Map();
    for (const node of index.nodes) {
        if (!isButtonLike(index, node)) continue;
        const background = parseColor(node.styles.backgroundColor);
        const borderWidth = px(node.styles.borderTopWidth) ?? 0;
        const style = isOpaque(background) ? "solid" : borderWidth > 0 ? "outline" : "plain";
        const shape = {
            style,
            radiusPx: px(node.styles.borderTopLeftRadius),
            borderWidthPx: borderWidth,
            paddingX: px(node.styles.paddingLeft),
            paddingY: px(node.styles.paddingTop),
            fontWeight: Number(node.styles.fontWeight) || null,
            textTransform: node.styles.textTransform === "none" ? null : node.styles.textTransform ?? null,
        };
        const key = JSON.stringify(shape);
        if (!groups.has(key)) groups.set(key, { ...shape, count: 0, heights: [], colors: new Map() });
        const group = groups.get(key);
        group.count++;
        group.heights.push(node.box.height);
        const text = parseColor(node.styles.color);
        const border = parseColor(node.styles.borderTopColor);
        const colors = {
            background: isOpaque(background) ? toHex(background) : null,
            text: isOpaque(text) ? toHex(text) : null,
            border: borderWidth > 0 && isOpaque(border) ? toHex(border) : null,
        };
        const colorKey = JSON.stringify(colors);
        group.colors.set(colorKey, { ...colors, count: (group.colors.get(colorKey)?.count ?? 0) + 1 });
    }

    return [...groups.values()]
        .map((group) => ({
            style: group.style,
            radiusPx: group.radiusPx,
            borderWidthPx: group.borderWidthPx,
            paddingX: group.paddingX,
            paddingY: group.paddingY,
            fontWeight: group.fontWeight,
            textTransform: group.textTransform,
            heightPx: Math.round(median(group.heights)),
            count: group.count,
            colors: [...group.colors.values()].sort((a, b) => b.count - a.count || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        }))
        .sort((a, b) => b.count - a.count || (a.style < b.style ? -1 : 1));
}

/**
 * Card de produto a partir do grupo repetido da seção de produtos.
 */
export function extractCard(index, repeated) {
    if (!repeated) return null;
    const item = index.node(repeated.itemIds[0]);
    const inside = index.visibleDescendants(item.id, { includeSelf: true });
    const image = inside.find((node) => node.media && node.media.kind !== "svg" && area(node.box) >= area(item.box) * 0.15);
    const background = parseColor(item.styles.backgroundColor);
    const borderWidth = px(item.styles.borderTopWidth) ?? 0;
    const texts = inside.filter((node) => node.textLength > 0);
    // Selo sobre a imagem em qualquer um dos itens (ex.: "novo", "-20%").
    const badge = repeated.itemIds.some((itemId) => {
        const nodes = index.visibleDescendants(itemId);
        const picture = nodes.find((node) => node.media && node.media.kind !== "svg");
        return Boolean(picture) && nodes.some(
            (node) =>
                node.textLength > 0 &&
                node.textLength <= 24 &&
                isOpaque(parseColor(node.styles.backgroundColor)) &&
                node.box.y >= picture.box.y &&
                node.box.y + node.box.height <= picture.box.y + picture.box.height
        );
    });

    return {
        background: isOpaque(background) ? toHex(background) : null,
        radiusPx: px(item.styles.borderTopLeftRadius),
        paddingPx: px(item.styles.paddingLeft),
        borderWidthPx: borderWidth,
        shadow: Boolean(item.styles.boxShadow) && item.styles.boxShadow !== "none",
        textAlign: mode(texts.map((node) => (node.styles.textAlign === "start" ? "left" : node.styles.textAlign))),
        image: image
            ? {
                  aspectRatio: round3(image.box.width / image.box.height),
                  radiusPx: px(image.styles.borderTopLeftRadius),
                  fit: image.styles.objectFit ?? null,
              }
            : null,
        hasBadge: badge,
        hasPrice: repeated.priceShare >= 0.5,
    };
}

/** Sombra CSS (primeira camada) → deslocamentos, desfoque e opacidade; null se ausente. */
export function parseShadow(value) {
    if (!value || value === "none") return null;
    const color = /rgba?\([^)]*\)/.exec(value)?.[0] ?? null;
    const nums = value.replace(/rgba?\([^)]*\)/, "").trim().split(/\s+/).map((part) => px(part)).filter((n) => n !== null);
    if (nums.length < 2) return null;
    const alpha = color ? parseColor(color)?.a ?? 1 : 1;
    return { xPx: nums[0], yPx: nums[1], blurPx: nums[2] ?? 0, opacity: Math.round(alpha * 100) / 100 };
}

/**
 * Cartões de CONTEÚDO (itens repetidos de colunas/depoimentos) com tratamento visual medido: fundo distinto do da
 * seção, borda ou sombra. Só seções cujos itens têm o tratamento entram; o estilo vem do grupo de maior área.
 * Sem tratamento observado → null (o gerador mantém o Dawn).
 * @param {Array<{ id: string, sectionBackground: string|null, repeated: any }>} groups
 */
export function extractContentCards(index, groups) {
    const found = [];
    for (const group of groups) {
        if (!group.repeated?.itemIds?.length || group.repeated.itemIds.length < 2) continue;
        const items = group.repeated.itemIds.map((id) => index.node(id));
        const item = items[0];
        const background = parseColor(item.styles.backgroundColor);
        const sectionBg = group.sectionBackground ? parseColor(group.sectionBackground) : null;
        const distinctBg = isOpaque(background) && (!sectionBg || distance(background, sectionBg) >= 6);
        const borderWidth = px(item.styles.borderTopWidth) ?? 0;
        const borderColor = parseColor(item.styles.borderTopColor);
        const shadow = parseShadow(item.styles.boxShadow);
        if (!distinctBg && !(borderWidth > 0 && isOpaque(borderColor)) && !shadow) continue;
        // consistência: os itens do grupo precisam ter o mesmo tratamento (evita confundir um destaque com cartões)
        const same = items.every((node) => node.styles.backgroundColor === item.styles.backgroundColor && node.styles.borderTopWidth === item.styles.borderTopWidth);
        if (!same) continue;
        found.push({ id: group.id, area: items.reduce((sum, node) => sum + area(node.box), 0), style: {
            background: distinctBg ? toHex(background) : null,
            borderWidthPx: borderWidth > 0 && isOpaque(borderColor) ? borderWidth : 0,
            borderColor: borderWidth > 0 && isOpaque(borderColor) ? toHex(borderColor) : null,
            radiusPx: px(item.styles.borderTopLeftRadius) ?? 0,
            paddingPx: px(item.styles.paddingLeft),
            shadow,
        } });
    }
    if (!found.length) return null;
    const main = [...found].sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1))[0];
    return { ...main.style, sections: found.map((entry) => entry.id).sort() };
}

export function extractInputs(index) {
    const inputs = index.nodes.filter((node) => node.visible && node.tag === "input");
    if (!inputs.length) return null;
    const first = inputs[0];
    const border = parseColor(first.styles.borderTopColor);
    return {
        radiusPx: px(first.styles.borderTopLeftRadius),
        borderWidthPx: px(first.styles.borderTopWidth),
        borderColor: isOpaque(border) ? toHex(border) : null,
        heightPx: Math.round(first.box.height),
    };
}
