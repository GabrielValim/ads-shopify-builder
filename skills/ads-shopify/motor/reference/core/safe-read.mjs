/**
 * Leitura segura de arquivos de entrada não confiáveis: sem seguir
 * symlinks (O_NOFOLLOW), somente arquivos regulares com um único link,
 * tamanho limitado e conteúdo estável durante a leitura.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * @param {string} dir Diretório já resolvido (realpath).
 * @param {string} name Nome simples do arquivo (sem subdiretórios).
 * @param {number} maxBytes
 */
export async function readRegularFile(dir, name, maxBytes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
        throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `Nome de arquivo inválido: ${name}`, { path: name });
    }
    const path = join(dir, name);
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (error.code === "ENOENT") throw fail(ErrorCodes.ARTIFACT_MISSING, `Arquivo ausente: ${name}`, { path: name });
        if (error.code === "ELOOP") throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `Symlink não permitido: ${name}`, { path: name });
        throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `Arquivo inacessível: ${name}`, { path: name, cause: error.code });
    }
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `Não é arquivo regular: ${name}`, { path: name });
        if (info.size > maxBytes) throw fail(ErrorCodes.RESOURCE_LIMIT, `Arquivo grande demais: ${name}`, { path: name, bytes: info.size });
        if (info.nlink > 1) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `Arquivo com múltiplos links: ${name}`, { path: name });
        const buffer = await handle.readFile();
        if (buffer.length !== info.size) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Arquivo mudou durante a leitura: ${name}`);
        return buffer;
    } finally {
        await handle.close();
    }
}

/**
 * Diretório de entrada: deve existir, ser diretório e não ser symlink.
 * @returns {Promise<string>} caminho real
 */
export async function resolveInputDir(dir, label = "diretório") {
    let info;
    try {
        info = await lstat(dir);
    } catch {
        throw fail(ErrorCodes.RUN_INVALID, `${label} não encontrado`, { dir: String(dir) });
    }
    if (info.isSymbolicLink()) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, `${label} não pode ser symlink`);
    if (!info.isDirectory()) throw fail(ErrorCodes.RUN_INVALID, `${label} não é um diretório`);
    return realpath(dir);
}

/** Lê um arquivo isolado (fora de um run) com as mesmas garantias. */
export async function readStandaloneFile(path, maxBytes) {
    let info;
    try {
        info = await lstat(path);
    } catch {
        throw fail(ErrorCodes.ARTIFACT_MISSING, `Arquivo ausente: ${path}`);
    }
    if (info.isSymbolicLink()) throw fail(ErrorCodes.ARTIFACT_PATH_INVALID, "Symlink não permitido");
    const real = await realpath(path);
    const dir = real.slice(0, real.lastIndexOf("/")) || "/";
    return readRegularFile(dir, real.slice(real.lastIndexOf("/") + 1), maxBytes);
}
