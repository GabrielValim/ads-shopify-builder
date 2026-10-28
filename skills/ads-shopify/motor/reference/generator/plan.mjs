/**
 * Plano de geração: StoreBlueprint v2 (+ ContentPack) -> configurações do
 * Dawn 16, com proveniência de cada valor.
 *
 * Regras:
 *  - Só configurações que existem no schema real do tema (validação em
 *    validatePlan); valores ajustados ao intervalo/passo com registro.
 *  - Sem evidência no blueprint: o padrão do Dawn é mantido e a lacuna
 *    entra em `fidelity`.
 *  - Seções `unknown` não são convertidas (status `unsupported`), mas
 *    mantêm a posição no plano.
 *  - image_picker só com referência RESOLVIDA (slot autorizado e upload
 *    verificado na Shopify); nos demais casos a imagem vira dependência
 *    explícita com o estado em que parou.
 *
 * Fórmulas do Dawn 16 usadas (layout/theme.liquid e assets/base.css):
 *  - 1rem = 10px × body_scale/100 (html { font-size: body_scale × 62.5% })
 *  - título(px) = heading_scale/100 × N × 10, N por nível (abaixo)
 *  - corpo: 1.5rem (mobile) / 1.6rem (≥750px)
 *  - largura da página = page_width/10 rem
 *  - altura do image-banner (min-height, rem): ver BANNER_REM
 *  - padding das seções no mobile = padding × 0.75
 */

import { contentFor, PLACEHOLDERS, slotImageReference, toInline, toRichtext, toText } from "./content-pack.mjs";
import { COMPONENT_REGISTRY, componentRecord } from "./components.mjs";
import { declaredExtensionProblems } from "./theme-extensions.mjs";
import { validateGlobalSettings, validateSettingsData, validateTemplate } from "./dawn-schema.mjs";
import { FONT_CATALOG, catalogEntry, isVerifiedFont, matchFont } from "./font-catalog.mjs";

export const GENERATOR_VERSION = "1.8.0";
export const PRESET_NAME = "ADS Reference";

// [mobile, desktop] em rem (assets/base.css). hxxl usa clamp com vw: excluído.
export const HEADING_REM = { h2: [2, 2.4], h1: [3, 4], h0: [4, 5.2], hxl: [5, 6.2] };
// image-banner: [mobile (min-height do conteúdo), desktop] em rem.
export const BANNER_REM = { small: [28, 42], medium: [34, 56], large: [39, 72] };
// image-with-text: altura da mídia [mobile, desktop] em rem
// (assets/component-image-with-text.css). "adapt" sem imagem = placeholder 20/30rem;
// com imagem, segue a proporção do arquivo.
export const MEDIA_REM = { small: [19.4, 31.4], medium: [29.6, 46], large: [43.5, 69.5] };
export const ADAPT_PLACEHOLDER_REM = [20, 30];
// Tolerância média de altura acima da qual uma opção fixa recortaria demais
// a mídia: usa "adapt" (proporção do arquivo autorizado).
export const MEDIA_HEIGHT_TOLERANCE = 0.15;

const rel = (actual, target) => (target ? Math.abs(actual - target) / target : 0);
const round1 = (value) => Math.round(value * 10) / 10;
const upper = (hex) => (hex ? hex.toUpperCase() : hex);

function snap(definition, value) {
    const step = definition.step ?? 1;
    const clamped = Math.min(definition.max, Math.max(definition.min, value));
    return Math.round((Math.round((clamped - definition.min) / step) * step + definition.min) * 1000) / 1000;
}

/** Escalas globais que melhor reproduzem as medidas do blueprint. */
export function solveScales(blueprint, theme, headingTargets) {
    const body = blueprint.tokens.typography.body;
    const bodyD = body?.sizePx.desktop ?? null;
    const bodyM = body?.sizePx.mobile ?? null;
    const container = blueprint.tokens.layout.desktop?.containerWidthPx ?? null;
    const bsDef = theme.settings.get("body_scale");
    const pwDef = theme.settings.get("page_width");
    const hsDef = theme.settings.get("heading_scale");

    let best = null;
    for (let bs = bsDef.min; bs <= bsDef.max; bs += bsDef.step) {
        let pageWidth = pwDef.default;
        let widthError = 0;
        if (container) {
            pageWidth = null;
            for (let pw = pwDef.min; pw <= pwDef.max; pw += pwDef.step) {
                const error = rel((pw * bs) / 100, container);
                if (pageWidth === null || error < widthError - 1e-9) {
                    pageWidth = pw;
                    widthError = error;
                }
            }
        }
        const cost = rel((16 * bs) / 100, bodyD) + rel((15 * bs) / 100, bodyM) + widthError;
        if (!best || cost < best.cost - 1e-9) best = { bs, pageWidth, cost };
    }

    let heading = null;
    for (let hs = hsDef.min; hs <= hsDef.max; hs += hsDef.step) {
        let cost = 0;
        const choices = {};
        for (const target of headingTargets) {
            let pick = null;
            for (const [size, [m, d]] of Object.entries(HEADING_REM)) {
                if (!target.allowed.includes(size)) continue;
                const px = { desktop: (hs / 100) * d * 10, mobile: (hs / 100) * m * 10 };
                const error = rel(px.desktop, target.desktop) + rel(px.mobile, target.mobile);
                if (!pick || error < pick.error - 1e-9) pick = { size, error, px };
            }
            choices[target.key] = pick;
            cost += pick?.error ?? 0;
        }
        if (!heading || cost < heading.cost - 1e-9) heading = { hs, cost, choices };
    }

    return {
        bodyScale: best.bs,
        pageWidth: best.pageWidth,
        rem: (10 * best.bs) / 100,
        achieved: {
            bodyPx: { desktop: round1((16 * best.bs) / 100), mobile: round1((15 * best.bs) / 100) },
            containerPx: Math.round((best.pageWidth * best.bs) / 100),
        },
        targets: { bodyPx: { desktop: bodyD, mobile: bodyM }, containerPx: container },
        headingScale: heading.hs,
        headings: heading.choices,
    };
}

function chooseBannerHeight(heights, rem) {
    let pick = null;
    for (const [option, [m, d]] of Object.entries(BANNER_REM)) {
        const px = { desktop: Math.round(d * rem), mobile: Math.round(m * rem) };
        const error = rel(px.desktop, heights.desktop) + rel(px.mobile, heights.mobile);
        if (!pick || error < pick.error - 1e-9) pick = { option, px, error };
    }
    return pick;
}

/** Registro de uma seção gerada, com proveniência por configuração. */
class SectionRecord {
    constructor(theme, section, target) {
        this.theme = theme;
        this.type = target.type;
        this.record = {
            blueprintSectionId: section.id,
            blueprintType: section.type,
            confidence: section.confidence,
            status: "generated",
            target,
            applied: [],
            adaptations: [],
            ignored: [],
            dependencies: [],
            fidelity: [],
            content: null,
        };
        this.settings = {};
        this.blocks = {};
        this.blockOrder = [];
    }

    definition(id, blockType) {
        const schema = this.theme.section(this.type);
        const list = blockType ? schema.blocks.find((b) => b.type === blockType)?.settings : schema.settings;
        return list?.find((item) => item.id === id) ?? null;
    }

    /** Define uma configuração da seção, ajustando ranges e registrando a origem. */
    set(id, value, from, note) {
        const definition = this.definition(id);
        let final = value;
        if (definition?.type === "range" && typeof value === "number") {
            final = snap(definition, value);
            if (final !== value) this.record.adaptations.push(`${id}: ${value} ajustado para ${final} (intervalo/passo do Dawn)`);
        }
        this.settings[id] = final;
        this.record.applied.push({ setting: id, value: final, from, ...(note ? { note } : {}) });
    }

    block(key, type, settings, from) {
        this.blocks[key] = { type, settings };
        this.blockOrder.push(key);
        this.record.applied.push({ setting: `block:${key}`, value: type, from });
    }

    build() {
        const section = { type: this.type, settings: this.settings };
        if (this.blockOrder.length) {
            section.blocks = this.blocks;
            section.block_order = this.blockOrder;
        }
        return { section, record: this.record };
    }
}

const scheme = (map, section) => map.get(section.colorScheme) ?? "scheme-1";

function paddings(rec, section, path) {
    const d = section.viewports.desktop ?? section.viewports.mobile;
    if (d.paddingTopPx !== null) rec.set("padding_top", d.paddingTopPx, `${path}.paddingTopPx`);
    if (d.paddingBottomPx !== null) rec.set("padding_bottom", d.paddingBottomPx, `${path}.paddingBottomPx`);
    const m = section.viewports.mobile;
    if (m && d.paddingTopPx !== null && Math.abs(m.paddingTopPx - d.paddingTopPx * 0.75) > 4) {
        rec.record.fidelity.push({
            aspect: "padding-mobile",
            expected: m.paddingTopPx,
            achieved: Math.round(rec.settings.padding_top * 0.75),
            note: "Dawn aplica 75% do padding no mobile",
        });
    }
}

const bpPath = (section) => `sections.${section.id}`;

function mapAnnouncement(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "sections/header-group.json", key: "announcement-bar", type: "announcement-bar" });
    const content = contentFor(ctx.pack, "announcement-bar", occurrence, PLACEHOLDERS["announcement-bar"]);
    rec.record.content = content.source;
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    rec.set("auto_rotate", false, `${bpPath(section)}.content`, "um único anúncio");
    rec.block("announcement-1", "announcement", { text: toInline(content.value.text), link: content.value.link ?? "" }, `content:announcement-bar[${occurrence}]`);
    const align = section.details.announcement?.textAlign;
    if (align && align !== "center") {
        rec.record.fidelity.push({ aspect: "text-align", expected: align, achieved: "center", note: "Dawn centraliza o anúncio; sem configuração de alinhamento" });
    }
    rec.record.ignored.push({ field: "show_line_separator", reason: "sem evidência no blueprint; padrão do Dawn mantido" });
    return rec.build();
}

function mapHeader(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "sections/header-group.json", key: "header", type: "header" });
    const details = section.details.header;
    const content = contentFor(ctx.pack, "header", occurrence, PLACEHOLDERS.header);
    rec.record.content = content.source;
    const path = `${bpPath(section)}.details.header`;

    const position = details.logo.position;
    const logoPosition = position === "center" ? "middle-center" : "middle-left";
    rec.set("logo_position", logoPosition, `${path}.logo.position`, details.navigation.desktop === "inline" ? "logo e menu na mesma linha" : undefined);
    if (position === "right") rec.record.adaptations.push("logo à direita não existe no Dawn; usado middle-left");

    rec.set("menu", content.value.menu, `content:header[${occurrence}].menu`);
    rec.record.dependencies.push({ kind: "menu", detail: `menu "${content.value.menu}" precisa existir na loja` });

    const navigation = details.navigation.desktop;
    rec.set("menu_type_desktop", navigation === "drawer" ? "drawer" : "dropdown", `${path}.navigation.desktop`);
    if (navigation === "none") rec.record.adaptations.push("referência sem menu visível; Dawn exibe o menu escolhido");
    if (details.navigation.mobile === "inline") {
        rec.record.fidelity.push({ aspect: "navigation-mobile", expected: "inline", achieved: "drawer", note: "Dawn sempre usa drawer no mobile" });
    }

    rec.set("sticky_header_type", details.sticky ? "always" : "none", `${path}.sticky`);
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    rec.set("menu_color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    rec.set("enable_country_selector", false, `${bpPath(section)}.content.inputs`, "nenhum seletor observado");
    rec.set("enable_language_selector", false, `${bpPath(section)}.content.inputs`, "nenhum seletor observado");

    rec.record.ignored.push({ field: "mobile_logo_position", reason: "blueprint não registra posição do logo no mobile; padrão do Dawn (center) mantido" });
    rec.record.ignored.push({ field: "show_line_separator", reason: "sem evidência de borda no blueprint" });
    rec.record.ignored.push({ field: "padding_top/padding_bottom", reason: `altura observada ${section.viewports.desktop?.box.height ?? "?"}px depende do logo; não convertida` });
    rec.record.fidelity.push({ aspect: "icons", expected: `${details.iconCount} ícone(s)`, achieved: "busca, conta e carrinho do Dawn", note: "ícones do header não são configuráveis individualmente" });
    if (details.logo.kind) {
        rec.record.dependencies.push({ kind: "logo", detail: details.logo.kind === "image" ? "logo em imagem exige upload (settings.logo)" : "logo em texto usa o nome da loja configurado na Shopify" });
    }
    return rec.build();
}

