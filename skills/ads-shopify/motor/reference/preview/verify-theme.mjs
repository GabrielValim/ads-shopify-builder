/**
 * Pré-validação do tema gerado ANTES de qualquer operação remota.
 * Somente leitura. Cada verificação produz { id, ok, detail }.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import { verifyPackAssets } from "../assets/assets.mjs";
import { loadContentPackWithHash, parseContentPack, slotImageReference, toInline, toRichtext } from "../generator/content-pack.mjs";
import { readArchived } from "../core/content-archive.mjs";
import { verifyCodeRecoverable } from "../core/code-identity.mjs";
import { readRegularFile } from "../core/safe-read.mjs";
import { extractVerifiedDawn } from "../generator/dawn-base.mjs";
import { ThemeSchema, isLinearGradient } from "../generator/dawn-schema.mjs";
import { validatePlan } from "../generator/plan.mjs";
import { COMPONENT_REGISTRY, loadRegisteredComponents } from "../generator/components.mjs";
import { WRITABLE_FILES } from "../generator/theme-writer.mjs";
import { THEME_EXTENSION_REGISTRY, declaredExtensionProblems, registeredThemeExtension } from "../generator/theme-extensions.mjs";
import { loadGeneration } from "./load-generation.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
/** Versão x.y.z ≥ mínima (versão ausente ou inválida: não). */
const atLeast = (version, min) => { const a = String(version ?? "").split(".").map(Number), b = min.split(".").map(Number); if (a.length !== 3 || a.some((n) => !Number.isInteger(n))) return false; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

// Padrões de credenciais (tokens Shopify, chaves privadas, segredos).
const SECRET_PATTERNS = [
    [/shp(?:at|ss|ca|pa|ua)_[0-9a-fA-F]{20,}/, "token Shopify"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "chave privada"],
    [/client_secret\s*["':=]/i, "client_secret"],
    [/SHOPIFY_(?:CLIENT|SHOP|ACCESS|API)[A-Z_]*\s*=/, "variável de credencial"],
    [/xox[baprs]-[0-9A-Za-z-]{10,}/, "token Slack"],
    [/AKIA[0-9A-Z]{16}/, "chave AWS"],
];

// Strings permitidas sem origem em conteúdo: vocabulário controlado.
const VOCABULARY = /^(?:[a-z0-9_-]{1,64}|#[0-9A-Fa-f]{6}|shopify:\/\/(?:collections|products|pages|blogs)\/[a-z0-9-]+|\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?|t:[a-z0-9_.-]+|)$/;

async function walk(root) {
    const files = [];
    async function visit(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            const info = await lstat(path);
            if (info.isSymbolicLink()) throw new Error(`symlink: ${relative(root, path)}`);
            if (info.isDirectory()) await visit(path);
            else files.push(relative(root, path).split(sep).join("/"));
        }
    }
    await visit(root);
    return files.sort();
}

/**
 * Textos que o ContentPack autoriza no tema: cada texto em forma simples,
 * inline e richtext, e — para listas de parágrafos — só o PREFIXO, na
 * ordem, em richtext (o gerador corta a lista pelo número da referência).
 * @returns {Set<string>}
 */
export function allowedPackTexts(pack) {
    const allowed = new Set();
    for (const value of strings(pack.sections)) {
        allowed.add(value);
        allowed.add(toInline(value));
        allowed.add(toRichtext(value));
    }
    for (const list of stringLists(pack.sections)) {
        for (let n = 2; n <= list.length; n++) allowed.add(toRichtext(list.slice(0, n)));
    }
    return allowed;
}

/** Listas de textos (arrays só de strings) dentro do pacote. */
function stringLists(value, out = []) {
    if (Array.isArray(value)) {
        if (value.length && value.every((item) => typeof item === "string")) out.push(value);
        else value.forEach((item) => stringLists(item, out));
    } else if (value && typeof value === "object") {
        Object.values(value).forEach((item) => stringLists(item, out));
    }
    return out;
}

function strings(value, out = []) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
    return out;
}

/** Valores de configuração cujo tipo no schema é image_picker. */
function imagePickerValues(theme, template) {
    const found = [];
    for (const [key, section] of Object.entries(template.sections ?? {})) {
        const schema = theme.section(section.type);
        if (!schema) continue;
        for (const def of schema.settings ?? []) {
            if (def.type === "image_picker" && section.settings?.[def.id]) found.push({ where: `${key}.${def.id}`, value: section.settings[def.id] });
        }
        for (const [blockKey, block] of Object.entries(section.blocks ?? {})) {
            const blockSchema = (schema.blocks ?? []).find((b) => b.type === block.type);
            for (const def of blockSchema?.settings ?? []) {
                if (def.type === "image_picker" && block.settings?.[def.id]) found.push({ where: `${key}.${blockKey}.${def.id}`, value: block.settings[def.id] });
            }
        }
    }
    return found;
}

/**
 * @param {object} params
 * @param {string} params.generationDir
 * @param {string} [params.contentPath] ContentPack EXTERNO para comparação
 *        (e, só em runs antigos sem cópia, como insumo quando o hash bate).
 * @param {string} [params.archiveDir] arquivo de insumos por hash (padrão:
 *   `content-archive/sha256` na mesma raiz de runs da geração).
 */
export async function verifyGeneratedTheme({ generationDir, contentPath, archiveDir = null }) {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok, ...(detail ? { detail } : {}) });

    let generation;
    let content = null;
    let dawnAvailable = false;
    try {
        generation = await loadGeneration(generationDir);
        add("generation:manifest-and-hashes", true, `${generation.manifest.artifacts.length} artefatos conferidos`);
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        add("generation:manifest-and-hashes", false, `${error.code}: ${error.message}`);
        return { ok: false, checks, integrity: { ok: false, complete: false, failed: ["generation:manifest-and-hashes"], notPerformed: [] }, availability: null, reproducibility: { proven: false, reasons: ["geração adulterada ou ilegível"], notes: [] }, comparisons: [] };
    }

    // 1. Arquivos do tema = theme-files.json (lista e hashes).
    let onDisk;
    try {
        onDisk = await walk(generation.themeDir);
    } catch (error) {
        // Symlink ou árvore ilegível: falha EXPLÍCITA e estruturada (nunca aprovada).
        add("theme:files-match-record", false, String(error.message).slice(0, 160));
        return { ok: false, checks, integrity: { ok: false, complete: false, failed: ["theme:files-match-record"], notPerformed: [] }, availability: null, reproducibility: { proven: false, reasons: ["árvore do tema inválida"], notes: [] }, comparisons: [] };
    }
    const recorded = new Map(generation.themeFiles.map((file) => [file.path, file.sha256]));
    const mismatched = [];
    for (const path of onDisk) {
        if (!recorded.has(path)) mismatched.push(`não registrado: ${path}`);
        else if (sha256(await readFile(join(generation.themeDir, path))) !== recorded.get(path)) mismatched.push(`alterado: ${path}`);
    }
    for (const path of recorded.keys()) if (!onDisk.includes(path)) mismatched.push(`ausente: ${path}`);
    add("theme:files-match-record", mismatched.length === 0, mismatched.length ? mismatched.slice(0, 5).join("; ") : `${onDisk.length} arquivos`);

    // 2. Dawn base (lockfile + patch + tree) e diferença restrita a 4 arquivos.
    const base = await extractVerifiedDawn();
    try {
        add("dawn:lock-patch-tree", true, `commit ${base.integrity.commit.slice(0, 12)}, ${base.integrity.hashVerified} hashes conferidos`);
        const baseFiles = await walk(base.dir);
        const changed = [];
        const added = [];
        for (const path of onDisk) {
            if (!baseFiles.includes(path)) {
                added.push(path);
                continue;
            }
            const same = sha256(await readFile(join(base.dir, path))) === recorded.get(path);
            if (!same) changed.push(path);
        }
        // Extensões de tema (1.6.0): declarações do plano conferidas contra o REGISTRO confiável; alvos, origens e
        // hashes vêm só do registro. Planos 1.6.0+ declaram todas as extensões registradas; planos antigos, nenhuma.
        const declaredExtensions = generation.plan.themeExtensions ?? [];
        const extensionProblems = declaredExtensionProblems(declaredExtensions);
        const derived = new Map();
        const extensionAdds = new Map();
        if (!extensionProblems.length) for (const record of declaredExtensions) for (const file of registeredThemeExtension(record.id).files) (file.op === "add" ? extensionAdds : derived).set(file.target, file);
        if (atLeast(generation.plan.generator?.version, "1.6.0")) for (const entry of THEME_EXTENSION_REGISTRY) if (!declaredExtensions.some((record) => record?.id === entry.id)) extensionProblems.push(`${entry.id}: extensão registrada ausente do plano`);
        for (const [path, file] of derived) {
            if (sha256(await readFile(join(base.dir, path))) !== file.baseSha256) extensionProblems.push(`${path}: origem do Dawn difere do registro`);
            if (!changed.includes(path) || recorded.get(path) !== file.sha256) extensionProblems.push(`${path}: derivação ausente ou com hash diferente do registro`);
        }
        for (const [path, file] of extensionAdds) if (!added.includes(path) || recorded.get(path) !== file.sha256) extensionProblems.push(`${path}: arquivo da extensão ausente ou com hash diferente do registro`);
        const unexpected = changed.filter((path) => !WRITABLE_FILES.includes(path) && !derived.has(path));
        // Componentes próprios (M7.8b): os arquivos NOVOS têm de ser exatamente
        // os componentes declarados no plano, cada um no registro fechado,
        // com o hash registrado — antes de qualquer schema do disco ser usado.
        const declared = generation.plan.components ?? [];
        const componentProblems = [];
        for (const component of declared) {
            const entry = COMPONENT_REGISTRY.find((item) => item.id === component.id);
            if (!entry || entry.target !== component.target || entry.sha256 !== component.sha256 || entry.version !== component.version) componentProblems.push(`${component.id}: fora do registro`);
            else if (!added.includes(entry.target)) componentProblems.push(`${component.id}: arquivo ausente`);
            else if (sha256(await readFile(join(generation.themeDir, entry.target))) !== entry.sha256) componentProblems.push(`${component.id}: hash diferente do registro`);
        }
        const undeclared = added.filter((path) => !declared.some((component) => component.target === path) && !extensionAdds.has(path));
        for (const path of undeclared) componentProblems.push(`novo não registrado: ${path}`);
        const missingBase = baseFiles.filter((path) => !onDisk.includes(path));
        add(
            "theme:only-allowed-files-differ",
            unexpected.length === 0 && componentProblems.length === 0 && extensionProblems.length === 0 && missingBase.length === 0 && baseFiles.length + declared.length + extensionAdds.size === onDisk.length,
            unexpected.length || componentProblems.length || extensionProblems.length || missingBase.length
                ? [...unexpected, ...componentProblems, ...extensionProblems, ...missingBase.map((path) => `ausente do Dawn: ${path}`)].slice(0, 6).join("; ")
                : `alterados: ${changed.join(", ")}${declared.length ? ` · componentes próprios: ${declared.map((c) => `${c.id}@${c.version}`).join(", ")}` : ""}${declaredExtensions.length ? ` · extensões de tema: ${declaredExtensions.map((e) => `${e.id}@${e.version}`).join(", ")}` : ""}`
        );

        // 3. Revalidação dos arquivos em disco contra os schemas CONFIÁVEIS:
        // Dawn verificado + componentes do registro lidos da fonte com hash
        // conferido (nunca o schema de um arquivo do disco da geração).
        let registered = [];
        try {
            registered = await loadRegisteredComponents();
        } catch (error) {
            add("components:registry-sources", false, String(error.message).slice(0, 160));
        }
        const theme = (await ThemeSchema.load(base.dir)).withComponents(registered.filter((component) => declared.some((item) => item.id === component.id)));
        const files = {};
        for (const path of WRITABLE_FILES) files[path] = JSON.parse(await readFile(join(generation.themeDir, path), "utf8"));
        const errors = validatePlan({ ...generation.plan, files }, theme);
        add("theme:schemas", errors.length === 0, errors.length ? errors.slice(0, 5).join("; ") : "settings, templates e grupos válidos");

        // 4. Imagens: cada image_picker preenchido precisa vir de um slot do
        // ContentPack AUTORIZADO com upload VERIFICADO (mesma referência), e
        // estar declarado no plano. Nenhuma outra referência shop_images.
        const pickers = [
            ...imagePickerValues(theme, files["templates/index.json"]),
            ...imagePickerValues(theme, files["sections/header-group.json"]),
            ...imagePickerValues(theme, files["sections/footer-group.json"]),
        ];
        const preset = files["config/settings_data.json"].presets[files["config/settings_data.json"].current];
        for (const [id, def] of theme.settings) if (def.type === "image_picker" && preset[id]) pickers.push({ where: `settings.${id}`, value: preset[id] });
        // ContentPack da geração: a CÓPIA do run (runs novos) ou, em runs
        // antigos, o arquivo por hash ou um pacote externo com o MESMO hash.
        content = await resolveGenerationContent(generation, { contentPath, archiveDir: archiveDir ?? join(generation.dir, "..", "..", "..", "content-archive", "sha256") });
        // Arquivo compartilhado com o hash da geração, mas bytes divergentes:
        // evidência adulterada (falha), mesmo que a cópia do run esteja íntegra.
        if (content.inArchive?.startsWith("inválido")) add("content:shared-archive", false, `arquivo por hash ${content.inArchive}`);
        if (content.contractError) add("content:contract", false, content.contractError);
        if (content.copyMismatch) add("content:run-copy", false, content.copyMismatch);
        else if (content.source === "run-copy") add("content:run-copy", true, `cópia do run confere com o plano (sha256 ${content.sha.slice(0, 12)}…)`);
        const verifiedPack = content.pack;
        // Só referências verificadas na loja de destino registrada no plano.
        const targetStore = generation.plan.provenance.targetStore ?? null;
        const authorizedRefs = new Set(Object.values(verifiedPack?.images ?? {}).map((slot) => slotImageReference(slot, { store: targetStore })).filter(Boolean));
        const planned = new Set(generation.plan.imageReferences ?? []);
        const imageProblems = pickers
            .filter((item) => !authorizedRefs.has(item.value) || !planned.has(item.value))
            .map((item) => `${item.where}: ${authorizedRefs.has(item.value) ? "não declarada no plano" : "sem slot autorizado com upload verificado"}`);
        const pickerValues = new Set(pickers.map((item) => item.value));
        for (const path of WRITABLE_FILES) {
            for (const value of strings(files[path])) {
                if (value.includes("shopify://shop_images") && !pickerValues.has(value)) imageProblems.push(`${path}: referência de imagem fora de image_picker`);
            }
        }
        add("theme:image-references", imageProblems.length === 0, imageProblems.slice(0, 5).join("; ") || (pickers.length ? `${pickers.length} referência(s) autorizada(s) e verificada(s)` : "nenhuma referência de imagem gravada"));

        // 4b. Arquivos locais declarados no ContentPack (origem e derivados).
        if (verifiedPack) {
            const assets = await verifyPackAssets(verifiedPack);
            add("content:assets-integrity", assets.problems.length === 0, assets.problems.slice(0, 5).join("; ") || (assets.checked ? `${assets.checked} arquivo(s) conferido(s)` : "nenhum arquivo local declarado"));
        }

        // 5. Sem URLs externas nos arquivos gerados.
        const external = WRITABLE_FILES.filter((path) => /https?:\/\//i.test(JSON.stringify(files[path])));
        add("theme:no-external-urls", external.length === 0, external.join("; ") || "nenhuma URL externa");

        // 6. Credenciais em todo o tema.
        const secrets = [];
        for (const path of onDisk) {
            const text = (await readFile(join(generation.themeDir, path))).toString("latin1");
            for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) secrets.push(`${label} em ${path}`);
        }
        add("theme:no-credentials", secrets.length === 0, secrets.join("; ") || `${onDisk.length} arquivos varridos`);

        // 7. Origem de cada texto gravado.
        const allowed = new Set();
        for (const path of WRITABLE_FILES) {
            try {
                strings(JSON.parse(await readFile(join(base.dir, path), "utf8"))).forEach((value) => allowed.add(value));
            } catch {
                /* arquivo com comentário de cabeçalho no Dawn */
                const raw = await readFile(join(base.dir, path), "utf8");
                strings(JSON.parse(raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""))).forEach((value) => allowed.add(value));
            }
        }
        allowed.add(generation.plan.generator.preset);
        let contentNote = "geração sem ContentPack";
        const pack = content.pack;
        if (pack) {
            for (const value of allowedPackTexts(pack)) allowed.add(value);
            // Referências de imagem: só as de slots autorizados com upload verificado.
            for (const slot of Object.values(pack.images ?? {})) {
                const reference = slotImageReference(slot, { store: generation.plan.provenance.targetStore ?? null });
                if (reference) allowed.add(reference);
            }
            contentNote = `${pack.id} (${pack.authorization.basis}: ${pack.authorization.owner}) · fonte: ${content.source}`;
        }
        const unexplained = [];
        for (const path of WRITABLE_FILES) {
            for (const value of strings(files[path])) {
                // Gradientes vêm de cores medidas (não de texto) e só no formato estrito.
                if (allowed.has(value) || VOCABULARY.test(value) || isLinearGradient(value)) continue;
                unexplained.push(`${path}: "${value.slice(0, 40)}"`);
            }
        }
        if (pack || !content.expectedSha) add("content:authorized-origin", unexplained.length === 0, unexplained.length ? unexplained.slice(0, 5).join("; ") : contentNote);
        dawnAvailable = true;
    } finally {
        await base.cleanup();
    }

    // --- Três resultados SEPARADOS ---------------------------------------------
    // Integridade = o que FOI conferido bate com os manifestos. Sem o
    // ContentPack, as conferências de conteúdo não são feitas: integridade
    // incompleta (não "adulterada") — e o tema não é dado como apto.
    const notPerformed = content?.expectedSha && !content.pack ? ["content:authorized-origin", "content:assets-integrity"] : [];
    const integrity = { ok: checks.every((check) => check.ok), complete: notPerformed.length === 0, failed: checks.filter((check) => !check.ok).map((check) => check.id), notPerformed };
    const analysisAvailable = await analysisRunAvailable(generation);
    const availability = {
        content: content.expectedSha ? content.source : "não usado",
        sharedArchive: content.expectedSha ? content.inArchive : null,
        recovery: content.recovery,
        analysis: analysisAvailable ? "disponível" : "indisponível",
        dawn: dawnAvailable ? "disponível" : "indisponível",
    };
    const code = await verifyCodeRecoverable(generation.codeIdentity);
    const reasons = [...code.reasons];
    if (content.expectedSha && !content.pack) reasons.push("ContentPack indisponível");
    if (content.recovery) reasons.push("ContentPack recuperado depois da geração (registro de recuperação); não restaura o código usado");
    if (!analysisAvailable) reasons.push("análise de origem indisponível");
    const reproducibility = { proven: reasons.length === 0, reasons, notes: code.notes };
    const comparisons = content.external ? [content.external] : [];

    return {
        ok: integrity.ok && integrity.complete,
        checks,
        integrity,
        availability,
        reproducibility,
        comparisons,
        generation: { dir: generation.dir, runId: generation.manifest.runId, themeDir: generation.themeDir },
    };
}

