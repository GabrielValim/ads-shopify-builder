/**
 * Catálogo de fontes da biblioteca Shopify com EVIDÊNCIA registrada.
 *
 * Um handle só entra aqui com fonte de verificação. Dois níveis, separados:
 *  - `verification`: por que acreditamos que o handle existe (documentação
 *    oficial, ou valor já aceito por uma loja);
 *  - `storeConfirmation`: se a loja de destino JÁ ACEITOU o handle
 *    ("accepted") ou se isso depende de uma operação posterior ("pending").
 * O Theme Check local NÃO é evidência de disponibilidade: ele só conhece
 * handles descontinuados.
 *
 * Sem entrada para a intenção do blueprint, o gerador mantém a fonte atual
 * do tema e registra a dependência — nunca presume que uma fonte existe.
 *
 * Para incluir uma fonte: handle `<familia>_<estilo><peso>` (n4 = normal 400,
 * n7 = normal 700), família, classe genérica, estilo, peso, evidência (como e
 * quando) e estado de confirmação na loja; com teste correspondente.
 */

const SHOPIFY_FONTS_DOC = "https://shopify.dev/docs/storefronts/themes/architecture/settings/fonts#available-fonts";

const documented = (handle, family, generic, weight, extra = {}) =>
    Object.freeze({
        handle,
        family,
        generic,
        style: "normal",
        weight,
        verification: Object.freeze({
            method: "official-documentation",
            source: SHOPIFY_FONTS_DOC,
            evidence: `handle "${handle}" listado na tabela "Available fonts" (fontes "free to use on all Shopify online stores")`,
            date: "2026-10-13",
            ...extra,
        }),
        storeConfirmation: "pending",
    });

export const FONT_CATALOG = Object.freeze([
    Object.freeze({
        handle: "assistant_n4",
        family: "Assistant",
        generic: "sans-serif",
        style: "normal",
        weight: 400,
        verification: Object.freeze({
            method: "accepted-by-shopify",
            source: "loja de desenvolvimento do projeto",
            evidence: "padrão do Dawn 16.0.0 (settings_schema) e valor aceito pela Shopify (pulls auditados de temas da loja de desenvolvimento do projeto)",
            date: "2026-10-13",
        }),
        storeConfirmation: "accepted",
    }),
    // Merriweather: pesos 3 a 9 (normal e itálico) na tabela oficial; aqui só
    // os usados. A tabela de fontes descontinuadas indica Merriweather como
    // substituta de Georgia Pro — registrado como evidência, NÃO como regra
    // de seleção (a escolha vem da intenção do blueprint).
    documented("merriweather_n4", "Merriweather", "serif", 400, { note: "substituta indicada pela Shopify para Georgia Pro (tabela Deprecated fonts)" }),
    documented("merriweather_n7", "Merriweather", "serif", 700, { note: "substituta indicada pela Shopify para Georgia Pro (tabela Deprecated fonts)" }),
    // 1.8.0 (consulta à tabela "Available fonts" em 2026-10-28): sans com pesos de título e de corpo.
    // Inter: preferida para pilhas de fonte do SISTEMA (ui-sans-serif/system-ui), por ser a sans de interface do catálogo.
    documented("inter_n4", "Inter", "sans-serif", 400, { date: "2026-10-28" }),
    documented("inter_n6", "Inter", "sans-serif", 600, { date: "2026-10-28" }),
    documented("inter_n7", "Inter", "sans-serif", 700, { date: "2026-10-28" }),
    documented("jost_n4", "Jost", "sans-serif", 400, { date: "2026-10-28" }),
    documented("jost_n5", "Jost", "sans-serif", 500, { date: "2026-10-28" }),
    documented("jost_n6", "Jost", "sans-serif", 600, { date: "2026-10-28" }),
    documented("jost_n7", "Jost", "sans-serif", 700, { date: "2026-10-28" }),
]);

/** Família do catálogo preferida quando a referência usa só a pilha de fontes do SISTEMA (classe genérica). */
export const SYSTEM_STACK_PREFERENCE = Object.freeze({ "sans-serif": "Inter" });

const HANDLE = /^[a-z0-9]+(?:_[a-z0-9]+)*_[ni][1-9]$/;
const METHODS = new Set(["official-documentation", "accepted-by-shopify"]);

/**
 * Integridade do catálogo: handle no formato, evidência completa, estado de
 * confirmação válido, sem duplicatas e sem handles descontinuados.
 * @param {readonly any[]} catalog
 * @param {{ deprecatedHandles?: Iterable<string> }} [options]
 * @returns {string[]} problemas
 */
