/**
 * Validação contra os schemas REAIS do tema (lidos do Dawn base):
 * `{% schema %}` de cada seção e config/settings_schema.json.
 *
 * Nada é presumido: configuração sem definição no schema é erro.
 */

import { readFile, readdir } from "node:fs/promises";

// Mesmo formato do contrato do ContentPack (definido lá, sem dependência circular de valores).
const SHOPIFY_IMAGE_REFERENCE = /^shopify:\/\/shop_images\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
import { join } from "node:path";

const SCHEMA_TAG = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;

export const MAX_TEMPLATE_SECTIONS = 25;
export const MAX_SECTION_BLOCKS = 50;

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FONT_HANDLE = /^[a-z0-9_]+_[ni][1-9]$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_URL = /^(?:\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?|shopify:\/\/(?:collections|products|pages|blogs)\/[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export class ThemeSchema {
    constructor({ sections, settings }) {
        this.sections = sections;
        /** @type {Map<string, any>} */
        this.settings = settings;
    }

    static async load(themeDir) {
        const sections = new Map();
        for (const name of await readdir(join(themeDir, "sections"))) {
            if (!name.endsWith(".liquid")) continue;
            const text = await readFile(join(themeDir, "sections", name), "utf8");
            const match = SCHEMA_TAG.exec(text);
            if (!match) continue;
            sections.set(name.replace(/\.liquid$/, ""), JSON.parse(match[1]));
        }
        const settingsSchema = JSON.parse(await readFile(join(themeDir, "config", "settings_schema.json"), "utf8"));
        const settings = new Map();
        for (const group of settingsSchema) {
            for (const setting of group.settings ?? []) if (setting.id) settings.set(setting.id, setting);
        }
        return new ThemeSchema({ sections, settings });
    }

    section(type) {
        return this.sections.get(type) ?? null;
    }

    /**
     * Cópia com os schemas dos componentes PRÓPRIOS registrados (hash já
     * conferido). Um componente nunca substitui uma seção do tema.
     */
    withComponents(components) {
        const sections = new Map(this.sections);
        for (const component of components) {
            if (sections.has(component.id)) throw new Error(`Componente ${component.id} colide com uma seção do tema`);
            sections.set(component.id, component.schema);
        }
        return new ThemeSchema({ sections, settings: this.settings });
    }
}

const GRADIENT = /^linear-gradient\((\d{1,3})deg((?:, rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 1\) \d{1,3}%){2,4})\)$/;

function isLinearGradient(value) {
    if (typeof value !== "string" || value.length > 300) return false;
    const match = GRADIENT.exec(value);
    if (!match || Number(match[1]) > 359) return false;
    const stops = [...match[2].matchAll(/rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), 1\) (\d{1,3})%/g)];
    let last = -1;
    for (const stop of stops) {
        const [r, g, b, position] = stop.slice(1).map(Number);
        if ([r, g, b].some((channel) => channel > 255) || position > 100 || position < last) return false;
        last = position;
    }
    return true;
}

