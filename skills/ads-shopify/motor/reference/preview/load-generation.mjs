/**
 * Carrega uma execução de geração do M4 como dado não confiável:
 * manifesto ok, artefatos com hash conferido e tema presente.
 */

import { z } from "zod";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { manifestSchema } from "../core/run-store.mjs";
import { readRegularFile, resolveInputDir, sha256 } from "../core/safe-read.mjs";

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

const REQUIRED = {
    "generation-plan.json": "generation-plan",
    "generation-map.json": "generation-map",
    "theme-files.json": "theme-files",
    "theme-check.json": "theme-check",
};

export const generationMapSchema = z
    .object({
        schemaVersion: z.literal(1),
        kind: z.literal("GenerationMap"),
        blueprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sections: z.array(
            z
                .object({
                    blueprintSectionId: z.string().regex(/^section-\d{2,3}$/),
                    blueprintType: z.string(),
                    position: z.number().int().min(0),
                    status: z.enum(["generated", "unsupported"]),
                    // 1.7.0 (opcional; mapas anteriores não têm): "estrutural" = estrutura convertida, aparência NÃO medida
                    reproduction: z.enum(["estrutural", "nenhuma"]).optional(),
                    shopify: z
                        .object({
                            file: z.string(),
                            key: z.string().regex(/^[a-z0-9_-]{1,64}$/),
                            type: z.string().regex(/^[a-z0-9-]{1,64}$/),
                            domSelector: z.string(),
                        })
                        .strict()
                        .nullable(),
                })
                .strict()
        ),
    })
    .strict();

const themeFilesSchema = z.object({
    schemaVersion: z.literal(1),
    files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0) }).strict()),
});

function parse(buffer, name) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        throw fail(ErrorCodes.RUN_INVALID, `JSON inválido: ${name}`);
    }
}

export async function loadGeneration(generationDir) {
    const dir = await resolveInputDir(generationDir, "O diretório da geração");
    const manifestBuffer = await readRegularFile(dir, "manifest.json", 2 * 1024 * 1024);
    const parsed = manifestSchema.safeParse(parse(manifestBuffer, "manifest.json"));
    if (!parsed.success) throw fail(ErrorCodes.RUN_INVALID, "Manifesto da geração fora do contrato");
    const manifest = parsed.data;
    const step = manifest.steps.find((item) => item.name === "generate");
    if (manifest.status !== "ok" || step?.status !== "ok") {
        throw fail(ErrorCodes.RUN_NOT_OK, "A geração não foi concluída com sucesso", { status: manifest.status });
    }

    const files = {};
    for (const [name, kind] of Object.entries(REQUIRED)) {
        const entry = manifest.artifacts.find((artifact) => artifact.path === name);
        if (!entry || entry.kind !== kind) throw fail(ErrorCodes.ARTIFACT_MISSING, `Artefato ausente: ${name}`);
        const buffer = await readRegularFile(dir, name, 64 * 1024 * 1024);
        if (buffer.length !== entry.bytes || sha256(buffer) !== entry.sha256) {
            throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Conteúdo não confere com o manifesto: ${name}`, { path: name });
        }
        files[name] = parse(buffer, name);
    }

    // Insumos imutáveis (gerações a partir do M6.2; ausentes nas antigas).
    const OPTIONAL = { "content-pack.json": "content-pack", "code-identity.json": "code-identity" };
    const inputs = {};
    for (const [name, kind] of Object.entries(OPTIONAL)) {
        const entry = manifest.artifacts.find((artifact) => artifact.path === name);
        if (!entry) continue;
        if (entry.kind !== kind) throw fail(ErrorCodes.RUN_INVALID, `Tipo inesperado para ${name}`);
        const buffer = await readRegularFile(dir, name, 4 * 1024 * 1024);
        if (buffer.length !== entry.bytes || sha256(buffer) !== entry.sha256) {
            throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Conteúdo não confere com o manifesto: ${name}`, { path: name });
        }
        inputs[name] = buffer;
    }

    const map = generationMapSchema.safeParse(files["generation-map.json"]);
    if (!map.success) throw fail(ErrorCodes.RUN_INVALID, "generation-map.json fora do contrato");
    const themeFiles = themeFilesSchema.safeParse(files["theme-files.json"]);
    if (!themeFiles.success) throw fail(ErrorCodes.RUN_INVALID, "theme-files.json fora do contrato");
    const plan = files["generation-plan.json"];
    if (plan?.kind !== "GenerationPlan" || plan.provenance?.blueprintSha256 !== map.data.blueprintSha256) {
        throw fail(ErrorCodes.RUN_INVALID, "Plano e mapa da geração não correspondem");
    }
    // Geração com identidade de código no plano (M6.2+): as cópias são
    // obrigatórias e precisam corresponder ao plano — não pode "virar" legado.
    const declared = plan.provenance.code;
    if (declared) {
        if (!inputs["code-identity.json"]) throw fail(ErrorCodes.ARTIFACT_MISSING, "Artefato ausente: code-identity.json (geração registra identidade de código)");
        if (plan.provenance.contentSha256 && !inputs["content-pack.json"]) throw fail(ErrorCodes.ARTIFACT_MISSING, "Artefato ausente: content-pack.json (geração registra ContentPack)");
        const identity = parse(inputs["code-identity.json"], "code-identity.json");
        if (identity.engine?.filesSha256 !== declared.filesSha256 || identity.git?.commit !== declared.commit || identity.codeRecoverable !== declared.codeRecoverable) {
            throw fail(ErrorCodes.RUN_INVALID, "code-identity.json não corresponde à identidade registrada no plano");
        }
    }

    return {
        dir,
        manifest,
        themeDir: await resolveInputDir(`${dir}/theme`, "O tema gerado"),
        plan,
        map: map.data,
        themeFiles: themeFiles.data.files,
        themeCheck: files["theme-check.json"],
        contentPackBuffer: inputs["content-pack.json"] ?? null,
        codeIdentity: inputs["code-identity.json"] ? parse(inputs["code-identity.json"], "code-identity.json") : null,
    };
}
