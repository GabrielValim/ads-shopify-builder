/**
 * StoreBlueprint (v4; v1, v2 e v3 aceitos com migração explícita): representação
 * estruturada de uma homepage para reconstrução visual em Shopify.
 *
 * Princípios do contrato:
 *  - Nenhum texto, URL, nome de classe ou imagem da referência: apenas
 *    medidas, proporções, contagens, cores (#rrggbb), famílias de fonte
 *    sanitizadas e identificadores de vocabulário controlado.
 *  - Toda string livre passa por regex restritiva; objetos são `strict`.
 *  - Campos sem evidência são `null` e aparecem em `unknowns`.
 */

import { z } from "zod";

export const BLUEPRINT_SCHEMA_VERSION = 4;

/** Tipos do contrato v1 (M3). O v2 acrescenta image-with-text e newsletter. */
export const SECTION_TYPE_VALUES_V1 = ["announcement-bar", "header", "hero", "product-grid", "rich-text", "footer", "unknown"];
export const SECTION_TYPE_VALUES_V2 = ["announcement-bar", "header", "hero", "product-grid", "rich-text", "image-with-text", "newsletter", "footer", "unknown"];
/** v3 (M7.4): conteúdo expansível (acordeão/FAQ) e colunas (benefícios/números). */
export const SECTION_TYPE_VALUES_V3 = [...SECTION_TYPE_VALUES_V2.slice(0, -1), "collapsible-content", "multicolumn", "unknown"];
/** v4 (M7.8b): depoimentos/avaliações em cartões. */
export const SECTION_TYPE_VALUES = [...SECTION_TYPE_VALUES_V3.slice(0, -1), "testimonials", "unknown"];
export const HINT_TYPE_VALUES = ["image-with-text", "newsletter", "collection-list", "multicolumn"];

