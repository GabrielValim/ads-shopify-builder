/**
 * ContentPack (v2; v1 aceito com migração explícita): conteúdo AUTORIZADO
 * que alimenta as seções geradas.
 *
 * O blueprint (modo reference) não traz textos nem imagens; o conteúdo
 * vem daqui, com base de autorização declarada. Sem pacote, o gerador
 * usa placeholders neutros próprios e os marca como tal no relatório.
 *
 * Imagens (v2): cada slot registra arquivo, autorização de uso, operações
 * (permissões futuras E fatos já realizados, separados) e o upload verificado
 * numa loja. A referência Shopify só entra no tema gerado para a loja de
 * destino em que foi verificada; fora isso, o placeholder do Dawn.
 */

import { z } from "zod";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { readStandaloneFile, sha256 } from "../core/safe-read.mjs";
import { HANDLE, SAFE_URL } from "./dawn-schema.mjs";

// Texto simples: sem marcação nem caracteres de controle.
const plain = (max) =>
    z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !/[<>\u0000-\u001f\u007f]/.test(value), "texto não pode conter marcação ou caracteres de controle");

const link = z.string().max(200).refine((value) => SAFE_URL.test(value), "link deve ser interno (/caminho) ou shopify://");
const button = z.object({ label: plain(40), link }).strict();
const handle = z.string().regex(HANDLE);

const imageSlot = z
    .object({
        status: z.enum(["pending-upload"]),
        description: plain(200),
    })
    .strict();

// --- v2: procedência de ativos visuais ---------------------------------------
// Estados SEPARADOS (nenhum implica o outro):
//  1. arquivo local validado   -> `source` (+ `derivatives`) com hash e dimensões;
//  2. arquivo autorizado        -> `authorization.status = "authorized"`;
//  3. upload verificado         -> `shopify.status = "uploaded-verified"`, com a
//     referência OBTIDA na Shopify (nunca construída pelo gerador);
//  4. imagem resolvida no tema  -> decisão do gerador (só com 2 e 3), conferida
//     pelo verify-theme.
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Caminho relativo à raiz do projeto, POSIX, sem "..", sem raiz absoluta.
export const ASSET_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/;
export const ASSET_MIME = ["image/svg+xml", "image/png", "image/webp", "image/jpeg"];
// Formato esperado do valor de image_picker; a referência só é aceita quando
// registrada a partir de evidência remota (auditoria pós-upload).
export const SHOPIFY_IMAGE_REFERENCE = /^shopify:\/\/shop_images\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// Loja Shopify pelo domínio canônico (subdomínio myshopify; referências de
// shop_images só valem na loja em que o arquivo foi enviado).
export const STORE_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const storeDomain = z.string().regex(STORE_DOMAIN);

// Derivados reconstruíveis ficam num endereço que depende só do conteúdo:
// mesmo caminho em qualquer máquina, sem carimbo de data nem run.
export const ASSET_STORE_ROOT = "runs/assets/sha256";
export const ASSET_EXTENSION = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };
export const contentAddressedPath = (sha256, mime) => `${ASSET_STORE_ROOT}/${sha256}.${ASSET_EXTENSION[mime]}`;

const assetFile = {
    path: z.string().regex(ASSET_PATH),
    sha256: sha,
    mime: z.enum(ASSET_MIME),
    bytes: z.number().int().min(1).max(20 * 1024 * 1024),
    width: z.number().int().min(1).max(10000),
    height: z.number().int().min(1).max(10000),
};

