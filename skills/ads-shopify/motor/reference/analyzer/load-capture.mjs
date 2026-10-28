/**
 * Carrega uma captura concluída do M2 como DADO NÃO CONFIÁVEL.
 *
 * Antes de qualquer análise:
 *  - o diretório não pode ser symlink; arquivos são abertos com O_NOFOLLOW
 *    e precisam ser regulares, dentro do diretório e com tamanho limitado;
 *  - o manifesto precisa ser válido, com status "ok" e etapa de captura ok;
 *  - cada artefato exigido precisa estar registrado e conferir em tamanho e
 *    SHA-256 com o manifesto (detecta adulteração);
 *  - os DOMs precisam obedecer ao contrato e ser coerentes entre si e com
 *    os screenshots.
 * Nada é gravado no diretório da captura.
 */


import { domSnapshotSchema } from "../capture/dom-schema.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { manifestSchema } from "../core/run-store.mjs";
import { decodePng } from "../compare/png.mjs";
import { readRegularFile, resolveInputDir, sha256 } from "../core/safe-read.mjs";

export const REQUIRED_ARTIFACTS = Object.freeze({
    "dom-desktop.json": { kind: "dom", maxBytes: 30 * 1024 * 1024 },
    "dom-mobile.json": { kind: "dom", maxBytes: 30 * 1024 * 1024 },
    "screenshot-desktop.png": { kind: "screenshot", maxBytes: 80 * 1024 * 1024 },
    "screenshot-mobile.png": { kind: "screenshot", maxBytes: 80 * 1024 * 1024 },
});

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 20_000;

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);

function parseJson(buffer, name) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        throw fail(name === "manifest.json" ? ErrorCodes.RUN_INVALID : ErrorCodes.CAPTURE_INVALID, `JSON inválido: ${name}`, { path: name });
    }
}

function pngSize(buffer, name) {
    const signature = "89504e470d0a1a0a";
    if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature || buffer.subarray(12, 16).toString("latin1") !== "IHDR") {
        throw fail(ErrorCodes.CAPTURE_INVALID, `PNG inválido: ${name}`, { path: name });
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}


/**
 * @param {string} captureDir
 */
export async function loadCapture(captureDir) {
    const checks = [];
    const check = (id, detail) => checks.push({ id, ok: true, ...(detail ? { detail } : {}) });

    const dir = await resolveInputDir(captureDir, "O diretório da captura");
    check("dir:regular");

    // --- Manifesto ---------------------------------------------------------
    const manifestBuffer = await readRegularFile(dir, "manifest.json", MAX_MANIFEST_BYTES);
    const parsedManifest = manifestSchema.safeParse(parseJson(manifestBuffer, "manifest.json"));
    if (!parsedManifest.success) {
        throw fail(ErrorCodes.RUN_INVALID, "Manifesto fora do contrato", {
            issues: parsedManifest.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
    }
    const manifest = parsedManifest.data;
    check("manifest:schema");

    const step = manifest.steps.find((item) => item.name === "capture");
    if (manifest.status !== "ok" || !step || step.status !== "ok") {
        throw fail(ErrorCodes.RUN_NOT_OK, `Captura não concluída com sucesso (status ${manifest.status})`, {
            status: manifest.status,
            step: step?.status ?? null,
        });
    }
    check("manifest:status-ok");

    // --- Artefatos (presença, integridade) ---------------------------------
    const buffers = {};
    const inputs = [];
    for (const [name, spec] of Object.entries(REQUIRED_ARTIFACTS)) {
        const entry = manifest.artifacts.find((artifact) => artifact.path === name);
        if (!entry) {
            const viewport = name.includes("mobile") ? "mobile" : "desktop";
            throw fail(ErrorCodes.VIEWPORT_MISSING, `Artefato do viewport ${viewport} ausente no manifesto: ${name}`, { path: name, viewport });
        }
        if (entry.kind !== spec.kind) throw fail(ErrorCodes.RUN_INVALID, `Tipo inesperado para ${name}`, { kind: entry.kind });

        const buffer = await readRegularFile(dir, name, spec.maxBytes);
        const digest = sha256(buffer);
        if (buffer.length !== entry.bytes || digest !== entry.sha256) {
            throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Conteúdo não confere com o manifesto: ${name}`, {
                path: name,
                expected: entry.sha256,
                actual: digest,
            });
        }
        buffers[name] = buffer;
        inputs.push({ path: name, sha256: digest, bytes: buffer.length });
    }
    check("artifacts:sha256", `${inputs.length} arquivos conferidos`);

    // --- DOM ---------------------------------------------------------------
    const dom = {};
    for (const viewport of ["desktop", "mobile"]) {
        const name = `dom-${viewport}.json`;
        const raw = parseJson(buffers[name], name);
        if (Array.isArray(raw?.nodes) && raw.nodes.length > MAX_NODES) {
            throw fail(ErrorCodes.RESOURCE_LIMIT, `DOM com nós demais: ${name}`, { nodes: raw.nodes.length });
        }
        const parsed = domSnapshotSchema.safeParse(raw);
        if (!parsed.success) {
            throw fail(ErrorCodes.CAPTURE_INVALID, `DOM fora do contrato: ${name}`, {
                issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
            });
        }
        if (parsed.data.viewport.name !== viewport) {
            throw fail(ErrorCodes.CAPTURE_INCONSISTENT, `${name} declara viewport ${parsed.data.viewport.name}`);
        }
        if (!parsed.data.nodes.length || parsed.data.nodes[0].parent !== null) {
            throw fail(ErrorCodes.CAPTURE_INVALID, `${name} sem nó raiz`);
        }
        dom[viewport] = parsed.data;
    }
    check("dom:schema");

    // --- Coerência entre viewports e com os screenshots ---------------------
    const { desktop, mobile } = dom;
    if (desktop.viewport.isMobile || !mobile.viewport.isMobile || desktop.viewport.width <= mobile.viewport.width) {
        throw fail(ErrorCodes.CAPTURE_INCONSISTENT, "Viewports desktop/mobile incoerentes");
    }
    if (desktop.document.url !== mobile.document.url) {
        throw fail(ErrorCodes.CAPTURE_INCONSISTENT, "Desktop e mobile capturaram documentos diferentes");
    }
    check("viewports:same-document");

    const screenshots = {};
    for (const viewport of ["desktop", "mobile"]) {
        const size = pngSize(buffers[`screenshot-${viewport}.png`], `screenshot-${viewport}.png`);
        const snapshot = dom[viewport];
        const expectedWidth = Math.round(snapshot.viewport.width);
        if (size.width !== expectedWidth || size.height < 1 || size.height > snapshot.document.scroll.height + 1) {
            throw fail(ErrorCodes.CAPTURE_INCONSISTENT, `Screenshot ${viewport} incoerente com o DOM`, { png: size });
        }
        screenshots[viewport] = size;
    }
    check("screenshots:dimensions");

    const warnings = Array.isArray(step.info?.warnings) ? step.info.warnings.slice(0, 50) : [];
    if (step.info?.complete === false) checks.push({ id: "capture:complete", ok: false, detail: "captura com avisos" });
    else check("capture:complete");

    return {
        dir,
        manifest,
        manifestSha256: sha256(manifestBuffer),
        dom,
        inputs,
        screenshots,
        // Pixels dos MESMOS bytes conferidos acima (hash do manifesto),
        // decodificados só quando pedidos (medição de cor do fundo).
        decodeScreenshot: (viewport) => decodePng(buffers[`screenshot-${viewport}.png`]),
        checks,
        captureWarnings: warnings,
    };
}