const hex = z.string().regex(/^#[0-9a-f]{6}$/);
const nhex = hex.nullable();
const pxValue = z.number().min(0).max(100_000);
const npx = pxValue.nullable();
const fraction = z.number().min(0).max(1);
const count = z.number().int().min(0).max(100_000);
const signal = z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,63}$/);
const family = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/);
const align = z.enum(["left", "center", "right", "justify"]).nullable();
const viewportName = z.enum(["desktop", "mobile"]);
const sectionId = z.string().regex(/^section-\d{2,3}$/);
const schemeId = z.string().regex(/^scheme-\d{1,2}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const box = z
    .object({ x: z.number().int(), y: z.number().int().min(0), width: z.number().int().min(0), height: z.number().int().min(0) })
    .strict();

const relativeBox = z.object({ x: fraction, y: fraction, width: fraction, height: fraction }).strict();

const image = z
    .object({
        role: z.enum(["background", "media", "product", "logo"]),
        kind: z.enum(["img", "video", "background"]),
        aspectRatio: z.number().positive().max(100),
        position: relativeBox,
    })
    .strict();

const presenceFor = (types) => z
    .object({
        order: z.number().int().min(0),
        box,
        paddingTopPx: npx,
        paddingBottomPx: npx,
        textAlign: align,
        columns: z.number().int().min(1).max(24),
        classification: z
            .object({
                type: z.enum(types),
                confidence: fraction,
                signals: z.array(signal).max(20),
            })
            .strict(),
        images: z.array(image).max(24),
    })
    .strict();

const content = z
    .object({
        headings: z.array(z.object({ level: z.number().int().min(1).max(6), chars: count, sizePx: npx }).strict()).max(40),
        paragraphs: count,
        textChars: count,
        buttons: z.array(z.object({ style: z.enum(["solid", "outline", "plain"]), chars: count }).strict()).max(20),
        links: count,
        inputs: z.array(z.enum(["email", "text", "search", "tel", "number", "password", "checkbox", "radio", "submit", "button", "select", "textarea", "other"])).max(20),
        icons: count,
    })
    .strict();

const perViewport = (schema) => z.object({ desktop: schema.nullable(), mobile: schema.nullable() }).strict();

// Campos do hero no v1 (congelados). O v2 acrescenta campos opcionais.
const heroBaseShape = () => ({
    heightPx: perViewport(count),
    background: z.enum(["image", "color", "gradient", "none"]),
    // Posição horizontal do bloco de conteúdo na seção.
    contentPosition: perViewport(z.enum(["left", "center", "right"])),
    // Alinhamento do texto dentro do bloco.
    contentAlignment: perViewport(z.enum(["left", "center", "right"])),
    verticalPosition: perViewport(z.enum(["top", "middle", "bottom"])),
    buttons: count,
    hasEyebrow: z.boolean(),
});

const detailsV1Shape = {
        announcement: z.object({ textAlign: align, hasLink: z.boolean() }).strict().optional(),
        header: z
            .object({
                logo: z.object({ kind: z.enum(["text", "image"]).nullable(), position: z.enum(["left", "center", "right"]).nullable() }).strict(),
                navigation: perViewport(z.enum(["inline", "drawer", "none"])),
                navItems: perViewport(count),
                sticky: z.boolean(),
                iconCount: count,
            })
            .strict()
            .optional(),
        hero: z.object(heroBaseShape()).strict().optional(),
        productGrid: z
            .object({
                columns: perViewport(z.number().int().min(1).max(12)),
                rows: perViewport(count),
                itemCount: count,
                gapPx: perViewport(pxValue),
                hasHeading: z.boolean(),
                hasViewAllLink: z.boolean(),
            })
            .strict()
            .optional(),
        richText: z.object({ alignment: align, maxWidthPx: npx, buttons: count }).strict().optional(),
        footer: z
            .object({ columns: perViewport(z.number().int().min(1).max(12)), linkCount: count, hasBottomRow: z.boolean() })
            .strict()
            .optional(),
};
const detailsV1 = z.object(detailsV1Shape).strict();

const layoutPosition = z.enum(["left", "right", "top", "bottom"]);
const detailsV2Shape = {
        ...detailsV1Shape,
        hero: z
            .object({
                ...heroBaseShape(),
                // M6.2 (opcionais; blueprints v2 anteriores continuam válidos):
                // altura do bloco de conteúdo e pintura do fundo medida no
                // screenshot (cores agregadas, nunca a imagem).
                contentHeightPx: perViewport(count).optional(),
                backgroundPaint: z
                    .object({
                        kind: z.enum(["solid", "gradient", "complex"]),
                        angleDeg: z.number().int().min(0).max(359).nullable(),
                        stops: z.array(z.object({ hex, position: fraction }).strict()).max(2),
                        fit: z.object({ cells: count, withinTolerance: fraction, meanDeltaE: z.number().min(0).max(300) }).strict(),
                        source: z.literal("screenshot-desktop"),
                    })
                    .strict()
                    .nullable()
                    .optional(),
            })
            .strict()
            .optional(),
        // Mídia + texto. Geometria por viewport; a imagem em si nunca entra
        // (só proporção e posição relativa em viewports.*.images).
        imageWithText: z
            .object({
                arrangement: perViewport(z.enum(["side-by-side", "stacked"])),
                mediaPosition: perViewport(layoutPosition),
                // Largura da mídia / largura do conjunto mídia + texto.
                mediaWidthShare: perViewport(fraction),
                mediaHeightPx: perViewport(count),
                mediaAspectRatio: z.number().positive().max(100),
                textVertical: perViewport(z.enum(["top", "middle", "bottom"])),
                contentAlignment: perViewport(z.enum(["left", "center", "right"])),
                gapPx: perViewport(pxValue),
                hasEyebrow: z.boolean(),
                buttons: count,
            })
            .strict()
            .optional(),
        // Inscrição por e-mail. Só estrutura do formulário: nenhum texto,
        // placeholder ou destino (action) da referência.
        newsletter: z
            .object({
                alignment: align,
                formLayout: perViewport(z.enum(["inline", "stacked"])),
                emailFields: count,
                consentFields: count,
                hasHeading: z.boolean(),
                hasText: z.boolean(),
                maxWidthPx: npx,
                buttons: count,
            })
            .strict()
            .optional(),
};
const detailsV2 = z.object(detailsV2Shape).strict();

// v3 (M7.4). Só estrutura e contagens: nenhum texto, pergunta, resposta ou
// rótulo da referência.
const detailsV3Shape = {
        ...detailsV2Shape,
        // M7.6 (aditivo, opcional): posição GEOMÉTRICA do bloco de texto na
        // faixa, independente do text-align — "full" quando o bloco ocupa
        // quase toda a faixa (posição não conclusiva).
        richText: z
            .object({
                alignment: align,
                maxWidthPx: npx,
                buttons: count,
                blockPosition: perViewport(z.enum(["left", "center", "right", "full"])).optional(),
            })
            .strict()
            .optional(),
        // Painéis expansíveis empilhados (acordeão/FAQ). `capturedPanels`:
        // painéis cujo conteúdo existia no DOM capturado — painel fechado e
        // ausente do DOM NÃO tem conteúdo conhecido.
        collapsibleContent: z
            .object({
                trigger: z.enum(["aria-expanded", "details"]),
                rows: z.number().int().min(2).max(60),
                openRows: count,
                firstRowOpen: z.boolean(),
                capturedPanels: count,
                panelContent: z.object({ paragraphs: count, listItems: count, links: count }).strict(),
                hasHeading: z.boolean(),
                headingAlignment: align,
                rowWidthPx: perViewport(count),
            })
            .strict()
            .optional(),
        // Itens repetidos em colunas (benefícios, ícones + texto, números).
        multicolumn: z
            .object({
                columns: perViewport(z.number().int().min(1).max(12)),
                itemCount: z.number().int().min(2).max(24),
                itemsWithIcon: count,
                itemsWithMedia: count,
                itemsWithTitle: count,
                // Itens cujo texto de maior destaque é essencialmente um número
                // (estatísticas): só a contagem, nunca o valor.
                itemsWithNumericLead: count,
                itemsWithLink: count,
                alignment: align,
                hasHeading: z.boolean(),
            })
            .strict()
            .optional(),
};
const detailsV3 = z.object(detailsV3Shape).strict();

// v4 (M7.8b). Depoimentos: só estrutura e contagens — nenhuma citação,
// nome, iniciais ou nota da referência. `null` = sem evidência uniforme.
const detailsV4 = z
    .object({
        ...detailsV3Shape,
        testimonials: z
            .object({
                itemCount: z.number().int().min(2).max(24),
                columns: perViewport(z.number().int().min(1).max(12)),
                itemsWithAuthor: count,
                // Linhas curtas de autoria por item (iguais em todos) ou null.
                authorLines: z.number().int().min(1).max(3).nullable(),
                // Avatar por item: imagem, círculo com texto curto, ou nenhum.
                avatar: z.object({ image: count, initials: count, none: count }).strict(),
                // Fileira de glifos iguais (ex.: estrelas) — NÃO é uma nota:
                // só presença e quantidade de glifos, quando uniforme.
                glyphs: z.object({ itemsWithRow: count, perItem: z.number().int().min(3).max(10).nullable() }).strict(),
                itemsWithDivider: count,
                quoteStyle: z.enum(["italic", "normal", "mixed"]),
                cardSurface: z.boolean(),
                hasHeading: z.boolean(),
                headingAlignment: align,
            })
            .strict()
            .optional(),
    })
    .strict();

const sectionFor = (types, details) => z
    .object({
        id: sectionId,
        type: z.enum(types),
        // Confiança no tipo atribuído. Para `unknown`, é a certeza de que
        // nenhum tipo conhecido se aplica (1 - melhor pontuação).
        confidence: fraction,
        // stacked-on-mobile: colunas no desktop (com evidência contra rich-text) que empilham no mobile (M7.9)
        agreement: z.enum(["both", "desktop-only", "mobile-only", "conflict", "stacked-on-mobile"]),
        unknownReason: z.enum(["insufficient-evidence", "ambiguous", "conflict"]).nullable(),
        hints: z.array(z.object({ type: z.enum(HINT_TYPE_VALUES), source: signal }).strict()).max(6),
        colorScheme: schemeId.nullable(),
        viewports: perViewport(presenceFor(types)),
        content,
        details,
    })
    .strict();

const buttonVariant = z
    .object({
        style: z.enum(["solid", "outline", "plain"]),
        radiusPx: npx,
        borderWidthPx: npx,
        paddingX: npx,
        paddingY: npx,
        fontWeight: z.number().int().min(1).max(1000).nullable(),
        textTransform: z.enum(["uppercase", "lowercase", "capitalize"]).nullable(),
        heightPx: npx,
        count,
        colors: z.array(z.object({ background: nhex, text: nhex, border: nhex, count }).strict()).max(10),
    })
    .strict();

const fontRole = z
    .object({
        family: family.nullable(),
        fallbacks: z.array(family).max(6),
        generic: family.nullable(),
        weights: z.array(z.number().int().min(1).max(1000)).max(10),
    })
    .strict();

const layout = z.object({ containerWidthPx: npx, gutterPx: npx, sectionPaddingPx: npx }).strict();

const blueprintShape = (version, types, details) => ({
        schemaVersion: z.literal(version),
        kind: z.literal("StoreBlueprint"),
        contentMode: z.literal("reference"),
        analyzer: z.object({ providers: z.array(signal).min(1).max(5), version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
        source: z
            .object({
                captureRunId: z.string().regex(/^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}$/),
                captureManifestSha256: sha256,
                inputs: z.array(z.object({ path: z.enum(["dom-desktop.json", "dom-mobile.json", "screenshot-desktop.png", "screenshot-mobile.png"]), sha256 }).strict()).length(4),
                viewports: z.object({
                    desktop: z.object({ width: count, height: count, pageHeight: count }).strict(),
                    mobile: z.object({ width: count, height: count, pageHeight: count }).strict(),
                }).strict(),
            })
            .strict(),
        tokens: z
            .object({
                colors: z
                    .object({
                        roles: z
                            .object({
                                background: nhex,
                                text: nhex,
                                mutedText: nhex,
                                primary: nhex,
                                onPrimary: nhex,
                                surface: nhex,
                                inverseBackground: nhex,
                            })
                            .strict(),
                        palette: z.array(z.object({ hex, share: fraction, usage: z.enum(["background", "text"]) }).strict()).max(16),
                    })
                    .strict(),
                colorSchemes: z
                    .array(
                        z
                            .object({
                                id: schemeId,
                                background: nhex,
                                backgroundMedia: z.enum(["none", "image", "gradient"]),
                                text: nhex,
                                button: nhex,
                                buttonLabel: nhex,
                                sections: z.array(sectionId).max(100),
                            })
                            .strict()
                    )
                    .max(12),
                typography: z
                    .object({
                        heading: fontRole.nullable(),
                        body: fontRole
                            .extend({
                                sizePx: perViewport(pxValue),
                                lineHeight: z.number().positive().max(5).nullable(),
                            })
                            .strict()
                            .nullable(),
                        scale: z
                            .array(
                                z
                                    .object({
                                        level: z.number().int().min(1).max(6),
                                        count,
                                        desktopPx: npx,
                                        mobilePx: npx,
                                        weight: z.number().int().min(1).max(1000).nullable(),
                                        lineHeight: z.number().positive().max(5).nullable(),
                                    })
                                    .strict()
                            )
                            .max(6),
                    })
                    .strict(),
                layout: perViewport(layout),
                buttons: z.array(buttonVariant).max(10),
                productCard: z
                    .object({
                        background: nhex,
                        radiusPx: npx,
                        paddingPx: npx,
                        borderWidthPx: npx,
                        shadow: z.boolean(),
                        textAlign: align,
                        image: z.object({ aspectRatio: z.number().positive().max(100), radiusPx: npx, fit: z.enum(["fill", "contain", "cover", "none", "scale-down"]).nullable() }).strict().nullable(),
                        hasBadge: z.boolean(),
                        hasPrice: z.boolean(),
                    })
                    .strict()
                    .nullable(),
                input: z.object({ radiusPx: npx, borderWidthPx: npx, borderColor: nhex, heightPx: npx }).strict().nullable(),
                // 1.8.0 (opcional): cartões de conteúdo medidos (colunas/depoimentos); ausente nos blueprints anteriores
                contentCards: z
                    .object({
                        background: nhex,
                        borderWidthPx: npx,
                        borderColor: nhex,
                        radiusPx: npx,
                        paddingPx: npx,
                        shadow: z.object({ xPx: z.number().min(-200).max(200), yPx: z.number().min(-200).max(200), blurPx: z.number().min(0).max(400), opacity: z.number().min(0).max(1) }).strict().nullable(),
                        sections: z.array(sectionId).min(1).max(60),
                    })
                    .strict()
                    .nullable()
                    .optional(),
            })
            .strict(),
        sections: z.array(sectionFor(types, details)).max(60),
        responsive: z
            .object({
                changes: z
                    .array(
                        z
                            .object({
                                sectionId,
                                property: z.enum(["columns", "layout", "navigation", "height", "alignment", "visibility"]),
                                desktop: z.union([z.string().regex(/^[a-z0-9-]{1,32}$/), z.number()]).nullable(),
                                mobile: z.union([z.string().regex(/^[a-z0-9-]{1,32}$/), z.number()]).nullable(),
                            })
                            .strict()
                    )
                    .max(200),
            })
            .strict(),
        unknowns: z
            .array(
                z
                    .object({
                        scope: z.string().regex(/^[a-zA-Z0-9.:_-]{1,96}$/),
                        reason: z.enum(["insufficient-evidence", "ambiguous", "conflict", "image-background", "not-observed", "single-viewport"]),
                    })
                    .strict()
            )
            .max(200),
        stats: z.object({ sections: count, recognized: count, unknown: count }).strict(),
});

function checkConsistency(blueprint, ctx) {
        const ids = new Set(blueprint.sections.map((s) => s.id));
        if (ids.size !== blueprint.sections.length) ctx.addIssue({ code: "custom", message: "ids de seção duplicados" });
        const schemes = new Set(blueprint.tokens.colorSchemes.map((s) => s.id));
        for (const s of blueprint.sections) {
            if (s.colorScheme && !schemes.has(s.colorScheme)) ctx.addIssue({ code: "custom", message: `esquema inexistente em ${s.id}` });
            if (!s.viewports.desktop && !s.viewports.mobile) ctx.addIssue({ code: "custom", message: `${s.id} sem viewport` });
            if (s.type === "unknown" && !s.unknownReason) ctx.addIssue({ code: "custom", message: `${s.id} unknown sem motivo` });
        }
        for (const scheme of blueprint.tokens.colorSchemes) {
            for (const id of scheme.sections) if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `esquema referencia ${id} inexistente` });
        }
        for (const change of blueprint.responsive.changes) {
            if (!ids.has(change.sectionId)) ctx.addIssue({ code: "custom", message: `mudança responsiva em ${change.sectionId} inexistente` });
        }
        const recognized = blueprint.sections.filter((s) => s.type !== "unknown").length;
        if (blueprint.stats.sections !== blueprint.sections.length || blueprint.stats.recognized !== recognized) {
            ctx.addIssue({ code: "custom", message: "estatísticas inconsistentes" });
        }
}