/**
 * Resolve o ContentPack de uma geração SEM depender do pacote editável:
 *  1. cópia imutável do run (conferida pelo hash do plano);
 *  2. runs antigos: arquivo por hash (com eventual registro de recuperação);
 *  3. runs antigos: pacote externo informado, só se tiver o MESMO hash.
 * Um pacote externo com hash diferente vira só COMPARAÇÃO (não adulteração).
 */
async function resolveGenerationContent(generation, { contentPath, archiveDir }) {
    const expectedSha = generation.plan.provenance.contentSha256 ?? null;
    const result = { expectedSha, sha: null, pack: null, source: "indisponível", inArchive: null, recovery: null, external: null, copyMismatch: null, contractError: null };
    // Pacote fora do contrato ATUAL (ex.: regra endurecida depois da geração):
    // falha registrada, nunca exceção nem pacote aceito.
    const parse = (buffer) => {
        let parsed;
        try {
            parsed = parseContentPack(JSON.parse(buffer.toString("utf8")));
        } catch (error) {
            parsed = { success: false, issues: [String(error.message).slice(0, 120)] };
        }
        if (!parsed.success) {
            result.contractError = `ContentPack fora do contrato atual: ${(parsed.issues ?? []).slice(0, 2).join("; ")}`;
            return null;
        }
        return parsed.pack;
    };
    if (generation.contentPackBuffer) {
        const sha = sha256(generation.contentPackBuffer);
        if (sha !== expectedSha) {
            result.copyMismatch = `cópia do run (sha256 ${sha.slice(0, 12)}…) difere do hash do plano (${String(expectedSha).slice(0, 12)}…)`;
        } else {
            const pack = parse(generation.contentPackBuffer);
            if (pack) Object.assign(result, { sha, pack, source: "run-copy" });
        }
    }
    if (expectedSha) {
        let archived = null;
        try {
            archived = await readArchived(expectedSha, { root: archiveDir });
        } catch (error) {
            if (!(error instanceof ReferenceEngineError)) throw error;
            result.inArchive = `inválido (${error.code})`;
        }
        if (archived) {
            result.inArchive = "presente";
            if (!result.pack && !result.copyMismatch && !result.contractError) {
                const pack = parse(archived);
                if (pack) Object.assign(result, { sha: expectedSha, pack, source: "arquivo por hash" });
            }
        } else if (result.inArchive === null) {
            result.inArchive = "ausente";
        }
        try {
            const dir = join(archiveDir, "..", "recoveries");
            result.recovery = JSON.parse((await readRegularFile(dir, `${generation.manifest.runId}.json`, 256 * 1024)).toString("utf8"));
            if (result.source === "arquivo por hash") result.source = "arquivo por hash (recuperado)";
        } catch {
            /* sem registro de recuperação */
        }
    }
    if (contentPath) {
        let external = null;
        try {
            external = await loadContentPackWithHash(contentPath);
        } catch (error) {
            // Só "fora do contrato" vira resultado; arquivo inexistente ou
            // ilegível continua sendo erro de entrada (exceção).
            if (!(error instanceof ReferenceEngineError) || error.code !== ErrorCodes.CONTENT_INVALID) throw error;
            result.external = { id: "comparison:external-content", error: `${error.code}: ${error.message}` };
        }
        if (external) {
            result.external = { id: "comparison:external-content", sha256: external.sha256, matchesGeneration: external.sha256 === expectedSha };
            if (!result.pack && !result.copyMismatch && !result.contractError && external.sha256 === expectedSha) Object.assign(result, { sha: expectedSha, pack: external.pack, source: "pacote externo com o mesmo hash" });
        }
    }
    return result;
}

/** A análise de origem (run imutável) ainda está disponível e íntegra? */
async function analysisRunAvailable(generation) {
    const { analysisRunId, analysisManifestSha256 } = generation.plan.provenance;
    if (!analysisRunId) return false;
    const host = basename(dirname(generation.dir));
    const dir = join(generation.dir, "..", "..", "..", "analyses", host, analysisRunId);
    try {
        const buffer = await readRegularFile(dir, "manifest.json", 2 * 1024 * 1024);
        return sha256(buffer) === analysisManifestSha256;
    } catch {
        return false;
    }
}
