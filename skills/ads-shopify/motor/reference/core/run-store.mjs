/**
 * Armazenamento isolado de artefatos do Reference Engine.
 *
 * Cada execução vive em `runs/<host>/<timestamp>-<id>/` com um
 * `manifest.json` validado. Garantias:
 *  - a raiz de runs nunca fica dentro de diretórios protegidos do projeto;
 *  - artefatos não podem escapar do diretório da execução;
 *  - nenhum artefato é sobrescrito (criação atômica exclusiva);
 *  - o manifesto é regravado de forma atômica (temporário + rename);
 *  - cada artefato registra tamanho e SHA-256.
 */

import { createHash, randomBytes } from "node:crypto";
import {
    link,
    mkdir,
    realpath,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";
import { ENGINE_VERSION } from "./safe-fetch.mjs";

export const PROJECT_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../.."
);

export const DEFAULT_RUNS_DIR = join(PROJECT_ROOT, "runs");

// Diretórios do projeto onde o Reference Engine nunca escreve.
const PROTECTED_DIRS = [
    "themes",
    "lojas",
    "media",
    ".backups",
    "reference",
    "node_modules",
    ".git",
];

const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

const stepSchema = z.object({
    name: z.string().min(1),
    status: z.enum(["ok", "failed", "skipped"]),
    startedAt: z.string(),
    finishedAt: z.string(),
    error: z
        .object({ code: z.string(), message: z.string() })
        .optional(),
    info: z.record(z.string(), z.unknown()).optional(),
});

export const manifestSchema = z
    .object({
        schemaVersion: z.literal(1),
        engineVersion: z.string(),
        runId: z.string().regex(/^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}$/),
        createdAt: z.string(),
        // "created" até a conclusão; só "ok" indica resultado completo.
        status: z.enum(["created", "ok", "failed"]),
        finishedAt: z.string().optional(),
        source: z.object({
            url: z.url(),
            host: z.string().min(1),
        }),
        steps: z.array(stepSchema),
        artifacts: z.array(
            z.object({
                path: z.string().min(1),
                kind: z.string().min(1),
                bytes: z.number().int().nonnegative(),
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
                createdAt: z.string(),
            })
        ),
    })
    .strict();

/** @typedef {z.infer<typeof manifestSchema>} RunManifest */

