/**
 * Carrega uma análise concluída do M3 como dado não confiável:
 * manifesto válido com status ok, blueprint.json e analysis.json com
 * tamanho e SHA-256 conferidos, blueprint no contrato e coerente com os
 * metadados da análise.
 *
 * Blueprints v1 (M3) são migrados explicitamente para v2, sem
 * reclassificação; a versão original e a migração ficam no retorno.
 */

import { parseStoreBlueprint } from "../blueprint/schema.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { manifestSchema } from "../core/run-store.mjs";
import { readRegularFile, resolveInputDir, sha256 } from "../core/safe-read.mjs";

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

const REQUIRED = {
    "blueprint.json": { kind: "blueprint", maxBytes: 5 * 1024 * 1024 },
    "analysis.json": { kind: "analysis-meta", maxBytes: 2 * 1024 * 1024 },
};

function parse(buffer, name, code) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        throw fail(code, `JSON inválido: ${name}`);
    }
}

export async function loadAnalysis(analysisDir) {
    const dir = await resolveInputDir(analysisDir, "O diretório da análise");
    const manifestBuffer = await readRegularFile(dir, "manifest.json", 2 * 1024 * 1024);
    const parsed = manifestSchema.safeParse(parse(manifestBuffer, "manifest.json", ErrorCodes.RUN_INVALID));
    if (!parsed.success) {
        throw fail(ErrorCodes.RUN_INVALID, "Manifesto da análise fora do contrato", {
            issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
    }
    const manifest = parsed.data;
    const step = manifest.steps.find((item) => item.name === "analyze");
    if (manifest.status !== "ok" || step?.status !== "ok") {
        throw fail(ErrorCodes.RUN_NOT_OK, "A análise não foi concluída com sucesso", { status: manifest.status });
    }

    const files = {};
    for (const [name, spec] of Object.entries(REQUIRED)) {
        const entry = manifest.artifacts.find((artifact) => artifact.path === name);
        if (!entry) throw fail(ErrorCodes.ARTIFACT_MISSING, `Artefato ausente no manifesto: ${name}`);
        if (entry.kind !== spec.kind) throw fail(ErrorCodes.RUN_INVALID, `Tipo inesperado para ${name}`);
        const buffer = await readRegularFile(dir, name, spec.maxBytes);
        if (buffer.length !== entry.bytes || sha256(buffer) !== entry.sha256) {
            throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Conteúdo não confere com o manifesto: ${name}`, { path: name });
        }
        files[name] = buffer;
    }

    const blueprintResult = parseStoreBlueprint(parse(files["blueprint.json"], "blueprint.json", ErrorCodes.BLUEPRINT_INVALID));
    if (!blueprintResult.success) {
        throw fail(ErrorCodes.BLUEPRINT_INVALID, `Blueprint fora do contrato (${blueprintResult.message})`, {
            issues: (blueprintResult.error?.issues ?? []).slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
    }
    const meta = parse(files["analysis.json"], "analysis.json", ErrorCodes.RUN_INVALID);
    const blueprintSha256 = sha256(files["blueprint.json"]);
    if (meta?.blueprintSha256 !== blueprintSha256 || step.info?.blueprintSha256 !== blueprintSha256) {
        throw fail(ErrorCodes.ARTIFACT_TAMPERED, "Blueprint não corresponde aos metadados da análise");
    }
    if (meta?.capture?.runId !== blueprintResult.data.source.captureRunId) {
        throw fail(ErrorCodes.RUN_INVALID, "Análise e blueprint referem capturas diferentes");
    }

    return {
        dir,
        manifest,
        manifestSha256: sha256(manifestBuffer),
        blueprint: blueprintResult.data,
        blueprintSha256,
        blueprintVersion: blueprintResult.version,
        migratedFrom: blueprintResult.migratedFrom,
    };
}
