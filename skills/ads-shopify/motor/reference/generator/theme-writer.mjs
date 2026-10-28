/**
 * Escrita do tema gerado, isolada e sem sobrescrita.
 *
 *  1. Copia o Dawn base verificado para `<run>/.staging-theme` (cópia
 *     exclusiva, sem symlinks).
 *  2. Substitui SOMENTE os arquivos permitidos (lista fechada) dentro da
 *     área de staging e acrescenta os componentes próprios REGISTRADOS
 *     usados pelo plano (cópia byte a byte, hash conferido; M7.8b).
 *     Aplica as extensões de tema REGISTRADAS (gerador 1.6.0, I2): `add` cria
 *     arquivo novo; `derive` altera um arquivo do Dawn só pela transformação
 *     registrada, com hashes de origem e de resultado conferidos.
 *  3. Renomeia staging -> `<run>/theme` (falha se o destino existir).
 * Em qualquer falha, a área de staging é removida; nada fora do run é tocado.
 */

import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isDeepStrictEqual } from "node:util";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { COMPONENT_REGISTRY, COMPONENT_TARGET } from "./components.mjs";
import { DERIVE_TRANSFORMS, THEME_EXTENSION_REGISTRY, checkThemeExtensions, themeExtensionRecord } from "./theme-extensions.mjs";

export const WRITABLE_FILES = Object.freeze([
    "config/settings_data.json",
    "templates/index.json",
    "sections/header-group.json",
    "sections/footer-group.json",
]);

const fail = (message, details) => new ReferenceEngineError(ErrorCodes.THEME_WRITE_FAILED, message, details);

function inside(root, path) {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Resolve um arquivo gravável dentro da raiz, recusando qualquer outro caminho. */
export function resolveWritable(root, relPath) {
    if (!WRITABLE_FILES.includes(relPath)) throw fail(`Arquivo fora da lista permitida: ${relPath}`);
    const target = resolve(root, relPath);
    if (!inside(root, target)) throw fail(`Caminho fora do tema: ${relPath}`);
    return target;
}

async function hashTree(root) {
    const files = [];
    async function visit(dir) {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = join(dir, entry.name);
            const info = await lstat(path);
            if (info.isSymbolicLink()) throw fail(`Symlink no tema gerado: ${relative(root, path)}`);
            if (info.isDirectory()) await visit(path);
            else files.push({ path: relative(root, path).split(sep).join("/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex"), bytes: info.size });
        }
    }
    await visit(root);
    return files;
}

/**
 * Resolve o alvo de um componente PRÓPRIO registrado (M7.8b): o caminho tem
 * de ser exatamente o do registro, dentro de `sections/`, com prefixo
 * `ads-`. Qualquer outro caminho (dinâmico, fora do tema, traversal) é recusado.
 */
export function resolveComponentTarget(root, component, registry = COMPONENT_REGISTRY) {
    const entry = registry.find((item) => item.id === component.id);
    if (!entry || entry.target !== component.target || entry.sha256 !== component.sha256 || entry.version !== component.version) throw fail(`Componente fora do registro: ${String(component.id).slice(0, 80)}`);
    if (!COMPONENT_TARGET.test(component.target)) throw fail(`Alvo de componente inválido: ${component.target}`);
    const target = resolve(root, component.target);
    if (!inside(root, target)) throw fail(`Caminho fora do tema: ${component.target}`);
    return target;
}

/**
 * Aplica as extensões de tema na área de staging. Cada operação vem da entrada do REGISTRO confiável (o objeto
 * recebido só precisa ser idêntico a ela e trazer os bytes de `add`): alvo, transformação e hashes nunca vêm de fora.
 */
