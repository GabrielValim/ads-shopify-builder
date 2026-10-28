/**
 * CF-01 — subconjunto de Liquid para renderização LOCAL das seções geradas.
 *
 * É uma APROXIMAÇÃO: não comprova compatibilidade com a renderização real da Shopify. O validador (validate.mjs)
 * só aceita as construções que este módulo implementa; qualquer outra coisa é recusada antes de renderizar.
 *
 * Tags: if/elsif/else/endif, unless/endunless, for … in … [limit:n] [offset:n]/else/endfor (coleção ou faixa a..b),
 *       case/when/else/endcase, assign, comment/endcomment, style/endstyle (vira <style>), schema/endschema (removido),
 *       raw/endraw. Controle de espaço {%- -%} {{- -}}.
 * Objetos: section.{id,settings,blocks}, block.{id,type,settings,shopify_attributes}, forloop.*, variáveis de assign,
 *          routes.* (rotas padrão da loja, como na Shopify) e configurações `link_list` (objeto de menu com `.links`).
 *          Menu local = DEMONSTRATIVO (ver DEMO_LINKLIST); configuração vazia → null, como na Shopify.
 * Filtros: FILTERS abaixo (lista fechada). Imagens: image_url / image_tag com a semântica da Shopify sobre um registro
 * LOCAL fechado de mídia demonstrativa (media.mjs); parâmetros nomeados só nesses dois filtros.
 */

import { resolveImage } from "./media.mjs";
import { placeholderSvg } from "./liquid-svg.mjs";
import { DEMO_LINKLIST, ROUTES } from "./liquid-data.mjs";

export const TAGS = new Set(["if", "elsif", "else", "endif", "unless", "endunless", "for", "endfor", "case", "when", "endcase", "assign", "comment", "endcomment", "style", "endstyle", "schema", "endschema", "raw", "endraw", "break", "continue"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Placeholder neutro local (a Shopify serve um SVG próprio; aqui é só uma caixa com hachura). */
const placeholder = (name, cls) => placeholderSvg(esc(name), esc(cls ?? "placeholder-svg"));

export const FILTERS = {
    escape: (v) => esc(v ?? ""),
    default: (v, d) => (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && !v.length) ? d : v),
    append: (v, s) => `${v ?? ""}${s ?? ""}`,
    prepend: (v, s) => `${s ?? ""}${v ?? ""}`,
    plus: (v, n) => num(v) + num(n),
    minus: (v, n) => num(v) - num(n),
    times: (v, n) => num(v) * num(n),
    divided_by: (v, n) => (Number.isInteger(num(n)) && Number.isInteger(num(v)) ? Math.floor(num(v) / num(n)) : num(v) / num(n)),
    modulo: (v, n) => num(v) % num(n),
    upcase: (v) => String(v ?? "").toUpperCase(),
    downcase: (v) => String(v ?? "").toLowerCase(),
    strip: (v) => String(v ?? "").trim(),
    size: (v) => (v == null ? 0 : v.length ?? 0),
    split: (v, s) => String(v ?? "").split(s ?? " "),
    first: (v) => (Array.isArray(v) ? v[0] : String(v ?? "")[0]),
    last: (v) => (Array.isArray(v) ? v[v.length - 1] : String(v ?? "").slice(-1)),
    join: (v, s) => (Array.isArray(v) ? v.join(s ?? " ") : v),
    newline_to_br: (v) => String(v ?? "").replace(/\r?\n/g, "<br />\n"), // como a Shopify: "<br />", inclusive para CRLF
    placeholder_svg_tag: (v, cls) => placeholder(String(v ?? "image"), cls),
};

// ---------------------------------------------------------------- imagens (semântica da Shopify, mídia local)

const MAX_IMAGE_PX = 5760;
const dim = (name, v) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_IMAGE_PX) throw new LiquidError(`${name} deve ser inteiro entre 1 e ${MAX_IMAGE_PX}`);
    return v;
};
const onlyKeys = (filter, kw, allowed) => { for (const k of Object.keys(kw)) if (!allowed.includes(k)) throw new LiquidError(`${filter}: parâmetro não suportado: ${k}`); };