/**
 * Estado da imagem de um slot do ContentPack, do arquivo local à referência
 * utilizável no tema. Só "ready" permite gravar image_picker.
 * A referência só vale na loja de destino da geração (`store`).
 * @returns {{ state: "no-slot" | "unknown-slot" | "no-file" | "not-authorized" | "not-uploaded" | "no-target-store" | "unbound-store" | "other-store" | "ready", reference: string | null, name: string | null }}
 */
export function imageState(pack, name, store = null) {
    if (!name) return { state: "no-slot", reference: null, name: null };
    const slot = pack?.images?.[name];
    if (!slot) return { state: "unknown-slot", reference: null, name };
    if (!slot.source) return { state: "no-file", reference: null, name };
    if (slot.authorization?.status !== "authorized") return { state: "not-authorized", reference: null, name };
    if (slot.shopify?.status !== "uploaded-verified") return { state: "not-uploaded", reference: null, name };
    if (!store) return { state: "no-target-store", reference: null, name };
    if (!slot.shopify.store) return { state: "unbound-store", reference: null, name };
    if (slot.shopify.store !== store) return { state: "other-store", reference: null, name };
    const reference = slotImageReference(slot, { store });
    return reference ? { state: "ready", reference, name } : { state: "not-uploaded", reference: null, name };
}

const IMAGE_STATE_TEXT = {
    "no-slot": "nenhum slot de imagem no ContentPack",
    "unknown-slot": "slot inexistente no ContentPack",
    "no-file": "slot sem arquivo de origem registrado",
    "not-authorized": "arquivo registrado, autorização pendente",
    "not-uploaded": "arquivo autorizado, upload na Shopify não verificado",
    "no-target-store": "upload verificado, mas a geração não informou a loja de destino (--store)",
    "unbound-store": "upload verificado sem loja registrada (pacote anterior ao vínculo por loja); a referência não é usada",
    "other-store": "upload verificado em OUTRA loja; a referência não vale na loja de destino",
};

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Gradiente no formato do seletor de gradiente da Shopify (color_background). */
export function cssLinearGradient(angleDeg, stops) {
    const parts = stops.map((stop) => `rgba(${rgbOf(stop.hex).join(", ")}, 1) ${Math.round(stop.position * 100)}%`);
    return `linear-gradient(${angleDeg}deg, ${parts.join(", ")})`;
}

/**
 * Como converter um hero. "image-banner" (comportamento do M6.1) sempre que
 * houver imagem autorizada pronta ou faltar evidência; "color" (rich-text de
 * largura total sobre esquema de cor) só com pintura MEDIDA sólida/gradiente
 * ou cor de fundo CSS, e com a geometria do conteúdo para estimar a altura.
 * @returns {{ strategy: "image-banner" | "color", reason: string, paint?: object }}
 */
export function heroStrategy(section, pack, occurrence, blueprint, store = null) {
    const details = section.details.hero;
    const content = contentFor(pack, "hero", occurrence, PLACEHOLDERS.hero);
    if (imageState(pack, content.value.image, store).state === "ready") return { strategy: "image-banner", reason: "authorized-image-ready" };
    const paint = details.backgroundPaint ?? null;
    if (paint && (paint.kind === "gradient" || paint.kind === "solid")) return { strategy: "color", reason: `measured-${paint.kind}`, paint };
    const own = blueprint.tokens.colorSchemes.find((item) => item.id === section.colorScheme);
    if (details.background === "color" && own?.background) {
        return { strategy: "color", reason: "css-background-color", paint: { kind: "solid", angleDeg: null, stops: [{ hex: own.background, position: 0 }], fit: null } };
    }
    // 1.7.0: SEM imagem autorizada o hero nunca vira image-banner (o Dawn desenharia uma ilustração genérica no lugar).
    // Usa a cor medida da região (esquema da seção; senão o fundo da página) e registra a mídia ausente.
    const fallback = own?.background ?? blueprint.tokens.colors.roles.background ?? null;
    if (fallback) return { strategy: "color", reason: "sem-imagem-autorizada", paint: { kind: "solid", angleDeg: null, stops: [{ hex: fallback, position: 0 }], fit: null } };
    return { strategy: "image-banner", reason: "sem-cor-medida" };
}

/** Padding simétrico (Dawn: 75% no mobile) que aproxima as alturas medidas. */
function solveHeroPadding(heights, content, definition) {
    let best = null;
    for (let p = definition.min; p <= definition.max; p += definition.step ?? 1) {
        const desktop = 2 * p + content.desktop;
        const mobile = content.mobile ? 1.5 * p + content.mobile : null;
        const error = rel(desktop, heights.desktop) + (mobile && heights.mobile ? rel(mobile, heights.mobile) : 0);
        if (!best || error < best.error - 1e-9) best = { padding: p, desktop, mobile, error };
    }
    return best;
}

function mapColorHero(ctx, section, occurrence, decision) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "rich-text" });
    const details = section.details.hero;
    const path = `${bpPath(section)}.details.hero`;
    const content = contentFor(ctx.pack, "hero", occurrence, PLACEHOLDERS.hero);
    rec.record.content = content.source;
    rec.record.heroStrategy = { strategy: "color", reason: decision.reason };

    const paint = decision.paint;
    rec.set("color_scheme", decision.schemeId, paint.fit ? `${path}.backgroundPaint` : `${bpPath(section)}.colorScheme`, paint.kind === "gradient" ? `gradiente ${paint.angleDeg}° medido no screenshot` : "cor sólida");
    rec.set("full_width", true, `${bpPath(section)}.viewports.desktop.box`, "fundo de largura total, como na referência");
    rec.set("desktop_content_position", details.contentPosition.desktop ?? "center", `${path}.contentPosition.desktop`);
    rec.set("content_alignment", details.contentAlignment.desktop ?? "left", `${path}.contentAlignment.desktop`);
    if (details.contentAlignment.mobile && details.contentAlignment.mobile !== (details.contentAlignment.desktop ?? "left")) {
        rec.record.fidelity.push({ aspect: "mobile-alignment", expected: details.contentAlignment.mobile, achieved: details.contentAlignment.desktop, note: "rich-text tem um único alinhamento" });
    }

    const paddingDef = ctx.theme.section("rich-text").settings.find((item) => item.id === "padding_top");
    // sem geometria do conteúdo: estimativa conservadora (40% da altura é conteúdo), registrada como tal
    const contentPx = details.contentHeightPx?.desktop ? details.contentHeightPx : { desktop: Math.round((details.heightPx.desktop ?? 600) * 0.4), mobile: details.heightPx.mobile ? Math.round(details.heightPx.mobile * 0.4) : null };
    if (!details.contentHeightPx?.desktop) rec.record.fidelity.push({ aspect: "content-geometry", expected: "altura do conteúdo medida", achieved: "estimada (40% da altura da região)", note: "geometria do conteúdo não observada" });
    const solved = solveHeroPadding(details.heightPx, contentPx, paddingDef);
    rec.set("padding_top", solved.padding, `${path}.heightPx + contentHeightPx`, "altura estimada com o conteúdo da referência");
    rec.set("padding_bottom", solved.padding, `${path}.heightPx + contentHeightPx`, "padding simétrico: conteúdo centralizado na vertical");
    rec.record.fidelity.push({
        aspect: "height",
        expected: `${details.heightPx.desktop}/${details.heightPx.mobile}px`,
        achieved: `≈ ${Math.round(solved.desktop)}/${solved.mobile ? Math.round(solved.mobile) : "?"}px (estimativa; padding máximo do Dawn ${ctx.theme.section("rich-text").settings.find((item) => item.id === "padding_top").max}px)`,
        note: "altura do rich-text = conteúdo + padding; não há altura mínima configurável",
    });
    if (details.verticalPosition.desktop && details.verticalPosition.desktop !== "middle") {
        rec.record.fidelity.push({ aspect: "vertical-position", expected: details.verticalPosition.desktop, achieved: "middle", note: "padding simétrico" });
    }
    if (paint.kind === "gradient" && paint.fit && paint.fit.withinTolerance < 1) {
        rec.record.fidelity.push({
            aspect: "background-detail",
            expected: "pintura completa da referência",
            achieved: `gradiente linear (${Math.round(paint.fit.withinTolerance * 100)}% das células dentro da tolerância)`,
            note: "formas que não seguem o gradiente não são reproduzidas",
        });
    }

    if (details.hasEyebrow && content.value.eyebrow) {
        rec.block("caption", "caption", { caption: toInline(content.value.eyebrow), text_style: "caption-with-letter-spacing", text_size: "medium" }, `content:hero[${occurrence}].eyebrow`);
    }
    const choice = ctx.scales.headings[section.id];
    rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h1" }, `content:hero[${occurrence}].heading`);
    if (content.value.text) rec.block("text", "text", { text: toRichtext(content.value.text) }, `content:hero[${occurrence}].text`);
    const styles = section.content.buttons.map((button) => button.style);
    const buttons = (content.value.buttons ?? []).slice(0, Math.min(styles.length, 2));
    if (buttons.length) {
        const settings = { button_label: toInline(buttons[0].label), button_link: buttons[0].link, button_style_secondary: styles[0] !== "solid" };
        if (buttons[1]) Object.assign(settings, { button_label_2: toInline(buttons[1].label), button_link_2: buttons[1].link, button_style_secondary_2: styles[1] !== "solid" });
        rec.block("button", "button", settings, `content:hero[${occurrence}].buttons + ${bpPath(section)}.content.buttons`);
    }
    const heroImage = imageState(ctx.pack, content.value.image, ctx.targetStore);
    if (details.background === "image" || content.value.image) {
        rec.record.dependencies.push({
            kind: "image",
            detail: `imagem de fundo autorizada${content.value.image ? ` (slot "${content.value.image}")` : ""} pendente${heroImage.name ? ` (${IMAGE_STATE_TEXT[heroImage.state]})` : ""}: o hero usa a cor medida até o upload, sem ilustração genérica; com a imagem pronta, a geração volta a usar image-banner`,
        });
    }
    // 1.7.0: mídia de conteúdo DENTRO do hero (ilustrações, mockups, cartões com imagem) também é registrada
    const media = (section.viewports.desktop?.images ?? []).filter((image) => image.role !== "background");
    if (media.length) {
        rec.record.dependencies.push({
            kind: "image",
            detail: `${media.length} imagem(ns)/composição(ões) visual(is) dentro do hero (proporções ${media.map((image) => image.aspectRatio ?? "?").join(", ")}) sem imagem autorizada: não reproduzida(s)`,
        });
    }
    return rec.build();
}

