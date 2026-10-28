#!/usr/bin/env node
/**
 * ADS Shopify Builder — especificação visual MEDIDA de uma região da referência (desktop + mobile).
 * Lê dom-*.json da captura; NUNCA grava texto da referência (só contagem de caracteres), nem arquivos de imagem.
 * Papéis atribuídos por regra genérica (os mesmos que a seção marca com a classe `ads-r-<papel>`):
 *   titulo (maior h1/h2), paragrafo (maior texto corrido após o título), botao-N (links/botões com fundo, borda ou raio,
 *   em ordem de leitura), nota (texto pequeno abaixo dos botões), cartao-N (contêineres com fundo/gradiente e raio
 *   contendo texto), imagem (maior mídia); além de camadas de fundo, ícones e trechos de texto com gradiente.
 * Uso: node especificacao.mjs <captura> <y0> <y1> <saida.json> [--mobile <y0> <y1>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cap, y0s, y1s, out, ...rest] = process.argv.slice(2);
if (!cap || !out) { console.error("uso: especificacao.mjs <captura> <y0> <y1> <saida.json> [--mobile <y0> <y1>]"); process.exit(2); }
const mi = rest.indexOf("--mobile");
const ranges = { desktop: [Number(y0s), Number(y1s)], ...(mi >= 0 ? { mobile: [Number(rest[mi + 1]), Number(rest[mi + 2])] } : {}) };

const px = (v) => (v == null ? null : Number.parseFloat(v));
const pick = (s, keys) => Object.fromEntries(keys.filter((k) => s?.[k] != null && !["none", "normal", "rgba(0, 0, 0, 0)", "0px"].includes(s[k])).map((k) => [k, s[k]]));
const STYLE_TEXT = ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "textAlign", "textTransform", "backgroundImage", "fontStyle", "fontFamily", "marginTop"];
const STYLE_BOX = ["backgroundColor", "backgroundImage", "borderTopLeftRadius", "borderTopWidth", "borderTopColor", "boxShadow", "paddingTop", "paddingLeft", "color", "fontSize", "fontWeight"];

function analyze(viewport, [y0, y1]) {
    const dom = JSON.parse(readFileSync(join(cap, `dom-${viewport}.json`), "utf8"));
    const vw = dom.viewport?.width ?? dom.document?.viewport?.width ?? (viewport === "desktop" ? 1440 : 390);
    const nodes = dom.nodes.filter((n) => n.visible);
    const byId = new Map(dom.nodes.map((n) => [n.id, n]));
    const inside = (n) => n.box.y >= y0 - 24 && n.box.y + n.box.height <= y1 + 40 && n.box.width > 0 && n.box.height > 0; // tolerância: mídias que sobem levemente sobre o limite
    const rel = (b) => ({ x: Math.round(b.x), y: Math.round(b.y - y0), w: Math.round(b.width), h: Math.round(b.height) });
    const ancestors = (n) => { const out = []; let p = byId.get(n.parent); while (p) { out.push(p.id); p = byId.get(p.parent); } return out; };
    const inRegion = nodes.filter(inside);
    const hasTextInside = (n) => inRegion.some((m) => m.textLength > 0 && ancestors(m).includes(n.id));
    const opaque = (c) => c && !/rgba\([^)]*,\s*0\)$/.test(c) && c !== "transparent";

    // texto direto ou em filhos (<h1><span>…</span><span>…</span></h1>); as "partes" são os nós-folha com texto
    const leafTexts = (n) => inRegion.filter((m) => m.textLength > 0 && ancestors(m).includes(n.id) && !inRegion.some((k) => k.textLength > 0 && ancestors(k).includes(m.id)));
    const headingParts = (n) => (n.textLength > 0 ? [n] : leafTexts(n));
    const headingSize = (n) => Math.max(...headingParts(n).map((m) => px(m.styles.fontSize) ?? 0));
    const headings = inRegion.filter((n) => /^h[1-3]$/.test(n.tag) && headingParts(n).length).sort((a, b) => headingSize(b) - headingSize(a));
    const titulo = headings[0] ?? null;
    const buttons = inRegion.filter((n) => (n.tag === "a" || n.tag === "button") && n.textLength > 0 && (opaque(n.styles.backgroundColor) || (n.styles.backgroundImage && n.styles.backgroundImage !== "none") || (px(n.styles.borderTopWidth) ?? 0) > 0 || (px(n.styles.borderTopLeftRadius) ?? 0) > 0))
        .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const paras = inRegion.filter((n) => n.tag === "p" && n.textLength > 0 && !buttons.some((b) => ancestors(n).includes(b.id)));
    const paragrafo = [...paras].filter((p) => !titulo || p.box.y >= titulo.box.y).sort((a, b) => b.textLength - a.textLength)[0] ?? null;
    const lastButton = buttons.length ? Math.max(...buttons.map((b) => b.box.y + b.box.height)) : null;
    const nota = lastButton ? paras.filter((p) => p !== paragrafo && p.box.y >= lastButton - 4).sort((a, b) => a.box.y - b.box.y)[0] ?? null : null;
    const cards = inRegion.filter((n) => ["div", "li", "article"].includes(n.tag) && (px(n.styles.borderTopLeftRadius) ?? 0) > 0 && (opaque(n.styles.backgroundColor) || (n.styles.backgroundImage ?? "none") !== "none") && n.box.width < vw * 0.9 && n.box.width * n.box.height >= 2500 && hasTextInside(n))
        .filter((n, _, all) => !all.some((o) => o !== n && ancestors(n).includes(o.id))) // só o contêiner externo
        .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const media = inRegion.filter((n) => ["img", "picture", "video"].includes(n.tag) || (n.tag === "svg" && n.box.width * n.box.height >= 40000)).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    const icons = inRegion.filter((n) => n.tag === "svg" && n.box.width <= 48 && n.box.height <= 48).length;
    const gradText = inRegion.filter((n) => n.textLength > 0 && /gradient/.test(n.styles.backgroundImage ?? "")).map((n) => ({ chars: n.textLength, caixa: rel(n.box), fundo: n.styles.backgroundImage }));
    const layers = dom.nodes.filter((n) => n.box.width >= vw * 0.9 && n.box.y <= y0 + 10 && n.box.y + n.box.height >= y1 - 10 && ((n.styles?.backgroundImage ?? "none") !== "none" || opaque(n.styles?.backgroundColor)))
        .map((n) => ({ tag: n.tag, ...pick(n.styles, ["backgroundColor", "backgroundImage", "borderTopWidth", "borderTopColor", "borderBottomWidth", "borderBottomColor"]) }));
    const decor = inRegion.filter((n) => !(n.textLength > 0) && !hasTextInside(n) && /gradient/.test(n.styles.backgroundImage ?? "") && n.box.width * n.box.height >= 40000 && n.box.width < vw * 0.9)
        .map((n) => ({ caixa: rel(n.box), ...pick(n.styles, ["backgroundImage", "borderTopLeftRadius", "boxShadow"]) }));

    const el = (papel, n, keys) => n && { papel, tag: n.tag, chars: n.textLength, caixa: rel(n.box), estilo: pick(n.styles, keys) };
    // itens repetidos: o 1º contêiner grid/flex da região com ≥3 filhos diretos que têm texto (faixas de ícones, listas de benefícios)
    const childrenOf = (n) => inRegion.filter((m) => m.parent === n.id);
    const itemGroup = inRegion.filter((n) => ["grid", "flex"].includes(n.styles.display) && childrenOf(n).filter((c) => c.textLength > 0 || hasTextInside(c)).length >= 3)
        .filter((n) => !buttons.some((b) => b.id === n.id))
        .sort((a, b) => a.box.y - b.box.y || b.box.width - a.box.width)[0] ?? null;
    const itens = itemGroup ? childrenOf(itemGroup).filter((c) => c.textLength > 0 || hasTextInside(c)) : [];
    const elementos = [
        titulo && { ...el("titulo", titulo, STYLE_TEXT), chars: headingParts(titulo).reduce((t, m) => t + m.textLength, 0), estilo: pick(headingParts(titulo)[0].styles, STYLE_TEXT),
            partes: headingParts(titulo).map((m) => ({ chars: m.textLength, caixa: rel(m.box), estilo: pick(m.styles, STYLE_TEXT) })) },
        el("paragrafo", paragrafo, STYLE_TEXT),
        ...buttons.map((b, i) => el(`botao-${i + 1}`, b, STYLE_BOX)),
        el("nota", nota, STYLE_TEXT),
        ...cards.map((c, i) => ({ ...el(`cartao-${i + 1}`, c, STYLE_BOX), textos: inRegion.filter((m) => m.textLength > 0 && ancestors(m).includes(c.id) && !inRegion.some((k) => k.textLength > 0 && ancestors(k).includes(m.id))).map((m) => ({ chars: m.textLength, ...pick(m.styles, ["fontSize", "fontWeight", "color", "lineHeight"]) })) })),
        ...(itemGroup ? [{ papel: "grupo-itens", tag: itemGroup.tag, chars: 0, caixa: rel(itemGroup.box), estilo: pick(itemGroup.styles, ["display", "gap", "gridTemplateColumns", "justifyContent"]) }] : []),
        ...itens.map((c, i) => ({ ...el(`item-${i + 1}`, c, [...STYLE_BOX, "gap", "justifyContent", "alignItems"]), textos: (c.textLength > 0 ? [c] : leafTexts(c)).map((m) => ({ chars: m.textLength, caixa: rel(m.box), ...pick(m.styles, ["fontSize", "fontWeight", "color", "lineHeight", "letterSpacing", "textTransform"]) })),
            icones: inRegion.filter((m) => m.tag === "svg" && ancestors(m).includes(c.id)).map((m) => ({ caixa: rel(m.box), cor: m.styles.color })) })),
        media[0] && { papel: "imagem", tag: media[0].tag, caixa: rel(media[0].box), proporcao: Math.round((media[0].box.width / media[0].box.height) * 1000) / 1000, origem: "conteúdo da referência — NÃO reproduzir" },
    ].filter(Boolean);
    return {
        viewport, largura: vw, regiao: { y0, y1, altura: y1 - y0 }, elementos,
        textosComGradiente: gradText, camadasDeFundo: layers, decoracoes: decor,
        naoReproduzir: { midias: media.map((m) => ({ tag: m.tag, caixa: rel(m.box) })), icones: icons, observacao: "imagens, ilustrações, logos e ícones da referência são conteúdo de terceiros" },
    };
}

const spec = { kind: "AdsRegionSpec", versao: 1, captura: cap, geradoEm: new Date().toISOString(), politica: "sem textos nem arquivos da referência: só medidas e contagens", viewports: {} };
for (const [vp, r] of Object.entries(ranges)) spec.viewports[vp] = analyze(vp, r);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
for (const v of Object.values(spec.viewports)) console.log(`${v.viewport}: ${v.elementos.map((e) => e.papel).join(", ")} | decorações ${v.decoracoes.length} | camadas ${v.camadasDeFundo.length} | mídias não reproduzíveis ${v.naoReproduzir.midias.length}, ícones ${v.naoReproduzir.icones}`);