/** Filtros que recebem parâmetros nomeados: (entrada, { nome: valor }). */
export const KW_FILTERS = {
    /** image_url: só objeto de imagem; exige width e/ou height; reduz para caber, nunca amplia. Saída: URL (data: local). */
    image_url(v, kw) {
        onlyKeys("image_url", kw, ["width", "height"]);
        if (v === null || v === undefined || v === "") return null;
        if (!v || v.__cfImage !== true) throw new LiquidError("image_url exige um objeto de imagem (image_picker)");
        if (kw.width === undefined && kw.height === undefined) throw new LiquidError("image_url exige width ou height");
        const w = kw.width === undefined ? Infinity : dim("width", kw.width), h = kw.height === undefined ? Infinity : dim("height", kw.height);
        const scale = Math.min(w / v.width, h / v.height, 1);
        const width = Math.max(1, Math.round(v.width * scale)), height = Math.max(1, Math.round(v.height * scale));
        return { __cfImageUrl: true, src: v.src, width, height, alt: v.alt, toString() { return this.src; } };
    },
    /** image_tag: só saída de image_url; <img> com width/height; atributos de uma lista fechada (nenhum on*). */
    image_tag(u, kw) {
        onlyKeys("image_tag", kw, ["alt", "class", "loading", "sizes", "width", "height", "fetchpriority", "preload", "widths"]);
        if (u === null || u === undefined || u === "") return "";
        if (!u || u.__cfImageUrl !== true) throw new LiquidError("image_tag exige a saída de image_url");
        if (kw.loading !== undefined && !["lazy", "eager"].includes(kw.loading)) throw new LiquidError("image_tag: loading deve ser lazy ou eager");
        if (kw.fetchpriority !== undefined && !["high", "low", "auto"].includes(kw.fetchpriority)) throw new LiquidError("image_tag: fetchpriority inválido");
        let width = u.width, height = u.height;
        if (kw.width !== undefined) { width = Math.min(dim("width", kw.width), u.width); height = Math.round((width * u.height) / u.width); }
        else if (kw.height !== undefined) { height = Math.min(dim("height", kw.height), u.height); width = Math.round((height * u.width) / u.height); }
        const attrs = [["src", u.src], ["alt", kw.alt ?? u.alt ?? ""], ["width", width], ["height", height], ["class", kw.class], ["loading", kw.loading], ["sizes", kw.sizes], ["fetchpriority", kw.fetchpriority]];
        // preload/widths: aceitos (existem na Shopify), sem efeito local — a Shopify ainda gera srcset; aqui não.
        return `<img ${attrs.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}="${esc(String(v))}"`).join(" ")}>`;
    },
};

// ---------------------------------------------------------------- tokenização

export function tokenize(src) {
    const out = [];
    const re = /\{\{(-?)([\s\S]*?)(-?)\}\}|\{%(-?)([\s\S]*?)(-?)%\}/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
        if (m.index > last) out.push({ kind: "text", value: src.slice(last, m.index) });
        if (m[0].startsWith("{{")) out.push({ kind: "output", expr: m[2].trim(), lstrip: !!m[1], rstrip: !!m[3] });
        else {
            const body = m[5].trim();
            const [name] = body.split(/\s+/, 1);
            out.push({ kind: "tag", name, args: body.slice(name.length).trim(), lstrip: !!m[4], rstrip: !!m[6] });
            if (name === "raw" || name === "comment" || name === "schema") {
                const end = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, "g");
                end.lastIndex = re.lastIndex;
                const e = end.exec(src);
                if (!e) throw new LiquidError(`${name} sem end${name}`);
                out.push({ kind: "text", value: src.slice(re.lastIndex, e.index), verbatim: name });
                out.push({ kind: "tag", name: `end${name}`, args: "", lstrip: e[0].startsWith("{%-"), rstrip: e[0].endsWith("-%}") });
                re.lastIndex = end.lastIndex;
            }
        }
        last = re.lastIndex;
    }
    if (last < src.length) out.push({ kind: "text", value: src.slice(last) });
    // controle de espaço
    for (let i = 0; i < out.length; i++) {
        const t = out[i];
        if (t.kind === "text") continue;
        if (t.lstrip && out[i - 1]?.kind === "text" && !out[i - 1].verbatim) out[i - 1].value = out[i - 1].value.replace(/\s+$/, "");
        if (t.rstrip && out[i + 1]?.kind === "text" && !out[i + 1].verbatim) out[i + 1].value = out[i + 1].value.replace(/^\s+/, "");
    }
    return out;
}

export class LiquidError extends Error {}

// ---------------------------------------------------------------- análise

export function parse(src) {
    const tokens = tokenize(src);
    let i = 0;
    const block = (ends) => {
        const nodes = [];
        while (i < tokens.length) {
            const t = tokens[i];
            if (t.kind === "tag" && ends.includes(t.name)) return nodes;
            i++;
            if (t.kind === "text") { nodes.push({ type: "text", value: t.value }); continue; }
            if (t.kind === "output") { nodes.push({ type: "output", expr: parseExpr(t.expr) }); continue; }
            if (!TAGS.has(t.name)) throw new LiquidError(`tag não suportada: ${t.name}`);
            switch (t.name) {
                case "if": case "unless": {
                    const branches = [{ cond: parseCond(t.args), body: block(["elsif", "else", `end${t.name}`]) }];
                    if (t.name === "unless") branches[0].negate = true;
                    while (tokens[i]?.name === "elsif") { const c = tokens[i++]; branches.push({ cond: parseCond(c.args), body: block(["elsif", "else", `end${t.name}`]) }); }
                    let otherwise = null;
                    if (tokens[i]?.name === "else") { i++; otherwise = block([`end${t.name}`]); }
                    expectEnd(`end${t.name}`);
                    nodes.push({ type: "if", branches, otherwise });
                    break;
                }
                case "for": {
                    const m = /^([a-z_][a-z0-9_]*)\s+in\s+(\S+)((?:\s+(?:limit|offset):\s*\S+)*)\s*$/i.exec(t.args);
                    if (!m) throw new LiquidError(`for inválido: ${t.args}`);
                    const opts = {};
                    for (const o of m[3].matchAll(/(limit|offset):\s*(\S+)/g)) opts[o[1]] = parseExpr(o[2]);
                    const body = block(["else", "endfor"]);
                    let otherwise = null;
                    if (tokens[i]?.name === "else") { i++; otherwise = block(["endfor"]); }
                    expectEnd("endfor");
                    nodes.push({ type: "for", name: m[1], source: parseSource(m[2]), opts, body, otherwise });
                    break;
                }
                case "case": {
                    const subject = parseExpr(t.args);
                    const whens = [];
                    let otherwise = null;
                    block(["when", "else", "endcase"]); // texto antes do primeiro when é ignorado (como na Shopify)
                    while (tokens[i]?.name === "when") { const w = tokens[i++]; whens.push({ values: splitTop(w.args, /\s*(?:,|\bor\b)\s*/).map(parseExpr), body: block(["when", "else", "endcase"]) }); }
                    if (tokens[i]?.name === "else") { i++; otherwise = block(["endcase"]); }
                    expectEnd("endcase");
                    nodes.push({ type: "case", subject, whens, otherwise });
                    break;
                }
                case "assign": {
                    const m = /^([a-z_][a-z0-9_]*)\s*=\s*([\s\S]+)$/i.exec(t.args);
                    if (!m) throw new LiquidError(`assign inválido: ${t.args}`);
                    nodes.push({ type: "assign", name: m[1], expr: parseExpr(m[2]) });
                    break;
                }
                case "comment": case "schema": i++; expectEnd(`end${t.name}`, true); break;
                case "raw": { const v = tokens[i++]; expectEnd("endraw", true); nodes.push({ type: "text", value: v.value }); break; }
                case "style": { const body = block(["endstyle"]); expectEnd("endstyle"); nodes.push({ type: "style", body }); break; }
                case "break": case "continue": nodes.push({ type: t.name }); break;
                default: throw new LiquidError(`tag fora de contexto: ${t.name}`);
            }
        }
        if (ends.length) throw new LiquidError(`bloco sem fechamento (${ends.join("/")})`);
        return nodes;
    };
    const expectEnd = (name, prior = false) => {
        if (prior && tokens[i - 1]?.name === name) return;
        if (tokens[i]?.name !== name) throw new LiquidError(`esperado ${name}`);
        i++;
    };
    const nodes = block([]);
    return nodes;
}

function splitTop(s, sep) {
    const out = [];
    let cur = "";
    for (const p of s.split(/("[^"]*"|'[^']*')/)) {
        if (/^["']/.test(p)) { cur += p; continue; }
        const pieces = p.split(sep);
        cur += pieces[0];
        for (const piece of pieces.slice(1)) { out.push(cur); cur = piece; }
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter((x) => x !== "");
}

function parseSource(s) {
    const r = /^\((-?\d+|[a-z_][\w.]*)\.\.(-?\d+|[a-z_][\w.]*)\)$/i.exec(s);
    if (r) return { range: [parseExpr(r[1]), parseExpr(r[2])] };
    return { expr: parseExpr(s) };
}

/** Expressão de saída: valor | filtro: arg, arg | filtro … */
export function parseExpr(s) {
    const parts = splitTop(s, /\s*\|\s*/);
    const base = parseValue(parts[0]);
    const filters = parts.slice(1).map((f) => {
        const m = /^([a-z_]+)\s*(?::\s*([\s\S]*))?$/i.exec(f);
        if (!m) throw new LiquidError(`filtro inválido: ${f}`);
        if (!Object.hasOwn(FILTERS, m[1]) && !Object.hasOwn(KW_FILTERS, m[1])) throw new LiquidError(`filtro não suportado: ${m[1]}`);
        const args = (m[2] ? splitTop(m[2], /\s*,\s*/) : []).map((a) => { const k = /^([a-z_]+)\s*:\s*([\s\S]+)$/i.exec(a); return k ? { kw: k[1], value: parseValue(k[2]) } : parseValue(a); });
        const kwFilter = Object.hasOwn(KW_FILTERS, m[1]);
        if (kwFilter && args.some((a) => !a.kw)) throw new LiquidError(`${m[1]}: use só parâmetros nomeados`);
        if (!kwFilter && args.some((a) => a.kw)) throw new LiquidError(`${m[1]}: parâmetros nomeados não suportados`);
        return { name: m[1], args, kw: kwFilter };
    });
    return { base, filters };
}

function parseValue(s) {
    s = s.trim();
    if (/^"[^"]*"$|^'[^']*'$/.test(s)) return { lit: s.slice(1, -1) };
    if (/^-?\d+(\.\d+)?$/.test(s)) return { lit: Number(s) };
    if (s === "true" || s === "false") return { lit: s === "true" };
    if (s === "nil" || s === "null" || s === "blank" || s === "empty") return { lit: s === "nil" || s === "null" ? null : "" , special: s };
    if (/^[a-z_][\w-]*(\.[a-z_][\w-]*|\[(\d+|"[^"]*"|'[^']*')\])*$/i.test(s)) {
        const path = [];
        for (const m of s.matchAll(/([a-z_][\w-]*)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/gi)) path.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3] ?? m[4]));
        return { path };
    }
    throw new LiquidError(`valor não suportado: ${s}`);
}

function parseCond(s) {
    // and/or associam à direita (como na Liquid); sem parênteses.
    const or = splitTop(s, /\s+or\s+/);
    if (or.length > 1) return { op: "or", a: parseCond(or[0]), b: parseCond(or.slice(1).join(" or ")) };
    const and = splitTop(s, /\s+and\s+/);
    if (and.length > 1) return { op: "and", a: parseCond(and[0]), b: parseCond(and.slice(1).join(" and ")) };
    const m = /^([\s\S]+?)\s*(==|!=|<>|>=|<=|>|<|\bcontains\b)\s*([\s\S]+)$/.exec(s);
    if (m) return { op: m[2], a: parseValue(m[1]), b: parseValue(m[3]) };
    return { op: "truthy", a: parseValue(s) };
}

// ---------------------------------------------------------------- execução

const MAX_OUTPUT = 512 * 1024;
const MAX_ITER = 2000;

export function render(nodes, scope) {
    const vars = [scope];
    let out = "", steps = 0;
    const lookup = (path) => {
        let v;
        const head = path[0];
        for (let k = vars.length - 1; k >= 0; k--) if (Object.hasOwn(vars[k], head)) { v = vars[k][head]; break; }
        for (const p of path.slice(1)) {
            if (v == null) return null;
            if (p === "size" && (Array.isArray(v) || typeof v === "string")) { v = v.length; continue; }
            if (p === "first" && Array.isArray(v)) { v = v[0]; continue; }
            if (p === "last" && Array.isArray(v)) { v = v[v.length - 1]; continue; }
            v = Object.hasOwn(Object(v), p) ? v[p] : null;
        }
        return v ?? null;
    };
    const value = (v) => (v.path ? lookup(v.path) : v.lit);
    const evalExpr = (e) => e.filters.reduce((acc, f) => (f.kw ? KW_FILTERS[f.name](acc, Object.fromEntries(f.args.map((a) => [a.kw, value(a.value)]))) : FILTERS[f.name](acc, ...f.args.map(value))), value(e.base));
    const truthy = (v) => v !== null && v !== undefined && v !== false;
    const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    const cond = (c) => {
        if (c.op === "or") return cond(c.a) || cond(c.b);
        if (c.op === "and") return cond(c.a) && cond(c.b);
        const a = value(c.a);
        if (c.op === "truthy") return truthy(a);
        const b = value(c.b);
        if (c.b.special === "blank" || c.b.special === "empty") return c.op === "!=" || c.op === "<>" ? !isEmpty(a) : isEmpty(a);
        switch (c.op) {
            case "==": return a === b || (a != null && b != null && String(a) === String(b) && typeof a === typeof b);
            case "!=": case "<>": return !(a === b);
            case ">": return num(a) > num(b);
            case "<": return num(a) < num(b);
            case ">=": return num(a) >= num(b);
            case "<=": return num(a) <= num(b);
            case "contains": return Array.isArray(a) ? a.includes(b) : String(a ?? "").includes(String(b));
        }
        return false;
    };
    const str = (v) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join("") : String(v));
    const emit = (s) => { out += s; if (out.length > MAX_OUTPUT) throw new LiquidError("saída acima do limite"); };
    const BREAK = Symbol("break"), CONTINUE = Symbol("continue");
    const run = (list) => {
        for (const n of list) {
            if (++steps > 200000) throw new LiquidError("passos acima do limite");
            switch (n.type) {
                case "text": emit(n.value); break;
                case "output": emit(str(evalExpr(n.expr))); break;
                case "assign": vars[0][n.name] = evalExpr(n.expr); break; // assign é global, como na Liquid
                case "style": emit("<style>"); { const r = run(n.body); if (r) return r; } emit("</style>"); break;
                case "if": {
                    const hit = n.branches.find((b) => (b.negate ? !cond(b.cond) : cond(b.cond)));
                    const r = run(hit ? hit.body : n.otherwise ?? []);
                    if (r) return r;
                    break;
                }
                case "case": {
                    const s = evalExpr(n.subject);
                    const hit = n.whens.find((w) => w.values.some((v) => String(evalExpr(v)) === String(s)));
                    const r = run(hit ? hit.body : n.otherwise ?? []);
                    if (r) return r;
                    break;
                }
                case "for": {
                    let items;
                    if (n.source.range) { const a = num(evalExpr(n.source.range[0])), b = num(evalExpr(n.source.range[1])); items = []; for (let k = a; k <= b && items.length < MAX_ITER; k++) items.push(k); }
                    else { const v = evalExpr(n.source.expr); items = Array.isArray(v) ? v : v == null ? [] : [v]; }
                    const offset = n.opts.offset ? num(evalExpr(n.opts.offset)) : 0;
                    const limit = n.opts.limit ? num(evalExpr(n.opts.limit)) : items.length;
                    items = items.slice(offset, offset + limit).slice(0, MAX_ITER);
                    if (!items.length) { const r = run(n.otherwise ?? []); if (r) return r; break; }
                    for (let k = 0; k < items.length; k++) {
                        vars.push({ [n.name]: items[k], forloop: { index: k + 1, index0: k, first: k === 0, last: k === items.length - 1, length: items.length, rindex: items.length - k, rindex0: items.length - k - 1 } });
                        const r = run(n.body);
                        vars.pop();
                        if (r === BREAK) break;
                    }
                    break;
                }
                case "break": return BREAK;
                case "continue": return CONTINUE;
            }
        }
        return null;
    };
    run(nodes);
    return out;
}

/** Extrai o JSON de {% schema %} (texto bruto) de uma seção. */
export function extractSchema(src) {
    const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(src);
    return m ? m[1] : null;
}

/** Objeto `routes` da Shopify (rotas padrão; nunca fixar "/account" etc. no código). */
export { ROUTES, DEMO_LINKLIST } from "./liquid-data.mjs";
/** Menu DEMONSTRATIVO para a renderização local de uma configuração `link_list` com valor (na loja real vem da navegação). */
export function resolveLinkList(handle) {
    if (handle == null || handle === "") return null; // como na Shopify: sem menu escolhido, o objeto é nulo
    const links = DEMO_LINKLIST.map((x) => { const [title, url] = x.split("|"); return { title, url, handle: title.toLowerCase(), active: false, current: false, child_active: false, child_current: false, levels: 0, links: [] }; });
    return { handle: String(handle), title: "Menu (demonstrativo)", levels: 1, links };
}

/** Monta settings/blocks com padrões do schema + valores do template (como a Shopify faz). */
export function sectionScope({ key, schema, entry, media = null }) {
    const defaults = (list) => Object.fromEntries((list ?? []).filter((s) => s.id).map((s) => [s.id, s.default ?? (s.type === "checkbox" ? false : s.type === "image_picker" ? null : "")]));
    const settings = { ...defaults(schema.settings), ...(entry?.settings ?? {}) };
    for (const s of schema.settings ?? []) if (s.type === "image_picker") settings[s.id] = resolveImage(settings[s.id], media);
    for (const s of schema.settings ?? []) if (s.type === "link_list") settings[s.id] = resolveLinkList(settings[s.id]);
    const blockDefs = Object.fromEntries((schema.blocks ?? []).map((b) => [b.type, b]));
    const order = entry?.block_order ?? Object.keys(entry?.blocks ?? {});
    const blocks = order.map((id) => {
        const b = entry.blocks[id];
        const def = blockDefs[b.type] ?? { settings: [] };
        const s = { ...defaults(def.settings), ...(b.settings ?? {}) };
        for (const d of def.settings ?? []) if (d.type === "image_picker") s[d.id] = resolveImage(s[d.id], media);
        for (const d of def.settings ?? []) if (d.type === "link_list") s[d.id] = resolveLinkList(s[d.id]);
        return { id, type: b.type, settings: s, shopify_attributes: `data-shopify-editor-block="${esc(id)}"` };
    });
    return { section: { id: `template--cf01__${key}`, settings, blocks }, routes: ROUTES };
}
