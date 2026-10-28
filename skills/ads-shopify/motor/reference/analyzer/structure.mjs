/**
 * Segmentação da página em faixas horizontais e extração de
 * características estruturais de cada faixa (sem copiar conteúdo).
 */

import { isOpaque, parseColor, toHex, ColorTally } from "./color.mjs";
import {
    area,
    fontSizeOf,
    hasBackgroundImage,
    hasButtonAppearance,
    hasGradient,
    hasPriceText,
    headingTypography,
    isButtonLike,
    overlapArea,
    px,
} from "./dom-index.mjs";

const SEMANTIC_BLOCKS = new Set(["header", "footer", "section", "nav", "aside", "form"]);

function hasOwnVisual(node) {
    return (
        isOpaque(parseColor(node.styles.backgroundColor)) ||
        hasBackgroundImage(node) ||
        hasGradient(node) ||
        ((px(node.styles.borderTopWidth) ?? 0) > 0 && node.styles.borderTopStyle !== "none")
    );
}

// Seções semânticas (tag ou landmark ARIA) que um contêiner de aplicação empilha.
const SECTIONING_TAGS = new Set(["header", "footer", "section", "article", "aside", "nav", "main"]);
const SECTIONING_ROLES = new Set(["banner", "contentinfo", "region", "main", "complementary", "navigation"]);
const isSectioning = (node) => SECTIONING_TAGS.has(node.tag) || SECTIONING_ROLES.has(node.role);

/** Inteiramente fora da página (ex.: link "pular para o conteúdo" escondido acima do topo). */
// Área horizontal EFETIVAMENTE visível de uma faixa: a caixa recortada pela
// janela. Itens de carrossel/faixa rolável fora dela não são colunas (1.6.1).
function visibleSpan(index, box) {
    return { x0: Math.max(0, box.x), x1: Math.min(index.viewport.width, box.x + box.width) };
}
// Conta como coluna o item com ao menos metade da largura na área visível.
function inVisibleSpan(span, box) {
    return box.width > 0 && Math.min(span.x1, box.x + box.width) - Math.max(span.x0, box.x) >= box.width * 0.5;
}

// Camada fixa que não pinta nada (contêiner vazio de aplicativo, transparente,
// sem texto, mídia, fundo ou borda em toda a subárvore): não é faixa nem
// overlay — não cobre conteúdo nenhum (1.6.1).
function isInertLayer(index, node) {
    if (node.styles.position !== "fixed" || hasOwnVisual(node)) return false;
    return !index.visibleDescendants(node.id).some((n) => n.textLength > 0 || n.media || hasOwnVisual(n));
}

// Colunas visíveis da 1ª linha de um grupo repetido. Irmãos do MESMO contêiner
// com a mesma tag, o mesmo tamanho e a mesma linha também contam, mesmo que a
// classe difira só por estado (ex.: item ativo/anterior/próximo de carrossel).
function visibleColumns(index, rootId, containerId, firstRow) {
    const span = visibleSpan(index, index.node(rootId).box);
    const ref = firstRow[0];
    const row = index
        .visibleChildren(containerId)
        .map((id) => index.node(id))
        .filter((kid) => kid.tag === ref.tag && Math.abs(kid.box.y - ref.box.y) <= 4 && kid.box.width > 0 && Math.max(kid.box.width, ref.box.width) / Math.min(kid.box.width, ref.box.width) <= 1.15);
    return Math.max(1, row.filter((kid) => inVisibleSpan(span, kid.box)).length);
}

function isOffPage(index, node) {
    const { x, y, width, height } = node.box;
    return y + height <= 0 || x + width <= 0 || x >= index.viewport.width || y >= index.pageHeight;
}

/**
 * Posição de um elemento em relação ao fluxo do documento:
 *  - "flow": ocupa espaço na pilha de blocos (inclui sticky);
 *  - "viewport": fixo na janela (header fixo, botão/barra flutuante) — não
 *    ocupa a pilha, mas continua candidato a faixa ou overlay;
 *  - "off-page": fora da página — continua no DOM, mas não vira faixa;
 *  - "layer": absoluto sobre o contêiner (camada de composição).
 */
export function flowRole(index, node) {
    if (isOffPage(index, node)) return "off-page";
    if (node.styles.position === "fixed") return "viewport";
    if (node.styles.position === "absolute") return "layer";
    return "flow";
}

/**
 * Um contêiner é "transparente" para a segmentação se só empilha blocos de
 * largura total — considerando apenas os filhos NO FLUXO: elementos fixos ou
 * fora da página não ocupam a pilha e não podem impedir a segmentação. Uma
 * camada absoluta que cobre parte relevante do contêiner indica composição
 * (ex.: fundo de um hero) e mantém o contêiner inteiro.
 */