/** Contrato v1 (M3), mantido só para leitura e migração de análises antigas. */
export const storeBlueprintSchemaV1 = z.object(blueprintShape(1, SECTION_TYPE_VALUES_V1, detailsV1)).strict().superRefine(checkConsistency);

const migrationFieldV3 = z.object({ from: z.union([z.literal(1), z.literal(2)]), rule: z.literal("no-reclassification") }).strict().optional();
const migrationField = z.object({ from: z.union([z.literal(1), z.literal(2), z.literal(3)]), rule: z.literal("no-reclassification") }).strict().optional();

/** Contrato v2 (M3–M7.3), mantido só para leitura e migração. */
export const storeBlueprintSchemaV2 = z
    .object({
        ...blueprintShape(2, SECTION_TYPE_VALUES_V2, detailsV2),
        migration: z.object({ from: z.literal(1), rule: z.literal("no-reclassification") }).strict().optional(),
    })
    .strict()
    .superRefine(checkConsistency);

/**
 * v3: os detalhes novos pertencem ao seu tipo (e o tipo exige o detalhe), e
 * as contagens são coerentes entre si. Só no contrato atual: os históricos
 * nunca têm esses tipos.
 */
function checkV3Details(blueprint, ctx) {
    const issue = (message) => ctx.addIssue({ code: "custom", message });
    for (const s of blueprint.sections) {
        for (const [type, key] of [["collapsible-content", "collapsibleContent"], ["multicolumn", "multicolumn"]]) {
            if ((s.type === type) !== Boolean(s.details[key])) issue(`${s.id}: details.${key} só existe (e é obrigatório) em ${type}`);
        }
        const c = s.details.collapsibleContent;
        if (c) {
            if (c.openRows > c.rows) issue(`${s.id}: openRows > rows`);
            if (c.capturedPanels > c.openRows) issue(`${s.id}: painel capturado sem linha aberta`);
            if (c.firstRowOpen && c.openRows === 0) issue(`${s.id}: firstRowOpen sem linha aberta`);
            if (c.capturedPanels === 0 && Object.values(c.panelContent).some((n) => n > 0)) issue(`${s.id}: conteúdo de painel sem painel capturado`);
        }
        const m = s.details.multicolumn;
        if (m) {
            for (const key of ["itemsWithIcon", "itemsWithMedia", "itemsWithTitle", "itemsWithNumericLead", "itemsWithLink"]) {
                if (m[key] > m.itemCount) issue(`${s.id}: ${key} > itemCount`);
            }
            if (m.columns.desktop === null && m.columns.mobile === null) issue(`${s.id}: colunas não observadas em nenhum viewport`);
            for (const viewport of ["desktop", "mobile"]) {
                if (m.columns[viewport] !== null && m.columns[viewport] > m.itemCount) issue(`${s.id}: mais colunas que itens (${viewport})`);
            }
        }
    }
}

