/**
 * Reference Analyzer (M3): captura do M2 -> StoreBlueprint v1.
 *
 * Reprocessável: lê apenas os artefatos da captura (sem navegador) e grava
 * o resultado em um run de análise separado, em runs/analyses/<host>/.
 * A captura original nunca é alterada.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import { storeBlueprintSchema } from "../blueprint/schema.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { DEFAULT_RUNS_DIR, createRun } from "../core/run-store.mjs";
import { ANALYZER_VERSION, TOKEN_EVIDENCE, buildBlueprint } from "./build-blueprint.mjs";
import { loadCapture } from "./load-capture.mjs";
import { renderReport } from "./report.mjs";

export const DEFAULT_ANALYSES_DIR = join(DEFAULT_RUNS_DIR, "analyses");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const VOCABULARY = /^[a-z0-9][a-z0-9:._-]*$/; // enums, ids, sinais (controlados)
const HEX = /^#[0-9a-f]{6}$/;

function stringValues(value, out = []) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
    else if (value && typeof value === "object") for (const item of Object.values(value)) stringValues(item, out);
    return out;
}

/**
 * Verificação de defesa: nenhum conteúdo da referência (textos, alt,
 * aria-label, placeholder, URLs, título) pode aparecer nos valores livres
 * do blueprint. Vocabulário controlado, cores e famílias tipográficas
 * permitidas não são valores livres.
 *
 * @param {object} blueprint
 * @param {Array<import("../capture/dom-schema.mjs").DomSnapshot>} snapshots
 * @param {string[]} allowed
 */
export function findContentLeaks(blueprint, snapshots, allowed = []) {
    const allow = new Set(allowed.map((value) => value.toLowerCase()));
    const free = stringValues(blueprint)
        .filter((value) => !VOCABULARY.test(value) && !HEX.test(value) && !allow.has(value.toLowerCase()))
        .map((value) => value.toLowerCase());

    const leaks = new Set();
    for (const snapshot of snapshots) {
        const sources = [snapshot.document.title, snapshot.document.url];
        for (const node of snapshot.nodes) {
            sources.push(node.text, node.attrs.alt, node.attrs.ariaLabel, node.attrs.placeholder, node.attrs.href, node.attrs.src);
        }
        for (const source of sources) {
            const text = String(source ?? "").trim().toLowerCase();
            if (text.length < 4 || !/\p{L}{3}/u.test(text)) continue;
            if (free.some((value) => value.includes(text) || (value.length >= 4 && text.includes(value)))) {
                leaks.add(text.slice(0, 40));
            }
        }
    }
    return [...leaks];
}

/**
 * @param {object} params
 * @param {string} params.captureDir
 * @param {string} [params.analysesDir]
 */
export async function analyzeCapture({ captureDir, analysesDir = DEFAULT_ANALYSES_DIR }) {
    const asError = (error) => ({
        code: error instanceof ReferenceEngineError ? error.code : ErrorCodes.BLUEPRINT_INVALID,
        message: String(error?.message ?? error).split("\n")[0],
        ...(error instanceof ReferenceEngineError ? { details: error.details } : {}),
    });

    // 1. Entradas validadas (recusas aqui não criam run).
    let capture;
    try {
        capture = await loadCapture(captureDir);
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        return { ok: false, run: null, error: asError(error) };
    }

    // 2. Blueprint determinístico + validação + checagem de vazamento.
    const source = {
        captureRunId: capture.manifest.runId,
        captureManifestSha256: capture.manifestSha256,
        inputs: capture.inputs.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
        viewports: Object.fromEntries(
            ["desktop", "mobile"].map((name) => [
                name,
                {
                    width: capture.dom[name].viewport.width,
                    height: capture.dom[name].viewport.height,
                    pageHeight: Math.round(capture.dom[name].document.scroll.height),
                },
            ])
        ),
    };

    let blueprint;
    let blueprintJson;
    let tokenEvidence = null;
    try {
        const screenshots = { desktop: capture.decodeScreenshot("desktop"), mobile: null };
        const built = buildBlueprint({ desktop: capture.dom.desktop, mobile: capture.dom.mobile, source, screenshots });
        tokenEvidence = TOKEN_EVIDENCE.get(built) ?? null;
        const parsed = storeBlueprintSchema.safeParse(built);
        if (!parsed.success) {
            throw new ReferenceEngineError(ErrorCodes.BLUEPRINT_INVALID, "Blueprint gerado fora do contrato", {
                issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
            });
        }
        blueprint = parsed.data;
        blueprintJson = JSON.stringify(blueprint, null, 2) + "\n";

        const families = [blueprint.tokens.typography.heading, blueprint.tokens.typography.body]
            .filter(Boolean)
            .flatMap((role) => [role.family, ...role.fallbacks, role.generic])
            .filter(Boolean);
        const leaks = findContentLeaks(blueprint, [capture.dom.desktop, capture.dom.mobile], families);
        if (leaks.length) {
            throw new ReferenceEngineError(ErrorCodes.BLUEPRINT_INVALID, "Blueprint contém conteúdo da referência", { leaks: leaks.slice(0, 5) });
        }
    } catch (error) {
        return { ok: false, run: null, error: asError(error) };
    }

    // 3. Run de análise isolado.
    const blueprintSha256 = sha256(blueprintJson);
    const checks = [
        ...capture.checks,
        { id: "blueprint:schema", ok: true },
        { id: "blueprint:no-content-leak", ok: true },
    ];
    const meta = {
        schemaVersion: 1,
        analyzer: { version: ANALYZER_VERSION, providers: blueprint.analyzer.providers },
        capture: {
            dir: capture.dir,
            runId: capture.manifest.runId,
            manifestSha256: capture.manifestSha256,
            inputs: capture.inputs,
            warnings: capture.captureWarnings,
        },
        checks,
        blueprintSha256,
        tokenEvidence,
        summary: {
            sections: blueprint.sections.map((section) => ({ id: section.id, type: section.type, confidence: section.confidence })),
            unknowns: blueprint.unknowns.length,
        },
    };

    const startedAt = new Date().toISOString();
    const run = await createRun({ url: new URL(capture.manifest.source.url), rootDir: analysesDir });
    try {
        await run.writeArtifact("blueprint.json", blueprintJson, { kind: "blueprint" });
        await run.writeArtifact("analysis-report.html", renderReport(blueprint, meta), { kind: "report" });
        await run.writeArtifact("analysis.json", JSON.stringify(meta, null, 2) + "\n", { kind: "analysis-meta" });
        await run.recordStep({
            name: "analyze",
            status: "ok",
            startedAt,
            finishedAt: new Date().toISOString(),
            info: { captureRunId: capture.manifest.runId, captureManifestSha256: capture.manifestSha256, blueprintSha256 },
        });
        await run.finish("ok");
    } catch (error) {
        await run
            .recordStep({
                name: "analyze",
                status: "failed",
                startedAt,
                finishedAt: new Date().toISOString(),
                error: { code: asError(error).code, message: asError(error).message },
            })
            .catch(() => {});
        await run.finish("failed").catch(() => {});
        return { ok: false, run, error: asError(error) };
    }

    return { ok: true, run, blueprint, blueprintSha256, meta, error: null };
}