const imageSlotV2 = z
    .object({
        description: plain(200),
        source: z
            .object({
                ...assetFile,
                origin: z.object({ kind: z.enum(["project-authored", "client-provided", "licensed"]), reference: plain(300) }).strict(),
            })
            .strict()
            .nullable(),
        derivatives: z
            .array(
                z
                    .object({
                        ...assetFile,
                        fromSha256: sha,
                        tool: plain(160),
                        // Como refazer o derivado a partir da origem versionada.
                        recipe: z.object({ kind: z.literal("rasterize-svg"), scale: z.number().positive().max(4) }).strict().optional(),
                    })
                    .strict()
            )
            .max(4),
        authorization: z.discriminatedUnion("status", [
            z.object({ status: z.literal("pending"), note: plain(300).optional() }).strict(),
            z
                .object({
                    status: z.literal("authorized"),
                    basis: z.enum(["own-content", "client-provided", "licensed"]),
                    grantedBy: plain(120),
                    // Fundamento verificável da autorização (onde e como foi dada).
                    evidence: plain(300),
                    date: isoDate,
                    scope: plain(200),
                    restrictions: z.array(plain(200)).min(1).max(10),
                    // Arquivos EXATOS autorizados: outro arquivo no mesmo slot não
                    // herda a autorização.
                    covers: z.array(sha).min(1).max(5),
                })
                .strict(),
        ]),
        // Operações, separadas da autorização de uso (autorizar o ativo não
        // autoriza enviá-lo a lugar nenhum):
        //  - "authorized": PERMISSÃO para executar uma operação (futura);
        //  - "performed": REGISTRO de uma operação já realizada por uma pessoa
        //    (ex.: upload manual no Admin). Não concede permissão nenhuma.
        operations: z
            .array(
                z.discriminatedUnion("status", [
                    z
                        .object({
                            kind: z.literal("upload"),
                            status: z.literal("authorized"),
                            target: plain(120),
                            // Opcional só por compatibilidade: sem loja, a
                            // permissão não vale para nenhuma loja específica.
                            store: storeDomain.optional(),
                            fileSha256: sha,
                            grantedBy: plain(120),
                            date: isoDate,
                            evidence: plain(300),
                        })
                        .strict(),
                    z
                        .object({
                            kind: z.literal("upload"),
                            status: z.literal("performed"),
                            method: z.enum(["shopify-admin-manual"]),
                            store: storeDomain,
                            fileSha256: sha,
                            // Nome com que o arquivo foi enviado (como a pessoa o selecionou).
                            filename: plain(200),
                            performedBy: plain(120),
                            date: isoDate,
                            evidence: plain(600),
                        })
                        .strict(),
                ])
            )
            .max(20)
            .default([]),
        shopify: z.discriminatedUnion("status", [
            z.object({ status: z.literal("not-uploaded") }).strict(),
            z
                .object({
                    status: z.literal("uploaded-verified"),
                    // Loja em que a referência foi OBSERVADA. Opcional só por
                    // compatibilidade; sem loja, a referência nunca é usada.
                    store: storeDomain.optional(),
                    reference: z.string().regex(SHOPIFY_IMAGE_REFERENCE),
                    fileSha256: sha,
                    verifiedAt: isoDate,
                    evidence: plain(600),
                })
                .strict(),
        ]),
        migratedFrom: z.literal("pending-upload").optional(),
    })
    .strict()
    .superRefine((slot, ctx) => {
        for (const item of slot.derivatives) {
            if (!slot.source || item.fromSha256 !== slot.source.sha256) ctx.addIssue({ code: "custom", message: `derivado ${item.path} não vem da origem registrada` });
            if (item.path.startsWith(`${ASSET_STORE_ROOT}/`) && item.path !== contentAddressedPath(item.sha256, item.mime)) {
                ctx.addIssue({ code: "custom", message: `derivado ${item.path} fora do endereço do próprio conteúdo` });
            }
            if (item.recipe?.kind === "rasterize-svg" && (slot.source?.mime !== "image/svg+xml" || item.mime !== "image/png")) {
                ctx.addIssue({ code: "custom", message: `receita rasterize-svg exige origem SVG e derivado PNG (${item.path})` });
            }
        }
        for (const operation of slot.operations) {
            if (slot.authorization.status !== "authorized" || !slot.authorization.covers.includes(operation.fileSha256)) {
                ctx.addIssue({ code: "custom", message: `${operation.status === "performed" ? "registro" : "permissão"} de ${operation.kind} para arquivo sem autorização de uso` });
            }
        }
        if (slot.authorization.status === "authorized") {
            if (!slot.source) ctx.addIssue({ code: "custom", message: "autorização exige arquivo de origem registrado" });
            const known = new Set([slot.source, ...slot.derivatives].filter(Boolean).map((item) => item.sha256));
            for (const hash of slot.authorization.covers) if (!known.has(hash)) ctx.addIssue({ code: "custom", message: `autorização cobre arquivo não registrado no slot: ${hash.slice(0, 12)}` });
            if (slot.source && !slot.authorization.covers.includes(slot.source.sha256)) ctx.addIssue({ code: "custom", message: "autorização precisa cobrir o arquivo de origem" });
        }
        if (slot.shopify.status === "uploaded-verified") {
            if (slot.authorization.status !== "authorized") ctx.addIssue({ code: "custom", message: "upload verificado exige arquivo autorizado" });
            const files = [slot.source, ...slot.derivatives].filter(Boolean).map((item) => item.sha256);
            if (!files.includes(slot.shopify.fileSha256)) ctx.addIssue({ code: "custom", message: "arquivo enviado não corresponde a nenhum arquivo registrado do slot" });
            if (slot.authorization.status === "authorized" && !slot.authorization.covers.includes(slot.shopify.fileSha256)) ctx.addIssue({ code: "custom", message: "arquivo enviado não está coberto pela autorização" });
            const uploads = slot.operations.filter((operation) => operation.kind === "upload" && operation.fileSha256 === slot.shopify.fileSha256);
            if (!uploads.length) {
                ctx.addIssue({ code: "custom", message: "upload verificado sem permissão ou registro de upload para o arquivo" });
            } else if (slot.shopify.store && !uploads.some((operation) => operation.store === slot.shopify.store)) {
                ctx.addIssue({ code: "custom", message: `upload verificado em ${slot.shopify.store} sem operação de upload nessa loja` });
            }
        }
    });

