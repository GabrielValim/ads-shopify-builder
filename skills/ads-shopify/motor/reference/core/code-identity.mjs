/**
 * Identidade do código usado numa execução (somente leitura do Git).
 *
 * Registra:
 *  - commit (SHA completo) e branch atuais, quando existirem;
 *  - estado da árvore (limpa / modificada) e o estado Git de CADA arquivo do
 *    motor (rastreado, modificado, staged, não rastreado);
 *  - manifesto determinístico dos arquivos do motor (caminho + SHA-256),
 *    inclusive os ainda não commitados que participam da execução;
 *  - versões das dependências e do tooling relevantes.
 *
 * Hash de código não commitado PROVA IDENTIDADE, mas não garante que o
 * código possa ser recuperado: nesse caso a reprodutibilidade do código fica
 * "não comprovada". Nada de .env, credenciais, runs/ ou backups.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { LOCK_PATH, PATCH_PATH } from "../generator/dawn-base.mjs";
import { PROJECT_ROOT } from "./run-store.mjs";
import { sha256 } from "./safe-read.mjs";

const run = promisify(execFile);
export const CODE_IDENTITY_VERSION = 1;

/** Raízes do motor (relativas ao projeto) e exclusões. */
const ENGINE_DIRS = ["reference"];
// Lock e patch do Dawn vêm do único módulo autorizado a apontar para o tema.
const ENGINE_FILES = ["package.json", "package-lock.json", relative(PROJECT_ROOT, LOCK_PATH).split(sep).join("/"), relative(PROJECT_ROOT, PATCH_PATH).split(sep).join("/")];
const EXCLUDED = /^(?:reference\/(?:test|dev|fixtures)\/|runs\/|\.backups\/|node_modules\/)|(?:^|\/)\.env(?:\.|$)/;
const TOOLING_PACKAGES = ["playwright", "zod"];

// Fontes Liquid próprias também são código do motor: componentes de seção (M7.8b) e extensões de tema (I2, 1.6.0).
const isComponentSource = (rel) => /^reference\/generator\/(?:components|theme-snippets)\/[a-z0-9-]+\.liquid$/.test(rel.split(sep).join("/"));

async function walk(root, dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) out.push(...(await walk(root, path)));
        else if (entry.isFile() && (entry.name.endsWith(".mjs") || isComponentSource(relative(root, path)))) out.push(relative(root, path).split(sep).join("/"));
    }
    return out;
}

async function git(projectRoot, args) {
    try {
        const { stdout } = await run("git", ["-c", "core.quotepath=off", ...args], {
            cwd: projectRoot,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    } catch {
        return null;
    }
}

/** Estado Git por arquivo a partir de `status --porcelain=v1 -z`. */
function parseStatus(output) {
    const states = new Map();
    const parts = (output ?? "").split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        const x = entry[0];
        const y = entry[1];
        const path = entry.slice(3);
        if (x === "R" || x === "C") i++; // origem do rename vem no item seguinte
        states.set(path, x === "?" ? "untracked" : x !== " " && y !== " " ? "staged+modified" : x !== " " ? "staged" : "modified");
    }
    return states;
}

/**
 * @param {{ projectRoot?: string }} [options]
 */
export async function collectCodeIdentity({ projectRoot = PROJECT_ROOT } = {}) {
    const paths = [];
    for (const dir of ENGINE_DIRS) paths.push(...(await walk(projectRoot, join(projectRoot, dir))));
    for (const file of ENGINE_FILES) {
        try {
            await readFile(join(projectRoot, file));
            paths.push(file);
        } catch {
            /* ausente neste checkout */
        }
    }
    const engine = [...new Set(paths)].filter((path) => !EXCLUDED.test(path)).sort();

    const inside = (await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
    const commit = inside ? (await git(projectRoot, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() || null : null;
    const branch = inside ? (await git(projectRoot, ["symbolic-ref", "-q", "--short", "HEAD"]))?.trim() || null : null;
    const allStatus = inside ? parseStatus(await git(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) : new Map();
    const tracked = inside ? new Set(((await git(projectRoot, ["ls-files", "-z"])) ?? "").split("\0").filter(Boolean)) : new Set();

    const files = [];
    for (const path of engine) {
        const buffer = await readFile(join(projectRoot, path));
        const git = !inside ? "no-git" : allStatus.get(path) ?? (tracked.has(path) ? "clean" : "untracked");
        files.push({ path, sha256: sha256(buffer), bytes: buffer.length, git });
    }
    const filesSha256 = sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""));

    const tooling = { node: process.version };
    for (const name of TOOLING_PACKAGES) {
        try {
            tooling[name] = JSON.parse(await readFile(join(projectRoot, "node_modules", name, "package.json"), "utf8")).version;
        } catch {
            tooling[name] = null;
        }
    }

    const engineClean = files.every((file) => file.git === "clean");
    const treeState = !inside ? "no-git" : allStatus.size === 0 ? "clean" : "modified";
    return {
        schemaVersion: CODE_IDENTITY_VERSION,
        kind: "CodeIdentity",
        git: { commit, branch, treeState, changedFiles: allStatus.size },
        engine: { filesSha256, count: files.length, files },
        tooling,
        // Código recuperável a partir do commit registrado?
        codeRecoverable: Boolean(commit) && engineClean,
        reasons: [
            ...(!inside ? ["fora de um repositório Git"] : []),
            ...(inside && !commit ? ["repositório sem commit"] : []),
            ...files.filter((file) => file.git !== "clean" && file.git !== "no-git").slice(0, 20).map((file) => `${file.path}: ${file.git}`),
        ],
    };
}

/**
 * O código registrado numa execução pode ser RECUPERADO deste repositório?
 * Exige identidade registrada, árvore do motor limpa no momento da execução,
 * commit presente e cada arquivo do commit com o hash registrado.
 * @returns {Promise<{ proven: boolean, reasons: string[], notes: string[] }>}
 */
export async function verifyCodeRecoverable(identity, { projectRoot = PROJECT_ROOT } = {}) {
    if (!identity) return { proven: false, reasons: ["execução sem identidade de código registrada (run anterior ao registro)"], notes: [] };
    if (!identity.codeRecoverable) {
        return { proven: false, reasons: ["código não commitado na execução: identidade provada pelos hashes, disponibilidade não", ...identity.reasons.slice(0, 5)], notes: [] };
    }
    const commit = identity.git.commit;
    if ((await git(projectRoot, ["cat-file", "-e", `${commit}^{commit}`])) === null) {
        return { proven: false, reasons: [`commit ${commit.slice(0, 12)} indisponível neste repositório`], notes: [] };
    }
    const divergent = [];
    for (const file of identity.engine.files) {
        try {
            const { stdout } = await run("git", ["show", `${commit}:${file.path}`], { cwd: projectRoot, env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "0" }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
            if (sha256(stdout) !== file.sha256) divergent.push(file.path);
        } catch {
            divergent.push(file.path);
        }
    }
    if (divergent.length) return { proven: false, reasons: [`arquivos do commit diferem do registrado: ${divergent.slice(0, 5).join(", ")}`], notes: [] };
    const remotes = ((await git(projectRoot, ["remote"])) ?? "").trim();
    return { proven: true, reasons: [], notes: remotes ? [] : ["commit só neste repositório local (sem remoto): sem cópia externa"] };
}