function isStep(value, min, step) {
    const ratio = (value - min) / step;
    return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

/**
 * Valida um valor contra a definição de uma configuração.
 * @returns {string | null} mensagem de erro
 */
export function checkValue(definition, value, context) {
    const { schemes } = context;
    switch (definition.type) {
        case "range":
            if (typeof value !== "number" || !Number.isFinite(value)) return "range exige número";
            if (value < definition.min || value > definition.max) return `fora do intervalo ${definition.min}..${definition.max}`;
            if (!isStep(value, definition.min, definition.step ?? 1)) return `fora do passo ${definition.step}`;
            return null;
        case "select":
        case "radio":
            return definition.options.some((option) => option.value === value) ? null : `opção inválida (${definition.options.map((o) => o.value).join("|")})`;
        case "checkbox":
            return typeof value === "boolean" ? null : "checkbox exige booleano";
        case "text":
            return typeof value === "string" && value.length <= 500 && !/[\r\n<>]/.test(value) ? null : "texto inválido";
        case "inline_richtext":
            return typeof value === "string" && value.length <= 500 && !/[<>]/.test(value) ? null : "inline_richtext deve ser texto escapado";
        case "richtext":
            return typeof value === "string" && /^(?:<p>[^<>]{0,2000}<\/p>){1,4}$/.test(value) ? null : "richtext deve ser de 1 a 4 <p> com texto escapado";
        case "url":
            return value === "" || (typeof value === "string" && SAFE_URL.test(value)) ? null : "url não permitida";
        case "color_scheme":
            return schemes.has(value) ? null : `esquema de cor inexistente: ${value}`;
        case "link_list":
        case "collection":
            return typeof value === "string" && HANDLE.test(value) ? null : "handle inválido";
        case "font_picker":
            return typeof value === "string" && FONT_HANDLE.test(value) ? null : "handle de fonte inválido";
        case "image_picker":
            // Só a referência de um slot autorizado com upload verificado
            // (declarada no plano); qualquer outro valor é recusado.
            return typeof value === "string" && SHOPIFY_IMAGE_REFERENCE.test(value) && context.imageReferences?.has(value)
                ? null
                : "image_picker não é gravado sem upload confirmado e autorizado";
        case "color":
            return typeof value === "string" && HEX.test(value) ? null : "cor inválida";
        case "color_background":
            // Vazio, ou gradiente linear no formato do seletor da Shopify, com
            // cores opacas e posições 0..100% (nada de url(), var() ou CSS livre).
            return value === "" || isLinearGradient(value) ? null : "gradiente fora do formato aceito";
        default:
            return `tipo de configuração não suportado pelo gerador: ${definition.type}`;
    }
}

function checkSettings(definitions, settings, context, where, errors) {
    for (const [id, value] of Object.entries(settings ?? {})) {
        const definition = definitions.find((item) => item.id === id);
        if (!definition) {
            errors.push(`${where}: configuração inexistente no schema: ${id}`);
            continue;
        }
        const problem = checkValue(definition, value, context);
        if (problem) errors.push(`${where}.${id}: ${problem} (${JSON.stringify(value)})`);
    }
}

/**
 * Valida uma seção (configurações, blocos, limites) contra o schema.
 * @param {ThemeSchema} theme
 * @param {{ type: string, settings?: object, blocks?: object, block_order?: string[] }} section
 * @param {{ schemes: Set<string>, group?: "header" | "footer" | null }} context
 */
export function validateSection(theme, section, context, where = section.type) {
    const errors = [];
    const schema = theme.section(section.type);
    if (!schema) return [`${where}: seção inexistente no tema: ${section.type}`];

    const group = context.group ?? null;
    const enabled = schema.enabled_on;
    const disabled = schema.disabled_on;
    if (group === null && enabled && !enabled.templates?.includes("*") && !enabled.templates?.includes("index")) {
        errors.push(`${where}: seção não permitida em templates`);
    }
    if (group && enabled?.groups && !enabled.groups.includes(group) && !enabled.groups.includes("*")) {
        errors.push(`${where}: seção não permitida no grupo ${group}`);
    }
    if (group && disabled?.groups?.includes(group)) errors.push(`${where}: seção desativada no grupo ${group}`);
    if (group === null && disabled?.templates?.includes("index")) errors.push(`${where}: seção desativada na homepage`);

    checkSettings(schema.settings ?? [], section.settings, context, where, errors);

    const blocks = section.blocks ?? {};
    const order = section.block_order ?? [];
    const keys = Object.keys(blocks);
    if (keys.length !== order.length || !keys.every((key) => order.includes(key))) {
        errors.push(`${where}: block_order não corresponde aos blocos`);
    }
    if (keys.length > Math.min(schema.max_blocks ?? MAX_SECTION_BLOCKS, MAX_SECTION_BLOCKS)) {
        errors.push(`${where}: blocos acima do limite`);
    }
    const perType = new Map();
    for (const [key, block] of Object.entries(blocks)) {
        const definition = (schema.blocks ?? []).find((item) => item.type === block.type);
        if (!definition) {
            errors.push(`${where}.${key}: tipo de bloco inexistente: ${block.type}`);
            continue;
        }
        perType.set(block.type, (perType.get(block.type) ?? 0) + 1);
        if (definition.limit && perType.get(block.type) > definition.limit) {
            errors.push(`${where}.${key}: limite de blocos ${block.type} (${definition.limit}) excedido`);
        }
        checkSettings(definition.settings ?? [], block.settings, context, `${where}.${key}`, errors);
    }
    return errors;
}

/**
 * Template JSON (ou grupo de seções): estrutura, ordem e limites.
 */
export function validateTemplate(theme, template, context, where) {
    const errors = [];
    const keys = Object.keys(template.sections ?? {});
    if (keys.length > MAX_TEMPLATE_SECTIONS) errors.push(`${where}: mais de ${MAX_TEMPLATE_SECTIONS} seções`);
    const order = template.order ?? [];
    if (keys.length !== order.length || !keys.every((key) => order.includes(key))) {
        errors.push(`${where}: order não corresponde às seções`);
    }
    for (const key of keys) {
        if (!/^[a-z0-9_-]{1,64}$/.test(key)) errors.push(`${where}: chave de seção inválida ${key}`);
        errors.push(...validateSection(theme, template.sections[key], context, `${where}.${key}`));
    }
    return errors;
}

/**
 * Estrutura de config/settings_data.json segundo as regras da Shopify:
 *  - `current` é o nome de um preset existente ou um objeto de configurações;
 *  - todos os presets (e `current`, se for objeto) têm os MESMOS IDs de
 *    esquema de cor (a Shopify rejeita o arquivo caso contrário);
 *  - toda configuração do tipo color_scheme aponta para um esquema existente
 *    no próprio preset.
 * @returns {string[]} erros
 */
export function validateSettingsData(theme, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return ["settings_data: estrutura inválida"];
    const errors = [];
    const presets = data.presets && typeof data.presets === "object" ? data.presets : {};
    const groups = Object.entries(presets).map(([name, settings]) => [`preset "${name}"`, settings]);

    if (typeof data.current === "string") {
        if (!Object.hasOwn(presets, data.current)) errors.push(`settings_data: current aponta para preset inexistente "${data.current}"`);
    } else if (data.current && typeof data.current === "object" && !Array.isArray(data.current)) {
        groups.push(["current", data.current]);
    } else {
        errors.push("settings_data: current ausente ou inválido");
    }
    if (!groups.length) errors.push("settings_data: nenhum conjunto de configurações");

    let reference = null;
    for (const [label, settings] of groups) {
        const ids = Object.keys(settings?.color_schemes ?? {}).sort();
        if (!ids.length) errors.push(`settings_data: ${label} sem esquemas de cor`);
        if (!reference) {
            reference = { label, ids };
        } else if (JSON.stringify(ids) !== JSON.stringify(reference.ids)) {
            const missing = reference.ids.filter((id) => !ids.includes(id));
            const extra = ids.filter((id) => !reference.ids.includes(id));
            errors.push(
                `settings_data: ${label} precisa conter os mesmos IDs de esquema de cor que ${reference.label}` +
                    `${missing.length ? ` (faltam: ${missing.join(", ")})` : ""}${extra.length ? ` (sobram: ${extra.join(", ")})` : ""}`
            );
        }
        for (const [id, value] of Object.entries(settings ?? {})) {
            if (theme.settings.get(id)?.type === "color_scheme" && !ids.includes(value)) {
                errors.push(`settings_data: ${label}.${id} aponta para esquema inexistente "${value}"`);
            }
        }
    }
    return errors;
}

/**
 * Configurações globais (settings_data) contra settings_schema.
 */
export function validateGlobalSettings(theme, settings, colorSchemes) {
    const errors = [];
    const context = { schemes: new Set(Object.keys(colorSchemes)) };
    const groupDefinition = theme.settings.get("color_schemes");
    for (const [id, value] of Object.entries(settings)) {
        if (id === "color_schemes") continue;
        const definition = theme.settings.get(id);
        if (!definition) {
            errors.push(`settings.${id}: inexistente no settings_schema`);
            continue;
        }
        const problem = checkValue(definition, value, context);
        if (problem) errors.push(`settings.${id}: ${problem} (${JSON.stringify(value)})`);
    }
    for (const [schemeId, scheme] of Object.entries(colorSchemes)) {
        if (!/^[a-z0-9-]{1,32}$/.test(schemeId)) errors.push(`color_schemes: id inválido ${schemeId}`);
        const fields = groupDefinition.definition.map((field) => field.id);
        const given = Object.keys(scheme.settings ?? {});
        for (const field of fields) if (!given.includes(field)) errors.push(`color_schemes.${schemeId}: falta ${field}`);
        for (const field of given) {
            const definition = groupDefinition.definition.find((item) => item.id === field);
            if (!definition) {
                errors.push(`color_schemes.${schemeId}: campo inexistente ${field}`);
                continue;
            }
            const problem = checkValue(definition, scheme.settings[field], context);
            if (problem) errors.push(`color_schemes.${schemeId}.${field}: ${problem}`);
        }
    }
    return errors;
}

export { HANDLE, SAFE_URL, isLinearGradient };