function isInside(child, parent) {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realOrSelf(path) {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

/**
 * Garante que a raiz de runs não é a raiz do projeto nem fica dentro
 * de um diretório protegido (também após resolver symlinks).
 * @param {string} rootDir
 */
export async function assertRunsRootAllowed(rootDir) {
    const candidates = [resolve(rootDir), await realOrSelf(resolve(rootDir))];
    const projectReal = await realOrSelf(PROJECT_ROOT);

    for (const candidate of candidates) {
        for (const project of new Set([PROJECT_ROOT, projectReal])) {
            const forbidden =
                candidate === project ||
                PROTECTED_DIRS.some((dir) => isInside(candidate, join(project, dir)));

            if (forbidden) {
                throw new ReferenceEngineError(
                    ErrorCodes.RUN_ROOT_FORBIDDEN,
                    `Diretório de runs não permitido: ${rootDir}`,
                    { rootDir }
                );
            }
        }
    }
}

/**
 * @param {string} hostname
 */
export function hostSlug(hostname) {
    const slug = String(hostname)
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/[^a-z0-9.-]+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 100);
    return slug || "unknown-host";
}

function timestampId(date) {
    // 2026-10-12T14:59:01.123Z -> 20261012T145901123Z
    return date.toISOString().replace(/[-:.]/g, "");
}

/**
 * Valida um caminho relativo de artefato e devolve os segmentos.
 * @param {string} relPath
 */
export function validateArtifactPath(relPath) {
    const fail = (message) => {
        throw new ReferenceEngineError(
            ErrorCodes.ARTIFACT_PATH_INVALID,
            message,
            { path: String(relPath) }
        );
    };

    if (typeof relPath !== "string" || !relPath || relPath.length > 512) {
        fail("Caminho de artefato vazio ou longo demais");
    }
    if (relPath.includes("\\") || relPath.includes("\0") || isAbsolute(relPath)) {
        fail("Caminho de artefato deve ser relativo e usar '/'");
    }

    const segments = relPath.split("/");
    for (const segment of segments) {
        if (segment === "." || segment === ".." || !SEGMENT.test(segment)) {
            fail(`Segmento inválido: ${segment || "(vazio)"}`);
        }
    }

    if (relPath === "manifest.json") {
        fail("manifest.json é reservado");
    }

    return segments;
}

/**
 * @typedef {object} Run
 * @property {string} id
 * @property {string} dir
 * @property {() => RunManifest} getManifest
 * @property {(relPath: string, data: string | Uint8Array, options?: { kind?: string }) => Promise<{ path: string, absolutePath: string, bytes: number, sha256: string }>} writeArtifact
 * @property {(step: z.infer<typeof stepSchema>) => Promise<void>} recordStep
 * @property {(status: "ok" | "failed") => Promise<void>} finish
 */

/**
 * Cria uma nova execução isolada.
 *
 * @param {object} options
 * @param {URL} options.url URL já validada pela política.
 * @param {string} [options.rootDir]
 * @param {Date} [options.now]
 * @param {() => string} [options.randomId] 8 caracteres hexadecimais.
 * @param {number} [options.maxArtifactBytes]
 * @returns {Promise<Run>}
 */
export async function createRun({
    url,
    rootDir = DEFAULT_RUNS_DIR,
    now = new Date(),
    randomId = () => randomBytes(4).toString("hex"),
    maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
}) {
    if (!(url instanceof URL)) {
        throw new TypeError("createRun exige uma URL validada");
    }

    await assertRunsRootAllowed(rootDir);

    const host = hostSlug(url.hostname);
    const id = `${timestampId(now)}-${randomId()}`;
    const hostDir = join(resolve(rootDir), host);
    const dir = join(hostDir, id);

    await mkdir(hostDir, { recursive: true });
    // Sem `recursive`: falha com EEXIST se o diretório já existir.
    await mkdir(dir);

    /** @type {RunManifest} */
    let manifest = manifestSchema.parse({
        schemaVersion: 1,
        engineVersion: ENGINE_VERSION,
        runId: id,
        createdAt: now.toISOString(),
        status: "created",
        source: { url: url.href, host: url.hostname },
        steps: [],
        artifacts: [],
    });

    const manifestPath = join(dir, "manifest.json");
    let queue = Promise.resolve();

    // Serializa alterações para que gravações concorrentes não se percam.
    const serialized = (task) => {
        const result = queue.then(task);
        queue = result.catch(() => {});
        return result;
    };

    async function persistManifest(next) {
        const valid = manifestSchema.parse(next);
        const temporary = join(dir, `.manifest.${randomBytes(6).toString("hex")}.tmp`);
        await writeFile(temporary, JSON.stringify(valid, null, 2) + "\n", {
            encoding: "utf8",
            flag: "wx",
        });
        await rename(temporary, manifestPath);
        manifest = valid;
    }

    await persistManifest(manifest);

    return {
        id,
        dir,
        getManifest: () => structuredClone(manifest),

        writeArtifact(relPath, data, { kind = "file" } = {}) {
            return serialized(async () => {
                if (manifest.status !== "created") {
                    throw new Error("Execução finalizada não aceita novos artefatos");
                }
                const segments = validateArtifactPath(relPath);
                const absolutePath = join(dir, ...segments);

                if (!isInside(absolutePath, dir) || absolutePath === dir) {
                    throw new ReferenceEngineError(
                        ErrorCodes.ARTIFACT_PATH_INVALID,
                        "Artefato fora do diretório da execução",
                        { path: relPath }
                    );
                }

                const buffer =
                    typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

                if (buffer.length > maxArtifactBytes) {
                    throw new ReferenceEngineError(
                        ErrorCodes.ARTIFACT_TOO_LARGE,
                        `Artefato excede ${maxArtifactBytes} bytes`,
                        { path: relPath, bytes: buffer.length }
                    );
                }

                if (manifest.artifacts.some((item) => item.path === relPath)) {
                    throw new ReferenceEngineError(
                        ErrorCodes.ARTIFACT_EXISTS,
                        `Artefato já registrado: ${relPath}`,
                        { path: relPath }
                    );
                }

                await mkdir(dirname(absolutePath), { recursive: true });

                // Confere novamente após resolver symlinks dos diretórios pai.
                const realParent = await realpath(dirname(absolutePath));
                if (!isInside(realParent, await realpath(dir))) {
                    throw new ReferenceEngineError(
                        ErrorCodes.ARTIFACT_PATH_INVALID,
                        "Artefato fora do diretório da execução",
                        { path: relPath }
                    );
                }

                const temporary = `${absolutePath}.${randomBytes(6).toString("hex")}.tmp`;
                await writeFile(temporary, buffer, { flag: "wx" });

                try {
                    // link() falha com EEXIST: nunca sobrescreve.
                    await link(temporary, absolutePath);
                } catch (error) {
                    if (error?.code === "EEXIST") {
                        throw new ReferenceEngineError(
                            ErrorCodes.ARTIFACT_EXISTS,
                            `Arquivo já existe: ${relPath}`,
                            { path: relPath }
                        );
                    }
                    throw error;
                } finally {
                    await unlink(temporary).catch(() => {});
                }

                const entry = {
                    path: relPath,
                    kind,
                    bytes: buffer.length,
                    sha256: createHash("sha256").update(buffer).digest("hex"),
                    createdAt: new Date().toISOString(),
                };

                await persistManifest({
                    ...manifest,
                    artifacts: [...manifest.artifacts, entry],
                });

                return { path: relPath, absolutePath, bytes: entry.bytes, sha256: entry.sha256 };
            });
        },

        finish(status) {
            return serialized(async () => {
                if (manifest.status !== "created") {
                    throw new Error(`Execução já finalizada como ${manifest.status}`);
                }
                if (status === "ok" && manifest.steps.some((step) => step.status === "failed")) {
                    throw new Error("Execução com etapa falha não pode ser finalizada como ok");
                }
                await persistManifest({
                    ...manifest,
                    status,
                    finishedAt: new Date().toISOString(),
                });
            });
        },

        recordStep(step) {
            return serialized(async () => {
                const valid = stepSchema.parse(step);
                await persistManifest({
                    ...manifest,
                    steps: [...manifest.steps, valid],
                });
            });
        },
    };
}
