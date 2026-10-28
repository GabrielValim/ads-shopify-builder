/**
 * Pintura de fundo de uma faixa medida no SCREENSHOT (capturado e com hash
 * conferido): cor sólida, gradiente linear ou "complexa".
 *
 * Só cores agregadas por célula entram no resultado — nenhum pixel, forma ou
 * recorte da imagem da referência é copiado. Áreas de conteúdo (textos e
 * botões) são excluídas da amostra.
 *
 * Critérios FIXOS (definidos antes de qualquer medição da fixture):
 *  - grade 24×12 sobre a faixa; célula válida se ≥ 50% dos pixels estão
 *    fora das áreas de conteúdo;
 *  - sólida: ≥ 90% das células a ΔE ≤ 6 da cor média;
 *  - gradiente: o melhor ajuste linear entre 4 eixos CSS (0°, 45°, 90°, 135°;
 *    o sentido fica na ordem das cores — θ e θ+180° são o mesmo gradiente)
 *    deixa ≥ 70% das células a ΔE ≤ 12 e as pontas distam ΔE ≥ 10;
 *  - qualquer outro caso: "complex" (nenhum gradiente é inventado).
 */

import { deltaE } from "../compare/image-ops.mjs";

export const PAINT_GRID = { cols: 24, rows: 12 };
export const SOLID_TOLERANCE = 6;
export const SOLID_SHARE = 0.9;
export const GRADIENT_TOLERANCE = 12;
export const GRADIENT_SHARE = 0.7;
export const GRADIENT_MIN_SPAN = 10;
const ANGLES = [0, 45, 90, 135];

const round3 = (value) => Math.round(value * 1000) / 1000;
const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

function inside(x, y, boxes) {
    return boxes.some((b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
}

/** Cor média de cada célula válida, com o centro relativo (0..1). */
function sampleCells(image, band, exclude) {
    const cells = [];
    const { cols, rows } = PAINT_GRID;
    const x0 = Math.max(0, Math.floor(band.x));
    const y0 = Math.max(0, Math.floor(band.y));
    const x1 = Math.min(image.width, Math.floor(band.x + band.width));
    const y1 = Math.min(image.height, Math.floor(band.y + band.height));
    if (x1 - x0 < cols || y1 - y0 < rows) return cells;
    const cw = (x1 - x0) / cols;
    const ch = (y1 - y0) / rows;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const cx0 = Math.floor(x0 + col * cw);
            const cy0 = Math.floor(y0 + row * ch);
            const cx1 = Math.floor(x0 + (col + 1) * cw);
            const cy1 = Math.floor(y0 + (row + 1) * ch);
            let r = 0, g = 0, b = 0, n = 0, total = 0;
            // Amostragem a cada 2 px: suficiente para uma média de célula.
            for (let y = cy0; y < cy1; y += 2) {
                for (let x = cx0; x < cx1; x += 2) {
                    total++;
                    if (inside(x, y, exclude)) continue;
                    const i = (y * image.width + x) * 4;
                    r += image.data[i];
                    g += image.data[i + 1];
                    b += image.data[i + 2];
                    n++;
                }
            }
            if (!total || n < total * 0.5) continue;
            cells.push({ u: (col + 0.5) / cols, v: (row + 0.5) / rows, color: { r: r / n, g: g / n, b: b / n } });
        }
    }
    return cells;
}

/** Posição de cada célula ao longo da linha do gradiente CSS de `angle`. */
function positions(cells, angle, aspect) {
    const rad = (angle * Math.PI) / 180;
    // CSS: 0deg = para cima, sentido horário; caixa w×h com w/h = aspect.
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const length = Math.abs(aspect * dx) + Math.abs(dy);
    return cells.map((cell) => ((cell.u - 0.5) * aspect * dx + (cell.v - 0.5) * dy) / length + 0.5);
}

function fitLinear(cells, t) {
    const n = cells.length;
    const mt = t.reduce((s, v) => s + v, 0) / n;
    const vt = t.reduce((s, v) => s + (v - mt) ** 2, 0);
    const channel = (key) => {
        const mc = cells.reduce((s, c) => s + c.color[key], 0) / n;
        const cov = cells.reduce((s, c, i) => s + (t[i] - mt) * (c.color[key] - mc), 0);
        const slope = vt > 1e-12 ? cov / vt : 0;
        return { a: mc - slope * mt, slope };
    };
    const fit = { r: channel("r"), g: channel("g"), b: channel("b") };
    const at = (value) => ({ r: fit.r.a + fit.r.slope * value, g: fit.g.a + fit.g.slope * value, b: fit.b.a + fit.b.slope * value });
    const residuals = cells.map((cell, i) => deltaE(cell.color, at(t[i])));
    return { start: at(0), end: at(1), residuals };
}

/**
 * @param {import("../compare/png.mjs").RgbaImage | null} image screenshot do viewport
 * @param {{ x: number, y: number, width: number, height: number }} band caixa da faixa
 * @param {Array<{ x: number, y: number, width: number, height: number }>} exclude áreas de conteúdo
 * @returns {null | { kind: "solid" | "gradient" | "complex", angleDeg: number | null, stops: Array<{ hex: string, position: number }>, fit: { cells: number, withinTolerance: number, meanDeltaE: number } }}
 */
export function measureBackgroundPaint(image, band, exclude = []) {
    if (!image) return null;
    const cells = sampleCells(image, band, exclude);
    if (cells.length < PAINT_GRID.cols * PAINT_GRID.rows * 0.25) return null;

    const n = cells.length;
    const mean = { r: 0, g: 0, b: 0 };
    for (const cell of cells) for (const key of ["r", "g", "b"]) mean[key] += cell.color[key] / n;
    const spread = cells.map((cell) => deltaE(cell.color, mean));
    const solidShare = spread.filter((value) => value <= SOLID_TOLERANCE).length / n;
    if (solidShare >= SOLID_SHARE) {
        return {
            kind: "solid",
            angleDeg: null,
            stops: [{ hex: hex(mean), position: 0 }],
            fit: { cells: n, withinTolerance: round3(solidShare), meanDeltaE: round3(spread.reduce((s, v) => s + v, 0) / n) },
        };
    }

    const aspect = band.width / Math.max(band.height, 1);
    let best = null;
    for (const angle of ANGLES) {
        const fitted = fitLinear(cells, positions(cells, angle, aspect));
        const share = fitted.residuals.filter((value) => value <= GRADIENT_TOLERANCE).length / n;
        const meanResidual = fitted.residuals.reduce((s, v) => s + v, 0) / n;
        if (!best || meanResidual < best.meanResidual - 1e-9) best = { angle, ...fitted, share, meanResidual };
    }
    const span = deltaE(best.start, best.end);
    const fit = { cells: n, withinTolerance: round3(best.share), meanDeltaE: round3(best.meanResidual) };
    if (best.share >= GRADIENT_SHARE && span >= GRADIENT_MIN_SPAN) {
        return {
            kind: "gradient",
            angleDeg: best.angle,
            stops: [
                { hex: hex(best.start), position: 0 },
                { hex: hex(best.end), position: 1 },
            ],
            fit,
        };
    }
    return { kind: "complex", angleDeg: null, stops: [], fit };
}
