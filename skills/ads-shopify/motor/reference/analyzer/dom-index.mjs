/**
 * Índice de navegação sobre um snapshot de DOM (dom-<viewport>.json já
 * validado). Somente leitura; nenhum conteúdo é interpretado como código.
 */

import { isOpaque, parseColor } from "./color.mjs";

const px = (value) => {
    const number = Number.parseFloat(String(value ?? ""));
    return Number.isFinite(number) ? number : null;
};

export { px };

const PRICE = /(?:^|\s)(?:[A-Z]{0,3}\$|€|£|¥|R\$|USD|BRL|EUR)\s?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})?(?:\s|$)|\d+[.,]\d{2}\s?(?:€|zł|kr|R\$)/;

export class DomIndex {
    /** @param {import("../capture/dom-schema.mjs").DomSnapshot} snapshot */
    constructor(snapshot) {
        this.snapshot = snapshot;
        this.nodes = snapshot.nodes;
        this.viewport = snapshot.viewport;
        this.pageHeight = snapshot.document.scroll.height;
        /** @type {Map<number, number[]>} */
        this.childMap = new Map();
        for (const node of this.nodes) {
            if (node.parent === null) continue;
            if (!this.childMap.has(node.parent)) this.childMap.set(node.parent, []);
            this.childMap.get(node.parent).push(node.id);
        }
        this._backgrounds = new Map();
    }

    node(id) {
        return this.nodes[id];
    }

    children(id) {
        return this.childMap.get(id) ?? [];
    }

    visibleChildren(id) {
        return this.children(id).filter((child) => this.nodes[child].visible);
    }