/** Contrato v3 (M7.4–M7.6), mantido só para leitura e migração. */
export const storeBlueprintSchemaV3 = z
    .object({
        ...blueprintShape(3, SECTION_TYPE_VALUES_V3, detailsV3),
        migration: migrationFieldV3,
    })
    .strict()
    .superRefine(checkConsistency)
    .superRefine(checkV3Details);

/** v4: depoimentos — detalhe exige o tipo e vice-versa; contagens coerentes. */
function checkV4Details(blueprint, ctx) {
    const issue = (message) => ctx.addIssue({ code: "custom", message });
    for (const s of blueprint.sections) {
        if ((s.type === "testimonials") !== Boolean(s.details.testimonials)) issue(`${s.id}: details.testimonials só existe (e é obrigatório) em testimonials`);
        const t = s.details.testimonials;
        if (!t) continue;
        for (const value of [t.itemsWithAuthor, t.glyphs.itemsWithRow, t.itemsWithDivider]) if (value > t.itemCount) issue(`${s.id}: contagem maior que itemCount`);
        if (t.avatar.image + t.avatar.initials + t.avatar.none !== t.itemCount) issue(`${s.id}: avatares não somam itemCount`);
        if (t.glyphs.itemsWithRow === 0 && t.glyphs.perItem !== null) issue(`${s.id}: glifos por item sem fileira de glifos`);
        if (t.columns.desktop === null && t.columns.mobile === null) issue(`${s.id}: colunas não observadas em nenhum viewport`);
        for (const viewport of ["desktop", "mobile"]) {
            if (t.columns[viewport] !== null && t.columns[viewport] > t.itemCount) issue(`${s.id}: mais colunas que itens (${viewport})`);
        }
    }
}

