/**
 * Componentes Shopify PRÓPRIOS do ADS AutoStore (M7.8b).
 *
 * Registro FECHADO: só os componentes listados aqui podem entrar num tema
 * gerado, cada um com fonte versionada no repositório, alvo fixo dentro de
 * `sections/` (prefixo `ads-`) e SHA-256 esperado. A cópia é byte a byte;
 * nenhum Liquid/HTML/CSS/JS vem de ContentPack, blueprint ou referência.
 * Sem componente no plano, o tema continua exatamente o Dawn + 4 JSON.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { PROJECT_ROOT } from "../core/run-store.mjs";
import { sha256 } from "../core/safe-read.mjs";

/** Diretório (relativo ao projeto) das fontes dos componentes. */
export const COMPONENTS_SOURCE_DIR = "reference/generator/components";
/** Alvo permitido: um arquivo de seção com prefixo próprio, sem subpastas. */
export const COMPONENT_TARGET = /^sections\/ads-[a-z0-9]+(?:-[a-z0-9]+)*\.liquid$/;
const SECTION_TYPE = /^ads-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEMA_TAG = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;

export const COMPONENT_REGISTRY = Object.freeze([
    Object.freeze({
        id: "ads-testimonials",
        version: "1.0.0",
        source: `${COMPONENTS_SOURCE_DIR}/ads-testimonials.liquid`,
        target: "sections/ads-testimonials.liquid",
        sha256: "1d81e064d95b254a467c2b71571a1109ee45c3c7258d3f72b430f83e60599f1a",
    }),
]);

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

/** Entrada do registro por id (tipo de seção = id); erro se desconhecido. */
export function registeredComponent(id, registry = COMPONENT_REGISTRY) {
    const entry = registry.find((item) => item.id === id);
    if (!entry) throw fail(ErrorCodes.GENERATION_INVALID, `Componente não registrado: ${String(id).slice(0, 80)}`);
    return entry;
}

/** O registro em si é coerente (ids únicos, alvos fixos, fonte no diretório próprio). */
export function checkRegistry(registry = COMPONENT_REGISTRY) {
    const ids = new Set();
    for (const entry of registry) {
        if (!SECTION_TYPE.test(entry.id) || ids.has(entry.id)) throw fail(ErrorCodes.GENERATION_INVALID, `Registro inválido: id ${entry.id}`);
        ids.add(entry.id);
        if (entry.target !== `sections/${entry.id}.liquid` || !COMPONENT_TARGET.test(entry.target)) throw fail(ErrorCodes.GENERATION_INVALID, `Registro inválido: alvo ${entry.target}`);
        if (entry.source !== `${COMPONENTS_SOURCE_DIR}/${entry.id}.liquid`) throw fail(ErrorCodes.GENERATION_INVALID, `Registro inválido: fonte ${entry.source}`);
        if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !/^\d+\.\d+\.\d+$/.test(entry.version)) throw fail(ErrorCodes.GENERATION_INVALID, `Registro inválido: hash/versão de ${entry.id}`);
    }
    return true;
}

/** Schema (`{% schema %}`) de um componente a partir dos bytes. */
export function componentSchema(bytes) {
    const match = SCHEMA_TAG.exec(bytes.toString("utf8"));
    if (!match) throw fail(ErrorCodes.GENERATION_INVALID, "Componente sem {% schema %}");
    return JSON.parse(match[1]);
}

/**
 * Lê a fonte de um componente registrado e exige o hash esperado.
 * @returns {Promise<{ id: string, version: string, target: string, sha256: string, bytes: Buffer, schema: object }>}
 */
export async function loadComponent(id, { projectRoot = PROJECT_ROOT, registry = COMPONENT_REGISTRY } = {}) {
    checkRegistry(registry);
    const entry = registeredComponent(id, registry);
    let bytes;
    try {
        bytes = await readFile(join(projectRoot, entry.source));
    } catch {
        throw fail(ErrorCodes.GENERATION_INVALID, `Fonte do componente ausente: ${entry.source}`);
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Fonte do componente ${entry.id} difere do hash registrado`, { expected: entry.sha256, actual });
    return { id: entry.id, version: entry.version, target: entry.target, sha256: entry.sha256, bytes, schema: componentSchema(bytes) };
}

/** Todos os componentes registrados (hash conferido), para validar planos. */
export async function loadRegisteredComponents(options = {}) {
    const registry = options.registry ?? COMPONENT_REGISTRY;
    return Promise.all(registry.map((entry) => loadComponent(entry.id, options)));
}

/** Registro de proveniência de um componente no plano (sem os bytes). */
export const componentRecord = (component) => ({ id: component.id, version: component.version, target: component.target, sha256: component.sha256 });
