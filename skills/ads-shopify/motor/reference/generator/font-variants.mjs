/**
 * Variantes tipográficas do tema-base (I2): snippet PRÓPRIO `ads-font-variants` + uma linha de render no layout.
 *
 * O Dawn declara @font-face só para a fonte de título escolhida (uma face) e para o corpo (regular, negrito, itálico,
 * negrito itálico). Pesos e estilos diferentes usados pelas seções são sintetizados pelo navegador. O snippet declara
 * as DEMAIS variantes existentes das duas famílias configuradas, sem citar famílias, e o layout passa a renderizá-lo
 * logo depois das faces do Dawn.
 *
 * Preparação LOCAL: gera as alterações de arquivo (layout + snippet) e as acrescenta a um payload de prévia virtual.
 * Não altera o tema travado nem o lock: a integração na base travada vem depois da validação numa prévia real.
 * O layout vem do Dawn upstream verificado (extractVerifiedDawn: git archive + hashes do lock), nunca da árvore de
 * trabalho do tema. Fail-closed: snippet com o SHA-256 registrado; layout igual ao Dawn travado (hash do lock);
 * âncora exatamente uma vez; layout já personalizado no patch, ou layout/snippet já presentes no payload → recusa.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { PROJECT_ROOT } from "../core/run-store.mjs";
import { sha256 } from "../core/safe-read.mjs";
import { extractVerifiedDawn } from "./dawn-base.mjs";

export const FONT_VARIANTS = Object.freeze({
    id: "ads-font-variants",
    version: "1.0.0",
    source: "reference/generator/theme-snippets/ads-font-variants.liquid",
    target: "snippets/ads-font-variants.liquid",
    sha256: "a96b52abea2956da2e4c9f41b6686c2e0e9397fa418f118eb5bf2e21018bed96",
});
export const LAYOUT_TARGET = "layout/theme.liquid";
/** Última face declarada pelo Dawn 16 no {% style %} do layout; a linha de render entra logo depois. */
export const LAYOUT_ANCHOR = "      {{ settings.type_header_font | font_face: font_display: 'swap' }}\n";
export const RENDER_LINE = "      {% render 'ads-font-variants' %}\n";

const fail = (message, details) => new ReferenceEngineError(ErrorCodes.GENERATION_INVALID, message, details);
const count = (text, part) => text.split(part).length - 1;

/** Fonte do snippet, conferida contra o hash registrado. */
export async function fontVariantsSnippet({ root = PROJECT_ROOT, entry = FONT_VARIANTS } = {}) {
    const bytes = await readFile(join(root, entry.source));
    if (sha256(bytes) !== entry.sha256) throw fail(`Snippet ${entry.id} difere do registrado`, { expected: entry.sha256, actual: sha256(bytes) });
    return bytes.toString("utf8");
}

/** Layout do Dawn travado + a linha de render (pura; o layout precisa ter o hash registrado no lock). */
export function layoutWithFontVariants(layout, expectedSha256) {
    if (sha256(Buffer.from(layout, "utf8")) !== expectedSha256) throw fail("layout/theme.liquid não é o Dawn travado (hash diferente do lock)");
    if (count(layout, LAYOUT_ANCHOR) !== 1) throw fail(`Âncora do layout encontrada ${count(layout, LAYOUT_ANCHOR)} vezes (esperado: 1)`);
    if (layout.includes("ads-font-variants")) throw fail("Layout já renderiza ads-font-variants");
    return layout.replace(LAYOUT_ANCHOR, `${LAYOUT_ANCHOR}${RENDER_LINE}`);
}

/** Alterações de tema (caminho → conteúdo) a partir do Dawn upstream verificado. */
export async function fontVariantsThemeChanges({ root = PROJECT_ROOT, entry = FONT_VARIANTS, extract = extractVerifiedDawn } = {}) {
    const base = await extract();
    try {
        const expected = base.lock.files?.[LAYOUT_TARGET]?.sha256;
        if (!expected) throw fail(`Lock sem ${LAYOUT_TARGET}`);
        if ((base.lock.changes?.modified ?? []).includes(LAYOUT_TARGET)) throw fail(`${LAYOUT_TARGET} já é personalizado no patch: revisar a integração`);
        const layout = await readFile(join(base.dir, LAYOUT_TARGET), "utf8");
        return { [LAYOUT_TARGET]: layoutWithFontVariants(layout, expected), [entry.target]: await fontVariantsSnippet({ root, entry }) };
    } finally {
        await base.cleanup();
    }
}

/** Novo payload de prévia virtual com as duas alterações (o original não é modificado). */
export function withFontVariants(payload, changes) {
    if (!payload?.theme_changes || typeof payload.theme_changes !== "object") throw fail("Payload sem theme_changes");
    for (const target of Object.keys(changes)) if (payload.theme_changes[target]) throw fail(`Payload já contém ${target}`);
    return { ...payload, theme_changes: { ...payload.theme_changes, ...Object.fromEntries(Object.entries(changes).map(([k, source]) => [k, { source }])) } };
}