/** Contrato atual (v4). `migration` só existe em blueprints migrados. */
export const storeBlueprintSchema = z
    .object({
        ...blueprintShape(BLUEPRINT_SCHEMA_VERSION, SECTION_TYPE_VALUES, detailsV4),
        migration: migrationField,
    })
    .strict()
    .superRefine(checkConsistency)
    .superRefine(checkV3Details)
    .superRefine(checkV4Details);

/**
 * Migração para a versão atual SEM reinterpretação: nenhuma seção é
 * reclassificada (unknown continua unknown, rich-text continua rich-text,
 * hipóteses continuam só hipóteses), nenhum detalhe é inferido. Muda apenas
 * a versão, e a versão de origem fica registrada.
 */
export function migrateBlueprintV1(v1) {
    return { ...structuredClone(v1), schemaVersion: BLUEPRINT_SCHEMA_VERSION, migration: { from: 1, rule: "no-reclassification" } };
}

export function migrateBlueprintV2(v2) {
    // Um v2 já migrado do v1 mantém a origem mais antiga.
    return { ...structuredClone(v2), schemaVersion: BLUEPRINT_SCHEMA_VERSION, migration: { from: v2.migration?.from ?? 2, rule: "no-reclassification" } };
}

export function migrateBlueprintV3(v3) {
    // Um v3 já migrado do v1/v2 mantém a origem mais antiga.
    return { ...structuredClone(v3), schemaVersion: BLUEPRINT_SCHEMA_VERSION, migration: { from: v3.migration?.from ?? 3, rule: "no-reclassification" } };
}

