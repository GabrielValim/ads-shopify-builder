/**
 * Operações de imagem determinísticas para a comparação visual.
 */

import { RgbaImage } from "./png.mjs";

export function crop(image, box) {
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const right = Math.min(image.width, Math.floor(box.x + box.width));
    const bottom = Math.min(image.height, Math.floor(box.y + box.height));
    if (right - x < 1 || bottom - y < 1) return null;
    const out = new RgbaImage(right - x, bottom - y);
    for (let row = 0; row < out.height; row++) {
        const start = ((y + row) * image.width + x) * 4;
        out.data.set(image.data.subarray(start, start + out.width * 4), row * out.width * 4);
    }
    return out;
}

/** Reamostragem por média de área (reduz) ou vizinho mais próximo (amplia). */
export function resize(image, width, height) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    const out = new RgbaImage(width, height);
    const sx = image.width / width;
    const sy = image.height / height;
    for (let ty = 0; ty < height; ty++) {
        const y0 = Math.floor(ty * sy);
        const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((ty + 1) * sy)));
        for (let tx = 0; tx < width; tx++) {
            const x0 = Math.floor(tx * sx);
            const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((tx + 1) * sx)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * image.width + x) * 4;
                    r += image.data[i];
                    g += image.data[i + 1];
                    b += image.data[i + 2];
                    n++;
                }
            }
            const o = (ty * width + tx) * 4;
            out.data[o] = r / n;
            out.data[o + 1] = g / n;
            out.data[o + 2] = b / n;
            out.data[o + 3] = 255;
        }
    }
    return out;
}

/** Cor dominante (moda quantizada em 4 bits por canal). */
export function dominantColor(image) {
    const buckets = new Map();
    const step = Math.max(1, Math.floor((image.width * image.height) / 200_000));
    for (let p = 0; p < image.width * image.height; p += step) {
        const i = p * 4;
        const key = ((image.data[i] >> 4) << 8) | ((image.data[i + 1] >> 4) << 4) | (image.data[i + 2] >> 4);
        const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bucket.n++;
        bucket.r += image.data[i];
        bucket.g += image.data[i + 1];
        bucket.b += image.data[i + 2];
        buckets.set(key, bucket);
    }
    const [best] = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]);
    const { n, r, g, b } = best[1];
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), share: n / Math.ceil((image.width * image.height) / step) };
}

export function toHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function toLab({ r, g, b }) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** Diferença de cor CIE76 (ΔE): < 2 imperceptível; > 10 claramente diferente. */
export function deltaE(a, b) {
    const [l1, a1, b1] = toLab(a);
    const [l2, a2, b2] = toLab(b);
    return Math.round(Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) * 100) / 100;
}

function luminanceGrid(image) {
    const values = new Float64Array(image.width * image.height);
    for (let p = 0; p < values.length; p++) {
        const i = p * 4;
        values[p] = 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
    }
    return values;
}

function gradients(image) {
    const lum = luminanceGrid(image);
    const out = new Float64Array(lum.length);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const i = y * image.width + x;
            const dx = x + 1 < image.width ? lum[i + 1] - lum[i] : 0;
            const dy = y + 1 < image.height ? lum[i + image.width] - lum[i] : 0;
            out[i] = Math.sqrt(dx * dx + dy * dy);
        }
    }
    return out;
}

function pearson(a, b, mask) {
    let n = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) if (!mask || !mask[i]) { sa += a[i]; sb += b[i]; n++; }
    if (!n) return null;
    const ma = sa / n;
    const mb = sb / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) {
        if (mask && mask[i]) continue;
        cov += (a[i] - ma) * (b[i] - mb);
        va += (a[i] - ma) ** 2;
        vb += (b[i] - mb) ** 2;
    }
    if (va < 1e-9 && vb < 1e-9) return 1;
    if (va < 1e-9 || vb < 1e-9) return 0;
    return cov / Math.sqrt(va * vb);
}

/**
 * Similaridade entre dois recortes normalizados para a mesma grade.
 * Altura e largura são normalizadas (a geometria é medida à parte).
 * @param {Uint8Array} [mask] células ignoradas (1 = ignorar), tamanho cols×rows
 */