function shouldExpand(index, node) {
    if (node.tag === "main" || node.role === "main") return true;
    if (SEMANTIC_BLOCKS.has(node.tag)) return false;

    const visible = index.visibleChildren(node.id).map((id) => index.node(id)).filter((kid) => kid.box.height >= 1);
    const kids = visible.filter((kid) => flowRole(index, kid) === "flow");
    const stacked = kids.every((kid, i) => i === 0 || kid.box.y >= kids[i - 1].box.y + kids[i - 1].box.height - 2);

    // Contêiner de aplicação (com ou sem fundo próprio, com ou sem camada
    // decorativa) que só empilha seções semânticas: as seções são as faixas.
    if (kids.length >= 2 && stacked && kids.every((kid) => isSectioning(kid) && kid.box.width >= index.viewport.width * 0.5)) return true;
    // Camada absoluta relevante sobre conteúdo NÃO semântico = composição
    // (ex.: fundo de um hero): o contêiner fica inteiro.
    const nodeArea = area(node.box);
    if (visible.some((kid) => flowRole(index, kid) === "layer" && nodeArea > 0 && overlapArea(kid.box, node.box) >= nodeArea * 0.25)) return false;
    if (hasOwnVisual(node)) return false;

    if (kids.length === 1) {
        return kids[0].box.width >= node.box.width * 0.95 && kids[0].box.height >= node.box.height * 0.8;
    }
    if (kids.length < 2) return false;

    const fullWidth = kids.every((kid) => kid.box.width >= node.box.width * 0.9);
    return fullWidth && stacked;
}

/**
 * Faixas da página em ordem vertical, mais overlays fixos separados.
 * @param {import("./dom-index.mjs").DomIndex} index
 */
export function segmentBands(index) {
    const viewportWidth = index.viewport.width;
    let candidates = index.visibleChildren(0);
    const overlays = [];

    for (let guard = 0; guard < 8; guard++) {
        let changed = false;
        const next = [];
        for (const id of candidates) {
            const node = index.node(id);
            if (shouldExpand(index, node) && index.visibleChildren(id).length) {
                next.push(...index.visibleChildren(id));
                changed = true;
            } else {
                next.push(id);
            }
        }
        candidates = next;
        if (!changed) break;
    }

    const bands = [];
    for (const id of candidates) {
        const node = index.node(id);
        if (node.box.height < 8 || node.box.width < viewportWidth * 0.5) continue;
        // Fora da página ou camada absoluta (decoração sobre o conteúdo): não
        // é faixa de conteúdo; continua no DOM.
        if (isOffPage(index, node) || flowRole(index, node) === "layer") continue;
        if (isInertLayer(index, node)) continue;
        if (node.styles.position === "fixed" && node.box.y > 0) {
            overlays.push(id);
            continue;
        }
        bands.push(id);
    }

    // Empate vertical (ex.: header fixo sobre o hero, ambos em y=0): o elemento
    // fixo vem antes; depois, a ordem do documento.
    const fixedFirst = (id) => (index.node(id).styles.position === "fixed" ? 0 : 1);
    bands.sort((a, b) => index.node(a).box.y - index.node(b).box.y || fixedFirst(a) - fixedFirst(b) || a - b);
    return { bands, overlays };
}

/**
 * Grupo de irmãos repetidos (cards, colunas) mais relevante na subárvore.
 */
export function findRepeatedGroup(index, rootId) {
    let best = null;

    for (const container of index.visibleDescendants(rootId, { includeSelf: true })) {
        const kids = index.visibleChildren(container.id).map((id) => index.node(id));
        if (kids.length < 3) continue;

        const groups = new Map();
        for (const kid of kids) {
            const signature = `${kid.tag}|${kid.attrs.class ?? ""}`;
            if (!groups.has(signature)) groups.set(signature, []);
            groups.get(signature).push(kid);
        }

        for (const items of groups.values()) {
            if (items.length < 3) continue;
            const widths = items.map((item) => item.box.width);
            const heights = items.map((item) => item.box.height);
            if (Math.min(...widths) <= 0 || Math.max(...widths) / Math.min(...widths) > 1.15) continue;
            if (Math.min(...heights) <= 0 || Math.max(...heights) / Math.min(...heights) > 1.35) continue;

            const score = items.length * area(items[0].box);
            if (!best || score > best.score) {
                best = { containerId: container.id, items, score };
            }
        }
    }

    if (!best) return null;

    const items = best.items;
    const firstRowY = Math.min(...items.map((item) => item.box.y));
    const firstRow = items.filter((item) => Math.abs(item.box.y - firstRowY) <= 4);
    const rows = new Set(items.map((item) => Math.round(item.box.y / 4))).size;
    const sortedRow = [...firstRow].sort((a, b) => a.box.x - b.box.x);
    const gaps = sortedRow.slice(1).map((item, i) => item.box.x - (sortedRow[i].box.x + sortedRow[i].box.width));

    const itemFacts = items.map((item) => {
        const inside = index.visibleDescendants(item.id, { includeSelf: true });
        const media = inside.filter(
            (node) => (node.media && node.media.kind !== "svg") || hasBackgroundImage(node)
        ).filter((node) => area(node.box) >= area(item.box) * 0.15);
        return {
            hasImage: media.length > 0,
            hasText: inside.some((node) => node.textLength > 0),
            hasHeading: inside.some((node) => node.headingLevel),
            hasPrice: inside.some((node) => node.textLength > 0 && node.textLength < 40 && hasPriceText(node.text)),
        };
    });
    const share = (key) => itemFacts.filter((fact) => fact[key]).length / items.length;

    return {
        containerId: best.containerId,
        itemIds: items.map((item) => item.id),
        count: items.length,
        columns: visibleColumns(index, rootId, best.containerId, firstRow),
        rows,
        gapX: gaps.length ? Math.round(Math.min(...gaps)) : null,
        itemWidth: Math.round(items[0].box.width),
        itemHeight: Math.round(items[0].box.height),
        imageShare: share("hasImage"),
        textShare: share("hasText"),
        headingShare: share("hasHeading"),
        priceShare: share("hasPrice"),
    };
}

