#!/usr/bin/env node
/**
 * ADS Shopify Builder — comparação VERIFICÁVEL referência × prévia da seção, por viewport:
 *  - recorte da região na captura da referência (y0..y1 da especificação) × topo da prévia (mesma altura);
 *  - lado a lado (referência | prévia) e mapa de diferenças (pixels com Δ > 24 em vermelho);
 *  - similaridade por grade 48×N (cor e estrutura, 0..1; reference/compare/image-ops) e % de pixels diferentes;
 *  - tabela elemento × propriedade: papéis da especificação × elementos da prévia com a classe `ads-r-<papel>`.
 * Uso: node comparar.mjs <captura-ref> <especificacao.json> <previa-dir> <saida-dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.ADS_MOTOR_ROOT ?? join(import.meta.dirname, "../../../.."));
const { decodePng, encodePng } = await import(join(ROOT, "reference/compare/png.mjs"));
const { crop, diffImage, gridSimilarity, sideBySide } = await import(join(ROOT, "reference/compare/image-ops.mjs"));

const [cap, specPath, prevDir, outDir] = process.argv.slice(2);
if (!cap || !specPath || !prevDir || !outDir) { console.error("uso: comparar.mjs <captura-ref> <especificacao.json> <previa-dir> <saida-dir>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const num = (v) => (v == null ? null : Number.parseFloat(v));
// rgb()/rgba() e color(srgb r g b / a) — forma em que o navegador serializa color-mix()
const rgb = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c ?? "");
    if (m) { const [r, g, b, a = 1] = m[1].split(",").map(Number); return { r, g, b, a }; }
    const k = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/.exec(c ?? "");
    return k ? { r: Math.round(k[1] * 255), g: Math.round(k[2] * 255), b: Math.round(k[3] * 255), a: k[4] == null ? 1 : Number(k[4]) } : null;
};
const colorDist = (a, b) => (a && b ? Math.round(Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)) : null);
const firstGradientColor = (bg) => rgb(/rgba?\([^)]+\)|color\(srgb[^)]+\)/.exec(bg ?? "")?.[0]);
// espaço vertical até o elemento acima mais próximo que se sobrepõe na horizontal (independe do comprimento do texto acima)
const gapAbove = (box, boxes) => {
    const above = boxes.filter((o) => o !== box && o.y + o.h <= box.y + 1 && o.x < box.x + box.w && box.x < o.x + o.w);
    return above.length ? Math.round(box.y - Math.max(...above.map((o) => o.y + o.h))) : null;
};

const result = { kind: "AdsRegionComparison", referencia: cap, previa: prevDir, viewports: {} };
for (const [vp, v] of Object.entries(spec.viewports)) {
    const ref = decodePng(readFileSync(join(cap, `screenshot-${vp}.png`)));
    const pre = decodePng(readFileSync(join(prevDir, `screenshot-${vp}.png`)));
    const h = Math.min(v.regiao.altura, pre.height, ref.height - v.regiao.y0);
    const a = crop(ref, { x: 0, y: v.regiao.y0, width: Math.min(ref.width, pre.width), height: h });
    const b = crop(pre, { x: 0, y: 0, width: Math.min(ref.width, pre.width), height: h });
    writeFileSync(join(outDir, `lado-a-lado-${vp}.png`), encodePng(sideBySide([a, b], 24, [255, 0, 170])));
    const diff = diffImage(a, b);
    writeFileSync(join(outDir, `diferencas-${vp}.png`), encodePng(diff.image));
    const grid = gridSimilarity(a, b, 48, Math.max(8, Math.round((48 * h) / a.width)));
    // elementos: papel da especificação × classe ads-r-<papel> na prévia
    const dom = JSON.parse(readFileSync(join(prevDir, `dom-${vp}.json`), "utf8"));
    const tabela = [];
    const pares = [];
    for (const e of v.elementos) {
        const n = dom.nodes.find((x) => x.visible && (x.attrs?.class ?? "").split(/\s+/).includes(`ads-r-${e.papel}`));
        const linha = { papel: e.papel, referencia: e.caixa, previa: n ? { x: Math.round(n.box.x), y: Math.round(n.box.y), w: Math.round(n.box.width), h: Math.round(n.box.height) } : null };
        if (!n) { linha.situacao = e.origem ? "não reproduzido (conteúdo da referência)" : "AUSENTE na prévia"; tabela.push(linha); continue; }
        const s = n.styles ?? {}, r = e.estilo ?? {};
        linha.desvios = {
            posicao: Math.round(Math.hypot(linha.previa.x - e.caixa.x, linha.previa.y - e.caixa.y)),
            largura: linha.previa.w - e.caixa.w, altura: linha.previa.h - e.caixa.h,
            ...(r.fontSize ? { tamanhoFonte: num(s.fontSize) - num(r.fontSize) } : {}),
            ...(r.fontWeight ? { peso: num(s.fontWeight) - num(r.fontWeight) } : {}),
            ...(r.color ? { cor: colorDist(rgb(s.color), rgb(r.color)) } : {}),
            ...(r.backgroundImage || r.backgroundColor ? { fundo: colorDist(firstGradientColor(s.backgroundImage) ?? rgb(s.backgroundColor), firstGradientColor(r.backgroundImage) ?? rgb(r.backgroundColor)) } : {}),
            // raio efetivo: acima de metade da menor dimensão o desenho é o mesmo (pílula)
            ...(r.borderTopLeftRadius ? { raio: Math.round(Math.min(num(s.borderTopLeftRadius), Math.min(linha.previa.w, linha.previa.h) / 2) - Math.min(num(r.borderTopLeftRadius), Math.min(e.caixa.w, e.caixa.h) / 2)) } : {}),
        };
        pares.push({ linha, ref: e.caixa, pre: linha.previa });
        tabela.push(linha);
    }
    for (const p of pares) {
        const gr = gapAbove(p.ref, pares.map((q) => q.ref)), gp = gapAbove(p.pre, pares.map((q) => q.pre));
        if (gr != null && gp != null) p.linha.desvios.espacoAcima = gp - gr;
    }
    result.viewports[vp] = { altura: h, similaridade: grid, pixelsDiferentes: diff.changedRatio, deltaMedio: diff.meanDelta, elementos: tabela };
    console.log(`${vp}: similaridade cor ${grid.color} estrutura ${grid.structure} | pixels diferentes ${(diff.changedRatio * 100).toFixed(1)}% | elementos ${tabela.filter((t) => t.previa).length}/${tabela.length} presentes`);
}
writeFileSync(join(outDir, "comparacao.json"), JSON.stringify(result, null, 2) + "\n");
