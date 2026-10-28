/**
 * CF-01 — lançador CONFIÁVEL da renderização confinada.
 *
 * A página gerada (não confiável) só é aberta dentro de `render-confine.sh`, que reproduz a técnica do sandbox v1:
 * namespaces novos (usuário, montagem, PID, IPC, UTS, rede, cgroup), raiz nova em tmpfs com pivot_root (nada do
 * sistema de arquivos do host além de /usr, fontes, binários e o código do capturador, tudo somente leitura),
 * /proc próprio, rede só loopback, sem novos namespaces de usuário, seccomp (AF_VSOCK, io_uring, chaveiros),
 * capacidades removidas, no_new_privs, env vazio, limites de CPU/arquivo/descritores e timeout.
 * Único destino gravável: o diretório de saída da captura. Além disso, o servidor local envia CSP sem scripts.
 * O sandbox interno do Chromium não inicia sem namespaces de usuário aninhados; o confinamento acima o substitui.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
export const RENDER_LIMITS = Object.freeze({ timeoutSec: 300, cpuSec: 600, fileKb: 262144, nofile: 4096 });
export const CONFINE_NS = ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--kill-child", "--ipc", "--uts", "--net", "--cgroup"];

/** Executa `command` (argv já dentro da raiz confinada) com a página em `pageDir` (ro) e saída em `outDir` (rw). */
export async function runConfined({ pageDir, outDir, command, limits = RENDER_LIMITS }) {
    const work = await mkdtemp(join(existsSync("/dev/shm") ? "/dev/shm" : "/tmp", "cf01-render-"));
    await mkdir(join(work, "root"));
    const env = {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        CF_WORK: work,
        CF_NODE: await realpath(process.execPath),
        CF_BROWSERS: await realpath(process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")),
        CF_SECCOMP: join(ROOT, "quarantine/tools/sandbox/seccomp-exec.py"),
        CF_PAGE: resolve(pageDir), CF_OUT: resolve(outDir),
        CF_RO: [join(ROOT, "reference"), join(ROOT, "node_modules"), join(ROOT, "package.json"), HERE].join("\n"),
        CF_CPU_SECONDS: String(limits.cpuSec), CF_FILE_KB: String(limits.fileKb), CF_NOFILE: String(limits.nofile),
    };
    const args = [...CONFINE_NS, "--", "/bin/bash", join(HERE, "render-confine.sh"), "--", ...command];
    const started = Date.now();
    const result = await new Promise((ok) => {
        const p = spawn("/usr/bin/unshare", args, { env, stdio: ["ignore", "pipe", "pipe"] });
        let so = "", se = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, limits.timeoutSec * 1000);
        p.stdout.on("data", (d) => (so = (so + d).slice(-65536)));
        p.stderr.on("data", (d) => (se = (se + d).slice(-65536)));
        p.on("close", (code, signal) => { clearTimeout(timer); ok({ code, signal, timedOut, stdout: so, stderr: se }); });
    });
    await rm(work, { recursive: true, force: true });
    return { ...result, ms: Date.now() - started, ready: /^cf01-confine: pronto$/m.test(result.stderr) };
}

/** `textGeometry` (contrato v4): passagem extra que mede a geometria de texto do candidato → `<outDir>/render-geometry/`. */
export async function renderIsolated({ html, outDir, textGeometry = false }) {
    await mkdir(outDir, { recursive: true });
    const pageDir = join(outDir, "page"), capDir = join(outDir, "capture");
    await mkdir(pageDir, { recursive: true });
    await mkdir(capDir, { recursive: true });
    await writeFile(join(pageDir, "index.html"), html, { flag: "wx" });
    const r = await runConfined({ pageDir, outDir: capDir, command: ["/opt/node/bin/node", join(HERE, "render-inner.mjs"), resolve(pageDir), resolve(capDir), "off", ...(textGeometry ? ["geometry"] : [])] });
    if (textGeometry && existsSync(join(capDir, "geometry"))) await rename(join(capDir, "geometry"), join(outDir, "render-geometry"));
    const hostDir = join(capDir, "127.0.0.1");
    const runs = await readdir(hostDir).catch(() => []);
    let summary = null;
    try { summary = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* sem resumo */ }
    return {
        exitCode: r.code, ms: r.ms, ready: r.ready, timedOut: r.timedOut, captureDir: runs.length === 1 ? join(hostDir, runs[0]) : null, summary,
        stderrTail: r.stderr.split("\n").slice(-8).join("\n"),
        isolation: { confine: "render-confine.sh (técnica do sandbox v1)", namespaces: CONFINE_NS, limits: RENDER_LIMITS, chromeSandbox: "off (substituído pelo confinamento)", csp: "script-src 'none'" },
    };
}
