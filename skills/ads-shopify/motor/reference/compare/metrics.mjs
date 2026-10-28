/**
 * Métricas, achados e pontuação da comparação visual (funções puras).
 *
 * Pontuação por seção e viewport (0..1):
 *   score = 0.35 × estrutura(mascarada) + 0.35 × cor(mascarada) + 0.30 × geometria
 *   geometria = max(0, 1 − |Δaltura| / altura_referência)
 *   "mascarada" = células de imagem (referência e candidato) excluídas, para
 *   separar diferenças de layout das causadas por imagens ausentes.
 * Pontuação do viewport = média ponderada pela altura de referência das
 * seções comparadas. Seções não geradas ficam FORA da pontuação e entram
 * na cobertura (altura comparada / altura total da referência).
 */

export const SCORE_WEIGHTS = Object.freeze({ structure: 0.35, color: 0.35, geometry: 0.3 });
export const TOLERANCE = Object.freeze({ heightRatio: 0.1, headingRatio: 0.1, deltaE: 5, imageEffect: 0.05 });

export const CATEGORIES = Object.freeze({
    "dawn-limitation": "Incompatibilidade/limitação do Dawn",
    "blueprint-gap": "Propriedade ausente no blueprint",
    "not-implemented": "Recurso ainda não implementado",
    "conversion-issue": "Problema real de conversão",
});

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);

export function geometryScore(reference, candidate) {
    if (!reference?.height) return null;
    return round(Math.max(0, 1 - Math.abs(candidate.height - reference.height) / reference.height));
}

export function sectionScore({ structure, color, geometry }) {
    if ([structure, color, geometry].some((value) => value === null || value === undefined)) return null;
    return round(SCORE_WEIGHTS.structure * structure + SCORE_WEIGHTS.color * color + SCORE_WEIGHTS.geometry * geometry);
}

/** Média ponderada pela altura de referência. */
export function viewportScore(entries) {
    let weight = 0;
    let sum = 0;
    for (const entry of entries) {
        if (entry.score === null) continue;
        sum += entry.score * entry.referenceHeight;
        weight += entry.referenceHeight;
    }
    return weight ? round(sum / weight) : null;
}