/**
 * Painéis expansíveis empilhados (acordeão/FAQ). Gatilho = elemento com
 * `aria-expanded` que age como botão, ou `<summary>`. Exige pelo menos 2
 * gatilhos empilhados, alinhados à esquerda e de larguras parecidas; um
 * atributo isolado não basta. Para cada linha registra se está aberta e se o
 * conteúdo do painel EXISTE no DOM (via aria-controls ou região entre
 * gatilhos) — painel fechado e ausente não tem conteúdo conhecido.
 * @returns {null | { trigger: "aria-expanded" | "details", rows: number, openRows: number, firstRowOpen: boolean, capturedPanels: number, panelContent: { paragraphs: number, listItems: number, links: number }, top: number, bottom: number, x: number, width: number }}
 */
export function disclosureGroup(index, rootId) {
    const nodes = index.visibleDescendants(rootId, { includeSelf: true });
    const byAttrId = new Map();
    for (const node of index.visibleDescendants(rootId, { includeSelf: true })) if (node.attrs.id) byAttrId.set(node.attrs.id, node);
    const triggers = nodes.filter((node) => {
        if (node.tag === "summary") return true;
        const expanded = node.attrs.ariaExpanded;
        return (expanded === "true" || expanded === "false") && (node.tag === "button" || node.role === "button" || hasButtonAppearance(index, node));
    });
    if (triggers.length < 2) return null;
    // Um gatilho dentro de outro (ex.: botão dentro de summary) conta uma vez.
    const rows = triggers.filter((node) => !triggers.some((other) => other !== node && index.isInside(node.id, other.id))).sort((a, b) => a.box.y - b.box.y || a.id - b.id);
    if (rows.length < 2) return null;
    const stacked = rows.every((row, i) => i === 0 || row.box.y >= rows[i - 1].box.y + rows[i - 1].box.height - 2);
    const xs = rows.map((row) => row.box.x);
    const widths = rows.map((row) => row.box.width);
    const aligned = Math.max(...xs) - Math.min(...xs) <= 24;
    const similar = Math.min(...widths) > 0 && Math.min(...widths) / Math.max(...widths) >= 0.8;
    if (!stacked || !aligned || !similar) return null;

    const kind = rows.every((row) => row.tag === "summary") ? "details" : rows.every((row) => row.tag !== "summary") ? "aria-expanded" : null;
    if (!kind) return null;
    const isOpen = (row) => (row.tag === "summary" ? index.node(row.parent)?.attrs.open === "true" : row.attrs.ariaExpanded === "true");
    const inRows = (node) => rows.some((row) => node.id === row.id || index.isInside(node.id, row.id));
    const groupBottom = Math.max(...rows.map((row) => row.box.y + row.box.height));
    // Ancestral mais alto do gatilho (dentro da faixa) que não contém outra linha.
    const ownContainer = (row) => {
        let own = row;
        for (let id = row.parent; id !== null && id !== undefined && id !== rootId; id = index.node(id).parent) {
            if (rows.some((other) => other !== row && index.isInside(other.id, id))) break;
            own = index.node(id);
        }
        return own;
    };

    let capturedPanels = 0;
    const panel = { paragraphs: 0, listItems: 0, links: 0 };
    rows.forEach((row, i) => {
        let content;
        const controlled = row.attrs.ariaControls ? byAttrId.get(row.attrs.ariaControls) : null;
        const own = ownContainer(row);
        if (controlled) {
            content = index.visibleDescendants(controlled.id, { includeSelf: true });
        } else if (own !== row) {
            // Item próprio da linha (ex.: <details>, wrapper gatilho + painel).
            content = index.visibleDescendants(own.id, { includeSelf: true }).filter((node) => !inRows(node));
        } else {
            // Gatilhos e painéis irmãos: região entre este gatilho e o próximo
            // (na última linha, até o fim da faixa), fora dos gatilhos.
            const top = row.box.y + row.box.height - 1;
            const rootBox = index.node(rootId).box;
            const bottom = i + 1 < rows.length ? rows[i + 1].box.y : rootBox.y + rootBox.height;
            content = nodes.filter((node) => !inRows(node) && node.box.y >= top && node.box.y < bottom && node.box.x >= Math.min(...xs) - 8);
        }
        const text = content.reduce((sum, node) => sum + node.textLength, 0);
        if (isOpen(row) && text > 0) {
            capturedPanels++;
            panel.paragraphs += content.filter((node) => node.tag === "p" && node.textLength > 0).length;
            panel.listItems += content.filter((node) => node.tag === "li").length;
            panel.links += content.filter((node) => node.tag === "a").length;
        }
    });

    return {
        trigger: kind,
        rows: rows.length,
        openRows: rows.filter(isOpen).length,
        firstRowOpen: isOpen(rows[0]),
        capturedPanels,
        panelContent: panel,
        top: rows[0].box.y,
        bottom: groupBottom,
        x: Math.min(...xs),
        width: Math.max(...widths),
    };
}

