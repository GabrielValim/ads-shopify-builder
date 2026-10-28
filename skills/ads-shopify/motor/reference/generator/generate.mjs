/**
 * Shopify Generator (M4): análise M3 -> tema Dawn 16 independente.
 *
 * Simulação por padrão (apenas o plano). Com `apply`, grava SOMENTE em um
 * run novo em runs/generated/<host>/<id>/: tema em `theme/`, plano,
 * mapa de rastreabilidade, relatório e resultado do Theme Check.
 * Nunca toca o tema local em themes/, o lockfile, o patch, o blueprint ou a captura.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { archiveBySha } from "../core/content-archive.mjs";
import { collectCodeIdentity } from "../core/code-identity.mjs";
import { DEFAULT_RUNS_DIR, createRun } from "../core/run-store.mjs";
import { loadRegisteredComponents } from "./components.mjs";
import { loadThemeExtensions } from "./theme-extensions.mjs";
import { STORE_DOMAIN, loadContentPackWithHash } from "./content-pack.mjs";
import { extractVerifiedDawn } from "./dawn-base.mjs";
import { ThemeSchema } from "./dawn-schema.mjs";
import { loadAnalysis } from "./load-analysis.mjs";
import { buildPlan, validatePlan } from "./plan.mjs";
import { renderGenerationReport } from "./report.mjs";
import { compareOffenses, runThemeCheck, themeCheckAvailable } from "./theme-check.mjs";
import { writeTheme } from "./theme-writer.mjs";

export const DEFAULT_GENERATED_DIR = join(DEFAULT_RUNS_DIR, "generated");

const asError = (error) => ({
    code: error instanceof ReferenceEngineError ? error.code : ErrorCodes.GENERATION_INVALID,
    message: String(error?.message ?? error).split("\n")[0],
    ...(error instanceof ReferenceEngineError ? { details: error.details } : {}),
});

/** Mapa de rastreabilidade blueprint -> Shopify (base do M5). */
export function traceabilityMap(plan) {
    return {
        schemaVersion: 1,
        kind: "GenerationMap",
        blueprintSha256: plan.provenance.blueprintSha256,
        sections: plan.sections.map((record) => ({
            blueprintSectionId: record.blueprintSectionId,
            blueprintType: record.blueprintType,
            position: record.position,
            status: record.status,
            // 1.7.0: "generated" = estrutura convertida para uma seção do Dawn; NÃO significa aparência reproduzida
            reproduction: record.status === "generated" ? "estrutural" : "nenhuma",
            shopify: record.target
                ? {
                      file: record.target.file,
                      key: record.target.key,
                      type: record.target.type,
                      // Wrapper renderizado pela Shopify termina com "__<key>".
                      domSelector: `[id^="shopify-section-"][id$="__${record.target.key}"]`,
                  }
                : null,
        })),
    };
}

/**
 * @param {object} params
 * @param {string} params.analysisDir
 * @param {string} [params.contentPath]
 * @param {boolean} [params.apply]
 * @param {string} [params.outputDir]
 * @param {boolean} [params.themeCheck]
 * @param {string} [params.store] loja de destino (domínio canônico, subdomínio myshopify): só ela
 *        recebe referências de imagem com upload verificado nessa loja.
 */