const packShape = (version, slot) => ({
        schemaVersion: z.literal(version),
        kind: z.literal("ContentPack"),
        id: handle,
        authorization: z
            .object({
                basis: z.enum(["own-content", "client-provided", "licensed"]),
                owner: plain(120),
                note: plain(300),
            })
            .strict(),
        sections: z
            .object({
                "announcement-bar": z.array(z.object({ text: plain(120), link: link.optional() }).strict()).max(5).optional(),
                header: z.array(z.object({ menu: handle }).strict()).max(1).optional(),
                hero: z
                    .array(
                        z
                            .object({
                                eyebrow: plain(60).optional(),
                                heading: plain(120),
                                text: plain(300).optional(),
                                buttons: z.array(button).max(4).optional(),
                                image: z.string().regex(HANDLE).optional(),
                            })
                            .strict()
                    )
                    .max(5)
                    .optional(),
                "product-grid": z
                    .array(z.object({ heading: plain(120).optional(), collection: handle }).strict())
                    .max(5)
                    .optional(),
                "rich-text": z
                    .array(
                        z
                            .object({
                                eyebrow: plain(60).optional(),
                                heading: plain(120).optional(),
                                text: plain(1000).optional(),
                                buttons: z.array(button).max(2).optional(),
                            })
                            .strict()
                    )
                    .max(10)
                    .optional(),
                "image-with-text": z
                    .array(
                        z
                            .object({
                                eyebrow: plain(60).optional(),
                                heading: plain(120).optional(),
                                // Um item por parágrafo (richtext com até 4 <p>).
                                paragraphs: z.array(plain(600)).min(1).max(4).optional(),
                                button: button.optional(),
                                image: z.string().regex(HANDLE).optional(),
                            })
                            .strict()
                    )
                    .max(10)
                    .optional(),
                // M7.4: perguntas/painéis (acordeão). Cada item = título da linha +
                // até 4 parágrafos (richtext do Dawn). Nada vem da referência.
                "collapsible-content": z
                    .array(
                        z
                            .object({
                                heading: plain(120).optional(),
                                items: z.array(z.object({ title: plain(120), paragraphs: z.array(plain(600)).min(1).max(4) }).strict()).min(1).max(30),
                            })
                            .strict()
                    )
                    .max(10)
                    .optional(),
                // M7.8b: depoimentos. `basis` declara a natureza do conteúdo
                // ("demonstrative" = escrito para demonstração/testes; nunca
                // apresentado como depoimento real). Sem avaliação/nota: o
                // gerador não exibe notas.
                testimonials: z
                    .array(
                        z
                            .object({
                                heading: plain(120).optional(),
                                basis: z.enum(["demonstrative", "authorized"]),
                                // Aviso VISÍVEL no tema; obrigatório quando o
                                // conteúdo é demonstrativo (não pode passar por real).
                                notice: plain(120).optional(),
                                items: z
                                    .array(
                                        z
                                            .object({
                                                quote: z.array(plain(600)).min(1).max(3),
                                                author: plain(80),
                                                meta: plain(80).optional(),
                                                initials: z.string().regex(/^\p{Lu}{1,3}$/u).optional(),
                                            })
                                            .strict()
                                    )
                                    .min(1)
                                    .max(12),
                            })
                            .strict()
                            .refine((section) => section.basis !== "demonstrative" || Boolean(section.notice), { message: "conteúdo demonstrativo exige um aviso visível (notice)", path: ["notice"] })
                    )
                    .max(10)
                    .optional(),
                // M7.4: colunas (benefícios, números). `title` pode ser um número
                // AUTORIZADO (estático); `text` é obrigatório (richtext do Dawn).
                multicolumn: z
                    .array(
                        z
                            .object({
                                heading: plain(120).optional(),
                                items: z.array(z.object({ title: plain(80), text: plain(600), link: button.optional() }).strict()).min(1).max(12),
                            })
                            .strict()
                    )
                    .max(10)
                    .optional(),
                // Rótulo do campo e do botão vêm das traduções do tema
                // (newsletter.label / newsletter.button_label), não daqui.
                newsletter: z
                    .array(z.object({ heading: plain(120).optional(), text: plain(300).optional() }).strict())
                    .max(5)
                    .optional(),
                footer: z
                    .array(
                        z
                            .object({
                                columns: z
                                    .array(
                                        z.union([
                                            z.object({ kind: z.literal("text"), heading: plain(80), text: plain(300) }).strict(),
                                            z.object({ kind: z.literal("menu"), heading: plain(80), menu: handle }).strict(),
                                        ])
                                    )
                                    .min(1)
                                    .max(8),
                            })
                            .strict()
                    )
                    .max(1)
                    .optional(),
            })
            .strict(),
        images: z.record(z.string().regex(HANDLE), slot).default({}),
});