// Texto principal que é essencialmente um número (prefixo/sufixo curtos):
// "120+", "98%", "+5 mil", "10 anos" — não "Etapa 1".
const NUMERIC_LEAD = /^\D{0,2}\d[\d.,]*\s?\S{0,5}$/;

/**
 * Itens repetidos em colunas (benefícios, ícones + texto, números), por
 * GEOMETRIA — não por classe CSS: irmãos com largura parecida (±25%), em
 * linhas regulares, todos com texto e inteiramente dentro da faixa na
 * horizontal (carrossel/marquee que transborda não conta).
 */

export function columnGroup(index, rootId) {
    const root = index.node(rootId);
    let best = null;
    for (const container of index.visibleDescendants(rootId, { includeSelf: true })) {
        const kids = index
            .visibleChildren(container.id)
            .map((id) => index.node(id))
            .filter((kid) => kid.box.height >= 16 && kid.box.width >= 40 && kid.styles.position !== "absolute" && kid.styles.position !== "fixed");
        if (kids.length < 2 || kids.length > 24) continue;
        const widths = kids.map((kid) => kid.box.width);
        const ratio = Math.max(...widths) / Math.min(...widths);
        // Grade regular (larguras parecidas) ou itens dimensionados pelo
        // conteúdo com a MESMA estrutura interna (folhas de texto e mídia).
        const shape = (kid) => {
            const inside = index.visibleDescendants(kid.id, { includeSelf: true });
            return `${inside.filter((node) => node.textLength > 0).length}|${inside.some((node) => node.media && node.media.kind !== "svg") ? 1 : 0}`;
        };
        const sameShape = new Set(kids.map(shape)).size === 1;
        if (ratio > 1.25 && !(sameShape && ratio <= 2)) continue;
        if (kids.some((kid) => kid.box.x < root.box.x - 1 || kid.box.x + kid.box.width > root.box.x + root.box.width + 1)) continue;
        const withText = kids.filter((kid) => index.visibleDescendants(kid.id, { includeSelf: true }).some((node) => node.textLength > 0));
        if (withText.length !== kids.length) continue;
        // Linhas: agrupadas pelo topo (tolerância de 8 px), em ordem.
        const sorted = [...kids].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
        const rows = [];
        for (const kid of sorted) {
            const row = rows.find((r) => Math.abs(r.y - kid.box.y) <= 8);
            if (row) row.items.push(kid);
            else rows.push({ y: kid.box.y, items: [kid] });
        }
        const columns = Math.max(...rows.map((row) => row.items.length));
        // Grade regular: só a última linha pode ter menos itens.
        if (rows.slice(0, -1).some((row) => row.items.length !== columns)) continue;
        const spanned = Math.max(...kids.map((kid) => kid.box.x + kid.box.width)) - Math.min(...kids.map((kid) => kid.box.x));
        if (spanned < root.box.width * 0.4) continue;
        // Colunas de verdade (2+ lado a lado) antes de listas empilhadas;
        // dentro de cada caso, itens de MESMA estrutura interna (componente
        // repetido) antes de irmãos heterogêneos (ex.: título + nota + grade
        // + botão empilhados acima dos cartões no mobile) — M7.8b.
        const score = (columns >= 2 ? 1e9 : 0) + (sameShape ? 1e6 : 0) + kids.length * spanned;
        if (!best || score > best.score) best = { container, kids, columns, rows: rows.length, score, sameShape, top: Math.min(...kids.map((kid) => kid.box.y)), bottom: Math.max(...kids.map((kid) => kid.box.y + kid.box.height)), spanned };
    }
    if (!best) return null;

    const facts = best.kids.map((kid) => {
        const inside = index.visibleDescendants(kid.id, { includeSelf: true });
        const sizes = inside.filter((node) => node.textLength > 0).map((node) => ({ node, size: fontSizeOf(node) }));
        const lead = sizes.sort((a, b) => b.size - a.size || a.node.id - b.node.id)[0]?.node ?? null;
        const median = (() => {
            const values = sizes.map((item) => item.size).sort((a, b) => a - b);
            // Mediana inferior: com 2 textos, o menor é a referência.
            return values.length ? values[Math.floor((values.length - 1) / 2)] : 0;
        })();
        const kidArea = area(kid.box) || 1;
        return {
            icon: inside.some((node) => (node.media?.kind === "svg" || node.media?.kind === "img") && Math.min(node.box.width, node.box.height) <= 64),
            media: inside.some((node) => ((node.media && node.media.kind !== "svg") || hasBackgroundImage(node)) && area(node.box) >= kidArea * 0.15 && Math.min(node.box.width, node.box.height) > 64),
            title: inside.some((node) => node.headingLevel) || (lead !== null && fontSizeOf(lead) >= median * 1.25 && sizes.length >= 2),
            numericLead: lead !== null && NUMERIC_LEAD.test(lead.text.trim()),
            link: inside.some((node) => node.tag === "a"),
            price: inside.some((node) => node.textLength > 0 && node.textLength < 40 && hasPriceText(node.text)),
            chars: inside.reduce((sum, node) => sum + node.textLength, 0),
        };
    });
    const count = (key) => facts.filter((fact) => fact[key]).length;
    return {
        containerId: best.container.id,
        itemIds: best.kids.map((kid) => kid.id),
        top: best.top,
        count: best.kids.length,
        columns: best.columns,
        rows: best.rows,
        itemsWithIcon: count("icon"),
        itemsWithMedia: count("media"),
        itemsWithTitle: count("title"),
        itemsWithNumericLead: count("numericLead"),
        itemsWithLink: count("link"),
        itemsWithPrice: count("price"),
        maxItemChars: Math.max(...facts.map((fact) => fact.chars)),
        // Dominância: parte do texto da faixa que está dentro dos itens.
        textShare: (() => {
            const total = index.visibleDescendants(rootId, { includeSelf: true }).reduce((sum, node) => sum + node.textLength, 0);
            return total ? Math.min(1, facts.reduce((sum, fact) => sum + fact.chars, 0) / total) : 0;
        })(),
    };
}