export function validateCatalog(catalog, { deprecatedHandles = [] } = {}) {
    const problems = [];
    const deprecated = new Set(deprecatedHandles);
    const seen = new Set();
    for (const entry of catalog) {
        const id = entry?.handle ?? "?";
        if (!HANDLE.test(entry?.handle ?? "")) problems.push(`${id}: handle fora do formato`);
        if (seen.has(id)) problems.push(`${id}: duplicado`);
        seen.add(id);
        if (deprecated.has(id)) problems.push(`${id}: handle descontinuado pela Shopify`);
        if (!entry?.family || !["serif", "sans-serif", "monospace", "cursive", "fantasy"].includes(entry?.generic)) problems.push(`${id}: família/classe ausente`);
        const weight = Number(id.slice(-1)) * 100;
        if (entry?.weight !== weight || entry?.style !== (id.at(-2) === "i" ? "italic" : "normal")) problems.push(`${id}: peso/estilo não correspondem ao handle`);
        const v = entry?.verification;
        if (!v || !METHODS.has(v.method) || !v.source || !v.evidence || !/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? "")) problems.push(`${id}: evidência de verificação insuficiente`);
        if (!["pending", "accepted"].includes(entry?.storeConfirmation)) problems.push(`${id}: estado de confirmação inválido`);
        if (entry?.storeConfirmation === "accepted" && v?.method !== "accepted-by-shopify") problems.push(`${id}: "accepted" exige aceite registrado da loja`);
    }
    return problems;
}

// O catálogo do projeto precisa ser íntegro para ser usado.
const ownProblems = validateCatalog(FONT_CATALOG);
if (ownProblems.length) throw new Error(`Catálogo de fontes inválido: ${ownProblems.join("; ")}`);

const normalize = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Fonte do catálogo para uma intenção tipográfica do blueprint.
 *  - "exact": a família da referência (ou um fallback declarado) está no catálogo;
 *  - "generic-equivalent": mesma classe genérica (serif, sans-serif, ...);
 *  - "none": sem equivalente (o tema mantém a fonte atual).
 * Entre candidatos, vence o peso mais próximo do mais pesado observado; empate
 * pelo handle (determinístico). Evidências como "substituta de Georgia Pro"
 * NÃO influenciam a escolha.
 * @param {{ family: string | null, fallbacks?: string[], generic: string | null, weights?: number[] } | null} intent
 */
export function matchFont(intent, catalog = FONT_CATALOG, { role = null } = {}) {
    if (!intent) return { match: "none", reason: "no-evidence", entry: null };
    // Peso-alvo: títulos → o mais pesado observado; corpo → 400 se observado (peso dominante do texto corrido), senão o menor.
    const weights = intent.weights ?? [];
    const target = role === "body" && weights.length ? (weights.includes(400) ? 400 : Math.min(...weights)) : Math.max(0, ...weights) || 400;
    const closest = (entries) =>
        [...entries].sort((a, b) => Math.abs(a.weight - target) - Math.abs(b.weight - target) || (a.handle < b.handle ? -1 : 1))[0];

    for (const family of [intent.family, ...(intent.fallbacks ?? [])].filter(Boolean)) {
        const same = catalog.filter((entry) => normalize(entry.family) === normalize(family));
        if (same.length) return { match: "exact", reason: family === intent.family ? "family" : "fallback-family", entry: closest(same) };
    }
    if (!intent.generic) return { match: "none", reason: "no-generic-class", entry: null };
    const equivalent = catalog.filter((entry) => entry.generic === intent.generic);
    // Só a classe genérica (pilha do sistema): família preferida declarada, se estiver no catálogo.
    const systemOnly = intent.family && normalize(intent.family) === normalize(intent.generic);
    const preferred = systemOnly && SYSTEM_STACK_PREFERENCE[intent.generic] ? equivalent.filter((entry) => entry.family === SYSTEM_STACK_PREFERENCE[intent.generic]) : [];
    if (preferred.length) return { match: "generic-equivalent", reason: `${intent.generic} (pilha do sistema → ${SYSTEM_STACK_PREFERENCE[intent.generic]})`, entry: closest(preferred) };
    if (equivalent.length) return { match: "generic-equivalent", reason: intent.generic, entry: closest(equivalent) };
    return { match: "none", reason: `no-verified-${intent.generic}`, entry: null };
}

/** Handle presente no catálogo (com evidência)? (validação do plano) */
export function isVerifiedFont(handle, catalog = FONT_CATALOG) {
    return catalog.some((entry) => entry.handle === handle);
}

/** Entrada do catálogo para um handle, ou null. */
export function catalogEntry(handle, catalog = FONT_CATALOG) {
    return catalog.find((entry) => entry.handle === handle) ?? null;
}
