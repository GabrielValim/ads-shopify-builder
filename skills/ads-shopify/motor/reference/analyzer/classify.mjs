/**
 * Classificação determinística de faixas por regras ponderadas.
 *
 * Cada tipo tem sinais com peso; sinais `required` vetam o tipo quando
 * falham. A confiança é a soma dos pesos satisfeitos. Abaixo do limiar,
 * a faixa fica `unknown`, com as melhores hipóteses registradas.
 *
 * As evidências são identificadores fixos deste módulo (nunca texto do
 * site), o que permite exibi-las com segurança e reproduzi-las.
 *
 * Arquitetura preparada para outros provedores (ex.: visão
 * multimodal): cada provedor devolve pontuações por tipo com evidências,
 * e `combineViewports` agrega.
 */

export const SECTION_TYPES = ["announcement-bar", "header", "hero", "product-grid", "rich-text", "image-with-text", "newsletter", "footer", "collapsible-content", "multicolumn", "testimonials"];
export const HINT_TYPES = ["image-with-text", "newsletter", "collection-list", "multicolumn"];
export const CLASSIFY_THRESHOLD = 0.6;
export const PROVIDER = "dom-heuristics-v2";

// Grupo de colunas que domina o texto da faixa (componente em colunas, não
// um detalhe dentro de outra seção).
const dominantColumns = (f) => Boolean(f.columnGroup) && f.columnGroup.columns >= 2 && f.columnGroup.textShare >= 0.6;

/**
 * @typedef {object} Context
 * @property {number} position índice da faixa
 * @property {number} count total de faixas
 * @property {number} pageMaxHeading maior heading da página (px)
 * @property {string | null} pageBackground hex do fundo da página
 * @property {{ width: number, height: number, isMobile: boolean }} viewport
 */