/**
 * Uma fileira de glifos iguais: 3+ mídias pequenas (≤ 24px) do mesmo
 * tamanho, na mesma linha e com o mesmo pai. Só presença e quantidade —
 * NUNCA uma nota (glifos podem ser decorativos).
 */
function glyphRow(index, nodes) {
    const small = nodes.filter((node) => node.media && node.box.width <= 24 && node.box.height <= 24 && node.box.width >= 6);
    const groups = new Map();
    for (const node of small) {
        const key = `${node.parent}|${Math.round(node.box.y / 3)}|${Math.round(node.box.width)}x${Math.round(node.box.height)}`;
        groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    // Tamanho do maior grupo; o limiar (≥ 3) é aplicado por quem usa.
    return Math.max(0, ...groups.values());
}

/** Círculo de avatar: quadrado 24–96px com raio ≥ metade (ou 50%/pílula). */
function avatarKind(index, node) {
    const { width, height } = node.box;
    if (Math.abs(width - height) > 2 || width < 24 || width > 96) return null;
    const radius = node.styles.borderTopLeftRadius ?? "0px";
    const round = /%$/.test(radius) ? parseFloat(radius) >= 50 : (px(radius) ?? 0) >= width / 2 - 1;
    if (!round) return null;
    const inside = index.visibleDescendants(node.id, { includeSelf: true });
    if (inside.some((item) => item.media && item.media.kind !== "svg") || hasBackgroundImage(node)) return "image";
    const chars = inside.reduce((sum, item) => sum + item.textLength, 0);
    return chars >= 1 && chars <= 3 ? "initials" : null;
}

/**
 * Depoimentos/avaliações (M7.8b): o grupo de colunas da faixa cujos itens
 * têm, TODOS, a hierarquia citação → autoria — um texto longo dominante
 * (citação), sem título acima dele, seguido de 1–3 linhas curtas (autoria) —
 * sem mídia grande nem preço, e em ≥ 75% deles uma pista auxiliar
 * (avatar circular, fileira de glifos, citação em itálico ou divisor).
 * Nada de texto literal: só geometria, estilos e comprimentos.
 */
export function testimonialGroup(index, rootId, group) {
    if (!group || group.count < 2 || group.itemsWithPrice > 0) return null;
    const bandBackground = parseColor(index.node(rootId).styles.backgroundColor);
    const facts = [];
    for (const id of group.itemIds) {
        const item = index.node(id);
        const inside = index.visibleDescendants(id);
        const texts = inside.filter((node) => node.textLength > 0);
        const total = texts.reduce((sum, node) => sum + node.textLength, 0);
        const quote = [...texts].sort((a, b) => b.textLength - a.textLength || a.id - b.id)[0];
        if (!quote || quote.textLength < 60 || quote.textLength < total * 0.5) return null;
        const quoteBottom = quote.box.y + quote.box.height;
        // Título acima do texto longo = cartão editorial/produto, não citação.
        if (texts.some((node) => node.id !== quote.id && node.box.y + node.box.height <= quote.box.y + 1 && (node.headingLevel || node.textLength > 40))) return null;
        const author = texts.filter((node) => node.id !== quote.id && node.box.y >= quoteBottom - 1 && node.textLength <= 40 && node.tag !== "a" && node.tag !== "button");
        const avatarNodes = inside.filter((node) => node.box.y >= quoteBottom - 1).map((node) => avatarKind(index, node)).filter(Boolean);
        const avatar = avatarNodes.includes("image") ? "image" : avatarNodes.includes("initials") ? "initials" : "none";
        // Linhas de autoria = textos curtos abaixo da citação, fora do avatar.
        const avatarText = new Set(inside.filter((node) => avatarKind(index, node)).flatMap((node) => index.visibleDescendants(node.id, { includeSelf: true }).map((child) => child.id)));
        const lines = author.filter((node) => !avatarText.has(node.id)).length;
        if (lines < 1 || lines > 3) return null;
        // Mídia grande (foto de equipe, notícia, produto) desqualifica.
        const itemArea = area(item.box) || 1;
        if (inside.some((node) => ((node.media && node.media.kind !== "svg") || hasBackgroundImage(node)) && area(node.box) >= itemArea * 0.15 && Math.min(node.box.width, node.box.height) > 64)) return null;
        const glyphs = glyphRow(index, inside);
        const divider = inside.some((node) => node.textLength === 0 && !node.media && node.box.height <= 2 && node.box.height > 0 && node.box.width >= item.box.width * 0.5);
        const italic = quote.styles.fontStyle === "italic";
        const background = parseColor(item.styles.backgroundColor);
        const surface = (isOpaque(background) && toHex(background) !== (isOpaque(bandBackground) ? toHex(bandBackground) : null)) || (px(item.styles.borderTopWidth) ?? 0) >= 1 || (item.styles.boxShadow ?? "none") !== "none";
        facts.push({ lines, avatar, glyphs, divider, italic, surface, chars: total, cue: avatar !== "none" || glyphs >= 3 || italic || divider });
    }
    if (facts.filter((fact) => fact.cue).length < facts.length * 0.75) return null;
    const uniform = (values) => (values.every((value) => value === values[0]) ? values[0] : null);
    return {
        count: facts.length,
        columns: group.columns,
        rows: group.rows,
        top: group.top,
        itemsWithAuthor: facts.length,
        authorLines: uniform(facts.map((fact) => fact.lines)),
        avatar: { image: facts.filter((f) => f.avatar === "image").length, initials: facts.filter((f) => f.avatar === "initials").length, none: facts.filter((f) => f.avatar === "none").length },
        glyphs: { itemsWithRow: facts.filter((f) => f.glyphs >= 3).length, perItem: facts.every((f) => f.glyphs >= 3) ? uniform(facts.map((f) => f.glyphs)) : null },
        itemsWithDivider: facts.filter((f) => f.divider).length,
        quoteStyle: facts.every((f) => f.italic) ? "italic" : facts.every((f) => !f.italic) ? "normal" : "mixed",
        cardSurface: facts.every((f) => f.surface),
        maxItemChars: Math.max(...facts.map((f) => f.chars)),
    };
}

/** Maior número de colunas lado a lado entre contêineres da subárvore. */
function sideBySide(index, rootId, bandWidth) {
    let best = { columns: 1, containerId: null };
    const span = visibleSpan(index, index.node(rootId).box);
    for (const container of index.visibleDescendants(rootId, { includeSelf: true })) {
        const kids = index
            .visibleChildren(container.id)
            .map((id) => index.node(id))
            .filter((kid) => kid.box.width >= bandWidth * 0.15 && kid.box.height >= 16 && inVisibleSpan(span, kid.box));
        if (kids.length < 2) continue;
        // Mesma linha = sobreposição vertical com o primeiro item do topo
        // (cobre itens centralizados verticalmente, como imagem + texto).
        const top = [...kids].sort((a, b) => a.box.y - b.box.y || a.id - b.id)[0];
        const row = kids.filter((kid) => {
            const overlap = Math.min(kid.box.y + kid.box.height, top.box.y + top.box.height) - Math.max(kid.box.y, top.box.y);
            return overlap >= Math.min(kid.box.height, top.box.height) * 0.5;
        });
        const disjoint = row.every((kid, i) =>
            row.every((other, j) => i === j || kid.box.x + kid.box.width <= other.box.x + 1 || other.box.x + other.box.width <= kid.box.x + 1)
        );
        if (disjoint && row.length > best.columns) best = { columns: row.length, containerId: container.id };
    }
    return best;
}

function unionBox(boxes) {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x, y, width: right - x, height: bottom - y };
}

