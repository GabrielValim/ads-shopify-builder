/**
 * Extensões PRÓPRIAS do tema (I2, gerador 1.6.0).
 *
 * Registro FECHADO e SEPARADO do de componentes de seção (components.mjs): COMPONENT_REGISTRY e as regras das seções
 * (schema, alvo em `sections/ads-*`, nunca sobrescrever o Dawn) não mudam. Uma extensão só existe se estiver listada
 * aqui, no código do gerador; planos, candidatos, configurações externas e a quarentena não registram nada.
 * Operações:
 *  - add: arquivo NOVO em `snippets/ads-*`, fonte versionada com SHA-256 fixado, cópia byte a byte, sem sobrescrita;
 *  - derive: altera UM arquivo do Dawn somente por uma transformação do mapa fechado DERIVE_TRANSFORMS, presa a um
 *    único alvo, com o hash da origem e o hash exato do resultado fixados no registro.
 * Toda geração 1.6.0 aplica todas as extensões registradas (independem do plano de seções).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { PROJECT_ROOT } from "../core/run-store.mjs";
import { sha256 } from "../core/safe-read.mjs";
import { COMPONENT_REGISTRY } from "./components.mjs";
import { layoutWithFontVariants } from "./font-variants.mjs";

/** Diretório (relativo ao projeto) das fontes Liquid das extensões. */
export const THEME_SNIPPETS_SOURCE_DIR = "reference/generator/theme-snippets";
const EXTENSION_ID = /^ads-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SNIPPET_TARGET = /^snippets\/ads-[a-z0-9]+(?:-[a-z0-9]+)*\.liquid$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Transformações aprovadas (fechado): identidade → alvo único e função pura (origem, hash da origem) → resultado. */
export const DERIVE_TRANSFORMS = Object.freeze({
    "font-variants/layout-render@1": Object.freeze({ target: "layout/theme.liquid", apply: layoutWithFontVariants }),
});

export const THEME_EXTENSION_REGISTRY = Object.freeze([
    Object.freeze({
        id: "ads-font-variants",
        version: "1.0.0",
        files: Object.freeze([
            Object.freeze({ op: "add", source: `${THEME_SNIPPETS_SOURCE_DIR}/ads-font-variants.liquid`, target: "snippets/ads-font-variants.liquid", sha256: "a96b52abea2956da2e4c9f41b6686c2e0e9397fa418f118eb5bf2e21018bed96" }),
            // Validado numa prévia Shopify real (2026-10-21): Dawn 16 e4031bae… + 1 linha de render → 8ff40b1f….
            Object.freeze({ op: "derive", target: "layout/theme.liquid", transform: "font-variants/layout-render@1", baseSha256: "e4031baede898d36ea61915ffd0b4f35fbd902f8c39a0a58495935d90062e22e", sha256: "8ff40b1f7718d54fa494dfc19cd985f6656c85c96382836c618b8a4c660faf18" }),
        ]),
    }),
]);

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

/** O registro é coerente: ids e alvos únicos, operações e alvos permitidos, fontes no diretório próprio. */
export function checkThemeExtensions(registry = THEME_EXTENSION_REGISTRY) {
    const ids = new Set();
    const targets = new Set();
    const bad = (message) => fail(ErrorCodes.GENERATION_INVALID, `Registro de extensões inválido: ${message}`);
    for (const entry of registry) {
        if (!EXTENSION_ID.test(entry.id ?? "") || ids.has(entry.id)) throw bad(`id ${entry.id}`);
        if (COMPONENT_REGISTRY.some((component) => component.id === entry.id)) throw bad(`id ${entry.id} colide com componente`);
        ids.add(entry.id);
        if (!/^\d+\.\d+\.\d+$/.test(entry.version ?? "") || !Array.isArray(entry.files) || !entry.files.length) throw bad(`versão/arquivos de ${entry.id}`);
        for (const file of entry.files) {
            if (targets.has(file.target)) throw bad(`alvo duplicado ${file.target}`);
            targets.add(file.target);
            if (!HEX64.test(file.sha256 ?? "")) throw bad(`hash de ${file.target}`);
            if (file.op === "add") {
                if (!SNIPPET_TARGET.test(file.target ?? "") || file.source !== `${THEME_SNIPPETS_SOURCE_DIR}/${file.target.slice("snippets/".length)}` || Object.keys(file).sort().join() !== "op,sha256,source,target") throw bad(`add ${file.target}`);
            } else if (file.op === "derive") {
                const transform = Object.hasOwn(DERIVE_TRANSFORMS, file.transform ?? "") ? DERIVE_TRANSFORMS[file.transform] : null;
                if (!transform || transform.target !== file.target || !HEX64.test(file.baseSha256 ?? "") || Object.keys(file).sort().join() !== "baseSha256,op,sha256,target,transform") throw bad(`derive ${file.target}`);
            } else throw bad(`operação ${String(file.op).slice(0, 20)}`);
        }
    }
    return true;
}