const rules = {
    "announcement-bar": (f, c) => [
        { id: "position:first", weight: 0.25, ok: c.position === 0 },
        { id: "height:compact", weight: 0.25, ok: f.box.height <= (c.viewport.isMobile ? 90 : 64), required: true },
        { id: "no-headings", weight: 0.15, ok: f.headings.length === 0, required: true },
        { id: "no-media", weight: 0.1, ok: f.media.length === 0 },
        { id: "short-text", weight: 0.1, ok: f.textChars >= 3 && f.textChars <= 200 },
        { id: "own-background", weight: 0.15, ok: f.background.own && f.background.hex !== c.pageBackground },
    ],
    header: (f, c) => [
        // Cabeçalho da página: <header>/banner, ou uma <nav> de nível de página
        // no lugar de <header> (comum em apps com navegação fixa). Uma <nav>
        // mais abaixo é barrada por position:top (geométrico, obrigatório).
        { id: "landmark:banner", weight: 0.35, ok: f.tag === "header" || f.role === "banner" || f.tag === "nav" || f.role === "navigation" },
        { id: "navigation", weight: 0.2, ok: f.hasNav || f.links >= 3 || f.icons >= 1 },
        // Cabeçalho = a PRIMEIRA faixa com papel de cabeçalho, perto do topo
        // (geometria, não índice: barras de aviso/utilitárias podem precedê-lo;
        // uma faixa depois do hero ou uma segunda navegação não é cabeçalho).
        { id: "position:top", weight: 0.2, ok: !c.headerAbove && f.box.y <= c.viewport.height * 0.25, required: true },
        { id: "height:compact", weight: 0.15, ok: f.box.height <= 200, required: true },
        { id: "no-h1", weight: 0.1, ok: !f.hasH1 },
    ],
    hero: (f, c) => [
        { id: "position:upper", weight: 0.15, ok: c.position <= 3 },
        { id: "height:tall", weight: 0.2, ok: f.box.height >= c.viewport.height * 0.4 },
        {
            id: "heading:dominant",
            weight: 0.25,
            ok: f.hasH1 || (f.maxHeadingSize > 0 && f.maxHeadingSize >= c.pageMaxHeading),
            required: true,
        },
        { id: "media:cover", weight: 0.2, ok: f.coverMedia || f.background.gradient },
        { id: "buttons", weight: 0.1, ok: f.buttons.length >= 1 },
        { id: "no-card-grid", weight: 0.1, ok: !f.repeated || f.repeated.imageShare < 0.5, required: true },
    ],
    "product-grid": (f) => [
        {
            id: "repeated:cards-with-image",
            weight: 0.45,
            ok: Boolean(f.repeated) && f.repeated.imageShare >= 0.75 && f.repeated.textShare >= 0.75,
            required: true,
        },
        { id: "repeated:price", weight: 0.25, ok: Boolean(f.repeated) && f.repeated.priceShare >= 0.5, required: true },
        { id: "heading", weight: 0.1, ok: f.headings.some((h) => h.level <= 3) },
        { id: "columns:multiple", weight: 0.2, ok: Boolean(f.repeated) && f.repeated.columns >= 2 },
    ],
    "rich-text": (f, c) => [
        { id: "text-content", weight: 0.25, ok: f.headings.length >= 1 || f.paragraphs >= 1, required: true },
        { id: "no-media", weight: 0.25, ok: f.media.length === 0 && !f.coverMedia, required: true },
        { id: "no-repeated-cards", weight: 0.15, ok: !f.repeated || f.repeated.imageShare < 0.5 },
        { id: "no-form", weight: 0.15, ok: f.inputs.length === 0, required: true },
        {
            id: "centered-or-narrow",
            weight: 0.1,
            ok: f.textAlign === "center" || f.columns.columns === 1,
        },
        { id: "few-buttons", weight: 0.1, ok: f.buttons.length <= 2 },
        // Componentes interativos ou em colunas não são texto corrido.
        { id: "no-disclosure", weight: 0, ok: !f.disclosure, required: true },
        { id: "no-dominant-columns", weight: 0, ok: !dominantColumns(f), required: true },
        { id: "no-testimonials", weight: 0, ok: !f.testimonials, required: true },
        { id: "not-top", weight: 0, ok: c.position > 0, required: true },
        {
            id: "not-landmark",
            weight: 0,
            ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
            required: true,
        },
    ],
    // Mídia única ao lado (desktop) ou acima/abaixo (mobile) de um bloco de
    // texto com título, sem sobreposição. Exige geometria — nunca classe,
    // texto ou id. No desktop só "lado a lado" conta: empilhado no desktop é
    // ambíguo com rich-text ilustrado e fica unknown.
    "image-with-text": (f, c) => {
        const split = f.split;
        const arranged = c.viewport.isMobile
            ? split?.arrangement === "side-by-side" || split?.arrangement === "stacked"
            : split?.arrangement === "side-by-side";
        const share = split?.mediaWidthShare ?? 0;
        return [
            { id: "media:single-prominent", weight: 0.25, ok: split?.mediaCount === 1, required: true },
            { id: "media:not-cover", weight: 0, ok: !f.coverMedia && !f.backgroundImage, required: true },
            { id: "text:heading", weight: 0.15, ok: f.headings.length >= 1, required: true },
            { id: "text:support", weight: 0.1, ok: f.paragraphs >= 1 || f.buttons.length >= 1 },
            { id: c.viewport.isMobile ? "layout:media-text-stacked" : "layout:media-beside-text", weight: 0.25, ok: arranged, required: true },
            {
                id: "media:proportion",
                weight: 0.15,
                ok: split?.arrangement === "side-by-side" ? share >= 0.25 && share <= 0.75 : share >= 0.6,
            },
            // Título dominante da página ao lado de uma imagem é candidato a
            // hero, não a image-with-text.
            { id: "heading:secondary", weight: 0.1, ok: !f.hasH1 && f.maxHeadingSize < c.pageMaxHeading, required: true },
            { id: "no-form", weight: 0, ok: f.inputs.length === 0, required: true },
            { id: "no-repeated-cards", weight: 0, ok: !f.repeated || f.repeated.imageShare < 0.5, required: true },
            { id: "not-top", weight: 0, ok: c.position > 0, required: true },
            {
                id: "not-landmark",
                weight: 0,
                ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
                required: true,
            },
        ];
    },
    // Formulário com UM campo de e-mail e envio, e nada mais além de
    // consentimento. Campos extras (nome, mensagem, senha, busca) indicam
    // outro tipo de formulário; campos fora de <form> não contam como
    // evidência.
    newsletter: (f, c) => {
        const signup = f.forms.find((form) => form.emailFields === 1 && form.otherFields === 0 && form.submits >= 1);
        return [
            { id: "form:email-signup", weight: 0.35, ok: Boolean(signup), required: true },
            { id: "form:single", weight: 0, ok: f.forms.length === 1 && f.fieldsOutsideForms === 0, required: true },
            { id: "text:heading", weight: 0.2, ok: f.headings.length >= 1 },
            { id: "text:short", weight: 0.15, ok: f.textChars <= 400 },
            { id: "no-media", weight: 0.15, ok: f.media.length === 0 },
            { id: "links:few", weight: 0.15, ok: f.links <= 2 },
            { id: "no-repeated-cards", weight: 0, ok: !f.repeated || f.repeated.imageShare < 0.5, required: true },
            { id: "not-top", weight: 0, ok: c.position > 0, required: true },
            {
                id: "not-landmark",
                weight: 0,
                ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
                required: true,
            },
        ];
    },
    // Painéis expansíveis empilhados (acordeão/FAQ): exige o GRUPO de
    // gatilhos (aria-expanded ou summary), não um atributo isolado.
    "collapsible-content": (f, c) => {
        const d = f.disclosure;
        return [
            { id: "disclosure:stacked-triggers", weight: 0.45, ok: Boolean(d) && d.rows >= 2, required: true },
            { id: "disclosure:three-or-more", weight: 0.1, ok: Boolean(d) && d.rows >= 3 },
            { id: "disclosure:wide-rows", weight: 0.2, ok: Boolean(d) && d.width >= f.box.width * 0.4 },
            { id: "text:heading", weight: 0.15, ok: f.headings.length >= 1 },
            { id: "media:not-cover", weight: 0.1, ok: !f.coverMedia },
            { id: "no-form", weight: 0, ok: f.inputs.length === 0, required: true },
            { id: "not-top", weight: 0, ok: c.position > 0, required: true },
            {
                id: "not-landmark",
                weight: 0,
                ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
                required: true,
            },
        ];
    },
    // Itens em colunas (benefícios, ícones + texto, números). No desktop
    // exige colunas lado a lado; no mobile, itens empilhados podem ser a
    // mesma estrutura (o desktop decide). Cards com preço ou de mídia
    // dominante são outros tipos.
    multicolumn: (f, c) => {
        const g = f.columnGroup;
        const structured = Boolean(g) && Math.max(g.itemsWithTitle, g.itemsWithIcon, g.itemsWithNumericLead) >= g.count * 0.75;
        return [
            {
                id: c.viewport.isMobile ? "columns:repeated-items" : "columns:side-by-side",
                weight: 0.35,
                ok: Boolean(g) && (c.viewport.isMobile ? g.count >= 2 : g.columns >= 2),
                required: true,
            },
            { id: "columns:dominant-text", weight: 0.2, ok: Boolean(g) && g.textShare >= 0.6, required: true },
            { id: "items:structured", weight: 0.15, ok: structured, required: true },
            { id: "items:compact", weight: 0.1, ok: Boolean(g) && g.maxItemChars <= 400 },
            { id: "columns:fit-dawn", weight: 0.1, ok: Boolean(g) && g.columns <= 6 },
            { id: "media:not-cover", weight: 0.1, ok: !f.coverMedia },
            { id: "items:no-price", weight: 0, ok: !g || g.itemsWithPrice === 0, required: true },
            { id: "items:media-minor", weight: 0, ok: !g || g.itemsWithMedia < g.count * 0.5, required: true },
            { id: "no-disclosure", weight: 0, ok: !f.disclosure, required: true },
            // Cartões citação → autoria são depoimentos, não colunas genéricas.
            { id: "no-testimonials", weight: 0, ok: !f.testimonials, required: true },
            { id: "no-form", weight: 0, ok: f.inputs.length === 0, required: true },
            { id: "not-top", weight: 0, ok: c.position > 0, required: true },
            {
                id: "not-landmark",
                weight: 0,
                ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
                required: true,
            },
        ];
    },
    // Depoimentos/avaliações (M7.8b): exige o GRUPO de cartões citação →
    // autoria (testimonialGroup), não um texto ou uma grade qualquer.
    testimonials: (f, c) => {
        const t = f.testimonials;
        return [
            { id: "testimonials:quote-author-cards", weight: 0.5, ok: Boolean(t) && t.count >= 2, required: true },
            { id: "testimonials:dominant-text", weight: 0.1, ok: Boolean(f.columnGroup) && f.columnGroup.textShare >= 0.6, required: true },
            { id: "testimonials:three-or-more", weight: 0.1, ok: Boolean(t) && t.count >= 3 },
            { id: "text:heading", weight: 0.1, ok: f.headings.length >= 1 },
            { id: "items:compact", weight: 0.1, ok: Boolean(t) && t.maxItemChars <= 800 },
            { id: "media:not-cover", weight: 0.1, ok: !f.coverMedia },
            { id: "no-disclosure", weight: 0, ok: !f.disclosure, required: true },
            { id: "no-form", weight: 0, ok: f.inputs.length === 0, required: true },
            { id: "not-top", weight: 0, ok: c.position > 0, required: true },
            {
                id: "not-landmark",
                weight: 0,
                ok: !["header", "footer", "nav"].includes(f.tag) && !["banner", "contentinfo", "navigation"].includes(f.role),
                required: true,
            },
        ];
    },
    footer: (f, c) => [
        { id: "landmark:contentinfo", weight: 0.4, ok: f.tag === "footer" || f.role === "contentinfo" },
        { id: "position:last", weight: 0.25, ok: c.position >= c.count - 2, required: true },
        { id: "links:many", weight: 0.2, ok: f.links >= 4 },
        { id: "columns:link-groups", weight: 0.15, ok: f.columns.columns >= 2 || f.links >= 8 },
    ],
};