    /** Descendentes em pré-ordem (ordem do documento). */
    *descendants(id, { includeSelf = false } = {}) {
        if (includeSelf) yield this.nodes[id];
        const stack = [...this.children(id)].reverse();
        while (stack.length) {
            const next = stack.pop();
            yield this.nodes[next];
            const kids = this.children(next);
            for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
    }

    visibleDescendants(id, options) {
        return [...this.descendants(id, options)].filter((node) => node.visible);
    }

    ancestors(id) {
        const result = [];
        for (let parent = this.nodes[id].parent; parent !== null; parent = this.nodes[parent].parent) {
            result.push(this.nodes[parent]);
        }
        return result;
    }

    isInside(id, ancestorId) {
        return id === ancestorId || this.ancestors(id).some((node) => node.id === ancestorId);
    }

    /** Cor de fundo efetiva: primeiro ancestral (ou o próprio) com fundo opaco. */
    effectiveBackground(id) {
        if (this._backgrounds.has(id)) return this._backgrounds.get(id);
        let result = { color: null, image: false, gradient: false, sourceId: null };
        for (const node of [this.nodes[id], ...this.ancestors(id)]) {
            const color = parseColor(node.styles.backgroundColor);
            if (hasBackgroundImage(node) || hasGradient(node)) {
                result = {
                    color: isOpaque(color) ? color : null,
                    image: hasBackgroundImage(node),
                    gradient: hasGradient(node),
                    sourceId: node.id,
                };
                break;
            }
            if (isOpaque(color)) {
                result = { color, image: false, gradient: false, sourceId: node.id };
                break;
            }
        }
        this._backgrounds.set(id, result);
        return result;
    }

    hasOwnText(node) {
        return node.visible && node.textLength > 0;
    }
}

export function hasBackgroundImage(node) {
    return /url\(/i.test(node.styles?.backgroundImage ?? "");
}

export function hasGradient(node) {
    return /gradient\(/i.test(node.styles?.backgroundImage ?? "");
}

export function hasPriceText(text) {
    return PRICE.test(` ${text} `);
}

export function area(box) {
    return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Interseção entre duas caixas (área). */
export function overlapArea(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

const FLEX_DISPLAYS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

/**
 * APARÊNCIA de botão: controle interativo (link, botão, role=button, input
 * submit) com rótulo curto VISÍVEL, preenchido ou com borda, altura típica
 * de botão e rótulo afastado das bordas — por padding OU por uma caixa de
 * tamanho fixo que centraliza o rótulo (flex/grid centralizado nos dois
 * eixos com folga vertical, ou line-height ≈ altura com texto
 * centralizado). Fundo, cursor ou tamanho sozinhos não bastam.
 */
export function hasButtonAppearance(index, node) {
    if (!node.visible) return false;
    const interactive =
        node.tag === "button" ||
        node.tag === "a" ||
        node.role === "button" ||
        (node.tag === "input" && ["submit", "button"].includes(node.attrs.type ?? ""));
    if (!interactive) return false;

    const textLength = node.textLength || index.visibleDescendants(node.id).reduce((sum, child) => sum + child.textLength, 0);
    if (textLength < 1 || textLength > 40) return false;
    if (node.box.height < 28 || node.box.height > 90 || node.box.width < 48) return false;

    const background = parseColor(node.styles.backgroundColor);
    const border = px(node.styles.borderTopWidth) ?? 0;
    const borderStyle = node.styles.borderTopStyle ?? "none";
    const filled = isOpaque(background);
    const outlined = border >= 1 && borderStyle !== "none";
    if (!filled && !outlined) return false;
    const padded = (px(node.styles.paddingLeft) ?? 0) >= 8 || (px(node.styles.paddingTop) ?? 0) >= 6;
    if (padded) return true;

    const lineHeight = px(node.styles.lineHeight) ?? (px(node.styles.fontSize) ?? 16) * 1.2;
    const flexCentered =
        FLEX_DISPLAYS.has(node.styles.display) &&
        node.styles.alignItems === "center" &&
        ["center", "space-around", "space-evenly"].includes(node.styles.justifyContent) &&
        node.box.height >= lineHeight + 12;
    const lineCentered = ["center", "-webkit-center"].includes(node.styles.textAlign) && lineHeight >= node.box.height - 4 && node.box.height >= 28;
    return flexCentered || lineCentered;
}

/**
 * Botão de CHAMADA PARA AÇÃO: aparência de botão, exceto gatilhos de
 * expansão (aria-expanded: acordeão, menu), que são controles de estado.
 * Quem procura gatilhos (ex.: disclosureGroup) usa hasButtonAppearance.
 */
export function isButtonLike(index, node) {
    if (node.attrs.ariaExpanded === "true" || node.attrs.ariaExpanded === "false") return false;
    return hasButtonAppearance(index, node);
}

/**
 * Tipografia VISÍVEL de um título: o texto pode estar no próprio elemento
 * ou distribuído em descendentes inline (span, strong, em, a…). Soma o
 * texto visível (cada nó traz só o próprio texto: sem duplicação), ignora
 * nós invisíveis, transparentes, de mídia ou sob aria-hidden, e escolhe o
 * tamanho DOMINANTE ponderado por caracteres (empate: o maior) — um selo
 * ou palavra pequena não domina a medida.
 * @returns {{ chars: number, size: number, family: string | null, weight: string | null, lineHeight: number | null, letterSpacing: string | null, transform: string | null, color: string | null }}
 */
export function headingTypography(index, node) {
    const hiddenBelow = (part) => {
        for (let current = part; current && current.id !== node.id; current = index.node(current.parent)) {
            if (current.attrs.ariaHidden === "true" || current.styles.opacity === "0") return true;
        }
        return false;
    };
    const parts = index
        .visibleDescendants(node.id, { includeSelf: true })
        .filter((part) => part.textLength > 0 && !part.media && !hiddenBelow(part));
    if (!parts.length) {
        return { chars: 0, size: px(node.styles.fontSize) ?? 0, family: node.styles.fontFamily ?? null, weight: node.styles.fontWeight ?? null, lineHeight: px(node.styles.lineHeight), letterSpacing: node.styles.letterSpacing ?? null, transform: node.styles.textTransform ?? null, color: node.styles.color ?? null };
    }
    const bySize = new Map();
    for (const part of parts) {
        const size = px(part.styles.fontSize) ?? 0;
        bySize.set(size, (bySize.get(size) ?? 0) + part.textLength);
    }
    const size = [...bySize.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const lead = parts.filter((part) => (px(part.styles.fontSize) ?? 0) === size).sort((a, b) => b.textLength - a.textLength || a.id - b.id)[0];
    return {
        chars: parts.reduce((sum, part) => sum + part.textLength, 0),
        size,
        family: lead.styles.fontFamily ?? null,
        weight: lead.styles.fontWeight ?? null,
        lineHeight: px(lead.styles.lineHeight),
        letterSpacing: lead.styles.letterSpacing ?? null,
        transform: lead.styles.textTransform ?? null,
        color: lead.styles.color ?? null,
    };
}

/** Título (h1–h6) que contém o nó, inclusive o próprio; ou null. */
export function headingOf(index, node) {
    if (node.headingLevel) return node;
    return index.ancestors(node.id).find((ancestor) => ancestor.headingLevel) ?? null;
}

/** Tamanho do texto (px) e se é "heading-like". */
export function fontSizeOf(node) {
    return px(node.styles.fontSize) ?? 0;
}

/**
 * Chave estrutural para casar o mesmo elemento entre viewports:
 * caminho de tag#id.classes a partir da raiz + ordinal entre irmãos iguais.
 */
export function pathKeys(index) {
    const keys = new Map();
    const signature = (node) => {
        const id = node.attrs.id ? `#${node.attrs.id}` : "";
        const cls = node.attrs.class ? `.${node.attrs.class.split(/\s+/).sort().join(".")}` : "";
        return `${node.tag}${id}${cls}`;
    };
    for (const node of index.nodes) {
        if (node.parent === null) {
            keys.set(node.id, signature(node));
            continue;
        }
        const siblings = index.children(node.parent);
        const own = signature(node);
        let ordinal = 0;
        for (const sibling of siblings) {
            if (sibling === node.id) break;
            if (signature(index.nodes[sibling]) === own) ordinal++;
        }
        keys.set(node.id, `${keys.get(node.parent)}>${own}:${ordinal}`);
    }
    return keys;
}