/** Extensão registrada por id; erro se desconhecida. */
export function registeredThemeExtension(id, registry = THEME_EXTENSION_REGISTRY) {
    const entry = registry.find((item) => item.id === id);
    if (!entry) throw fail(ErrorCodes.GENERATION_INVALID, `Extensão não registrada: ${String(id).slice(0, 80)}`);
    return entry;
}

/** Registro de proveniência de uma extensão (sem bytes nem caminho da fonte). */
export const themeExtensionRecord = (entry) => ({ id: entry.id, version: entry.version, files: entry.files.map(({ source, ...file }) => ({ ...file })) });

/**
 * Lê as fontes de uma extensão registrada e exige os hashes do registro.
 * @returns {Promise<{ id: string, version: string, record: object, bytes: Map<string, Buffer> }>} bytes por alvo `add`.
 */
export async function loadThemeExtension(id, { projectRoot = PROJECT_ROOT, registry = THEME_EXTENSION_REGISTRY } = {}) {
    checkThemeExtensions(registry);
    const entry = registeredThemeExtension(id, registry);
    const bytes = new Map();
    for (const file of entry.files.filter((item) => item.op === "add")) {
        let data;
        try {
            data = await readFile(join(projectRoot, file.source));
        } catch {
            throw fail(ErrorCodes.GENERATION_INVALID, `Fonte da extensão ausente: ${file.source}`);
        }
        const actual = sha256(data);
        if (actual !== file.sha256) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Fonte da extensão ${entry.id} difere do hash registrado`, { expected: file.sha256, actual });
        bytes.set(file.target, data);
    }
    return { id: entry.id, version: entry.version, record: themeExtensionRecord(entry), bytes };
}

/** Todas as extensões registradas (hashes conferidos): toda geração 1.6.0 as aplica. */
export async function loadThemeExtensions(options = {}) {
    const registry = options.registry ?? THEME_EXTENSION_REGISTRY;
    return Promise.all(registry.map((entry) => loadThemeExtension(entry.id, options)));
}

/**
 * Declarações de um plano conferidas contra o registro confiável (nunca o contrário): cada declaração tem de ser
 * idêntica ao registro de uma extensão conhecida, sem duplicatas. Devolve problemas (vazio = íntegro).
 */
export function declaredExtensionProblems(declared, registry = THEME_EXTENSION_REGISTRY) {
    const problems = [];
    if (!Array.isArray(declared)) return ["themeExtensions não é uma lista"];
    const seen = new Set();
    for (const record of declared) {
        const id = String(record?.id ?? "?").slice(0, 80);
        if (seen.has(id)) problems.push(`${id}: extensão duplicada`);
        seen.add(id);
        const entry = registry.find((item) => item.id === record?.id);
        if (!entry) problems.push(`${id}: extensão fora do registro`);
        else if (!isDeepStrictEqual(record, themeExtensionRecord(entry))) problems.push(`${id}: declaração difere do registro`);
    }
    return problems;
}