export async function applyThemeExtensions(root, extensions, registry = THEME_EXTENSION_REGISTRY) {
    checkThemeExtensions(registry);
    const sha = (data) => createHash("sha256").update(data).digest("hex");
    const ids = new Set();
    for (const extension of extensions) {
        const entry = registry.find((item) => item.id === extension.id);
        if (!entry || ids.has(entry.id) || !isDeepStrictEqual(extension.record, themeExtensionRecord(entry))) throw fail(`Extensão fora do registro: ${String(extension.id).slice(0, 80)}`);
        ids.add(entry.id);
        for (const file of entry.files) {
            if (WRITABLE_FILES.includes(file.target) || COMPONENT_REGISTRY.some((component) => component.target === file.target)) throw fail(`Alvo de extensão reservado: ${file.target}`);
            const target = resolve(root, file.target);
            if (!inside(root, target)) throw fail(`Caminho fora do tema: ${file.target}`);
            let data;
            if (file.op === "add") {
                data = extension.bytes?.get(file.target);
                if (!data || sha(data) !== file.sha256) throw fail(`Bytes da extensão ${entry.id} diferem do hash registrado: ${file.target}`);
                // "wx": nunca sobrescreve (um arquivo do Dawn com o mesmo nome é erro).
                await writeFile(target, data, { flag: "wx" });
            } else {
                const original = await readFile(target, "utf8").catch(() => null);
                if (original === null || sha(original) !== file.baseSha256) throw fail(`Origem de ${file.target} difere do hash registrado para ${entry.id}`);
                try {
                    data = DERIVE_TRANSFORMS[file.transform].apply(original, file.baseSha256);
                } catch (error) {
                    throw fail(`Transformação ${file.transform} recusou ${file.target}: ${String(error.message).slice(0, 120)}`);
                }
                if (sha(data) !== file.sha256) throw fail(`Resultado de ${file.transform} difere do hash registrado: ${file.target}`);
                await writeFile(target, data, { flag: "w" });
            }
            if (sha(await readFile(target)) !== file.sha256) throw fail(`Extensão ${entry.id} gravada com hash diferente: ${file.target}`);
        }
    }
}

/**
 * @param {object} params
 * @param {string} params.baseDir Dawn base verificado.
 * @param {string} params.runDir Diretório do run de geração (novo).
 * @param {Record<string, object>} params.files Conteúdo JSON por caminho permitido.
 * @param {Array<{ id: string, version: string, target: string, sha256: string, bytes: Buffer }>} [params.components]
 *        componentes próprios REGISTRADOS (bytes já conferidos com o hash);
 *        copiados byte a byte, nunca sobre um arquivo existente.
 * @param {Array<{ id: string, record: object, bytes: Map<string, Buffer> }>} [params.extensions]
 *        extensões de tema REGISTRADAS (loadThemeExtensions), aplicadas por applyThemeExtensions.
 */
export async function writeTheme({ baseDir, runDir, files, components = [], extensions = [] }) {
    const staging = join(runDir, ".staging-theme");
    const target = join(runDir, "theme");
    if (!inside(runDir, staging) || !inside(runDir, target)) throw fail("Destino inválido");

    // A área de staging não pode existir: é criada pela própria cópia.
    try {
        await lstat(staging);
        throw fail("Área de staging já existe");
    } catch (error) {
        if (error instanceof ReferenceEngineError) throw error;
    }
    try {
        await cp(baseDir, staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        // Defesa: nenhum symlink deve existir na cópia.
        await hashTree(staging);

        for (const [relPath, content] of Object.entries(files)) {
            const path = resolveWritable(staging, relPath);
            await writeFile(path, JSON.stringify(content, null, 2) + "\n", { encoding: "utf8", flag: "w" });
        }
        for (const component of components) {
            const path = resolveComponentTarget(staging, component);
            if (createHash("sha256").update(component.bytes).digest("hex") !== component.sha256) throw fail(`Bytes do componente ${component.id} diferem do hash registrado`);
            // "wx": nunca sobrescreve (um arquivo do Dawn com o mesmo nome é erro).
            await writeFile(path, component.bytes, { flag: "wx" });
            if (createHash("sha256").update(await readFile(path)).digest("hex") !== component.sha256) throw fail(`Componente ${component.id} gravado com hash diferente`);
        }
        await applyThemeExtensions(staging, extensions);

        // rename falha se `theme` já existir: nunca sobrescreve.
        try {
            await lstat(target);
            throw fail("Tema de destino já existe");
        } catch (error) {
            if (error instanceof ReferenceEngineError) throw error;
        }
        await rename(staging, target);
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error instanceof ReferenceEngineError ? error : fail(`Falha ao gravar o tema: ${error.message}`);
    }

    return { dir: target, files: await hashTree(target) };
}