/**
 * Lê um blueprint de qualquer versão suportada. Versão desconhecida ou
 * ausente é recusada (nunca adivinhada).
 * @returns {{ success: true, data: StoreBlueprint, version: number, migratedFrom: number | null } | { success: false, error: import("zod").ZodError | null, message: string }}
 */
export function parseStoreBlueprint(data) {
    const version = data && typeof data === "object" ? data.schemaVersion : undefined;
    if (version === BLUEPRINT_SCHEMA_VERSION) {
        const parsed = storeBlueprintSchema.safeParse(data);
        return parsed.success ? { success: true, data: parsed.data, version, migratedFrom: null } : { success: false, error: parsed.error, message: "blueprint v4 fora do contrato" };
    }
    if (version === 3) {
        const parsed = storeBlueprintSchemaV3.safeParse(data);
        if (!parsed.success) return { success: false, error: parsed.error, message: "blueprint v3 fora do contrato" };
        const migrated = storeBlueprintSchema.safeParse(migrateBlueprintV3(parsed.data));
        return migrated.success ? { success: true, data: migrated.data, version: 3, migratedFrom: parsed.data.migration?.from ?? 3 } : { success: false, error: migrated.error, message: "migração v3 -> v4 inválida" };
    }
    if (version === 2) {
        const parsed = storeBlueprintSchemaV2.safeParse(data);
        if (!parsed.success) return { success: false, error: parsed.error, message: "blueprint v2 fora do contrato" };
        const migrated = storeBlueprintSchema.safeParse(migrateBlueprintV2(parsed.data));
        return migrated.success ? { success: true, data: migrated.data, version: 2, migratedFrom: parsed.data.migration?.from ?? 2 } : { success: false, error: migrated.error, message: "migração v2 -> v4 inválida" };
    }
    if (version === 1) {
        const parsed = storeBlueprintSchemaV1.safeParse(data);
        if (!parsed.success) return { success: false, error: parsed.error, message: "blueprint v1 fora do contrato" };
        const migrated = storeBlueprintSchema.safeParse(migrateBlueprintV1(parsed.data));
        return migrated.success ? { success: true, data: migrated.data, version: 1, migratedFrom: 1 } : { success: false, error: migrated.error, message: "migração v1 -> v4 inválida" };
    }
    return { success: false, error: null, message: `versão de blueprint não suportada: ${JSON.stringify(version)}` };
}

/** @typedef {z.infer<typeof storeBlueprintSchema>} StoreBlueprint */