export function gridSimilarity(a, b, cols, rows, mask) {
    const ga = resize(a, cols, rows);
    const gb = resize(b, cols, rows);
    let sum = 0;
    let n = 0;
    for (let p = 0; p < cols * rows; p++) {
        if (mask && mask[p]) continue;
        const i = p * 4;
        sum += (Math.abs(ga.data[i] - gb.data[i]) + Math.abs(ga.data[i + 1] - gb.data[i + 1]) + Math.abs(ga.data[i + 2] - gb.data[i + 2])) / 3;
        n++;
    }
    const color = n ? 1 - sum / n / 255 : null;
    // O gradiente de uma célula usa os vizinhos à direita e abaixo: células
    // que tocam a máscara também são excluídas (evita vazamento da mídia).
    let gradientMask = mask;
    if (mask) {
        gradientMask = new Uint8Array(mask.length);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                gradientMask[i] = mask[i] || (x + 1 < cols && mask[i + 1]) || (y + 1 < rows && mask[i + cols]) ? 1 : 0;
            }
        }
    }
    const r = pearson(gradients(ga), gradients(gb), gradientMask);
    const structure = r === null ? null : (Math.max(-1, Math.min(1, r)) + 1) / 2;
    return { color: round(color), structure: round(structure), cells: n, total: cols * rows };
}

/** Máscara de células a partir de caixas relativas (0..1). */
export function maskFromBoxes(cols, rows, boxes) {
    const mask = new Uint8Array(cols * rows);
    for (const box of boxes) {
        const x0 = Math.floor(box.x * cols);
        const y0 = Math.floor(box.y * rows);
        const x1 = Math.ceil((box.x + box.width) * cols);
        const y1 = Math.ceil((box.y + box.height) * rows);
        for (let y = Math.max(0, y0); y < Math.min(rows, y1); y++) for (let x = Math.max(0, x0); x < Math.min(cols, x1); x++) mask[y * cols + x] = 1;
    }
    return mask;
}

/**
 * Mapa de diferenças pixel a pixel na área comum (alinhada ao topo).
 * Pixel igual: referência esmaecida; diferente: vermelho proporcional.
 */
export function diffImage(a, b, threshold = 24) {
    const width = Math.min(a.width, b.width);
    const height = Math.min(a.height, b.height);
    const out = new RgbaImage(width, height);
    let changed = 0;
    let total = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const ia = (y * a.width + x) * 4;
            const ib = (y * b.width + x) * 4;
            const delta = Math.max(Math.abs(a.data[ia] - b.data[ib]), Math.abs(a.data[ia + 1] - b.data[ib + 1]), Math.abs(a.data[ia + 2] - b.data[ib + 2]));
            const o = (y * width + x) * 4;
            total += delta;
            if (delta > threshold) {
                changed++;
                out.data[o] = 255;
                out.data[o + 1] = 40;
                out.data[o + 2] = 40;
            } else {
                const gray = 0.2126 * a.data[ia] + 0.7152 * a.data[ia + 1] + 0.0722 * a.data[ia + 2];
                const faded = 255 - (255 - gray) * 0.25;
                out.data[o] = faded;
                out.data[o + 1] = faded;
                out.data[o + 2] = faded;
            }
            out.data[o + 3] = 255;
        }
    }
    return { image: out, changedRatio: round(changed / (width * height)), meanDelta: round(total / (width * height)), width, height };
}

/** Composição horizontal (alinhada ao topo) com espaçamento. */
export function sideBySide(images, gap = 16, background = [235, 235, 235]) {
    const width = images.reduce((sum, image) => sum + image.width, 0) + gap * (images.length - 1);
    const height = Math.max(...images.map((image) => image.height));
    const out = RgbaImage.filled(width, height, background);
    let offset = 0;
    for (const image of images) {
        for (let y = 0; y < image.height; y++) {
            out.data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + offset) * 4);
        }
        offset += image.width + gap;
    }
    return out;
}

/** Empilhamento vertical (alinhado à esquerda). */
export function stack(images, gap = 12, background = [255, 255, 255]) {
    const width = Math.max(...images.map((image) => image.width));
    const height = images.reduce((sum, image) => sum + image.height, 0) + gap * (images.length - 1);
    const out = RgbaImage.filled(width, height, background);
    let offset = 0;
    for (const image of images) {
        for (let y = 0; y < image.height; y++) {
            out.data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((offset + y) * width) * 4);
        }
        offset += image.height + gap;
    }
    return out;
}

export function scale(image, factor) {
    return resize(image, image.width * factor, image.height * factor);
}

function round(value) {
    return value === null ? null : Math.round(value * 1000) / 1000;
}