function mapHero(ctx, section, occurrence) {
    const decision = ctx.heroStrategies.get(section.id);
    if (decision?.strategy === "color") return mapColorHero(ctx, section, occurrence, decision);
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "image-banner" });
    if (decision) rec.record.heroStrategy = { strategy: "image-banner", reason: decision.reason };
    const details = section.details.hero;
    const path = `${bpPath(section)}.details.hero`;
    const content = contentFor(ctx.pack, "hero", occurrence, PLACEHOLDERS.hero);
    rec.record.content = content.source;

    const height = chooseBannerHeight(details.heightPx, ctx.scales.rem);
    rec.set("image_height", height.option, `${path}.heightPx`, `≈ ${height.px.desktop}px desktop / ${height.px.mobile}px mobile`);
    rec.record.fidelity.push({
        aspect: "height",
        expected: `${details.heightPx.desktop}/${details.heightPx.mobile}px`,
        achieved: `${height.px.desktop}/${height.px.mobile}px (mínimo, sem imagem)`,
        note: "altura do Dawn por opção fixa (small/medium/large)",
    });

    const vertical = details.verticalPosition.desktop ?? "middle";
    const horizontal = details.contentPosition.desktop ?? "center";
    rec.set("desktop_content_position", `${vertical}-${horizontal}`, `${path}.verticalPosition + contentPosition`);
    if (details.contentAlignment.desktop) rec.set("desktop_content_alignment", details.contentAlignment.desktop, `${path}.contentAlignment.desktop`);
    if (details.contentAlignment.mobile) rec.set("mobile_content_alignment", details.contentAlignment.mobile, `${path}.contentAlignment.mobile`);
    rec.set("show_text_box", false, `${path}.background`, "texto diretamente sobre a mídia");
    rec.set("show_text_below", false, `${path}.verticalPosition.mobile`, "texto sobre a imagem também no mobile");
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);

    rec.record.ignored.push({ field: "image_overlay_opacity", reason: "opacidade de overlay não é observável no DOM; padrão do Dawn (0) mantido" });
    if (details.background === "image") {
        const image = section.viewports.desktop?.images.find((item) => item.role === "background");
        const resolved = imageState(ctx.pack, content.value.image, ctx.targetStore);
        if (resolved.state === "ready") {
            rec.set("image", resolved.reference, `content:images.${resolved.name}.shopify.reference`, `imagem autorizada com upload verificado em ${ctx.targetStore}`);
            ctx.imageReferences.add(resolved.reference);
        } else {
            rec.record.dependencies.push({
                kind: "image",
                detail: `imagem de fundo (proporção ${image?.aspectRatio ?? "?"}:1)${resolved.name ? `, slot "${resolved.name}"` : ""}: ${IMAGE_STATE_TEXT[resolved.state]}; o tema exibe o placeholder do Dawn`,
            });
        }
    }

    const choice = ctx.scales.headings[section.id];
    rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h1" }, `content:hero[${occurrence}].heading`);
    if (choice) {
        rec.record.fidelity.push({
            aspect: "heading-size",
            expected: `${ctx.headingTargets.find((t) => t.key === section.id).desktop}/${ctx.headingTargets.find((t) => t.key === section.id).mobile}px`,
            achieved: `${round1(choice.px.desktop)}/${round1(choice.px.mobile)}px (${choice.size})`,
        });
    }

    if (content.value.text) {
        rec.block("text", "text", { text: toInline(content.value.text), text_style: "body" }, `content:hero[${occurrence}].text`);
    }
    if (details.hasEyebrow) {
        rec.record.fidelity.push({
            aspect: "eyebrow",
            expected: "texto de apoio acima do título",
            achieved: content.value.text ? "omitido" : "não aplicável",
            note: "image-banner permite um único bloco de texto (limit 1)",
        });
    }

    const styles = section.content.buttons.map((button) => button.style);
    // Quantidade de botões vem da referência (máximo 2 no image-banner).
    const buttons = (content.value.buttons ?? []).slice(0, Math.min(styles.length, 2));
    if (buttons.length) {
        const settings = {};
        buttons.forEach((button, i) => {
            settings[`button_label_${i + 1}`] = toInline(button.label);
            settings[`button_link_${i + 1}`] = button.link;
            settings[`button_style_secondary_${i + 1}`] = styles[i] === "outline" || styles[i] === "plain";
        });
        rec.block("buttons", "buttons", settings, `content:hero[${occurrence}].buttons + ${bpPath(section)}.content.buttons`);
    }
    if (section.content.buttons.length > 2) rec.record.ignored.push({ field: "buttons", reason: "image-banner suporta no máximo 2 botões" });
    return rec.build();
}

function mapProductGrid(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "featured-collection" });
    const details = section.details.productGrid;
    const path = `${bpPath(section)}.details.productGrid`;
    const content = contentFor(ctx.pack, "product-grid", occurrence, PLACEHOLDERS["product-grid"]);
    rec.record.content = content.source;

    rec.set("collection", content.value.collection, `content:product-grid[${occurrence}].collection`);
    rec.record.dependencies.push({
        kind: "collection",
        detail: `coleção "${content.value.collection}" com produtos publicados; sem ela o Dawn mostra cards de exemplo e a grade NÃO é funcional`,
    });
    rec.set("products_to_show", details.itemCount, `${path}.itemCount`);
    if (details.columns.desktop) rec.set("columns_desktop", details.columns.desktop, `${path}.columns.desktop`);
    if (details.columns.mobile) {
        const mobile = details.columns.mobile >= 2 ? "2" : "1";
        rec.set("columns_mobile", mobile, `${path}.columns.mobile`);
        if (details.columns.mobile > 2) rec.record.adaptations.push(`${details.columns.mobile} colunas no mobile reduzidas para 2 (máximo do Dawn)`);
    }
    if (details.hasHeading) {
        const choice = ctx.scales.headings[section.id];
        rec.set("title", toInline(content.value.heading ?? PLACEHOLDERS["product-grid"].heading), `content:product-grid[${occurrence}].heading`);
        if (choice) rec.set("heading_size", choice.size, `${bpPath(section)}.content.headings[0]`, `≈ ${round1(choice.px.desktop)}/${round1(choice.px.mobile)}px`);
    } else {
        rec.set("title", "", `${path}.hasHeading`);
    }
    rec.set("show_view_all", details.hasViewAllLink, `${path}.hasViewAllLink`);
    if (details.hasViewAllLink) {
        rec.set("view_all_style", "link", `${path}.hasViewAllLink`, "link simples na referência");
        rec.record.fidelity.push({ aspect: "view-all-position", expected: "na linha do título", achieved: "abaixo da grade", note: "posição fixa no Dawn" });
    }
    const ratio = ctx.blueprint.tokens.productCard?.image?.aspectRatio ?? null;
    if (ratio !== null) {
        const option = Math.abs(ratio - 1) <= 0.05 ? "square" : ratio < 0.95 && ratio >= 0.6 ? "portrait" : "adapt";
        rec.set("image_ratio", option, "tokens.productCard.image.aspectRatio", `proporção ${ratio}`);
    }
    rec.set("full_width", false, `${bpPath(section)}.viewports.desktop.box`, "conteúdo dentro do contêiner");
    rec.set("enable_desktop_slider", false, `${path}.rows`, "grade estática");
    rec.set("swipe_on_mobile", false, `${path}.rows.mobile`, "grade em linhas no mobile");
    rec.set("show_secondary_image", false, "tokens.productCard", "sem evidência de segunda imagem");
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    if (details.gapPx.mobile !== null && details.gapPx.mobile !== details.gapPx.desktop) {
        rec.record.fidelity.push({ aspect: "grid-gap-mobile", expected: `${details.gapPx.mobile}px`, achieved: "espaçamento global do Dawn", note: "gap mobile não é configurável por seção" });
    }
    if (ctx.blueprint.tokens.productCard?.hasBadge) {
        rec.record.fidelity.push({ aspect: "card-badge", expected: "selo sobre a imagem", achieved: "apenas selos de promoção/esgotado do Dawn", note: "selo livre não existe no Dawn" });
    }
    return rec.build();
}

function mapRichText(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "rich-text" });
    const details = section.details.richText;
    const path = `${bpPath(section)}.details.richText`;
    const content = contentFor(ctx.pack, "rich-text", occurrence, PLACEHOLDERS["rich-text"]);
    rec.record.content = content.source;

    const alignment = details.alignment === "justify" || !details.alignment ? "left" : details.alignment;
    const container = ctx.blueprint.tokens.layout.desktop?.containerWidthPx ?? null;
    const narrow = details.maxWidthPx !== null && container !== null && details.maxWidthPx < container * 0.8;
    // Posição geométrica observada do bloco (M7.6) tem precedência; sem ela
    // (blueprints anteriores, bloco de largura total ou não medido), a regra
    // anterior por largura máxima.
    const observed = details.blockPosition?.desktop ?? null;
    if (["left", "center", "right"].includes(observed)) rec.set("desktop_content_position", observed, `${path}.blockPosition.desktop`);
    else rec.set("desktop_content_position", narrow ? (alignment === "left" ? "left" : alignment) : "left", `${path}.maxWidthPx`);
    rec.set("content_alignment", alignment, `${path}.alignment`);
    rec.set("full_width", false, `${path}.maxWidthPx`, "conteúdo limitado ao contêiner");
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);
    if (details.maxWidthPx) {
        rec.record.fidelity.push({ aspect: "max-width", expected: `${details.maxWidthPx}px`, achieved: "largura de texto padrão do Dawn", note: "rich-text não tem largura configurável" });
    }

    if (content.value.eyebrow) {
        rec.block("caption", "caption", { caption: toInline(content.value.eyebrow), text_style: "caption-with-letter-spacing", text_size: "medium" }, `content:rich-text[${occurrence}].eyebrow`);
    }
    const heading = section.content.headings[0];
    if (heading && content.value.heading) {
        const choice = ctx.scales.headings[section.id];
        rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h1" }, `content:rich-text[${occurrence}].heading`);
    }
    if (section.content.paragraphs > 0 && content.value.text) {
        rec.block("text", "text", { text: toRichtext(content.value.text) }, `content:rich-text[${occurrence}].text`);
    }
    const styles = section.content.buttons.map((button) => button.style);
    const buttons = (content.value.buttons ?? []).slice(0, Math.min(styles.length, 2));
    if (buttons.length) {
        const settings = { button_label: toInline(buttons[0].label), button_link: buttons[0].link, button_style_secondary: styles[0] !== "solid" };
        if (buttons[1]) Object.assign(settings, { button_label_2: toInline(buttons[1].label), button_link_2: buttons[1].link, button_style_secondary_2: styles[1] !== "solid" });
        rec.block("button", "button", settings, `content:rich-text[${occurrence}].buttons + ${bpPath(section)}.content.buttons`);
    }
    return rec.build();
}

