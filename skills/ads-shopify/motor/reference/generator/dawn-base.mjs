/**
 * Dawn base reproduzível para o gerador.
 *
 * Usa o commit upstream registrado em themes/ads-base.lock.json (Dawn
 * 16.0.0 sem as personalizações da loja piloto) e o extrai com
 * `git archive`, que só LÊ objetos do repositório aninhado (sem tocar
 * index, HEAD ou árvore de trabalho).
 *
 * Integridade verificada antes do uso:
 *  - lockfile válido e patch com o SHA-256 registrado;
 *  - tree do commit igual à registrada no lock;
 *  - conjunto de arquivos extraídos = arquivos do lock − adicionados + removidos;
 *  - SHA-256 de cada arquivo não modificado localmente igual ao do lock;
 *  - versão do tema igual à registrada; nenhum symlink.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "zod";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { PROJECT_ROOT } from "../core/run-store.mjs";

export const LOCK_PATH = join(PROJECT_ROOT, "themes", "ads-base.lock.json");
export const PATCH_PATH = join(PROJECT_ROOT, "themes", "ads-base.patch");
export const NESTED_REPO = join(PROJECT_ROOT, "themes", "ads-base");

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
// v1: symlinks com o alvo original da máquina; v2 (portável): só a forma
// do alvo, e arquivos de ferramentas excluídos explicitamente. As duas
// versões são lidas; nenhuma é reinterpretada como a outra.
const lockBase = (version, symlink, extra = {}) =>
    z.object({
        schemaVersion: z.literal(version),
        theme: z.string(),
        upstream: z.object({ url: z.string(), commit: sha40, tree: sha40, themeName: z.string(), themeVersion: z.string() }),
        patch: z.object({ file: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number() }),
        changes: z.object({
            modified: z.array(z.string()),
            deleted: z.array(z.string()),
            added: z.array(z.string()),
            symlinks: z.array(symlink),
        }),
        ignored: z.array(z.string()),
        ...extra,
        fileCount: z.number(),
        files: z.record(z.string(), z.object({ sha256: z.string(), executable: z.boolean() })),
    });
const lockSchema = z.union([
    lockBase(1, z.object({ path: z.string(), target: z.string(), originalTarget: z.string() })),
    lockBase(2, z.object({ path: z.string(), target: z.string(), sourceForm: z.enum(["absolute", "relative"]) }).strict(), {
        excluded: z.array(z.object({ path: z.string(), kind: z.enum(["file", "symlink"]), reason: z.string() }).strict()),
    }),
]);

const fail = (message, details) => new ReferenceEngineError(ErrorCodes.ARTIFACT_TAMPERED, message, details);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

function runGit(args, { stdout } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", ["-C", NESTED_REPO, ...args], { env: GIT_ENV, stdio: ["ignore", stdout ? "pipe" : "pipe", "pipe"] });
        let out = "";
        let err = "";
        if (stdout) child.stdout.pipe(stdout);
        else child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} falhou: ${err.trim()}`))));
    });
}

async function walk(root) {
    const files = [];
    async function visit(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            const info = await lstat(path);
            if (info.isSymbolicLink()) throw fail(`Symlink inesperado no Dawn base: ${relative(root, path)}`);
            if (info.isDirectory()) await visit(path);
            else if (info.isFile()) files.push(relative(root, path).split(sep).join("/"));
        }
    }
    await visit(root);
    return files.sort();
}

/**
 * Lê e valida o lockfile e o patch.
 */
export async function readLock({ lockPath = LOCK_PATH, patchPath = PATCH_PATH } = {}) {
    let lock;
    try {
        lock = lockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
    } catch (error) {
        throw fail(`Lockfile do tema inválido: ${error.message.split("\n")[0]}`);
    }
    // DISTRIBUIÇÃO: o patch não acompanha o pacote (não é usado pelo gerador); se existir, ainda é conferido
    let patch = null;
    try { patch = await readFile(patchPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (patch && (sha256(patch) !== lock.patch.sha256 || patch.length !== lock.patch.bytes)) {
        throw fail("Patch do tema não confere com o lockfile");
    }
    return lock;
}

/**
 * Extrai o Dawn upstream verificado para um diretório temporário novo.
 * O chamador deve remover `dir` com `cleanup()`.
 */
export async function extractVerifiedDawn(options = {}) {
    const lock = await readLock(options);
    // DISTRIBUIÇÃO: o Dawn vem em themes/dawn (git archive do commit travado, feito no build) e é verificado arquivo a
    // arquivo contra themes/dawn.sha256.json E contra o lockfile (abaixo). Não usa git nem rede.
    const DAWN_DIR = join(PROJECT_ROOT, "themes", "dawn");
    const { existsSync: existe } = await import("node:fs");
    if (!existe(join(DAWN_DIR, "config", "settings_schema.json"))) throw fail("Dawn ainda não baixado: rode a preparação (ads.mjs preparar)");
    const dawnMan = JSON.parse(await readFile(join(PROJECT_ROOT, "themes", "dawn.sha256.json"), "utf8"));
    if (dawnMan.commit !== lock.upstream.commit || dawnMan.tree !== lock.upstream.tree) throw fail("Dawn empacotado não corresponde ao lockfile");
    const tree = dawnMan.tree;

    const dir = await mkdtemp(join(tmpdir(), "ads-dawn-base-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });

    try {
        const { cp } = await import("node:fs/promises");
        await cp(DAWN_DIR, dir, { recursive: true });
        for (const path of await walk(dir)) {
            if (sha256(await readFile(join(dir, path))) !== dawnMan.arquivos[path]) throw fail(`Hash diferente no Dawn empacotado: ${path}`);
        }

        const files = await walk(dir);
        const added = new Set(lock.changes.added);
        const expected = [...new Set([...Object.keys(lock.files).filter((path) => !added.has(path)), ...lock.changes.deleted])].sort();
        if (JSON.stringify(files) !== JSON.stringify(expected)) {
            const missing = expected.filter((path) => !files.includes(path));
            const extra = files.filter((path) => !expected.includes(path));
            throw fail("Arquivos do Dawn base diferem do lockfile", { missing: missing.slice(0, 5), extra: extra.slice(0, 5) });
        }

        const modified = new Set(lock.changes.modified);
        let verified = 0;
        for (const path of files) {
            if (modified.has(path) || !lock.files[path]) continue;
            if (sha256(await readFile(join(dir, path))) !== lock.files[path].sha256) {
                throw fail(`Hash diferente no Dawn base: ${path}`);
            }
            verified++;
        }

        const schema = JSON.parse(await readFile(join(dir, "config", "settings_schema.json"), "utf8"));
        const info = schema.find((group) => group.name === "theme_info");
        if (info?.theme_name !== lock.upstream.themeName || info?.theme_version !== lock.upstream.themeVersion) {
            throw fail("Versão do Dawn base difere do lockfile");
        }

        return {
            dir,
            cleanup,
            lock,
            integrity: {
                commit: lock.upstream.commit,
                tree,
                themeVersion: lock.upstream.themeVersion,
                files: files.length,
                hashVerified: verified,
                modifiedLocallySkipped: lock.changes.modified.length,
            },
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