/**
 * Relação geométrica entre a mídia principal da faixa e o bloco de texto
 * (títulos, parágrafos e botões fora da mídia). Só geometria: nenhuma
 * classe, texto ou atributo do site entra na decisão.
 *
 * - `mediaCount`: mídias proeminentes (≥ 5% da faixa, não de fundo).
 * - `arrangement`: "side-by-side" (lado a lado, sem sobreposição),
 *   "stacked" (uma acima da outra), "overlap" (texto sobre a mídia) ou
 *   null (sem texto ou relação indefinida).
 */
function mediaTextSplit(index, root, nodes, media, buttonIds) {
    const bandArea = area(root.box) || 1;
    const prominent = media
        .filter((item) => item.kind !== "background" && area(item.box) >= bandArea * 0.05)
        .sort((a, b) => area(b.box) - area(a.box) || a.id - b.id);
    if (!prominent.length) return null;
    const main = prominent[0];
    const textNodes = nodes.filter(
        (node) =>
            (node.headingLevel || (node.tag === "p" && node.textLength > 0) || buttonIds.has(node.id)) &&
            !index.isInside(node.id, main.id)
    );
    const base = { mediaCount: prominent.length, aspectRatio: Math.round((main.box.width / Math.max(main.box.height, 1)) * 1000) / 1000 };
    const text = unionBox(textNodes.map((node) => node.box));
    if (!text) return { ...base, arrangement: null, mediaPosition: null, mediaWidthShare: null, textVertical: null, gapPx: null };

    const m = main.box;
    const shared = overlapArea(m, text) / Math.max(1, Math.min(area(m), area(text)));
    let arrangement = null;
    let mediaPosition = null;
    let gapPx = null;
    if (shared > 0.05) {
        arrangement = "overlap";
    } else {
        const verticalOverlap = Math.min(m.y + m.height, text.y + text.height) - Math.max(m.y, text.y);
        const leftOf = m.x + m.width <= text.x + 2;
        const rightOf = text.x + text.width <= m.x + 2;
        if (verticalOverlap >= Math.min(m.height, text.height) * 0.5 && (leftOf || rightOf)) {
            arrangement = "side-by-side";
            mediaPosition = leftOf ? "left" : "right";
            gapPx = Math.round(leftOf ? text.x - (m.x + m.width) : m.x - (text.x + text.width));
        } else if (m.y + m.height <= text.y + 2) {
            arrangement = "stacked";
            mediaPosition = "top";
            gapPx = Math.round(text.y - (m.y + m.height));
        } else if (text.y + text.height <= m.y + 2) {
            arrangement = "stacked";
            mediaPosition = "bottom";
            gapPx = Math.round(m.y - (text.y + text.height));
        }
    }
    const span = unionBox([m, text]);
    const center = (text.y + text.height / 2 - m.y) / (m.height || 1);
    return {
        ...base,
        mediaId: main.id,
        arrangement,
        mediaPosition,
        mediaWidthShare: Math.round((m.width / (span.width || 1)) * 1000) / 1000,
        textVertical: arrangement === "side-by-side" ? (center < 0.38 ? "top" : center > 0.62 ? "bottom" : "middle") : null,
        gapPx,
        textBox: text,
    };
}