export async function generateTheme({ analysisDir, contentPath, apply = false, outputDir = DEFAULT_GENERATED_DIR, themeCheck = true, archiveDir = join(dirname(outputDir), "content-archive", "sha256"), store = null }) {
    if (store !== null && !STORE_DOMAIN.test(store)) {
        return { ok: false, error: { code: ErrorCodes.GENERATION_INVALID, message: "Loja de destino inválida: use o domínio canônico da loja (subdomínio myshopify), sem protocolo nem caminho" } };
    }
    let analysis;
    let pack = null;
    let contentSha256 = null;
    let contentBuffer = null;
    try {
        analysis = await loadAnalysis(analysisDir);
        if (contentPath) ({ pack, sha256: contentSha256, buffer: contentBuffer } = await loadContentPackWithHash(contentPath));
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        return { ok: false, error: asError(error) };
    }

    let base;
    try {
        base = await extractVerifiedDawn();
    } catch (error) {
        return { ok: false, error: asError(error) };
    }

    try {
        // Identidade do código: dos arquivos-fonte (não dos artefatos), sem ciclo.
        const code = await collectCodeIdentity();
        // Componentes próprios registrados (hash conferido): só os USADOS pelo
        // plano entram no tema; sem eles, o tema é o Dawn + 4 JSON.
        const components = await loadRegisteredComponents();
        // Extensões de tema registradas (hash conferido): toda geração 1.6.0 aplica todas.
        const extensions = await loadThemeExtensions();
        const theme = (await ThemeSchema.load(base.dir)).withComponents(components);
        const dawnSettings = JSON.parse(await readFile(join(base.dir, "config", "settings_data.json"), "utf8"));
        const plan = buildPlan({
            blueprint: analysis.blueprint,
            pack,
            theme,
            dawnSettings,
            components,
            extensions,
            provenance: {
                analysisRunId: analysis.manifest.runId,
                analysisManifestSha256: analysis.manifestSha256,
                blueprintSha256: analysis.blueprintSha256,
                blueprintSchemaVersion: analysis.blueprintVersion,
                blueprintMigratedFrom: analysis.migratedFrom,
                captureRunId: analysis.blueprint.source.captureRunId,
                contentSha256,
                targetStore: store,
                dawn: base.integrity,
                code: { commit: code.git.commit, branch: code.git.branch, treeState: code.git.treeState, filesSha256: code.engine.filesSha256, codeRecoverable: code.codeRecoverable },
            },
        });
        const errors = validatePlan(plan, theme);
        if (errors.length) {
            return { ok: false, error: { code: ErrorCodes.GENERATION_INVALID, message: "Plano inválido segundo os schemas do Dawn", details: { errors: errors.slice(0, 20) } } };
        }

        if (!apply) return { ok: true, mode: "simulation", plan, dawn: base.integrity };

        // --- Escrita (apenas --apply) ---------------------------------------
        const run = await createRun({ url: new URL(analysis.manifest.source.url), rootDir: outputDir });
        const startedAt = new Date().toISOString();
        try {
            const used = components.filter((component) => (plan.components ?? []).some((record) => record.id === component.id));
            const written = await writeTheme({ baseDir: base.dir, runDir: run.dir, files: plan.files, components: used, extensions });

            let check = { status: "skipped", reason: "desativado" };
            if (themeCheck) {
                const version = await themeCheckAvailable();
                if (!version) {
                    check = { status: "skipped", reason: "Shopify CLI indisponível" };
                } else {
                    const baseline = await runThemeCheck(base.dir);
                    const generated = await runThemeCheck(written.dir);
                    check = { status: "ok", cli: version, baseline, generated, comparison: compareOffenses(baseline, generated) };
                }
            }

            // Insumos imutáveis do run: o ContentPack EXATO (mesmo SHA-256 do
            // plano) e a identidade do código. O arquivo por hash é só uma
            // camada adicional de recuperação.
            let contentArchive = null;
            if (contentBuffer) {
                const copy = await run.writeArtifact("content-pack.json", contentBuffer, { kind: "content-pack" });
                if (copy.sha256 !== contentSha256) throw new ReferenceEngineError(ErrorCodes.ARTIFACT_TAMPERED, "Cópia do ContentPack difere do hash registrado no plano");
                contentArchive = (await archiveBySha(contentBuffer, { root: archiveDir, expectedSha256: contentSha256 })).status;
            }
            await run.writeArtifact("code-identity.json", JSON.stringify(code, null, 2) + "\n", { kind: "code-identity" });

            const meta = { dawn: base.integrity, themeCheck: check };
            await run.writeArtifact("generation-plan.json", JSON.stringify(plan, null, 2) + "\n", { kind: "generation-plan" });
            await run.writeArtifact("generation-map.json", JSON.stringify(traceabilityMap(plan), null, 2) + "\n", { kind: "generation-map" });
            await run.writeArtifact("theme-files.json", JSON.stringify({ schemaVersion: 1, files: written.files }, null, 2) + "\n", { kind: "theme-files" });
            await run.writeArtifact("theme-check.json", JSON.stringify(check, null, 2) + "\n", { kind: "theme-check" });
            await run.writeArtifact("generation-report.html", renderGenerationReport(plan, meta), { kind: "report" });

            const regressions = check.status === "ok" ? check.comparison.newOffenses.length : 0;
            await run.recordStep({
                name: "generate",
                status: regressions ? "failed" : "ok",
                startedAt,
                finishedAt: new Date().toISOString(),
                ...(regressions ? { error: { code: ErrorCodes.GENERATION_INVALID, message: `${regressions} ofensa(s) nova(s) no Theme Check` } } : {}),
                info: {
                    analysisRunId: analysis.manifest.runId,
                    blueprintSha256: analysis.blueprintSha256,
                    contentSha256,
                    contentArchive,
                    codeRecoverable: code.codeRecoverable,
                    themeFiles: written.files.length,
                    // Componentes próprios gravados (id, versão, alvo, hash do registro).
                    ...(plan.components ? { components: plan.components } : {}),
                    ...(plan.themeExtensions ? { themeExtensions: plan.themeExtensions } : {}),
                    themeCheck: check.status === "ok" ? { baseline: check.comparison.baseline, generated: check.comparison.generated, new: regressions } : check,
                },
            });
            await run.finish(regressions ? "failed" : "ok");
            return { ok: true, mode: "apply", plan, run, themeDir: written.dir, themeFiles: written.files, themeCheck: check, dawn: base.integrity };
        } catch (error) {
            const failure = asError(error);
            await run.recordStep({ name: "generate", status: "failed", startedAt, finishedAt: new Date().toISOString(), error: { code: failure.code, message: failure.message } }).catch(() => {});
            await run.finish("failed").catch(() => {});
            return { ok: false, run, error: failure };
        }
    } finally {
        await base.cleanup();
    }
}
