/**
 * Arquivo de insumos endereçado pelo SHA-256 (camada adicional de
 * recuperação; não substitui a cópia imutável dentro de cada run).
 *
 *   runs/content-archive/sha256/<sha256>.json
 *
 * Regras:
 *  - o nome é o hash do conteúdo; gravar confere o hash antes;
 *  - gravação atômica (arquivo temporário + link), nunca sobrescreve;
 *  - arquivo já existente: precisa ser regular, sem symlink, e ter
 *    exatamente o mesmo hash — senão é CONFLITO (erro), nunca substituição;
 *  - `runs/` é ignorado pelo Git: este arquivo NÃO é backup externo.
 */

import { lstat, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";
import { DEFAULT_RUNS_DIR, assertRunsRootAllowed } from "./run-store.mjs";
import { readRegularFile, sha256 } from "./safe-read.mjs";

export const DEFAULT_CONTENT_ARCHIVE = join(DEFAULT_RUNS_DIR, "content-archive", "sha256");
const SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

/** Diretório do arquivo: permitido para runs e sem symlink em nenhum nível criado. */
async function prepareRoot(root) {
    await assertRunsRootAllowed(root);
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true });
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, "Diretório do arquivo de insumos inválido");
    return absolute;
}

/**
 * Lê um insumo arquivado pelo hash. null se ausente; erro se adulterado,
 * symlink ou inválido.
 * @returns {Promise<Buffer | null>}
 */
export async function readArchived(digest, { root = DEFAULT_CONTENT_ARCHIVE } = {}) {
    if (!SHA.test(digest ?? "")) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, "Hash de insumo inválido");
    const absolute = resolve(root);
    try {
        await lstat(join(absolute, `${digest}.json`));
    } catch {
        return null;
    }
    const buffer = await readRegularFile(absolute, `${digest}.json`, MAX_BYTES);
    if (sha256(buffer) !== digest) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Insumo arquivado não confere com o próprio hash: ${digest.slice(0, 12)}…`);
    return buffer;
}

/**
 * Arquiva bytes pelo hash. Se `expectedSha256` for dado, os bytes precisam
 * tê-lo. Idempotente para o mesmo conteúdo; conflito é erro.
 * @returns {Promise<{ sha256: string, path: string, status: "archived" | "present" }>}
 */
export async function archiveBySha(buffer, { root = DEFAULT_CONTENT_ARCHIVE, expectedSha256 = null } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_BYTES) throw fail(ErrorCodes.RESOURCE_LIMIT, "Insumo vazio ou acima do limite");
    const digest = sha256(buffer);
    if (expectedSha256 && digest !== expectedSha256) throw fail(ErrorCodes.ARTIFACT_TAMPERED, "Bytes não correspondem ao hash esperado", { expected: expectedSha256, actual: digest });
    const dir = await prepareRoot(root);
    const target = join(dir, `${digest}.json`);
    const existing = await readArchived(digest, { root: dir });
    if (existing) return { sha256: digest, path: target, status: "present" };
    const temporary = join(dir, `.${digest}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, buffer, { flag: "wx" });
    try {
        await link(temporary, target); // EEXIST se outro processo gravou antes
    } catch (error) {
        await unlink(temporary);
        if (error.code === "EEXIST") {
            await readArchived(digest, { root: dir }); // confere o conteúdo concorrente
            return { sha256: digest, path: target, status: "present" };
        }
        throw error;
    }
    await unlink(temporary);
    return { sha256: digest, path: target, status: "archived" };
}

/**
 * Registro de RECUPERAÇÃO (inventário separado): de onde veio um insumo
 * arquivado depois do fato e qual correspondência foi comprovada. Nunca
 * sobrescreve.
 */
export async function recordRecovery(record, { root = DEFAULT_CONTENT_ARCHIVE } = {}) {
    const dir = resolve(await prepareRoot(root), "..", "recoveries");
    await mkdir(dir, { recursive: true });
    const name = `${record.generationRunId}.json`;
    if (!/^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}\.json$/.test(name)) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, "Run de geração inválido no registro de recuperação");
    const text = JSON.stringify(record, null, 2) + "\n";
    try {
        await writeFile(join(dir, name), text, { flag: "wx" });
    } catch (error) {
        if (error.code === "EEXIST") throw fail(ErrorCodes.RUN_INVALID, `Já existe registro de recuperação para ${record.generationRunId}: nada sobrescrito`);
        throw error;
    }
    return { path: join(dir, name), sha256: sha256(text) };
}