const FIELD_TAGS = new Set(["input", "select", "textarea"]);
const NON_FIELD_INPUTS = new Set(["submit", "button", "image", "reset", "hidden"]);

/**
 * Formulários visíveis da faixa: campos de e-mail, consentimento
 * (checkbox), outros campos e controles de envio. O tipo vem do atributo
 * `type` capturado (no DOM real, `button` sem tipo é "submit").
 */
function formFacts(index, nodes) {
    const forms = nodes
        .filter((node) => node.tag === "form")
        .map((form) => {
            const inside = index.visibleDescendants(form.id);
            const fields = inside.filter((node) => FIELD_TAGS.has(node.tag) && !(node.tag === "input" && NON_FIELD_INPUTS.has(node.attrs.type ?? "text")));
            const typeOf = (node) => (node.tag === "input" ? node.attrs.type ?? "text" : node.tag);
            const email = fields.filter((node) => typeOf(node) === "email");
            const consent = fields.filter((node) => typeOf(node) === "checkbox");
            const submits = inside.filter(
                (node) =>
                    (node.tag === "button" && (node.attrs.type ?? "submit") === "submit") ||
                    (node.tag === "input" && ["submit", "image"].includes(node.attrs.type ?? ""))
            );
            let layout = null;
            if (email.length && submits.length) {
                const a = email[0].box;
                const b = submits[0].box;
                const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                layout = overlap >= Math.min(a.height, b.height) * 0.5 ? "inline" : "stacked";
            }
            return {
                id: form.id,
                emailFields: email.length,
                consentFields: consent.length,
                otherFields: fields.length - email.length - consent.length,
                submits: submits.length,
                layout,
            };
        });
    const formIds = forms.map((form) => form.id);
    const loose = nodes.filter(
        (node) =>
            FIELD_TAGS.has(node.tag) &&
            !(node.tag === "input" && NON_FIELD_INPUTS.has(node.attrs.type ?? "text")) &&
            !formIds.some((formId) => index.isInside(node.id, formId))
    ).length;
    return { forms, fieldsOutsideForms: loose };
}

