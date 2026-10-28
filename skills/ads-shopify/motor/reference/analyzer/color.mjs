/**
 * Utilidades de cor para valores de estilo computado (dados não confiáveis).
 * Só aceita os formatos que o Chromium produz; o resto vira null.
 */

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */

const RGB = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+)(%?))?\s*\)$/i;
const HEX = /^#([0-9a-f]{6})$/i;

/**
 * @param {unknown} value
 * @returns {Rgba | null}
 */
export function parseColor(value) {
    if (typeof value !== "string" || value.length > 64) return null;
    const text = value.trim();

    const hex = HEX.exec(text);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }

    const match = RGB.exec(text);
    if (!match) return null;
    const [r, g, b] = [match[1], match[2], match[3]].map((v) => Math.min(255, Math.round(Number(v))));
    let a = match[4] === undefined ? 1 : Number(match[4]);
    if (match[5] === "%") a /= 100;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

/** Cor opaca o suficiente para contar como fundo/texto visível. */
export function isOpaque(color) {
    return Boolean(color) && color.a >= 0.5;
}

/** @param {Rgba} color */
export function toHex(color) {
    return `#${[color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** @param {string} hex */
export function hexToRgb(hex) {
    return parseColor(hex);
}

/** Luminância relativa (WCAG). */
export function luminance(color) {
    const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(a, b) {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

export function distance(a, b) {
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Acumulador de cores com peso; une tons muito próximos (distância < 10).
 */
export class ColorTally {
    constructor() {
        /** @type {Array<{ hex: string, color: Rgba, weight: number, count: number }>} */
        this.entries = [];
    }

    add(color, weight) {
        if (!isOpaque(color) || !(weight > 0)) return;
        const near = this.entries.find((entry) => distance(entry.color, color) < 10);
        if (near) {
            near.weight += weight;
            near.count += 1;
        } else {
            this.entries.push({ hex: toHex(color), color: { ...color, a: 1 }, weight, count: 1 });
        }
    }

    /** Ordem determinística: peso desc, depois hex. */
    sorted() {
        return [...this.entries].sort((a, b) => b.weight - a.weight || (a.hex < b.hex ? -1 : 1));
    }

    total() {
        return this.entries.reduce((sum, entry) => sum + entry.weight, 0);
    }
}