/** Família genérica a partir de uma pilha de fontes computada. */
export function genericFamily(stack) {
    const value = String(stack ?? "").toLowerCase();
    const first = value.split(",")[0]?.replace(/["']/g, "").trim() ?? "";
    if (/\bmono/.test(first)) return "monospace";
    if (/serif/.test(first) && !/sans/.test(first)) return "serif";
    if (/(georgia|times|garamond|playfair|lora|merriweather|baskerville|serif$)/.test(first)) return "serif";
    if (value.includes("sans-serif") || /sans|arial|helvetica|assistant|inter|roboto/.test(first)) return "sans-serif";
    if (/\bserif\b/.test(value)) return "serif";
    return "unknown";
}

/**
 * Classifica uma divergência medida usando o que o plano já declarou.
 * @param {object} record registro da seção no plano (fidelity, ignored, dependencies)
 * @param {string} aspect
 */
export function categorize(record, aspect, { viewport, globalFidelity = [], heightDelta = null } = {}) {
    const declared = (record?.fidelity ?? []).map((item) => item.aspect);
    const dependencies = (record?.dependencies ?? []).map((item) => item.kind);
    switch (aspect) {
        case "height":
            if (declared.includes("height")) return { category: "dawn-limitation", explanation: "alturas fixas do image-banner (small/medium/large)" };
            if (viewport === "mobile" && declared.includes("padding-mobile")) {
                // O padding reduzido só explica alturas MENORES, em magnitude compatível.
                const item = record.fidelity.find((entry) => entry.aspect === "padding-mobile");
                const predicted = (Number(item.achieved) - Number(item.expected)) * 2;
                const plausible = heightDelta === null || (Math.sign(heightDelta) === Math.sign(predicted) && Math.abs(heightDelta) <= Math.abs(predicted) * 2 + 8);
                if (plausible) return { category: "dawn-limitation", explanation: `Dawn aplica 75% do padding no mobile (previsto ${predicted}px)` };
                return { category: "conversion-issue", explanation: `altura diverge ${heightDelta}px; o padding do Dawn previa ${predicted}px` };
            }
            if (dependencies.includes("collection")) return { category: "not-implemented", explanation: "conteúdo da coleção depende de produtos publicados" };
            return { category: "conversion-issue", explanation: "altura diverge sem causa declarada" };
        case "heading-size":
            if (declared.includes("heading-size") || record?.target?.type === "featured-collection" || record?.target?.type === "rich-text") {
                return { category: "dawn-limitation", explanation: "tamanhos de título por nível fixo e escala única (heading_scale)" };
            }
            return { category: "conversion-issue", explanation: "tamanho de título diverge sem causa declarada" };
        case "font-family":
            if (globalFidelity.some((item) => item.aspect === "fonts")) return { category: "not-implemented", explanation: "fonte equivalente ainda não escolhida na biblioteca da Shopify" };
            return { category: "conversion-issue", explanation: "família tipográfica diverge" };
        case "image":
            if (dependencies.includes("image")) return { category: "not-implemented", explanation: "imagem autorizada pendente de upload; o tema mostra placeholder" };
            if (dependencies.includes("collection")) return { category: "not-implemented", explanation: "imagens dos produtos dependem da coleção/produtos na loja" };
            return { category: "conversion-issue", explanation: "diferença atribuída a mídia sem dependência declarada" };
        case "background-image":
            return { category: "not-implemented", explanation: "fundo em imagem na referência; imagem pendente" };
        case "missing-section":
            return { category: "conversion-issue", explanation: "seção gerada não encontrada na renderização" };
        default:
            return { category: "conversion-issue", explanation: `${aspect} diverge` };
    }
}

/** Recomendações priorizadas por impacto estimado (fração da página afetada). */
export function recommend(findings, sections) {
    const byKey = new Map();
    const add = (key, text, category, impact, refs) => {
        const entry = byKey.get(key) ?? { text, category, impact: 0, sections: new Set() };
        entry.impact += impact;
        refs.forEach((ref) => entry.sections.add(ref));
        byKey.set(key, entry);
    };
    for (const section of sections) {
        if (section.status === "unsupported") {
            const hint = section.hints?.[0] ?? "tipo desconhecido";
            add(`support:${hint}`, `Implementar reconhecimento e conversão de "${hint}" (hoje não gerada)`, "not-implemented", section.referenceShare ?? 0, [section.blueprintSectionId]);
        }
    }
    for (const finding of findings) {
        // Seções não geradas já entram pela lista de seções (acima).
        if (finding.aspect === "section") continue;
        const share = finding.referenceShare ?? 0;
        const loss = finding.loss ?? 0.1;
        const text = {
            image: "Enviar imagens autorizadas (hero e produtos) e configurar os campos de imagem — exige operação remota autorizada",
            "background-image": "Enviar imagem autorizada para o fundo do hero — exige operação remota autorizada",
            "font-family": "Escolher na Shopify fontes equivalentes às da referência (serifada nos títulos)",
            height: finding.category === "dawn-limitation" ? "Avaliar CSS/seção customizada para alturas e espaçamentos fora das opções do Dawn (mudança de arquitetura)" : "Corrigir conversão de alturas/espaçamentos",
            "heading-size": "Avaliar escala tipográfica por seção (o Dawn usa escala única) — mudança de arquitetura",
            columns: "Corrigir mapeamento de colunas da grade",
            "background-color": "Corrigir mapeamento de cor de fundo",
            "text-color": "Corrigir mapeamento de cor de texto",
            buttons: "Corrigir mapeamento de botões",
            "missing-section": "Investigar seção gerada ausente na renderização",
        }[finding.aspect] ?? `Revisar ${finding.aspect}`;
        add(`${finding.aspect}:${finding.category}`, text, finding.category, share * loss, [finding.section]);
    }
    return [...byKey.values()]
        .map((entry) => ({ ...entry, impact: round(entry.impact), sections: [...entry.sections].sort() }))
        .sort((a, b) => b.impact - a.impact || (a.text < b.text ? -1 : 1))
        .map((entry, i) => ({ priority: i + 1, ...entry }));
}