/**
 * Características estruturais de uma faixa.
 * @param {import("./dom-index.mjs").DomIndex} index
 * @param {number} bandId
 */
export function bandFeatures(index, bandId) {
    const root = index.node(bandId);
    const bandArea = area(root.box) || 1;
    const nodes = index.visibleDescendants(bandId, { includeSelf: true });

    // Tipografia visível (texto pode estar em descendentes inline).
    const headings = nodes
        .filter((node) => node.headingLevel)
        .map((node) => {
            const typography = headingTypography(index, node);
            return { id: node.id, level: node.headingLevel, size: typography.size, chars: typography.chars };
        });
    const grouped = columnGroup(index, bandId);
    const buttons = nodes.filter((node) => isButtonLike(index, node));
    const buttonIds = new Set(buttons.map((node) => node.id));
    const links = nodes.filter((node) => node.tag === "a" && !buttonIds.has(node.id));
    const inputs = nodes.filter((node) => ["input", "select", "textarea"].includes(node.tag));
    const paragraphs = nodes.filter((node) => node.tag === "p" && node.textLength > 0);

    const media = [];
    let icons = 0;
    for (const node of nodes) {
        const isMedia = node.media && node.media.kind !== "svg";
        const background = node.id !== bandId && hasBackgroundImage(node);
        const svg = node.media?.kind === "svg";
        if (!isMedia && !background && !svg) continue;
        const small = Math.min(node.box.width, node.box.height) < 48 || area(node.box) < bandArea * 0.01;
        if (svg && small) {
            icons++;
            continue;
        }
        if (small) {
            icons++;
            continue;
        }
        media.push({ id: node.id, box: node.box, kind: background ? "background" : node.media.kind });
    }

    const rootBackgroundImage = hasBackgroundImage(root);
    const coverMedia =
        rootBackgroundImage ||
        media.some((item) => overlapArea(item.box, root.box) >= bandArea * 0.6);

    const textTally = new ColorTally();
    const headingTally = new ColorTally();
    const alignTally = new Map();
    for (const node of nodes) {
        if (node.textLength <= 0) continue;
        textTally.add(parseColor(node.styles.color), node.textLength);
        // Cor de título: só texto próprio do título (comportamento anterior).
        // Títulos com texto em descendentes podem ter várias cores (destaque);
        // decidir a cor de esquema nesses casos é outro problema (TD-012).
        if (node.headingLevel) headingTally.add(parseColor(node.styles.color), node.textLength);
        const align = node.styles.textAlign === "start" ? "left" : node.styles.textAlign;
        alignTally.set(align, (alignTally.get(align) ?? 0) + node.textLength);
    }
    const textAlign = [...alignTally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;

    const background = index.effectiveBackground(bandId);
    const ownBackground = parseColor(root.styles.backgroundColor);
    const { forms, fieldsOutsideForms } = formFacts(index, nodes);

    return {
        id: bandId,
        tag: root.tag,
        role: root.role,
        box: root.box,
        headings,
        maxHeadingSize: Math.max(0, ...headings.map((heading) => heading.size)),
        hasH1: headings.some((heading) => heading.level === 1),
        buttons: buttons.map((node) => node.id),
        links: links.length,
        inputs: inputs.map((node) => (node.attrs.type ?? node.tag).toLowerCase()),
        hasEmailInput: inputs.some((node) => node.attrs.type === "email"),
        paragraphs: paragraphs.length,
        textChars: nodes.reduce((sum, node) => sum + node.textLength, 0),
        media,
        icons,
        coverMedia,
        backgroundImage: rootBackgroundImage,
        background: {
            hex: background.color ? toHex(background.color) : null,
            image: background.image,
            gradient: background.gradient,
            own: isOpaque(ownBackground) || rootBackgroundImage || hasGradient(root),
        },
        textColor: textTally.sorted()[0]?.hex ?? null,
        // Cor dos títulos representa melhor a cor de texto do esquema.
        headingColor: headingTally.sorted()[0]?.hex ?? null,
        textAlign,
        hasNav: nodes.some((node) => node.tag === "nav" || node.role === "navigation"),
        sticky: [root, ...index.visibleChildren(bandId).map((id) => index.node(id))].some(
            (node) => node.styles.position === "sticky" || node.styles.position === "fixed"
        ),
        repeated: findRepeatedGroup(index, bandId),
        disclosure: disclosureGroup(index, bandId),
        columnGroup: grouped,
        testimonials: testimonialGroup(index, bandId, grouped),
        columns: sideBySide(index, bandId, root.box.width),
        split: mediaTextSplit(index, root, nodes, media, buttonIds),
        forms,
        fieldsOutsideForms,
        paddingTop: px(root.styles.paddingTop),
        paddingBottom: px(root.styles.paddingBottom),
    };
}