const hintRules = {
    "image-with-text": (f) =>
        f.media.length >= 1 &&
        f.media.some((m) => m.box.width >= f.box.width * 0.25 && m.box.width <= f.box.width * 0.75) &&
        f.headings.length >= 1 &&
        !f.coverMedia,
    newsletter: (f) => f.hasEmailInput && f.buttons.length >= 1,
    "collection-list": (f) => Boolean(f.repeated) && f.repeated.imageShare >= 0.75 && f.repeated.priceShare < 0.5,
    multicolumn: (f) => Boolean(f.repeated) && f.repeated.columns >= 2 && f.repeated.imageShare < 0.75,
};

/**
 * Vetos que são EVIDÊNCIA de outro componente (acordeão, colunas
 * dominantes), não apenas falta de sinal: um viewport com esse veto
 * contradiz o tipo vetado vindo do outro viewport.
 */
export const STRUCTURAL_VETOES = ["no-disclosure", "no-dominant-columns", "no-testimonials"];


/**
 * @param {ReturnType<import("./structure.mjs").bandFeatures>} features
 * @param {Context} context
 */
export function classifyBand(features, context) {
    const scores = [];
    for (const type of SECTION_TYPES) {
        const signals = rules[type](features, context);
        const vetoed = signals.some((signal) => signal.required && !signal.ok);
        const score = vetoed ? 0 : signals.reduce((sum, signal) => sum + (signal.ok ? signal.weight : 0), 0);
        scores.push({
            type,
            score: round(score),
            vetoed,
            evidence: signals.filter((signal) => signal.ok && signal.weight > 0).map((signal) => signal.id),
            missing: signals.filter((signal) => !signal.ok).map((signal) => signal.id),
        });
    }
    scores.sort((a, b) => b.score - a.score || SECTION_TYPES.indexOf(a.type) - SECTION_TYPES.indexOf(b.type));

    const [best, second] = scores;
    const ambiguous = second && round(best.score - second.score) < 0.1 && second.score >= CLASSIFY_THRESHOLD;
    const known = best.score >= CLASSIFY_THRESHOLD && !ambiguous;

    // Hipóteses só interessam quando a faixa não foi reconhecida.
    const hints = known ? [] : HINT_TYPES.filter((type) => hintRules[type](features)).map((type) => ({ type, source: PROVIDER }));

    return {
        type: known ? best.type : "unknown",
        confidence: known ? best.score : round(1 - best.score),
        evidence: known ? best.evidence : [],
        candidates: scores.filter((score) => score.score >= 0.3).map(({ type, score }) => ({ type, score })),
        hints,
        reason: known ? null : ambiguous ? "ambiguous" : "insufficient-evidence",
        excludes: scores.filter((score) => score.missing.some((id) => STRUCTURAL_VETOES.includes(id))).map((score) => score.type),
    };
}