function mapFooter(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "sections/footer-group.json", key: "footer", type: "footer" });
    const details = section.details.footer;
    const path = `${bpPath(section)}.details.footer`;
    const content = contentFor(ctx.pack, "footer", occurrence, PLACEHOLDERS.footer);
    rec.record.content = content.source;

    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    const noInputs = section.content.inputs.length === 0;
    rec.set("newsletter_enable", !noInputs, `${bpPath(section)}.content.inputs`);
    rec.set("show_social", false, `${bpPath(section)}.content.icons`, `${section.content.icons} ícone(s); redes sociais não identificadas`);
    rec.set("payment_enable", false, `${bpPath(section)}.content.icons`, "nenhum ícone de pagamento observado");
    rec.set("enable_follow_on_shop", false, `${bpPath(section)}.content`, "não observado");
    rec.set("enable_country_selector", false, `${bpPath(section)}.content.inputs`, "nenhum seletor observado");
    rec.set("enable_language_selector", false, `${bpPath(section)}.content.inputs`, "nenhum seletor observado");
    rec.set("show_policy", false, `${bpPath(section)}.content.links`, "nenhum link de política identificado");
    rec.set("margin_top", 0, `${bpPath(section)}.viewports.desktop.box`, "footer encostado na seção anterior");
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    content.value.columns.forEach((column, i) => {
        if (column.kind === "text") {
            rec.block(`column-${i + 1}`, "text", { heading: toInline(column.heading), subtext: toRichtext(column.text) }, `content:footer[${occurrence}].columns[${i}]`);
        } else {
            rec.block(`column-${i + 1}`, "link_list", { heading: toInline(column.heading), menu: column.menu }, `content:footer[${occurrence}].columns[${i}]`);
            rec.record.dependencies.push({ kind: "menu", detail: `menu "${column.menu}" precisa existir na loja` });
        }
    });
    if (details.columns.desktop && details.columns.desktop !== content.value.columns.length) {
        rec.record.adaptations.push(`referência com ${details.columns.desktop} colunas; conteúdo fornece ${content.value.columns.length}`);
    }
    rec.record.fidelity.push({ aspect: "column-widths", expected: "larguras observadas", achieved: "colunas de largura igual do Dawn" });
    if (details.hasBottomRow) rec.record.fidelity.push({ aspect: "bottom-row", expected: "linha inferior própria", achieved: "copyright padrão do Dawn" });
    return rec.build();
}

function chooseMediaHeight(heights, rem) {
    let pick = null;
    for (const [option, [m, d]] of Object.entries(MEDIA_REM)) {
        const px = { desktop: Math.round(d * rem), mobile: Math.round(m * rem) };
        const parts = [rel(px.desktop, heights.desktop), rel(px.mobile, heights.mobile)].filter((_, i) => [heights.desktop, heights.mobile][i]);
        const error = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : Infinity;
        if (!pick || error < pick.error - 1e-9) pick = { option, px, error };
    }
    return pick;
}

/** Registra o tamanho de título obtido versus o medido (quando houve alvo). */
function headingFidelity(ctx, rec, section) {
    const choice = ctx.scales.headings[section.id];
    const target = ctx.headingTargets.find((item) => item.key === section.id);
    if (!choice || !target) return;
    rec.record.fidelity.push({
        aspect: "heading-size",
        expected: `${target.desktop}/${target.mobile}px`,
        achieved: `${round1(choice.px.desktop)}/${round1(choice.px.mobile)}px (${choice.size})`,
        ...(choice.size === "h2" && target.desktop < choice.px.desktop * 0.9 ? { note: "h2 é o menor tamanho de título do Dawn nesta seção" } : {}),
    });
}

// 1.8.0: sem imagem autorizada, o image-with-text do Dawn mostraria uma ILUSTRAÇÃO GENÉRICA no lugar da mídia.
// Gera um rich-text com o MESMO conteúdo autorizado (título, parágrafos, botão) e registra a composição ausente.
function mapImageWithTextWithoutImage(ctx, section, occurrence, resolved) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "rich-text" });
    const details = section.details.imageWithText;
    const path = `${bpPath(section)}.details.imageWithText`;
    const content = contentFor(ctx.pack, "image-with-text", occurrence, PLACEHOLDERS["image-with-text"]);
    rec.record.content = content.source;
    rec.set("desktop_content_position", "center", path, "sem a mídia, o texto ocupa a coluna de conteúdo");
    rec.set("content_alignment", details.contentAlignment.desktop ?? "left", `${path}.contentAlignment.desktop`);
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);
    if (details.hasEyebrow && content.value.eyebrow) rec.block("caption", "caption", { caption: toInline(content.value.eyebrow), text_style: "caption-with-letter-spacing", text_size: "medium" }, `content:image-with-text[${occurrence}].eyebrow`);
    if (section.content.headings[0] && content.value.heading) {
        const choice = ctx.scales.headings[section.id];
        rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h2" }, `content:image-with-text[${occurrence}].heading`);
    }
    if (section.content.paragraphs > 0 && content.value.paragraphs?.length) {
        rec.block("text", "text", { text: toRichtext(content.value.paragraphs.slice(0, Math.min(section.content.paragraphs, 4))) }, `content:image-with-text[${occurrence}].paragraphs`);
    }
    const style = section.content.buttons[0]?.style ?? null;
    if (style && content.value.button) rec.block("button", "button", { button_label: toInline(content.value.button.label), button_link: content.value.button.link, button_style_secondary: style !== "solid" }, `content:image-with-text[${occurrence}].button`);
    rec.record.fidelity.push({ aspect: "composition", expected: `imagem (${Math.round((details.mediaWidthShare.desktop ?? 0.5) * 100)}% da largura, ${details.mediaPosition.desktop ?? "?"}) + texto`, achieved: "somente texto (rich-text), sem ilustração genérica", note: "a imagem autorizada restaura o image-with-text" });
    rec.record.dependencies.push({
        kind: "image",
        detail: `composição imagem + texto não reproduzida: imagem da seção (proporção ${details.mediaAspectRatio}:1)${resolved.name ? `, slot "${resolved.name}"` : ""}: ${IMAGE_STATE_TEXT[resolved.state]}; gerado só o texto (sem placeholder ilustrativo)`,
    });
    return rec.build();
}

function mapImageWithText(ctx, section, occurrence) {
    {
        const content = contentFor(ctx.pack, "image-with-text", occurrence, PLACEHOLDERS["image-with-text"]);
        const resolved = imageState(ctx.pack, content.value.image, ctx.targetStore);
        if (resolved.state !== "ready") return mapImageWithTextWithoutImage(ctx, section, occurrence, resolved);
    }
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "image-with-text" });
    const details = section.details.imageWithText;
    const path = `${bpPath(section)}.details.imageWithText`;
    const content = contentFor(ctx.pack, "image-with-text", occurrence, PLACEHOLDERS["image-with-text"]);
    rec.record.content = content.source;

    // Altura da mídia: opção fixa do Dawn se ficar dentro da tolerância;
    // senão "adapt", que reproduz a proporção quando a imagem autorizada existir.
    const fixed = chooseMediaHeight(details.mediaHeightPx, ctx.scales.rem);
    if (fixed.error <= MEDIA_HEIGHT_TOLERANCE) {
        rec.set("height", fixed.option, `${path}.mediaHeightPx`, `≈ ${fixed.px.desktop}/${fixed.px.mobile}px (erro médio ${Math.round(fixed.error * 100)}%)`);
        rec.record.fidelity.push({ aspect: "media-height", expected: `${details.mediaHeightPx.desktop}/${details.mediaHeightPx.mobile}px`, achieved: `${fixed.px.desktop}/${fixed.px.mobile}px (${fixed.option})`, note: "altura fixa do Dawn; a imagem é recortada (cover)" });
    } else {
        rec.set("height", "adapt", `${path}.mediaAspectRatio`, `nenhuma opção fixa dentro de ${MEDIA_HEIGHT_TOLERANCE * 100}%; segue a proporção da imagem`);
        rec.record.fidelity.push({
            aspect: "media-height",
            expected: `${details.mediaHeightPx.desktop}/${details.mediaHeightPx.mobile}px`,
            achieved: `${Math.round(ADAPT_PLACEHOLDER_REM[1] * ctx.scales.rem)}/${Math.round(ADAPT_PLACEHOLDER_REM[0] * ctx.scales.rem)}px enquanto não houver imagem (placeholder)`,
            note: "com a imagem autorizada, a altura segue a proporção do arquivo",
        });
    }

    const share = details.mediaWidthShare.desktop;
    if (share !== null) {
        const width = share < 0.42 ? "small" : share > 0.58 ? "large" : "medium";
        rec.set("desktop_image_width", width, `${path}.mediaWidthShare.desktop`, `mídia ocupa ${Math.round(share * 100)}% do conjunto (Dawn: small 33%, medium 50%, large 67%)`);
    }
    const position = details.mediaPosition.desktop;
    if (position === "left" || position === "right") {
        rec.set("layout", position === "left" ? "image_first" : "text_first", `${path}.mediaPosition.desktop`);
    } else {
        rec.record.ignored.push({ field: "layout", reason: "posição da mídia no desktop não observada; padrão do Dawn (image_first) mantido" });
    }
    if (details.mediaPosition.mobile === "bottom") {
        rec.record.fidelity.push({ aspect: "mobile-order", expected: "mídia abaixo do texto", achieved: "mídia acima do texto", note: "Dawn sempre empilha a mídia primeiro no mobile" });
    }
    if (details.textVertical.desktop) rec.set("desktop_content_position", details.textVertical.desktop, `${path}.textVertical.desktop`);
    if (details.contentAlignment.desktop) rec.set("desktop_content_alignment", details.contentAlignment.desktop, `${path}.contentAlignment.desktop`);
    if (details.contentAlignment.mobile) rec.set("mobile_content_alignment", details.contentAlignment.mobile, `${path}.contentAlignment.mobile`);
    rec.set("content_layout", "no-overlap", `${path}.arrangement`, "mídia e texto sem sobreposição na referência");
    rec.set("image_behavior", "none", `${bpPath(section)}.viewports`, "animação não é observável em captura estática");
    const colorScheme = scheme(ctx.schemes, section);
    rec.set("section_color_scheme", colorScheme, `${bpPath(section)}.colorScheme`);
    rec.set("color_scheme", colorScheme, `${bpPath(section)}.colorScheme`, "mesmo esquema da seção: sem caixa de texto destacada");
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    if (details.gapPx.desktop !== null) {
        rec.record.fidelity.push({ aspect: "media-text-gap", expected: `${details.gapPx.desktop}px`, achieved: "grade sem gap + padding interno do texto (Dawn)", note: "espaçamento entre mídia e texto não é configurável" });
    }

    if (details.hasEyebrow && content.value.eyebrow) {
        rec.block("caption", "caption", { caption: toInline(content.value.eyebrow), text_style: "caption-with-letter-spacing", text_size: "medium" }, `content:image-with-text[${occurrence}].eyebrow`);
    }
    if (section.content.headings[0] && content.value.heading) {
        const choice = ctx.scales.headings[section.id];
        rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h2" }, `content:image-with-text[${occurrence}].heading`);
        headingFidelity(ctx, rec, section);
    }
    if (section.content.paragraphs > 0 && content.value.paragraphs?.length) {
        // Quantos parágrafos: o da referência (máximo 4, limite do richtext validado).
        const paragraphs = content.value.paragraphs.slice(0, Math.min(section.content.paragraphs, 4));
        rec.block("text", "text", { text: toRichtext(paragraphs), text_style: "body" }, `content:image-with-text[${occurrence}].paragraphs`);
        if (paragraphs.length < section.content.paragraphs) {
            rec.record.adaptations.push(`referência com ${section.content.paragraphs} parágrafos; conteúdo fornece ${paragraphs.length}`);
        }
    }
    const style = section.content.buttons[0]?.style ?? null;
    if (style && content.value.button) {
        rec.block("button", "button", { button_label: toInline(content.value.button.label), button_link: content.value.button.link, button_style_secondary: style !== "solid" }, `content:image-with-text[${occurrence}].button + ${bpPath(section)}.content.buttons[0]`);
    }
    if (section.content.buttons.length > 1) rec.record.ignored.push({ field: "buttons", reason: "image-with-text suporta 1 botão (limit 1)" });

    const resolved = imageState(ctx.pack, content.value.image, ctx.targetStore);
    if (resolved.state === "ready") {
        rec.set("image", resolved.reference, `content:images.${resolved.name}.shopify.reference`, `imagem autorizada com upload verificado em ${ctx.targetStore}`);
        ctx.imageReferences.add(resolved.reference);
    } else {
        rec.record.dependencies.push({
            kind: "image",
            detail: `imagem da seção (proporção ${details.mediaAspectRatio}:1)${resolved.name ? `, slot "${resolved.name}"` : ""}: ${IMAGE_STATE_TEXT[resolved.state]}; o tema exibe o placeholder do Dawn`,
        });
        // 1.7.0: o placeholder do Dawn é uma ILUSTRAÇÃO GENÉRICA (não a imagem da referência): registrado como composição não reproduzida
        rec.record.fidelity.push({ aspect: "composition", expected: "imagem da referência + texto", achieved: "ilustração genérica do Dawn (placeholder) + texto", note: "sem imagem autorizada; a ilustração não representa a referência" });
    }
    return rec.build();
}