function checkSlots(pack, ctx) {
    for (const entry of [...(pack.sections.hero ?? []), ...(pack.sections["image-with-text"] ?? [])]) {
        if (entry.image && !pack.images[entry.image]) ctx.addIssue({ code: "custom", message: `slot de imagem inexistente: ${entry.image}` });
    }
}

/** Contrato v1 (M4–M6.1), mantido para os pacotes históricos. */
export const contentPackSchema = z.object(packShape(1, imageSlot)).strict().superRefine(checkSlots);
/** Contrato v2: slots de imagem com procedência e estados separados. */
export const contentPackSchemaV2 = z.object(packShape(2, imageSlotV2)).strict().superRefine(checkSlots);

/**
 * v1 -> v2 SEM promover nada: cada slot "pending-upload" vira um slot sem
 * arquivo registrado, autorização pendente e sem upload.
 */
export function migrateContentPackV1(v1) {
    const images = Object.fromEntries(
        Object.entries(v1.images ?? {}).map(([name, slot]) => [
            name,
            { description: slot.description, source: null, derivatives: [], authorization: { status: "pending" }, operations: [], shopify: { status: "not-uploaded" }, migratedFrom: "pending-upload" },
        ])
    );
    return { ...structuredClone(v1), schemaVersion: 2, images };
}

/**
 * Lê um ContentPack de versão suportada (v1 migrado explicitamente).
 * @returns {{ success: true, pack: any, version: number } | { success: false, issues: string[] }}
 */
export function parseContentPack(data) {
    const version = data && typeof data === "object" ? data.schemaVersion : undefined;
    const issues = (error) => error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    if (version === 2) {
        const parsed = contentPackSchemaV2.safeParse(data);
        return parsed.success ? { success: true, pack: parsed.data, version: 2 } : { success: false, issues: issues(parsed.error) };
    }
    if (version === 1) {
        const parsed = contentPackSchema.safeParse(data);
        if (!parsed.success) return { success: false, issues: issues(parsed.error) };
        const migrated = contentPackSchemaV2.safeParse(migrateContentPackV1(parsed.data));
        return migrated.success ? { success: true, pack: migrated.data, version: 1 } : { success: false, issues: issues(migrated.error) };
    }
    return { success: false, issues: [`versão de ContentPack não suportada: ${JSON.stringify(version)}`] };
}

/**
 * Referência de imagem utilizável num tema para a loja `store`, ou null.
 * Exige autorização de uso cobrindo o arquivo, upload verificado NESSA loja e
 * uma operação de upload (permitida ou realizada) do mesmo arquivo na mesma
 * loja — arquivo local validado não basta, e a referência vem do registro
 * (nunca é construída a partir do nome do arquivo).
 * @param {object} slot
 * @param {{ store?: string | null }} [options]
 */
export function slotImageReference(slot, { store = null } = {}) {
    const shopify = slot?.shopify;
    if (!store || !STORE_DOMAIN.test(store)) return null;
    if (slot?.authorization?.status !== "authorized" || shopify?.status !== "uploaded-verified" || shopify.store !== store) return null;
    if (!slot.authorization.covers?.includes(shopify.fileSha256)) return null;
    const uploaded = (slot.operations ?? []).some((operation) => operation.kind === "upload" && operation.fileSha256 === shopify.fileSha256 && operation.store === store);
    return uploaded && SHOPIFY_IMAGE_REFERENCE.test(shopify.reference) ? shopify.reference : null;
}