/**
 * Tipos em que o DESKTOP é decisivo: no mobile quase todo layout empilha
 * mídia e texto, então o empilhamento sozinho não prova o tipo.
 */
export const DESKTOP_DECISIVE_TYPES = ["image-with-text", "multicolumn"];

/**
 * Sinais de um tipo para uma faixa, com resultado e obrigatoriedade.
 * Usado para explicar decisões (relatório e testes); não classifica.
 */
export function evaluateType(type, features, context) {
    return rules[type](features, context).map(({ id, weight, ok, required }) => ({ id, weight, ok, required: Boolean(required) }));
}

/**
 * Combina as classificações do mesmo elemento em desktop e mobile.
 */
export function combineViewports(desktop, mobile) {
    if (desktop && mobile) {
        if (desktop.type === "unknown" && DESKTOP_DECISIVE_TYPES.includes(mobile.type)) {
            return { type: "unknown", confidence: desktop.confidence, agreement: "conflict" };
        }
        if (desktop.type === mobile.type) {
            return {
                type: desktop.type,
                confidence: round((desktop.confidence + mobile.confidence) / 2),
                agreement: "both",
            };
        }
        if (desktop.type === "unknown" || mobile.type === "unknown") {
            const known = desktop.type === "unknown" ? mobile : desktop;
            const other = known === mobile ? desktop : mobile;
            // O outro viewport tem evidência estrutural CONTRA o tipo.
            if (other.excludes?.includes(known.type)) return { type: "unknown", confidence: other.confidence, agreement: "conflict" };
            const confidence = round(known.confidence * 0.75);
            return confidence >= CLASSIFY_THRESHOLD * 0.8
                ? { type: known.type, confidence, agreement: desktop.type === "unknown" ? "mobile-only" : "desktop-only" }
                : { type: "unknown", confidence: round(1 - confidence), agreement: "conflict" };
        }
        return { type: "unknown", confidence: 0.5, agreement: "conflict" };
    }
    const single = desktop ?? mobile;
    return {
        type: single.type,
        confidence: round(single.confidence * (single.type === "unknown" ? 1 : 0.8)),
        agreement: desktop ? "desktop-only" : "mobile-only",
    };
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}