function mapNewsletter(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "newsletter" });
    const details = section.details.newsletter;
    const path = `${bpPath(section)}.details.newsletter`;
    const content = contentFor(ctx.pack, "newsletter", occurrence, PLACEHOLDERS.newsletter);
    rec.record.content = content.source;

    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    rec.set("full_width", true, `${bpPath(section)}.viewports.desktop.box`, "faixa de largura total com a cor do esquema; conteúdo centralizado pelo Dawn");
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    if (details.hasHeading && content.value.heading) {
        const choice = ctx.scales.headings[section.id];
        rec.block("heading", "heading", { heading: toInline(content.value.heading), heading_size: choice?.size ?? "h2" }, `content:newsletter[${occurrence}].heading`);
        headingFidelity(ctx, rec, section);
    }
    if (details.hasText && content.value.text) {
        rec.block("paragraph", "paragraph", { text: toRichtext(content.value.text) }, `content:newsletter[${occurrence}].text`);
    }
    // O bloco do formulário não tem configurações; `settings: {}` explícito
    // evita a normalização que a Shopify faria no upload.
    rec.block("email_form", "email_form", {}, `${path}.emailFields`);

    if (details.alignment && details.alignment !== "center") {
        rec.record.fidelity.push({ aspect: "alignment", expected: details.alignment, achieved: "center", note: "Dawn centraliza a newsletter" });
    }
    rec.record.fidelity.push({
        aspect: "form-layout",
        expected: `campo + botão de texto (${details.formLayout.desktop ?? "?"} no desktop, ${details.formLayout.mobile ?? "?"} no mobile)`,
        achieved: "campo com botão de ícone embutido (Dawn)",
        note: "rótulo do campo e do botão vêm das traduções do tema (newsletter.label / newsletter.button_label)",
    });
    if (details.maxWidthPx) {
        rec.record.fidelity.push({ aspect: "max-width", expected: `${details.maxWidthPx}px`, achieved: "largura do formulário padrão do Dawn", note: "não configurável por seção" });
    }
    if (details.consentFields > 0) {
        rec.record.fidelity.push({ aspect: "consent", expected: `${details.consentFields} checkbox de consentimento`, achieved: "sem checkbox", note: "Dawn não oferece campo de consentimento no bloco email_form" });
    }
    rec.record.dependencies.push({
        kind: "functional-test",
        detail: "formulário nativo {% form 'customer' %}: a inscrição grava o cliente com consentimento de marketing na Shopify. Renderização gerada; funcionamento NÃO verificado (exige envio de teste na loja: sucesso, erro, e-mail duplicado)",
    });
    rec.record.dependencies.push({
        kind: "store-setting",
        detail: "revisar política de privacidade e consentimento de marketing da loja antes de ativar a coleta de e-mails",
    });
    return rec.build();
}

/**
 * Acordeão/FAQ -> collapsible-content (Dawn). Linhas = itens do ContentPack
 * (nunca mais que as da referência; nenhuma linha inventada). Conteúdo de
 * painel fechado não capturado vem só do pacote; listas/links internos aos
 * painéis não são reproduzidos (row_content = parágrafos).
 */
function mapCollapsible(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "collapsible-content" });
    const details = section.details.collapsibleContent;
    const path = `${bpPath(section)}.details.collapsibleContent`;
    const content = contentFor(ctx.pack, "collapsible-content", occurrence, PLACEHOLDERS["collapsible-content"]);
    rec.record.content = content.source;

    const heading = details.hasHeading && content.value.heading ? toInline(content.value.heading) : "";
    rec.set("heading", heading, details.hasHeading ? `content:collapsible-content[${occurrence}].heading` : `${path}.hasHeading`, heading ? undefined : "sem título (referência ou pacote)");
    if (heading) rec.set("heading_size", ctx.scales.headings[section.id]?.size ?? "h1", "tokens.typography.scale");
    if (details.hasHeading && !heading) rec.record.fidelity.push({ aspect: "heading", expected: "título da seção", achieved: "sem título", note: "o ContentPack não fornece título para esta seção" });
    rec.set("heading_alignment", ["center", "right"].includes(details.headingAlignment) ? details.headingAlignment : "left", `${path}.headingAlignment`);
    rec.set("layout", "none", `${path}`, "estilo do contêiner das linhas não medido; padrão do Dawn");
    rec.set("open_first_collapsible_row", details.firstRowOpen, `${path}.firstRowOpen`);
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    const items = content.value.items.slice(0, details.rows);
    if (content.value.items.length > details.rows) rec.record.adaptations.push(`ContentPack com ${content.value.items.length} itens; usados os ${details.rows} primeiros (linhas observadas na referência)`);
    items.forEach((item, i) => {
        rec.block(`row_${i + 1}`, "collapsible_row", { heading: toText(item.title), icon: "none", row_content: toRichtext(item.paragraphs) }, `content:collapsible-content[${occurrence}].items[${i}]`);
    });
    rec.record.ignored.push({ field: "icon", reason: "ícone das linhas não observado no blueprint; linhas sem ícone" });
    if (items.length < details.rows) {
        rec.record.fidelity.push({ aspect: "rows", expected: details.rows, achieved: items.length, note: "o conteúdo autorizado tem menos itens que a referência; nenhuma linha é inventada" });
    }
    if (details.capturedPanels < details.rows) {
        rec.record.fidelity.push({ aspect: "panel-content", expected: `${details.rows} painéis`, achieved: `${details.capturedPanels} com conteúdo capturado`, note: "painéis fechados e ausentes do DOM: o conteúdo de cada linha vem só do ContentPack" });
    }
    if (details.panelContent.listItems > 0 || details.panelContent.links > 0) {
        rec.record.fidelity.push({ aspect: "panel-structure", expected: `${details.panelContent.listItems} itens de lista, ${details.panelContent.links} links`, achieved: "parágrafos do ContentPack", note: "listas e links internos aos painéis não são reproduzidos (row_content em parágrafos)" });
    }
    return rec.build();
}

/**
 * Itens em colunas -> multicolumn (Dawn). Colunas = itens do ContentPack
 * (título + texto obrigatórios; números só como texto estático autorizado).
 * Ícones/imagens exigem upload autorizado (image_picker) e não são gerados.
 */
function mapMulticolumn(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "multicolumn" });
    const details = section.details.multicolumn;
    const path = `${bpPath(section)}.details.multicolumn`;
    const content = contentFor(ctx.pack, "multicolumn", occurrence, PLACEHOLDERS.multicolumn);
    rec.record.content = content.source;

    const title = details.hasHeading && content.value.heading ? toInline(content.value.heading) : "";
    rec.set("title", title, details.hasHeading ? `content:multicolumn[${occurrence}].heading` : `${path}.hasHeading`, title ? undefined : "sem título (referência ou pacote)");
    if (title) rec.set("heading_size", ctx.scales.headings[section.id]?.size ?? "h1", "tokens.typography.scale");
    if (details.hasHeading && !title) rec.record.fidelity.push({ aspect: "heading", expected: "título da seção", achieved: "sem título", note: "o ContentPack não fornece título para esta seção" });
    const desktopColumns = details.columns.desktop ?? Math.min(details.itemCount, 6);
    rec.set("columns_desktop", Math.max(1, Math.min(6, desktopColumns)), `${path}.columns.desktop`, details.columns.desktop === null ? "desktop não observado; um item por coluna (até 6)" : undefined);
    if (details.columns.desktop === null) rec.record.adaptations.push("columns_desktop: colunas do desktop não observadas; usado um item por coluna (até 6)");
    if (desktopColumns > 6) rec.record.adaptations.push(`columns_desktop: ${desktopColumns} limitado a 6 (máximo do Dawn)`);
    rec.set("columns_mobile", details.columns.mobile !== null && details.columns.mobile >= 2 ? "2" : "1", `${path}.columns.mobile`);
    if (details.columns.mobile === null) {
        rec.record.fidelity.push({ aspect: "columns-mobile", expected: "não observado (itens diferentes no mobile)", achieved: "1 coluna", note: "estrutura do mobile divergente; não inventamos uma estrutura comum" });
    }
    rec.set("column_alignment", details.alignment === "center" ? "center" : "left", `${path}.alignment`);
    // 1.8.0: itens com cartão medido (tokens.contentCards) → "primary" (fundo do cartão = fundo da seção + 4% do texto, Dawn)
    const cards = ctx.blueprint.tokens.contentCards ?? null;
    if (cards?.background && cards.sections.includes(section.id)) {
        rec.set("background_style", "primary", "tokens.contentCards.background", `cartões com fundo próprio (${cards.background}) na referência`);
        rec.record.fidelity.push({ aspect: "card-background", expected: cards.background, achieved: "fundo da seção + 4% da cor do texto (Dawn)", note: "o Dawn não aceita cor própria para o cartão de coluna" });
        if (cards.paddingPx !== null) rec.record.fidelity.push({ aspect: "card-padding", expected: `${cards.paddingPx}px`, achieved: "padding fixo do Dawn", note: "não configurável" });
    } else {
        rec.set("background_style", "none", `${path}`, "itens sem cartão medido");
    }
    rec.set("button_label", "", `${path}`, "sem botão de seção");
    rec.set("swipe_on_mobile", false, `${path}.columns.mobile`);
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    const items = content.value.items.slice(0, details.itemCount);
    if (content.value.items.length > details.itemCount) rec.record.adaptations.push(`ContentPack com ${content.value.items.length} itens; usados os ${details.itemCount} primeiros (itens observados na referência)`);
    items.forEach((item, i) => {
        const settings = { title: toInline(item.title), text: toRichtext(item.text) };
        if (item.link) Object.assign(settings, { link_label: toText(item.link.label), link: item.link.link });
        rec.block(`column_${i + 1}`, "column", settings, `content:multicolumn[${occurrence}].items[${i}]`);
    });
    if (items.length < details.itemCount) {
        rec.record.fidelity.push({ aspect: "items", expected: details.itemCount, achieved: items.length, note: "o conteúdo autorizado tem menos itens que a referência; nenhum item é inventado" });
    }
    if (details.itemsWithIcon > 0 || details.itemsWithMedia > 0) {
        rec.record.dependencies.push({ kind: "image", detail: `${details.itemsWithIcon} ícone(s) e ${details.itemsWithMedia} imagem(ns) nos itens: exigem imagens autorizadas com upload verificado (image_picker); colunas geradas sem imagem` });
    }
    if (details.itemsWithNumericLead > 0) {
        rec.record.fidelity.push({ aspect: "numbers", expected: `${details.itemsWithNumericLead} número(s) em destaque (podem ser animados)`, achieved: "texto estático do ContentPack", note: "animação de contagem não implementada" });
    }
    return rec.build();
}

/**
 * Depoimentos -> componente PRÓPRIO registrado ads-testimonials (M7.8b).
 * Cartões = itens do ContentPack (nunca mais que os da referência; nenhum
 * inventado). Citações/autoria só do pacote; avaliação nunca é exibida
 * (glifos observados não são uma nota); avatar em imagem exige upload.
 */
