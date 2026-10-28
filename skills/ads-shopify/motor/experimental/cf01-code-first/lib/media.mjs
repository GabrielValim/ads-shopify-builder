/**
 * CF-01 — mídia LOCAL para o Liquid aproximado.
 *
 * Na Shopify, um `image_picker` guarda `shopify://shop_images/<arquivo>` e a loja resolve para um objeto de imagem
 * com dimensões reais. Localmente, só um REGISTRO FECHADO de imagens demonstrativas próprias (arte abstrata gerada
 * aqui, sem texto nem marca) é resolvido; qualquer outra referência vira "sem imagem" (o tema cai no fallback).
 * As imagens entram na página como `data:` (a CSP local só permite `img-src data:`).
 */
import { encodePng, RgbaImage } from "../../../reference/compare/png.mjs";

/** Formato de referência que a Shopify grava no template para um image_picker. */
export const IMAGE_REF_RE = /^shopify:\/\/shop_images\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:png|jpe?g|webp|gif)$/;

/** Arte demonstrativa abstrata, determinística (gradiente quente + formas suaves). */
export function demoMediaPng({ width, height, seed = 1 }) {
    const img = new RgbaImage(width, height);
    const hue = [[0.93, 0.86, 0.82], [0.88, 0.80, 0.78], [0.95, 0.90, 0.84]][seed % 3];
    const circles = [0.3, 0.7, 0.5].map((c, i) => ({ x: ((c + seed * 0.17) % 1) * width, y: (((c * 1.3 + i * 0.21) + seed * 0.11) % 1) * height, r: Math.min(width, height) * (0.25 + 0.08 * i) }));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const t = (x / width) * 0.4 + (y / height) * 0.6;
        let k = 0.92 - 0.12 * t;
        for (const c of circles) { const d = Math.hypot(x - c.x, y - c.y) / c.r; if (d < 1) k -= 0.05 * (1 - d * d); }
        const i = (y * width + x) * 4;
        img.data[i] = Math.round(255 * hue[0] * k); img.data[i + 1] = Math.round(255 * hue[1] * k); img.data[i + 2] = Math.round(255 * hue[2] * k); img.data[i + 3] = 255;
    }
    return encodePng(img);
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

/** Registro fechado: nome do arquivo → objeto de imagem (como a Shopify o entrega ao Liquid). */
export function createLocalMedia(entries) {
    const map = new Map();
    for (const [name, { png, alt = "" }] of Object.entries(entries)) {
        if (!IMAGE_REF_RE.test(`shopify://shop_images/${name}`)) throw new Error(`nome de mídia inválido: ${name}`);
        const { width, height } = pngSize(png);
        map.set(name, Object.freeze({ src: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, width, height, alt }));
    }
    return map;
}

/** Resolve o valor de um image_picker; fora do formato ou do registro → null. */
export function resolveImage(value, media) {
    if (typeof value !== "string" || !IMAGE_REF_RE.test(value) || !media) return null;
    const name = value.slice("shopify://shop_images/".length);
    const m = media.get(name);
    if (!m) return null;
    // toString devolve a referência (como na Shopify, o objeto impresso cru NÃO é uma URL de imagem utilizável).
    return { __cfImage: true, src: m.src, width: m.width, height: m.height, aspect_ratio: m.width / m.height, alt: m.alt, toString: () => value };
}

/** Registro padrão do CF-01: 3 artes demonstrativas 820×720 (proporção dos cartões medidos), geradas aqui. */
let DEFAULT_MEDIA = null;
export function defaultDemoMedia() {
    DEFAULT_MEDIA ??= createLocalMedia(Object.fromEntries([1, 2, 3].map((seed, i) => [`cf01-demo-${"abc"[i]}.png`, { png: demoMediaPng({ width: 820, height: 720, seed }), alt: `Arte demonstrativa ${"ABC"[i]}` }])));
    return DEFAULT_MEDIA;
}
