/**
 * Visual Validation (M5): referência (captura M2) × tema gerado renderizado
 * (captura M2 da prévia), guiada pelo generation-map do M4.
 *
 * Somente leitura sobre as entradas (todas validadas por manifesto/hash).
 * Cada comparação grava um run NOVO em runs/comparisons/<host>/<id>/ e lista
 * as comparações anteriores (histórico preservado).
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { loadCapture } from "../analyzer/load-capture.mjs";
import { isOpaque, parseColor } from "../analyzer/color.mjs";
import { DomIndex } from "../analyzer/dom-index.mjs";
import { bandFeatures } from "../analyzer/structure.mjs";
import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { DEFAULT_RUNS_DIR, createRun } from "../core/run-store.mjs";
import { readRegularFile, sha256 } from "../core/safe-read.mjs";
import { loadAnalysis } from "../generator/load-analysis.mjs";
import { loadGeneration } from "../preview/load-generation.mjs";
import { crop, deltaE, diffImage, dominantColor, gridSimilarity, maskFromBoxes, resize, scale, sideBySide, stack, toHex } from "./image-ops.mjs";
import { TOLERANCE, CATEGORIES, SCORE_WEIGHTS, categorize, genericFamily, geometryScore, recommend, sectionScore, viewportScore } from "./metrics.mjs";
import { decodePng, encodePng } from "./png.mjs";
import { renderComparisonReport } from "./report.mjs";

export const DEFAULT_COMPARISONS_DIR = join(DEFAULT_RUNS_DIR, "comparisons");
export const COMPARATOR_VERSION = "1.0.0";
const GRID_COLS = 48;
const VIEWPORTS = ["desktop", "mobile"];

const fail = (code, message, details) => new ReferenceEngineError(code, message, details);
const round = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Nó da seção gerada no DOM renderizado pela Shopify. */
export function locateRenderedSection(index, key) {
    const pattern = new RegExp(`^shopify-section-.+__${escapeRegex(key)}$`);
    return index.nodes.find((node) => node.visible && node.box.height > 0 && pattern.test(node.attrs.id ?? "")) ?? null;
}

/**
 * Desce por embrulhos sem aparência própria (ex.: div.shopify-section) até o
 * primeiro nó que de fato pinta a seção: um único filho visível que cobre
 * ≥90% da área do pai.
 */