function mapTestimonials(ctx, section, occurrence) {
    const rec = new SectionRecord(ctx.theme, section, { file: "templates/index.json", key: ctx.keyFor(section), type: "ads-testimonials" });
    const details = section.details.testimonials;
    const path = `${bpPath(section)}.details.testimonials`;
    const content = contentFor(ctx.pack, "testimonials", occurrence, PLACEHOLDERS.testimonials);
    rec.record.content = content.source;

    const heading = details.hasHeading && content.value.heading ? toInline(content.value.heading) : "";
    rec.set("heading", heading, details.hasHeading ? `content:testimonials[${occurrence}].heading` : `${path}.hasHeading`, heading ? undefined : "sem título (referência ou pacote)");
    if (heading) rec.set("heading_size", ctx.scales.headings[section.id]?.size ?? "h1", "tokens.typography.scale");
    if (details.hasHeading && !heading) rec.record.fidelity.push({ aspect: "heading", expected: "título da seção", achieved: "sem título", note: "o ContentPack não fornece título para esta seção" });
    rec.set("heading_alignment", ["center", "right"].includes(details.headingAlignment) ? details.headingAlignment : "left", `${path}.headingAlignment`);
    // Aviso visível: obrigatório no pacote quando o conteúdo é demonstrativo.
    if (content.value.notice) rec.set("notice", toText(content.value.notice), `content:testimonials[${occurrence}].notice`, content.value.basis === "demonstrative" ? "identifica conteúdo demonstrativo" : undefined);
    const desktopColumns = details.columns.desktop ?? Math.min(details.itemCount, 4);
    rec.set("columns_desktop", Math.max(1, Math.min(4, desktopColumns)), `${path}.columns.desktop`, details.columns.desktop === null ? "desktop não observado; um item por coluna (até 4)" : undefined);
    if (details.columns.desktop === null) rec.record.adaptations.push("columns_desktop: colunas do desktop não observadas; usado um item por coluna (até 4)");
    if (desktopColumns > 4) rec.record.adaptations.push(`columns_desktop: ${desktopColumns} limitado a 4 (máximo do componente)`);
    rec.set("columns_mobile", details.columns.mobile !== null && details.columns.mobile >= 2 ? "2" : "1", `${path}.columns.mobile`);
    if (details.columns.mobile === null) rec.record.fidelity.push({ aspect: "columns-mobile", expected: "não observado", achieved: "1 coluna", note: "colunas do mobile não observadas" });
    rec.set("card_style", details.cardSurface ? "card" : "plain", `${path}.cardSurface`);
    rec.set("quote_style", details.quoteStyle === "italic" ? "italic" : "normal", `${path}.quoteStyle`);
    if (details.quoteStyle === "mixed") rec.record.fidelity.push({ aspect: "quote-style", expected: "itálico em parte dos cartões", achieved: "normal", note: "estilo da citação é único por seção" });
    rec.set("show_divider", details.itemsWithDivider === details.itemCount, `${path}.itemsWithDivider`);
    if (details.itemsWithDivider > 0 && details.itemsWithDivider < details.itemCount) rec.record.fidelity.push({ aspect: "divider", expected: `divisor em ${details.itemsWithDivider} de ${details.itemCount} cartões`, achieved: "sem divisor", note: "divisor é único por seção" });
    rec.set("color_scheme", scheme(ctx.schemes, section), `${bpPath(section)}.colorScheme`);
    paddings(rec, section, `${bpPath(section)}.viewports.desktop`);

    const items = content.value.items.slice(0, details.itemCount);
    if (content.value.items.length > details.itemCount) rec.record.adaptations.push(`ContentPack com ${content.value.items.length} itens; usados os ${details.itemCount} primeiros (cartões observados na referência)`);
    const wantsInitials = details.avatar.initials > 0;
    items.forEach((item, i) => {
        const settings = { quote: toRichtext(item.quote), author: toText(item.author) };
        if (item.meta) settings.author_meta = toText(item.meta);
        if (wantsInitials && item.initials) settings.initials = toText(item.initials);
        settings.rating = "none";
        rec.block(`testimonial_${i + 1}`, "testimonial", settings, `content:testimonials[${occurrence}].items[${i}]`);
    });
    if (items.length < details.itemCount) rec.record.fidelity.push({ aspect: "items", expected: details.itemCount, achieved: items.length, note: "o conteúdo autorizado tem menos depoimentos que a referência; nenhum é inventado" });
    if (details.glyphs.itemsWithRow > 0) rec.record.fidelity.push({ aspect: "rating-glyphs", expected: `fileira de ${details.glyphs.perItem ?? "?"} glifos em ${details.glyphs.itemsWithRow} cartões`, achieved: "avaliação não exibida", note: "glifos não comprovam uma nota; nenhuma avaliação autorizada no pacote" });
    if (details.avatar.image > 0) rec.record.dependencies.push({ kind: "image", detail: `${details.avatar.image} avatar(es) em imagem: exigem imagens autorizadas com upload verificado (image_picker); cartões gerados sem avatar` });
    if (wantsInitials && items.some((item) => !item.initials)) rec.record.fidelity.push({ aspect: "avatar-initials", expected: `${details.avatar.initials} avatar(es) com texto curto`, achieved: "só onde o pacote fornece iniciais", note: "iniciais vêm apenas do conteúdo autorizado" });
    if (content.value.basis === "demonstrative") rec.record.fidelity.push({ aspect: "content-basis", expected: "depoimentos reais autorizados", achieved: `conteúdo demonstrativo (${content.source === "content-pack" ? "pacote" : "placeholder"}) com aviso visível`, note: "não apresentar como depoimentos de clientes" });
    return rec.build();
}

// Seções cujo título entra no ajuste global da escala de títulos.
export const HEADING_SECTIONS = ["hero", "product-grid", "rich-text", "image-with-text", "newsletter", "collapsible-content", "multicolumn", "testimonials"];

const MAPPERS = {
    "announcement-bar": { map: mapAnnouncement, group: "header" },
    header: { map: mapHeader, group: "header" },
    hero: { map: mapHero, group: null },
    "product-grid": { map: mapProductGrid, group: null },
    "rich-text": { map: mapRichText, group: null },
    "image-with-text": { map: mapImageWithText, group: null },
    newsletter: { map: mapNewsletter, group: null },
    "collapsible-content": { map: mapCollapsible, group: null },
    multicolumn: { map: mapMulticolumn, group: null },
    testimonials: { map: mapTestimonials, group: null },
    footer: { map: mapFooter, group: "footer" },
};
const GROUP_SINGLETONS = new Set(["announcement-bar", "header", "footer"]);

function schemeSettings({ background, text, button, buttonLabel, gradient = "" }) {
    return {
        settings: {
            background: upper(background),
            background_gradient: gradient,
            text: upper(text),
            button: upper(button),
            button_label: upper(buttonLabel),
            secondary_button_label: upper(text),
            shadow: upper(text),
        },
    };
}

/**
 * @param {object} input
 * @param {import("../blueprint/schema.mjs").StoreBlueprint} input.blueprint
 * @param {import("./content-pack.mjs").ContentPack | null} input.pack
 * @param {import("./dawn-schema.mjs").ThemeSchema} input.theme
 * @param {object} input.dawnSettings config/settings_data.json do Dawn base
 * @param {object} input.provenance
 */