/**
 * Há PERMISSÃO para enviar `fileSha256` à loja `store`? Só uma operação
 * "authorized" com a mesma loja e o mesmo arquivo conta; um upload já
 * realizado ("performed") nunca autoriza outro, e a autorização de uso do
 * ativo também não. Todo código que vier a enviar arquivos deve passar aqui.
 */
export function uploadPermitted(slot, { store, fileSha256 }) {
    if (!store || !STORE_DOMAIN.test(store) || !fileSha256) return false;
    if (slot?.authorization?.status !== "authorized" || !slot.authorization.covers?.includes(fileSha256)) return false;
    return (slot.operations ?? []).some((operation) => operation.kind === "upload" && operation.status === "authorized" && operation.store === store && operation.fileSha256 === fileSha256);
}

/** @typedef {z.infer<typeof contentPackSchemaV2>} ContentPack */

export async function loadContentPack(path) {
    return (await loadContentPackWithHash(path)).pack;
}

/** Carrega o pacote e devolve também o SHA-256 do arquivo (proveniência). */
export async function loadContentPackWithHash(path) {
    const buffer = await readStandaloneFile(path, 256 * 1024);
    let data;
    try {
        data = JSON.parse(buffer.toString("utf8"));
    } catch {
        throw new ReferenceEngineError(ErrorCodes.CONTENT_INVALID, "ContentPack com JSON inválido");
    }
    const parsed = parseContentPack(data);
    if (!parsed.success) {
        throw new ReferenceEngineError(ErrorCodes.CONTENT_INVALID, "ContentPack fora do contrato", { issues: parsed.issues });
    }
    // `buffer`: os bytes EXATOS lidos (para a cópia imutável no run).
    return { pack: parsed.pack, sha256: sha256(buffer), version: parsed.version, buffer };
}

/**
 * Conteúdo da n-ésima ocorrência de um tipo de seção, ou placeholder.
 * @returns {{ value: any, source: "content-pack" | "placeholder" }}
 */
export function contentFor(pack, type, occurrence, placeholder) {
    const entry = pack?.sections?.[type]?.[occurrence];
    return entry ? { value: entry, source: "content-pack" } : { value: placeholder, source: "placeholder" };
}

/** richtext do Dawn: um <p> por parágrafo, com texto já validado (sem marcação). */
export function toRichtext(text) {
    const paragraphs = Array.isArray(text) ? text : [text];
    return paragraphs.map((item) => `<p>${String(item).replace(/&/g, "&amp;")}</p>`).join("");
}

/** inline_richtext/text: o schema do pacote já proíbe "<" e ">"; escapamos "&". */
export function toInline(text) {
    return String(text).replace(/&/g, "&amp;");
}

/**
 * Configuração `text` que o Dawn renderiza com `| escape` (ex.: título de
 * collapsible_row, link_label de column): valor literal — escapar "&" aqui
 * exibiria "&amp;". O schema do pacote já proíbe "<" e ">".
 */
export function toText(text) {
    return String(text);
}

/** Placeholders neutros, próprios do ADS AutoStore (sem marca). */
export const PLACEHOLDERS = Object.freeze({
    "announcement-bar": { text: "Mensagem de anúncio" },
    header: { menu: "main-menu" },
    hero: { heading: "Título principal", text: "Texto de apoio da seção.", buttons: [{ label: "Ver produtos", link: "shopify://collections/all" }, { label: "Saiba mais", link: "/" }] },
    "product-grid": { heading: "Produtos em destaque", collection: "all" },
    "rich-text": { heading: "Título da seção", text: "Texto descritivo da seção.", buttons: [{ label: "Saiba mais", link: "/" }] },
    "image-with-text": { heading: "Título da seção", paragraphs: ["Texto descritivo da seção."], button: { label: "Saiba mais", link: "/" } },
    newsletter: { heading: "Receba novidades", text: "Cadastre seu e-mail para receber lançamentos." },
    footer: { columns: [{ kind: "text", heading: "Sobre", text: "Texto institucional." }, { kind: "menu", heading: "Links", menu: "footer" }] },
    "collapsible-content": { heading: "Perguntas frequentes", items: [{ title: "Pergunta", paragraphs: ["Resposta."] }] },
    multicolumn: { heading: "Destaques", items: [{ title: "Destaque", text: "Descrição curta." }] },
    testimonials: { heading: "Depoimentos", basis: "demonstrative", notice: "Conteúdo demonstrativo", items: [{ quote: ["Texto do depoimento."], author: "Nome" }] },
});
