/**
 * Theme Check local (Shopify CLI). Não contata a loja: apenas analisa
 * arquivos. Telemetria da CLI desativada.
 *
 * O resultado do tema gerado é comparado com o do Dawn base no mesmo
 * run: só ofensas novas contam como regressão.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Variaveis que o Windows exige para qualquer processo filho (e que a CLI da
// Shopify usa para achar a sessao de login). Em POSIX o filtro nao acrescenta nada.
const ENV_SISTEMA = ["SystemRoot", "windir", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP"];
const envSistema = () => Object.fromEntries(ENV_SISTEMA.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

// A CLI da Shopify fica dentro do motor, nao no PATH. Chamar o entrypoint JS
// com o Node atual evita depender do PATH e dos atalhos .cmd do Windows.
const CLI_ENTRY = join(import.meta.dirname, "..", "..", "node_modules", "@shopify", "cli", "bin", "run.js");
const CLI = existsSync(CLI_ENTRY) ? [process.execPath, CLI_ENTRY] : ["shopify"];
const runCli = (args, opts) => run(CLI[0], [...CLI.slice(1), ...args], opts);

const ENV = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...envSistema(),
    SHOPIFY_CLI_NO_ANALYTICS: "1",
    NO_COLOR: "1",
    CI: "1",
};

export async function themeCheckAvailable() {
    try {
        const { stdout } = await runCli(["version"], { env: ENV, timeout: 60_000 });
        return stdout.trim().split("\n").pop();
    } catch {
        return null;
    }
}

/**
 * @returns {Promise<Array<{ check: string, severity: string, path: string, message: string, line: number | null }>>}
 */
export async function runThemeCheck(themeDir) {
    let stdout;
    try {
        ({ stdout } = await runCli(["theme", "check", "--path", themeDir, "--output", "json", "--no-color"], {
            env: ENV,
            timeout: 300_000,
            maxBuffer: 64 * 1024 * 1024,
        }));
    } catch (error) {
        // Ofensas de nível error fazem a CLI sair com código != 0.
        if (!error.stdout) throw new Error(`theme check falhou: ${String(error.stderr ?? error.message).slice(0, 300)}`);
        stdout = error.stdout;
    }
    const report = JSON.parse(stdout);
    const offenses = [];
    for (const file of report) {
        const path = relative(themeDir, file.path).split(sep).join("/");
        for (const offense of file.offenses) {
            offenses.push({
                check: offense.check,
                severity: String(offense.severity),
                path,
                message: offense.message,
                line: offense.start_row ?? offense.start?.line ?? null,
            });
        }
    }
    return offenses.sort((a, b) => (`${a.path}${a.check}${a.message}` < `${b.path}${b.check}${b.message}` ? -1 : 1));
}

const key = (offense) => `${offense.check}|${offense.path}|${offense.message}`;

export function compareOffenses(baseline, generated) {
    const base = new Set(baseline.map(key));
    const gen = new Set(generated.map(key));
    return {
        baseline: baseline.length,
        generated: generated.length,
        newOffenses: generated.filter((offense) => !base.has(key(offense))),
        resolved: baseline.filter((offense) => !gen.has(key(offense))),
    };
}