export function buildPlan({ blueprint, pack, theme, dawnSettings, provenance, components = [], extensions = [] }) {
    // Loja de destino (domínio canônico da loja) declarada na geração: só ela
    // pode receber referências de imagem verificadas.
    const targetStore = provenance?.targetStore ?? null;
    const roles = blueprint.tokens.colors.roles;
    const notes = [];
    const fidelity = [];

    // --- Esquemas de cor ----------------------------------------------------
    const basePreset = dawnSettings.presets[dawnSettings.current];
    const colorSchemes = structuredClone(basePreset.color_schemes);
    const page = {
        background: roles.background ?? "#ffffff",
        text: roles.text ?? "#121212",
        button: roles.primary ?? roles.text ?? "#121212",
        buttonLabel: roles.onPrimary ?? roles.background ?? "#ffffff",
    };
    colorSchemes["scheme-1"] = schemeSettings(page);
    notes.push("scheme-1 (primeiro esquema = :root/body no Dawn) recebeu as cores-base da página; scheme-2..5 mantidos para as demais páginas");

    const darkest = blueprint.tokens.colors.palette
        .filter((entry) => entry.usage === "background")
        .map((entry) => entry.hex);
    const schemes = new Map();
    for (const source of blueprint.tokens.colorSchemes) {
        const id = `ads-${source.id.replace("scheme-", "")}`;
        let background = source.background;
        if (!background) {
            // Fundo de imagem: cor de reserva com maior contraste com o texto.
            const text = source.text ?? page.text;
            background = darkest.sort((a, b) => contrast(b, text) - contrast(a, text) || (a < b ? -1 : 1))[0] ?? page.background;
            notes.push(`${id}: fundo é imagem na referência; cor de reserva ${background} (maior contraste com o texto)`);
        }
        colorSchemes[id] = schemeSettings({
            background,
            text: source.text ?? page.text,
            button: source.button ?? page.button,
            buttonLabel: source.buttonLabel ?? page.buttonLabel,
        });
        schemes.set(source.id, id);
    }

    // --- Hero: imagem ou pintura medida ---------------------------------------
    // Esquema PRÓPRIO por hero de cor (ads-hero-N): os esquemas das demais
    // seções não mudam.
    const heroStrategies = new Map();
    let heroOccurrence = 0;
    for (const section of blueprint.sections.filter((item) => item.type === "hero")) {
        const decision = heroStrategy(section, pack, heroOccurrence++, blueprint, targetStore);
        if (decision.strategy === "color") {
            const source = blueprint.tokens.colorSchemes.find((item) => item.id === section.colorScheme);
            const stops = decision.paint.stops;
            const rgb = stops.map((stop) => rgbOf(stop.hex));
            const mean = rgb[0].map((_, channel) => Math.round(rgb.reduce((sum, color) => sum + color[channel], 0) / rgb.length));
            const schemeId = `ads-hero-${heroStrategies.size + 1}`;
            colorSchemes[schemeId] = schemeSettings({
                background: `#${mean.map((value) => value.toString(16).padStart(2, "0")).join("")}`,
                gradient: decision.paint.kind === "gradient" ? cssLinearGradient(decision.paint.angleDeg, stops) : "",
                text: source?.text ?? page.text,
                button: source?.button ?? page.button,
                buttonLabel: source?.buttonLabel ?? page.buttonLabel,
            });
            notes.push(`${schemeId}: ${decision.paint.kind === "gradient" ? "gradiente" : "cor"} do hero ${section.id} (${decision.reason})`);
            decision.schemeId = schemeId;
        }
        heroStrategies.set(section.id, decision);
    }

    // --- Seções ---------------------------------------------------------------
    const headingTargets = [];
    const scaleOf = (level) => blueprint.tokens.typography.scale.find((item) => item.level === level);
    for (const section of blueprint.sections) {
        const mapper = MAPPERS[section.type];
        const heading = section.content.headings[0];
        if (!mapper || !heading || !HEADING_SECTIONS.includes(section.type)) continue;
        // Componentes de itens: o título da SEÇÃO só existe se observado acima
        // do grupo (os títulos dos itens não entram na escala de títulos).
        const ownTitle = section.details.collapsibleContent?.hasHeading ?? section.details.multicolumn?.hasHeading ?? section.details.testimonials?.hasHeading ?? true;
        if (!ownTitle) continue;
        const level = scaleOf(heading.level);
        headingTargets.push({
            key: section.id,
            desktop: heading.sizePx ?? level?.desktopPx,
            mobile: level?.mobilePx ?? heading.sizePx,
            // O componente próprio de depoimentos só oferece h2/h1/h0.
            allowed: section.type === "testimonials" ? ["h2", "h1", "h0"] : Object.keys(HEADING_REM),
        });
    }
    const scales = solveScales(blueprint, theme, headingTargets);

    const keyFor = (section) => `bp_${section.id.replace(/-/g, "_")}`;
    const imageReferences = new Set();
    const ctx = { theme, pack, blueprint, schemes, scales, headingTargets, keyFor, heroStrategies, imageReferences, targetStore };
    const occurrences = new Map();
    const records = [];
    const index = { sections: {}, order: [] };
    const headerGroup = { type: "header", name: "t:sections.header.name", sections: {}, order: [] };
    const footerGroup = { type: "footer", name: "t:sections.footer.name", sections: {}, order: [] };

    blueprint.sections.forEach((section, position) => {
        const mapper = MAPPERS[section.type];
        const occurrence = occurrences.get(section.type) ?? 0;
        occurrences.set(section.type, occurrence + 1);

        if (!mapper || (GROUP_SINGLETONS.has(section.type) && occurrence > 0)) {
            records.push({
                blueprintSectionId: section.id,
                blueprintType: section.type,
                confidence: section.confidence,
                position,
                status: "unsupported",
                target: null,
                reason: !mapper
                    ? section.type === "unknown"
                        ? `tipo não reconhecido (${section.unknownReason}); sem conversão especulativa`
                        : `sem mapeamento para ${section.type}`
                    : `segunda ocorrência de ${section.type} não suportada no grupo de seções`,
                hints: section.hints.map((hint) => hint.type),
                dependencies: [],
            });
            return;
        }

        const { section: built, record } = mapper.map(ctx, section, occurrence);
        record.position = position;
        records.push(record);
        if (mapper.group === "header") {
            headerGroup.sections[record.target.key] = built;
        } else if (mapper.group === "footer") {
            footerGroup.sections[record.target.key] = built;
        } else {
            index.sections[record.target.key] = built;
            index.order.push(record.target.key);
        }
    });
    // Ordem do grupo do header: anúncio antes do header.
    headerGroup.order = ["announcement-bar", "header"].filter((key) => headerGroup.sections[key]);
    footerGroup.order = Object.keys(footerGroup.sections);

    // --- Configurações globais ---------------------------------------------
    const settings = {};
    const applied = [];
    const setGlobal = (id, value, from, note) => {
        const definition = theme.settings.get(id);
        let final = value;
        if (definition?.type === "range" && typeof value === "number") {
            final = snap(definition, value);
            if (final !== value) notes.push(`${id}: ${value} ajustado para ${final} (intervalo/passo do Dawn)`);
        }
        settings[id] = final;
        applied.push({ setting: id, value: final, from, ...(note ? { note } : {}) });
    };

    setGlobal("body_scale", scales.bodyScale, "tokens.typography.body.sizePx", `corpo ≈ ${scales.achieved.bodyPx.desktop}/${scales.achieved.bodyPx.mobile}px`);
    setGlobal("page_width", scales.pageWidth, "tokens.layout.desktop.containerWidthPx", `contêiner ≈ ${scales.achieved.containerPx}px`);
    setGlobal("heading_scale", scales.headingScale, "tokens.typography.scale + sections.*.content.headings");
    setGlobal("spacing_sections", 0, "sections.*.viewports.*.paddingTopPx", "espaçamento feito pelo padding de cada seção");
    const gap = blueprint.sections.find((s) => s.type === "product-grid")?.details.productGrid?.gapPx.desktop;
    if (gap !== undefined && gap !== null) {
        setGlobal("spacing_grid_horizontal", gap, "sections.<product-grid>.details.productGrid.gapPx.desktop");
        setGlobal("spacing_grid_vertical", gap, "sections.<product-grid>.details.productGrid.gapPx.desktop", "assumido igual ao horizontal");
    }

    const buttons = blueprint.tokens.buttons;
    const solid = buttons.find((button) => button.style === "solid");
    const outline = buttons.find((button) => button.style === "outline");
    const radius = (solid ?? outline)?.radiusPx;
    if (radius !== null && radius !== undefined) setGlobal("buttons_radius", radius, "tokens.buttons[].radiusPx");
    setGlobal("buttons_border_thickness", outline?.borderWidthPx ?? 0, "tokens.buttons[outline].borderWidthPx", "Dawn usa uma espessura para todos os botões");
    setGlobal("buttons_border_opacity", 100, "tokens.buttons[outline].colors", "borda sólida");
    setGlobal("buttons_shadow_opacity", 0, "tokens.buttons", "sem sombra observada");

    const input = blueprint.tokens.input;
    if (input?.radiusPx !== null && input?.radiusPx !== undefined) setGlobal("inputs_radius", input.radiusPx, "tokens.input.radiusPx");
    if (input?.borderWidthPx !== null && input?.borderWidthPx !== undefined) setGlobal("inputs_border_thickness", input.borderWidthPx, "tokens.input.borderWidthPx");

    // 1.8.0: cartões de CONTEÚDO medidos → "Contêineres de conteúdo" nativos do Dawn (editáveis no Theme Editor).
    // Só com evidência em seções de COLUNAS (cujos cartões são .content-container no Dawn); evidência só em componentes
    // próprios (ex.: depoimentos) não muda configurações globais.
    const contentCards = blueprint.tokens.contentCards ?? null;
    const cardColumns = contentCards ? contentCards.sections.filter((id) => blueprint.sections.find((s) => s.id === id)?.type === "multicolumn") : [];
    if (contentCards && cardColumns.length) {
        setGlobal("text_boxes_radius", contentCards.radiusPx ?? 0, "tokens.contentCards.radiusPx");
        setGlobal("text_boxes_border_thickness", contentCards.borderWidthPx ?? 0, "tokens.contentCards.borderWidthPx");
        if (contentCards.borderColor) {
            const owner = blueprint.sections.find((s) => s.id === cardColumns[0]);
            const sch = blueprint.tokens.colorSchemes.find((x) => x.id === owner?.colorScheme);
            const [bg, fg, bd] = [sch?.background ?? page.background, sch?.text ?? page.text, contentCards.borderColor].map((hex) => rgbOf(hex));
            // Dawn: borda = rgba(cor do texto, opacidade) sobre o fundo → opacidade que reproduz a cor medida (média dos canais)
            const ratios = [0, 1, 2].filter((c) => Math.abs(fg[c] - bg[c]) >= 16).map((c) => (bd[c] - bg[c]) / (fg[c] - bg[c]));
            const alpha = ratios.length ? Math.min(1, Math.max(0, ratios.reduce((a, b) => a + b, 0) / ratios.length)) : 1;
            setGlobal("text_boxes_border_opacity", Math.round(alpha * 100), "tokens.contentCards.borderColor + colorSchemes", `borda ${contentCards.borderColor} ≈ texto da seção com ${Math.round(alpha * 100)}% de opacidade`);
        }
        if (contentCards.shadow) {
            setGlobal("text_boxes_shadow_opacity", Math.round(contentCards.shadow.opacity * 100), "tokens.contentCards.shadow.opacity");
            setGlobal("text_boxes_shadow_horizontal_offset", contentCards.shadow.xPx, "tokens.contentCards.shadow.xPx");
            setGlobal("text_boxes_shadow_vertical_offset", contentCards.shadow.yPx, "tokens.contentCards.shadow.yPx");
            setGlobal("text_boxes_shadow_blur", contentCards.shadow.blurPx, "tokens.contentCards.shadow.blurPx");
        } else {
            setGlobal("text_boxes_shadow_opacity", 0, "tokens.contentCards.shadow", "sem sombra nos cartões");
        }
    } else if (contentCards) {
        notes.push(`cartões medidos só em ${contentCards.sections.join(", ")} (componente sem contêiner do Dawn): configurações globais de contêiner mantidas`);
    }

    const card = blueprint.tokens.productCard;
    if (card) {
        const gridSection = blueprint.sections.find((s) => s.type === "product-grid");
        const gridBackground = blueprint.tokens.colorSchemes.find((s) => s.id === gridSection?.colorScheme)?.background ?? page.background;
        const isCard = card.background !== null && card.background !== gridBackground;
        setGlobal("card_style", isCard ? "card" : "standard", "tokens.productCard.background");
        if (card.paddingPx !== null) setGlobal("card_image_padding", card.paddingPx, "tokens.productCard.paddingPx");
        if (card.radiusPx !== null) setGlobal("card_corner_radius", card.radiusPx, "tokens.productCard.radiusPx");
        if (card.textAlign && card.textAlign !== "justify") setGlobal("card_text_alignment", card.textAlign, "tokens.productCard.textAlign");
        setGlobal("card_border_thickness", card.borderWidthPx ?? 0, "tokens.productCard.borderWidthPx");
        setGlobal("card_shadow_opacity", card.shadow ? 10 : 0, "tokens.productCard.shadow");
        if (isCard) {
            let cardScheme = [...schemes.values()].find((id) => colorSchemes[id].settings.background === upper(card.background) && colorSchemes[id].settings.text === upper(page.text));
            if (!cardScheme) {
                cardScheme = "ads-card";
                colorSchemes[cardScheme] = schemeSettings({ ...page, background: card.background });
            }
            setGlobal("card_color_scheme", cardScheme, "tokens.productCard.background");
        }
        if (card.image?.radiusPx) {
            fidelity.push({ aspect: "card-image-radius", expected: `${card.image.radiusPx}px`, achieved: "derivado do raio do card", note: "Dawn não tem raio próprio para a imagem do card" });
        }
    }

    // Fontes: intenção do blueprint (família e classe genérica, títulos e
    // corpo separados) -> handle VERIFICADO do catálogo. Sem equivalente
    // verificado, a fonte do tema é mantida e a lacuna fica registrada.
    const typography = blueprint.tokens.typography;
    const fonts = {};
    for (const [role, setting] of [["heading", "type_header_font"], ["body", "type_body_font"]]) {
        const intent = typography[role] ?? null;
        const result = matchFont(intent, undefined, { role });
        const kept = basePreset[setting];
        if (result.entry) {
            setGlobal(setting, result.entry.handle, `tokens.typography.${role}`, result.match === "exact" ? `família ${result.entry.family}` : `equivalente ${result.entry.generic} verificado: ${result.entry.family} no lugar de ${intent.family}`);
        }
        fonts[role] = {
            intent: intent ? { family: intent.family, generic: intent.generic, weights: intent.weights } : null,
            match: result.match,
            reason: result.reason,
            handle: result.entry?.handle ?? kept,
            source: result.entry ? "font-catalog" : "theme-default-kept",
            storeConfirmation: result.entry?.storeConfirmation ?? null,
        };
    }
    const fontText = (role) => `${typography[role]?.family ?? "?"} (${typography[role]?.generic ?? "?"})`;
    if (fonts.heading.match !== "exact" || fonts.body.match !== "exact") {
        fidelity.push({
            aspect: "fonts",
            expected: `títulos ${fontText("heading")}, corpo ${fontText("body")}`,
            achieved: `títulos ${fonts.heading.handle} [${fonts.heading.match}], corpo ${fonts.body.handle} [${fonts.body.match}]`,
            note: ["heading", "body"]
                .filter((role) => fonts[role].match === "none")
                .map((role) => `${role === "heading" ? "títulos" : "corpo"}: nenhuma fonte ${typography[role]?.generic ?? ""} verificada no catálogo; fonte do tema mantida`)
                .concat(["heading", "body"].filter((role) => fonts[role].match === "generic-equivalent").map((role) => `${role === "heading" ? "títulos" : "corpo"}: fonte equivalente, não a da referência`))
                .join("; "),
        });
    }
    const headingWeight = Math.max(0, ...(typography.heading?.weights ?? []));
    const headingEntry = FONT_CATALOG.find((entry) => entry.handle === fonts.heading.handle);
    if (headingEntry && headingWeight && Math.abs(headingEntry.weight - headingWeight) >= 200) {
        fidelity.push({ aspect: "heading-weight", expected: String(headingWeight), achieved: `${headingEntry.weight} (${headingEntry.handle})`, note: "peso disponível no catálogo verificado" });
    }
    const body = scales.targets.bodyPx;
    if (body.mobile && scales.achieved.bodyPx.mobile !== body.mobile) {
        fidelity.push({ aspect: "body-size-mobile", expected: `${body.mobile}px`, achieved: `${scales.achieved.bodyPx.mobile}px`, note: "Dawn usa 1.5rem no mobile e 1.6rem no desktop" });
    }
    const gutter = blueprint.tokens.layout;
    if (gutter.desktop?.gutterPx !== null) {
        fidelity.push({
            aspect: "gutter",
            expected: `${gutter.desktop?.gutterPx}/${gutter.mobile?.gutterPx}px`,
            achieved: `${Math.round(5 * scales.rem)}/${Math.round(1.5 * scales.rem)}px`,
            note: "margem lateral fixa do Dawn (5rem / 1.5rem)",
        });
    }

    const preset = { ...structuredClone(basePreset), ...settings, color_schemes: colorSchemes };
    // Preset único: a Shopify exige os mesmos IDs de esquema de cor em todos
    // os presets; manter o preset original do Dawn (sem os esquemas novos)
    // fazia o arquivo inteiro ser rejeitado no upload.
    const settingsData = { current: PRESET_NAME, presets: { [PRESET_NAME]: preset } };

    const dependencies = [];
    const seen = new Set();
    for (const record of records) {
        for (const dependency of record.dependencies) {
            const key = `${record.blueprintSectionId}|${dependency.kind}|${dependency.detail}`;
            if (seen.has(key)) continue;
            seen.add(key);
            dependencies.push({ section: record.blueprintSectionId, ...dependency });
        }
    }
    for (const record of records) if (record.status === "generated") fidelity.push(...record.fidelity.map((item) => ({ section: record.blueprintSectionId, ...item })));
    // Fonte documentada mas ainda não aceita pela loja: dependência explícita.
    for (const role of ["heading", "body"]) {
        const entry = catalogEntry(fonts[role].handle);
        if (fonts[role].source === "font-catalog" && entry?.storeConfirmation === "pending") {
            dependencies.push({
                section: null,
                kind: "font-confirmation",
                detail: `${entry.handle} (${entry.family}) documentada pela Shopify (${entry.verification.source}); aceite na loja pendente: confirmar no settings_data remoto e no carregamento da fonte após um upload autorizado`,
            });
        }
    }

    // Componentes próprios registrados USADOS pelas seções geradas (M7.8b).
    // Sem nenhum, a chave nem existe: o plano histórico fica igual.
    const usedTypes = new Set([index, headerGroup, footerGroup].flatMap((file) => Object.values(file.sections).map((item) => item.type)));
    const usedComponents = components.filter((component) => usedTypes.has(component.id)).map(componentRecord);

    return {
        schemaVersion: 1,
        kind: "GenerationPlan",
        generator: { version: GENERATOR_VERSION, target: "dawn-16.0.0", preset: PRESET_NAME },
        provenance,
        ...(usedComponents.length ? { components: usedComponents } : {}),
        // Extensões de tema registradas (1.6.0): todas, sempre; o registro idêntico ao do código confiável.
        ...(extensions.length ? { themeExtensions: extensions.map((extension) => extension.record) } : {}),
        content: pack ? { id: pack.id, authorization: pack.authorization } : { id: null, authorization: null, note: "sem ContentPack: placeholders neutros" },
        scales,
        fonts,
        // Referências de imagem gravadas no tema (só slots autorizados com upload verificado).
        imageReferences: [...imageReferences].sort(),
        global: { applied, colorSchemes: Object.keys(colorSchemes), notes },
        sections: records,
        files: {
            "config/settings_data.json": settingsData,
            "templates/index.json": index,
            "sections/header-group.json": headerGroup,
            "sections/footer-group.json": footerGroup,
        },
        dependencies,
        fidelity,
        // 1.7.0: o que NÃO foi reproduzido, por região (estrutura ≠ aparência), e o estado da medição visual
        omissions: omissionsFor(blueprint, records, pack),
        visualFidelity: { measured: false, reason: "sem captura do tema renderizado: semelhança visual com a referência não foi medida", reproduction: "estrutural" },
        stats: {
            sections: records.length,
            generated: records.filter((r) => r.status === "generated").length,
            unsupported: records.filter((r) => r.status === "unsupported").length,
        },
    };
}

