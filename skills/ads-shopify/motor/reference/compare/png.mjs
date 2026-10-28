/**
 * Codec PNG mínimo (8 bits, RGB/RGBA, sem entrelaçamento) sobre node:zlib.
 * Suficiente para os screenshots do Chromium e para gravar os artefatos de
 * comparação, sem dependências novas. Entradas tratadas como não confiáveis.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PIXELS = 60_000_000;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** Imagem RGBA em memória. */
export class RgbaImage {
    constructor(width, height, data) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
            throw new Error(`Dimensões inválidas: ${width}x${height}`);
        }
        this.width = width;
        this.height = height;
        this.data = data ?? new Uint8ClampedArray(width * height * 4);
        if (this.data.length !== width * height * 4) throw new Error("Buffer RGBA com tamanho incorreto");
    }

    static filled(width, height, [r, g, b, a = 255]) {
        const image = new RgbaImage(width, height);
        for (let i = 0; i < image.data.length; i += 4) {
            image.data[i] = r;
            image.data[i + 1] = g;
            image.data[i + 2] = b;
            image.data[i + 3] = a;
        }
        return image;
    }
}

export function decodePng(buffer) {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Não é PNG");
    let offset = 8;
    let header = null;
    const idat = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString("latin1", offset + 4, offset + 8);
        if (offset + 12 + length > buffer.length) throw new Error("Chunk truncado");
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) {
            throw new Error(`CRC inválido no chunk ${type}`);
        }
        if (type === "IHDR") {
            header = {
                width: data.readUInt32BE(0),
                height: data.readUInt32BE(4),
                depth: data[8],
                colorType: data[9],
                interlace: data[12],
            };
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        offset += 12 + length;
    }
    if (!header) throw new Error("PNG sem IHDR");
    if (header.depth !== 8 || ![2, 6].includes(header.colorType) || header.interlace !== 0) {
        throw new Error("Formato PNG não suportado (esperado 8 bits RGB/RGBA sem entrelaçamento)");
    }
    const { width, height } = header;
    if (width * height > MAX_PIXELS) throw new Error("PNG grande demais");

    const channels = header.colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1 });
    if (raw.length !== (stride + 1) * height) throw new Error("Dados de imagem com tamanho inesperado");

    const image = new RgbaImage(width, height);
    const previous = new Uint8Array(stride);
    const current = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? current[x - channels] : 0;
            const up = previous[x];
            const upLeft = x >= channels ? previous[x - channels] : 0;
            let value;
            switch (filter) {
                case 0: value = row[x]; break;
                case 1: value = row[x] + left; break;
                case 2: value = row[x] + up; break;
                case 3: value = row[x] + ((left + up) >> 1); break;
                case 4: {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    value = row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
                    break;
                }
                default: throw new Error(`Filtro PNG inválido: ${filter}`);
            }
            current[x] = value & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const target = (y * width + x) * 4;
            image.data[target] = current[x * channels];
            image.data[target + 1] = current[x * channels + 1];
            image.data[target + 2] = current[x * channels + 2];
            image.data[target + 3] = channels === 4 ? current[x * channels + 3] : 255;
        }
        previous.set(current);
    }
    return image;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

export function encodePng(image) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(image.width, 0);
    header.writeUInt32BE(image.height, 4);
    header[8] = 8;
    header[9] = 6;
    const stride = image.width * 4;
    const raw = Buffer.alloc((stride + 1) * image.height);
    for (let y = 0; y < image.height; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