export function unwrapSection(index, node) {
    let current = node;
    for (let depth = 0; depth < 6; depth++) {
        const styles = current.styles ?? {};
        if (isOpaque(parseColor(styles.backgroundColor)) || /url\(|gradient\(/.test(styles.backgroundImage ?? "")) return current;
        const kids = index.visibleChildren(current.id).map((id) => index.node(id));
        if (kids.length !== 1) return current;
        const kid = kids[0];
        if (kid.box.width * kid.box.height < current.box.width * current.box.height * 0.9) return current;
        current = kid;
    }
    return current;
}

/** Nó da referência com a caixa registrada no blueprint. */
function locateReferenceBand(index, box) {
    return (
        index.nodes.find(
            (node) =>
                node.visible &&
                Math.round(node.box.x) === box.x &&
                Math.round(node.box.y) === box.y &&
                Math.round(node.box.width) === box.width &&
                Math.round(node.box.height) === box.height
        ) ?? null
    );
}

function relativeBoxes(items, container) {
    return items.map((item) => ({
        x: (item.box.x - container.x) / (container.width || 1),
        y: (item.box.y - container.y) / (container.height || 1),
        width: item.box.width / (container.width || 1),
        height: item.box.height / (container.height || 1),
    }));
}

function domFacts(index, features) {
    const firstHeading = features.headings[0] ? index.node(features.headings[0].id) : null;
    const columns = Math.max(1, features.repeated && features.repeated.imageShare >= 0.5 ? features.repeated.columns : features.columns.columns);
    return {
        headingPx: firstHeading ? features.headings[0].size : null,
        headingFamily: firstHeading ? genericFamily(firstHeading.styles.fontFamily) : null,
        columns,
        buttons: features.buttons.length,
        textColor: features.headingColor ?? features.textColor,
        background: features.background.image ? "image" : features.background.hex,
    };
}

async function readImage(dir, name, expectedSha) {
    const buffer = await readRegularFile(dir, name, 80 * 1024 * 1024);
    if (sha256(buffer) !== expectedSha) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Screenshot mudou após validação: ${name}`);
    return decodePng(buffer);
}

async function previousComparisons(root, currentId) {
    const history = [];
    let dirs = [];
    try {
        dirs = await readdir(root, { withFileTypes: true });
    } catch {
        return history;
    }
    const entrySchema = z.object({
        runId: z.string(),
        reference: z.object({ runId: z.string() }).passthrough(),
        candidate: z.object({ runId: z.string() }).passthrough(),
        generation: z.object({ runId: z.string() }).passthrough(),
        scores: z.record(z.string(), z.unknown()),
    }).passthrough();
    for (const dir of dirs) {
        if (!dir.isDirectory() || dir.name === currentId) continue;
        try {
            const data = entrySchema.parse(JSON.parse((await readRegularFile(join(root, dir.name), "comparison.json", 20 * 1024 * 1024)).toString("utf8")));
            history.push({ runId: data.runId, reference: data.reference.runId, candidate: data.candidate.runId, generation: data.generation.runId, scores: data.scores });
        } catch {
            /* run incompleto ou inválido: ignorado no histórico */
        }
    }
    return history.sort((a, b) => (a.runId < b.runId ? -1 : 1));
}

/**
 * @param {object} params
 * @param {string} params.referenceDir captura M2 da referência
 * @param {string} params.candidateDir captura M2 da prévia do tema gerado
 * @param {string} params.analysisDir análise M3 da referência
 * @param {string} params.generationDir geração M4
 * @param {string} [params.outputDir]
 */
export async function compareRender({ referenceDir, candidateDir, analysisDir, generationDir, outputDir = DEFAULT_COMPARISONS_DIR }) {
    let reference, candidate, analysis, generation;
    try {
        [reference, candidate, analysis, generation] = await Promise.all([
            loadCapture(referenceDir),
            loadCapture(candidateDir),
            loadAnalysis(analysisDir),
            loadGeneration(generationDir),
        ]);
        const blueprint = analysis.blueprint;
        if (blueprint.source.captureRunId !== reference.manifest.runId) {
            throw fail(ErrorCodes.CAPTURE_INCONSISTENT, "A análise não corresponde à captura de referência");
        }
        for (const input of blueprint.source.inputs) {
            const actual = reference.inputs.find((item) => item.path === input.path);
            if (actual?.sha256 !== input.sha256) throw fail(ErrorCodes.ARTIFACT_TAMPERED, `Captura de referência difere do blueprint: ${input.path}`);
        }
        if (generation.plan.provenance.blueprintSha256 !== analysis.blueprintSha256) {
            throw fail(ErrorCodes.CAPTURE_INCONSISTENT, "A geração não corresponde à análise informada");
        }
        if (candidate.manifest.runId === reference.manifest.runId) {
            throw fail(ErrorCodes.CAPTURE_INCONSISTENT, "Referência e candidato são a mesma captura");
        }
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
    }

    const blueprint = analysis.blueprint;
    const plan = generation.plan;
    const globalFidelity = plan.fidelity.filter((item) => !item.section);
    const viewports = {};
    const findings = [];
    const images = {};

    for (const viewport of VIEWPORTS) {
        const refImage = await readImage(reference.dir, `screenshot-${viewport}.png`, reference.inputs.find((i) => i.path === `screenshot-${viewport}.png`).sha256);
        const candImage = await readImage(candidate.dir, `screenshot-${viewport}.png`, candidate.inputs.find((i) => i.path === `screenshot-${viewport}.png`).sha256);
        const refIndex = new DomIndex(reference.dom[viewport]);
        const candIndex = new DomIndex(candidate.dom[viewport]);
        const refPageHeight = reference.dom[viewport].document.scroll.height;
        const entries = [];
        const strips = [];
        const stripWidth = viewport === "desktop" ? 480 : 260;

        for (const mapped of generation.map.sections) {
            const section = blueprint.sections.find((item) => item.id === mapped.blueprintSectionId);
            const presence = section?.viewports[viewport] ?? null;
            const record = plan.sections.find((item) => item.blueprintSectionId === mapped.blueprintSectionId);
            const base = {
                blueprintSectionId: mapped.blueprintSectionId,
                blueprintType: mapped.blueprintType,
                shopifyType: mapped.shopify?.type ?? null,
                status: mapped.status,
                referenceHeight: presence?.box.height ?? 0,
                referenceShare: presence ? round(presence.box.height / refPageHeight) : 0,
                hints: record?.hints ?? [],
            };
            if (!presence) {
                entries.push({ ...base, status: "absent-in-reference", score: null });
                continue;
            }
            if (mapped.status === "unsupported") {
                entries.push({ ...base, score: null, reference: presence.box });
                findings.push({
                    section: mapped.blueprintSectionId,
                    viewport,
                    aspect: "section",
                    expected: `${mapped.blueprintType} (${(record?.hints ?? []).join(", ") || "sem hipótese"})`,
                    measured: "não gerada",
                    category: "not-implemented",
                    explanation: record?.reason ?? "seção não suportada",
                    referenceShare: base.referenceShare,
                    loss: 1,
                });
                continue;
            }

            const node = locateRenderedSection(candIndex, mapped.shopify.key);
            if (!node) {
                entries.push({ ...base, status: "missing", score: null, reference: presence.box });
                findings.push({ section: mapped.blueprintSectionId, viewport, aspect: "missing-section", expected: mapped.shopify.domSelector, measured: "não encontrada", ...categorize(record, "missing-section"), referenceShare: base.referenceShare, loss: 1 });
                continue;
            }

            const refBox = presence.box;
            const candBox = { x: Math.round(node.box.x), y: Math.round(node.box.y), width: Math.round(node.box.width), height: Math.round(node.box.height) };
            const refCrop = crop(refImage, refBox);
            const candCrop = crop(candImage, candBox);
            const rows = Math.min(120, Math.max(3, Math.round((GRID_COLS * refBox.height) / Math.max(refBox.width, 1))));

            const painted = unwrapSection(candIndex, node);
            const candFeatures = bandFeatures(candIndex, painted.id);
            const refBand = locateReferenceBand(refIndex, refBox);
            const refNode = refBand ? unwrapSection(refIndex, refBand) : null;
            const refFeatures = refNode ? bandFeatures(refIndex, refNode.id) : null;

            const refMediaBoxes = presence.images.map((image) => image.position);
            const candMediaBoxes = [
                ...(candFeatures.backgroundImage ? [{ x: 0, y: 0, width: 1, height: 1 }] : []),
                ...relativeBoxes(candFeatures.media, node.box),
            ];
            const mask = maskFromBoxes(GRID_COLS, rows, [...refMediaBoxes, ...candMediaBoxes]);
            const full = refCrop && candCrop ? gridSimilarity(refCrop, candCrop, GRID_COLS, rows) : null;
            const masked = refCrop && candCrop ? gridSimilarity(refCrop, candCrop, GRID_COLS, rows, mask) : null;
            const unmaskedShare = masked ? round(masked.cells / masked.total) : 0;
            const useMasked = masked && masked.cells >= masked.total * 0.1;
            const structure = useMasked ? masked.structure : full?.structure ?? null;
            const color = useMasked ? masked.color : full?.color ?? null;
            const geometry = geometryScore(refBox, candBox);
            const score = sectionScore({ structure, color, geometry });

            const refDominant = refCrop ? dominantColor(refCrop) : null;
            const candDominant = candCrop ? dominantColor(candCrop) : null;
            const refFacts = refFeatures ? domFacts(refIndex, refFeatures) : null;
            const candFacts = domFacts(candIndex, candFeatures);

            const entry = {
                ...base,
                reference: refBox,
                candidate: candBox,
                geometry: { score: geometry, heightDelta: candBox.height - refBox.height, yDelta: candBox.y - refBox.y },
                pixels: {
                    grid: `${GRID_COLS}x${rows}`,
                    full,
                    masked,
                    maskedShare: round(1 - unmaskedShare),
                    // Ganho ao ignorar as imagens: quanto da diferença vem da mídia.
                    imageEffect: full && useMasked ? round((masked.color + masked.structure - full.color - full.structure) / 2) : null,
                    basis: useMasked ? "mascarada" : "completa (imagem cobre a seção ou máscara > 90%)",
                },
                dominantColor: refDominant && candDominant ? { reference: toHex(refDominant), candidate: toHex(candDominant), deltaE: deltaE(refDominant, candDominant) } : null,
                dom: { reference: refFacts, candidate: candFacts },
                score,
            };
            entries.push(entry);

            // --- Achados medidos ------------------------------------------
            const push = (aspect, expected, measured, extra = {}) => {
                findings.push({ section: mapped.blueprintSectionId, viewport, aspect, expected, measured, ...categorize(record, aspect, { viewport, globalFidelity, heightDelta: entry.geometry.heightDelta }), referenceShare: base.referenceShare, loss: round(1 - (score ?? 0)), ...extra });
            };
            const columnsDiverge = refFacts && refFacts.columns !== candFacts.columns && ["product-grid", "footer"].includes(mapped.blueprintType);
            if (Math.abs(entry.geometry.heightDelta) / refBox.height > TOLERANCE.heightRatio) {
                if (columnsDiverge) {
                    push("height", `${refBox.height}px`, `${candBox.height}px`, { category: "conversion-issue", explanation: `consequência da divergência de colunas (${refFacts.columns} → ${candFacts.columns})` });
                } else {
                    push("height", `${refBox.height}px`, `${candBox.height}px`);
                }
            }
            if (refFacts && candFacts.headingPx && refFacts.headingPx && Math.abs(candFacts.headingPx - refFacts.headingPx) / refFacts.headingPx > TOLERANCE.headingRatio) {
                push("heading-size", `${refFacts.headingPx}px`, `${candFacts.headingPx}px`);
            }
            if (refFacts?.headingFamily && candFacts.headingFamily && refFacts.headingFamily !== candFacts.headingFamily) {
                push("font-family", refFacts.headingFamily, candFacts.headingFamily);
            }
            if (columnsDiverge) push("columns", refFacts.columns, candFacts.columns);
            if (refFacts && refFacts.buttons !== candFacts.buttons) push("buttons", refFacts.buttons, candFacts.buttons);
            if (refFacts?.background === "image") {
                if (candFacts.background !== "image") push("background-image", "imagem de fundo", candFacts.background ?? "sem fundo");
            } else if (refFacts?.background && candFacts.background && candFacts.background !== "image") {
                const d = deltaE(hexRgb(refFacts.background), hexRgb(candFacts.background));
                if (d > TOLERANCE.deltaE) push("background-color", refFacts.background, candFacts.background, { deltaE: d });
            }
            if (refFacts?.textColor && candFacts.textColor) {
                const d = deltaE(hexRgb(refFacts.textColor), hexRgb(candFacts.textColor));
                if (d > TOLERANCE.deltaE) push("text-color", refFacts.textColor, candFacts.textColor, { deltaE: d });
            }
            if (entry.pixels.imageEffect !== null && entry.pixels.imageEffect >= TOLERANCE.imageEffect && (presence.images.length || candFeatures.media.length)) {
                push("image", "mídia da referência", "placeholder/sem imagem", { imageEffect: entry.pixels.imageEffect });
            }

            // --- Faixa visual da seção ---------------------------------------
            if (refCrop && candCrop) {
                const width = stripWidth;
                const refThumb = resize(refCrop, width, Math.min(600, (refCrop.height * width) / refCrop.width));
                const candThumb = resize(candCrop, width, Math.min(600, (candCrop.height * width) / candCrop.width));
                const diff = diffImage(refThumb, resize(candCrop, refThumb.width, refThumb.height)).image;
                strips.push(sideBySide([refThumb, candThumb, diff], 8));
            }
        }

        // --- Página inteira ----------------------------------------------------
        const found = entries.filter((entry) => entry.candidate);
        const orderOk = found.every((entry, i) => i === 0 || entry.candidate.y >= found[i - 1].candidate.y);
        const mappedKeys = new Set(generation.map.sections.filter((s) => s.shopify).map((s) => s.shopify.key));
        const extras = candIndex.nodes
            .filter((node) => node.visible && node.box.height > 4 && /^shopify-section-/.test(node.attrs.id ?? ""))
            .filter((node) => ![...mappedKeys].some((key) => new RegExp(`__${escapeRegex(key)}$`).test(node.attrs.id)))
            .map((node) => ({ id: node.attrs.id.slice(0, 80), height: Math.round(node.box.height) }));

        const factor = viewport === "desktop" ? 0.5 : 1;
        const refScaled = scale(refImage, factor);
        const candScaled = scale(candImage, factor);
        const pageDiff = diffImage(refImage, candImage);
        images[`sidebyside-${viewport}.png`] = encodePng(sideBySide([refScaled, candScaled], 24));
        images[`diff-${viewport}.png`] = encodePng(scale(pageDiff.image, factor));
        if (strips.length) images[`sections-${viewport}.png`] = encodePng(stack(strips, 16));

        const compared = entries.filter((entry) => entry.score !== null && entry.score !== undefined);
        const comparedHeight = compared.reduce((sum, entry) => sum + entry.referenceHeight, 0);
        viewports[viewport] = {
            reference: { pageHeight: refPageHeight, width: refImage.width },
            candidate: { pageHeight: candidate.dom[viewport].document.scroll.height, width: candImage.width },
            orderPreserved: orderOk,
            coverage: round(comparedHeight / refPageHeight),
            score: viewportScore(compared),
            pageDiff: { changedRatio: pageDiff.changedRatio, meanDelta: pageDiff.meanDelta, note: "alinhada ao topo; deslocamentos verticais acumulam — informativa" },
            extras,
            sections: entries,
        };
    }

    // Itens declarados pelo plano mas não medidos visualmente.
    const declared = [];
    for (const record of plan.sections) {
        for (const item of record.ignored ?? []) declared.push({ section: record.blueprintSectionId, aspect: item.field, category: /blueprint|evidência|observável/i.test(item.reason) ? "blueprint-gap" : "dawn-limitation", explanation: item.reason });
        for (const item of record.fidelity ?? []) declared.push({ section: record.blueprintSectionId, aspect: item.aspect, category: "dawn-limitation", explanation: `esperado ${item.expected}; obtido ${item.achieved}${item.note ? ` (${item.note})` : ""}` });
        for (const item of record.dependencies ?? []) declared.push({ section: record.blueprintSectionId, aspect: item.kind, category: "not-implemented", explanation: item.detail });
    }
    for (const item of globalFidelity) declared.push({ section: null, aspect: item.aspect, category: item.aspect === "fonts" ? "not-implemented" : "dawn-limitation", explanation: `esperado ${item.expected}; obtido ${item.achieved}` });

    const unsupported = generation.map.sections
        .filter((s) => s.status === "unsupported")
        .map((s) => ({
            ...s,
            hints: plan.sections.find((r) => r.blueprintSectionId === s.blueprintSectionId)?.hints ?? [],
            referenceShare: viewports.desktop.sections.find((e) => e.blueprintSectionId === s.blueprintSectionId)?.referenceShare ?? 0,
        }));

    const scores = {
        desktop: viewports.desktop.score,
        mobile: viewports.mobile.score,
        overall: viewports.desktop.score !== null && viewports.mobile.score !== null ? round((viewports.desktop.score + viewports.mobile.score) / 2) : null,
        coverage: { desktop: viewports.desktop.coverage, mobile: viewports.mobile.coverage },
    };

    const result = {
        schemaVersion: 1,
        kind: "VisualComparison",
        comparator: COMPARATOR_VERSION,
        reference: { runId: reference.manifest.runId, url: reference.manifest.source.url },
        candidate: { runId: candidate.manifest.runId, url: candidate.manifest.source.url },
        analysis: { runId: analysis.manifest.runId, blueprintSha256: analysis.blueprintSha256 },
        generation: { runId: generation.manifest.runId },
        method: {
            weights: SCORE_WEIGHTS,
            tolerance: TOLERANCE,
            formula: "seção = 0.35·estrutura + 0.35·cor + 0.30·geometria (estrutura/cor em grade 48×N, com áreas de imagem mascaradas quando ≥10% da grade continua comparável); viewport = média ponderada pela altura de referência das seções comparadas; geral = média de desktop e mobile",
            excluded: [
                "seções não geradas (contam só na cobertura)",
                "áreas de imagem (mascaradas nas métricas de estrutura/cor; efeito reportado à parte)",
                "conteúdo textual (os textos vêm do ContentPack, não da referência)",
                "animações/estados interativos",
            ],
            categories: CATEGORIES,
        },
        scores,
        viewports,
        findings,
        declared,
        recommendations: recommend(findings, unsupported),
    };

    const host = new URL(candidate.manifest.source.url);
    const run = await createRun({ url: host, rootDir: outputDir });
    result.runId = run.id;
    result.history = await previousComparisons(join(outputDir, basename(dirname(run.dir))), run.id);
    for (const [name, data] of Object.entries(images).sort()) await run.writeArtifact(name, data, { kind: "comparison-image" });
    await run.writeArtifact("comparison.json", JSON.stringify(result, null, 2) + "\n", { kind: "comparison" });
    await run.writeArtifact("comparison-report.html", renderComparisonReport(result, images), { kind: "report" });
    await run.recordStep({ name: "compare", status: "ok", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), info: { scores } });
    await run.finish("ok");

    return { ok: true, run, result };
}

function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