/**
 * Omissões por região: o que a referência tem e o tema gerado NÃO reproduz (imagens/composições, ícones, itens,
 * botões, textos substituídos, região inteira). Determinístico, a partir do blueprint e dos registros do plano.
 */
export function omissionsFor(blueprint, records, pack) {
    const out = [];
    for (const record of records) {
        const section = blueprint.sections.find((item) => item.id === record.blueprintSectionId);
        if (!section) continue;
        const items = [];
        if (record.status !== "generated") {
            items.push({ kind: "region", detail: `região inteira não gerada (${record.reason ?? "sem mapeamento"})` });
        } else {
            const images = (section.viewports.desktop?.images ?? section.viewports.mobile?.images ?? []).length;
            const imageDeps = (record.dependencies ?? []).filter((dep) => dep.kind === "image" || dep.kind === "logo");
            if (images && !imageDeps.length) items.push({ kind: "image", detail: `${images} imagem(ns) da referência sem equivalente no tema` });
            for (const dep of imageDeps) items.push({ kind: dep.kind === "logo" ? "brand" : "image", detail: dep.detail });
            if (section.content.icons > 0) items.push({ kind: "icon", detail: `${section.content.icons} ícone(s) da referência não reproduzido(s)` });
            for (const f of record.fidelity ?? []) {
                if (f.aspect === "items" && Number(f.achieved) < Number(f.expected)) items.push({ kind: "items", detail: `${f.expected} itens na referência; ${f.achieved} no tema (${f.note ?? ""})` });
                if (f.aspect === "composition") items.push({ kind: "composition", detail: `${f.expected} → ${f.achieved}` });
            }
            for (const ig of record.ignored ?? []) if (ig.field === "buttons") items.push({ kind: "button", detail: ig.reason });
            if (section.content.textChars > 0 && record.content !== null) {
                items.push({ kind: "text", detail: record.content === "content-pack" ? `textos da referência (${section.content.textChars} caracteres) substituídos por conteúdo de demonstração (${pack?.id ?? "ContentPack"})` : `textos da referência substituídos por placeholders neutros` });
            }
        }
        out.push({ blueprintSectionId: section.id, blueprintType: section.type, reproduction: record.status === "generated" ? "estrutural" : "nenhuma", items });
    }
    return out;
}

function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        .map((v) => v / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/**
 * Valida o plano inteiro contra os schemas reais do tema.
 * @returns {string[]} erros
 */
export function validatePlan(plan, theme) {
    const settingsData = plan.files["config/settings_data.json"];
    const preset = settingsData.presets[settingsData.current];
    const overrides = Object.fromEntries(plan.global.applied.map((item) => [item.setting, preset[item.setting]]));
    const schemes = preset.color_schemes;
    const context = { schemes: new Set(Object.keys(schemes)), imageReferences: new Set(plan.imageReferences ?? []) };
    // Fonte gravada no preset: do catálogo verificado ou a original do tema.
    const fontErrors = [];
    for (const setting of ["type_header_font", "type_body_font"]) {
        const value = preset[setting];
        const original = theme.settings.get(setting)?.default;
        if (value !== undefined && value !== original && !isVerifiedFont(value)) fontErrors.push(`settings.${setting}: fonte não verificada no catálogo (${value})`);
    }
    return [
        ...fontErrors,
        ...checkPlanInvariants(plan),
        ...validateSettingsData(theme, settingsData),
        ...validateGlobalSettings(theme, overrides, schemes),
        ...validateTemplate(theme, plan.files["templates/index.json"], { ...context, group: null }, "templates/index.json"),
        ...validateTemplate(theme, plan.files["sections/header-group.json"], { ...context, group: "header" }, "sections/header-group.json"),
        ...validateTemplate(theme, plan.files["sections/footer-group.json"], { ...context, group: "footer" }, "sections/footer-group.json"),
    ];
}

/**
 * Invariantes de rastreabilidade entre o plano e os arquivos gerados:
 *  - cada seção do blueprint aparece uma vez, na posição original;
 *  - `unknown` nunca é gerada (sem conversão especulativa);
 *  - seção gerada tem destino existente no arquivo indicado;
 *  - seção não suportada não tem destino e não aparece nos arquivos;
 *  - todo arquivo só contém seções que vêm de um registro gerado.
 * @returns {string[]}
 */
export function checkPlanInvariants(plan) {
    const errors = [];
    const ids = plan.sections.map((record) => record.blueprintSectionId);
    if (new Set(ids).size !== ids.length) errors.push("plano: seção do blueprint duplicada");
    plan.sections.forEach((record, index) => {
        if (record.position !== index) errors.push(`plano: ${record.blueprintSectionId} fora da posição original`);
    });

    const claimed = new Set();
    for (const record of plan.sections) {
        const where = `plano.${record.blueprintSectionId}`;
        if (record.blueprintType === "unknown" && record.status !== "unsupported") {
            errors.push(`${where}: seção unknown não pode ser gerada`);
        }
        if (record.status === "generated") {
            const file = record.target && plan.files[record.target.file];
            if (!file || !file.sections?.[record.target.key]) {
                errors.push(`${where}: gerada sem destino válido`);
            } else if (file.sections[record.target.key].type !== record.target.type) {
                errors.push(`${where}: tipo do destino diverge`);
            } else {
                claimed.add(`${record.target.file}|${record.target.key}`);
            }
        } else if (record.status === "unsupported") {
            if (record.target !== null) errors.push(`${where}: não suportada com destino`);
        } else {
            errors.push(`${where}: status inválido ${record.status}`);
        }
    }
    for (const file of ["templates/index.json", "sections/header-group.json", "sections/footer-group.json"]) {
        for (const key of Object.keys(plan.files[file]?.sections ?? {})) {
            if (!claimed.has(`${file}|${key}`)) errors.push(`plano: ${file}.${key} sem registro de origem`);
        }
    }
    // Componentes próprios: exatamente os registrados que as seções usam.
    const declared = (plan.components ?? []).map((component) => component.id);
    const usedOwn = new Set(
        ["templates/index.json", "sections/header-group.json", "sections/footer-group.json"]
            .flatMap((file) => Object.values(plan.files[file]?.sections ?? {}).map((item) => item.type))
            .filter((type) => type.startsWith("ads-"))
    );
    for (const type of usedOwn) if (!declared.includes(type)) errors.push(`plano: seção própria ${type} sem componente declarado`);
    for (const id of declared) {
        if (!usedOwn.has(id)) errors.push(`plano: componente ${id} declarado sem uso`);
        const entry = COMPONENT_REGISTRY.find((item) => item.id === id);
        const record = plan.components.find((component) => component.id === id);
        if (!entry || entry.sha256 !== record.sha256 || entry.version !== record.version || entry.target !== record.target) errors.push(`plano: componente ${id} fora do registro`);
    }
    if (new Set(declared).size !== declared.length) errors.push("plano: componente duplicado");
    // Extensões de tema: cada declaração idêntica ao registro confiável (planos sem a chave: gerações até 1.5.0).
    if (plan.themeExtensions !== undefined) for (const problem of declaredExtensionProblems(plan.themeExtensions)) errors.push(`plano: ${problem}`);
    return errors;
}
