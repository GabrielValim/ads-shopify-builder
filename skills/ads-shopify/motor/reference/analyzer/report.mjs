/**
 * Relatório HTML de inspeção do blueprint.
 *
 * Segurança: o documento não tem scripts; a CSP proíbe scripts, recursos
 * externos, formulários e <base>. Todo valor interpolado passa por
 * `escapeHtml`; cores só entram em atributos `style` se forem #rrggbb.
 * Nenhum pixel ou texto da referência é incluído: o wireframe é desenhado
 * a partir das medidas do blueprint.
 */

const HEX = /^#[0-9a-f]{6}$/;

export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/`/g, "&#96;");
}

const safeColor = (value) => (typeof value === "string" && HEX.test(value) ? value : null);
const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "—");
const text = (value) => (value === null || value === undefined ? "—" : escapeHtml(value));

const TYPE_COLORS = {
    "announcement-bar": "#8e7cc3",
    header: "#6fa8dc",
    hero: "#e69138",
    "product-grid": "#6aa84f",
    "rich-text": "#c27ba0",
    footer: "#999999",
    unknown: "#cc0000",
};

function swatch(hex) {
    const color = safeColor(hex);
    if (!color) return `<span class="muted">—</span>`;
    return `<span class="swatch" style="background:${color}"></span><code>${color}</code>`;
}

function wireframe(blueprint, viewport, targetWidth) {
    const source = blueprint.source.viewports[viewport];
    const scale = targetWidth / source.width;
    const height = Math.max(1, Math.round(source.pageHeight * scale));
    const rects = blueprint.sections
        .filter((section) => section.viewports[viewport])
        .map((section) => {
            const box = section.viewports[viewport].box;
            const color = TYPE_COLORS[section.type] ?? TYPE_COLORS.unknown;
            const y = Math.round(box.y * scale);
            const h = Math.max(2, Math.round(box.height * scale));
            const label = `${section.id.replace("section-", "#")} ${section.type}`;
            return `<g><rect x="0" y="${y}" width="${targetWidth}" height="${h}" fill="${color}" fill-opacity="0.28" stroke="${color}"/>` +
                (h >= 12 ? `<text x="4" y="${y + Math.min(h - 3, 13)}" font-size="10">${escapeHtml(label)}</text>` : "") +
                `</g>`;
        })
        .join("");
    return `<svg width="${targetWidth}" height="${height}" viewBox="0 0 ${targetWidth} ${height}" role="img" aria-label="${escapeHtml(viewport)}"><rect width="100%" height="100%" fill="#fff" stroke="#ccc"/>${rects}</svg>`;
}

function sectionRows(blueprint) {
    return blueprint.sections
        .map((section) => {
            const d = section.viewports.desktop;
            const m = section.viewports.mobile;
            const dims = (p) => (p ? `${num(p.box.width)}×${num(p.box.height)} @ y=${num(p.box.y)}${p.columns > 1 ? ` · ${num(p.columns)} col` : ""}` : "—");
            const signals = [...new Set([...(d?.classification.signals ?? []), ...(m?.classification.signals ?? [])])];
            const hints = section.hints.map((hint) => hint.type);
            const color = TYPE_COLORS[section.type] ?? TYPE_COLORS.unknown;
            return `<tr class="${section.type === "unknown" ? "unknown" : ""}">
<td>${text(section.id)}</td>
<td><span class="tag" style="border-color:${color}">${text(section.type)}</span>${section.unknownReason ? `<div class="muted">${text(section.unknownReason)}</div>` : ""}</td>
<td>${section.type === "unknown" ? "—" : num(section.confidence)}<div class="muted">${text(section.agreement)}</div></td>
<td>${dims(d)}</td><td>${dims(m)}</td>
<td>${signals.map((s) => `<code>${text(s)}</code>`).join(" ") || "—"}</td>
<td>${hints.map((h) => `<code>${text(h)}</code>`).join(" ") || "—"}</td>
<td>${text(section.colorScheme)}</td>
</tr>`;
        })
        .join("\n");
}

function detailsBlock(blueprint) {
    return blueprint.sections
        .map((section) => {
            const images = [...(section.viewports.desktop?.images ?? [])]
                .map((image) => `${text(image.role)}/${text(image.kind)} ${num(image.aspectRatio)}:1 em (${num(image.position.x)}, ${num(image.position.y)})`)
                .join("; ");
            return `<details><summary>${text(section.id)} · ${text(section.type)}</summary>
<pre>${escapeHtml(JSON.stringify({ details: section.details, content: section.content }, null, 2))}</pre>
<p class="muted">Imagens (desktop): ${images || "nenhuma"}</p></details>`;
        })
        .join("\n");
}

/**
 * @param {import("../blueprint/schema.mjs").StoreBlueprint} blueprint
 * @param {object} meta Metadados de validação (checks, avisos, hashes).
 */
export function renderReport(blueprint, meta) {
    const roles = blueprint.tokens.colors.roles;
    const typography = blueprint.tokens.typography;

    const roleRows = Object.entries(roles)
        .map(([role, value]) => `<tr><td>${text(role)}</td><td>${swatch(value)}</td></tr>`)
        .join("");
    const schemeRows = blueprint.tokens.colorSchemes
        .map(
            (scheme) => `<tr><td>${text(scheme.id)}</td><td>${swatch(scheme.background)} ${scheme.backgroundMedia !== "none" ? `<span class="muted">(${text(scheme.backgroundMedia)})</span>` : ""}</td><td>${swatch(scheme.text)}</td><td>${swatch(scheme.button)}</td><td>${swatch(scheme.buttonLabel)}</td><td>${scheme.sections.map(text).join(", ")}</td></tr>`
        )
        .join("");
    const scaleRows = typography.scale
        .map((level) => `<tr><td>h${num(level.level)}</td><td>${num(level.desktopPx)}</td><td>${num(level.mobilePx)}</td><td>${num(level.weight)}</td><td>${num(level.lineHeight)}</td></tr>`)
        .join("");
    const buttonRows = blueprint.tokens.buttons
        .map((button) => `<tr><td>${text(button.style)}</td><td>${num(button.radiusPx)}</td><td>${num(button.paddingX)}×${num(button.paddingY)}</td><td>${num(button.heightPx)}</td><td>${num(button.fontWeight)}</td><td>${button.colors.map((c) => `${swatch(c.background)} / ${swatch(c.text)}`).join("<br>")}</td></tr>`)
        .join("");
    const changeRows = blueprint.responsive.changes
        .map((change) => `<tr><td>${text(change.sectionId)}</td><td>${text(change.property)}</td><td>${text(change.desktop)}</td><td>${text(change.mobile)}</td></tr>`)
        .join("");
    const unknownRows = blueprint.unknowns.map((item) => `<li><code>${text(item.scope)}</code> — ${text(item.reason)}</li>`).join("");
    const checkRows = (meta.checks ?? [])
        .map((item) => `<li class="${item.ok ? "ok" : "warn"}">${item.ok ? "✓" : "!"} <code>${text(item.id)}</code>${item.detail ? ` — ${text(item.detail)}` : ""}</li>`)
        .join("");
    const inputRows = blueprint.source.inputs.map((input) => `<li><code>${text(input.path)}</code> <code class="muted">${text(input.sha256)}</code></li>`).join("");
    const layout = blueprint.tokens.layout;
    const font = (role) => (role ? `${text(role.family)} <span class="muted">(${role.fallbacks.map(text).join(", ") || "—"}; ${text(role.generic)}) pesos ${role.weights.map(num).join(", ")}</span>` : "—");

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise da referência</title>
<style>
:root { color-scheme: light; --ink:#1f2328; --muted:#656d76; --line:#d0d7de; --bg:#fff; }
body { margin:0; padding:24px 16px; font:14px/1.5 system-ui, sans-serif; color:var(--ink); background:var(--bg); }
main { max-width:1200px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
table { border-collapse:collapse; width:100%; margin:8px 0; } td, th { border:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; }
th { background:#f6f8fa; } tr.unknown td { background:#fff5f5; }
.muted { color:var(--muted); font-size:12px; } code { font-size:12px; background:#f6f8fa; padding:0 3px; border-radius:3px; word-break:break-all; }
.swatch { display:inline-block; width:14px; height:14px; border:1px solid var(--line); vertical-align:middle; margin-right:4px; }
.tag { border:2px solid; border-radius:10px; padding:0 8px; font-weight:600; }
.frames { display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap; } .frames figure { margin:0; }
.ok { color:#1a7f37; } .warn { color:#9a6700; } pre { background:#f6f8fa; padding:8px; overflow:auto; font-size:12px; }
.scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
<h1>Análise da referência</h1>
<p class="muted">StoreBlueprint v${num(blueprint.schemaVersion)} · modo ${text(blueprint.contentMode)} · ${text(blueprint.analyzer.providers.join(", "))} ${text(blueprint.analyzer.version)} · captura ${text(blueprint.source.captureRunId)}</p>
<p><strong>${num(blueprint.stats.recognized)}</strong> de ${num(blueprint.stats.sections)} seções reconhecidas · <strong>${num(blueprint.stats.unknown)}</strong> desconhecidas · ${num(blueprint.unknowns.length)} itens sem evidência suficiente.</p>

<h2>Seções</h2>
<div class="frames">
<figure>${wireframe(blueprint, "desktop", 300)}<figcaption class="muted">desktop</figcaption></figure>
<figure>${wireframe(blueprint, "mobile", 120)}<figcaption class="muted">mobile</figcaption></figure>
<div class="scroll" style="flex:1; min-width:320px">
<table><thead><tr><th>id</th><th>tipo</th><th>confiança</th><th>desktop</th><th>mobile</th><th>evidências</th><th>hipóteses</th><th>esquema</th></tr></thead>
<tbody>${sectionRows(blueprint)}</tbody></table>
</div>
</div>
${detailsBlock(blueprint)}

<h2>Cores</h2>
<table><thead><tr><th>papel</th><th>cor</th></tr></thead><tbody>${roleRows}</tbody></table>
<div class="scroll"><table><thead><tr><th>esquema</th><th>fundo</th><th>texto</th><th>botão</th><th>rótulo</th><th>seções</th></tr></thead><tbody>${schemeRows}</tbody></table></div>

<h2>Tipografia</h2>
<p>Títulos: ${font(typography.heading)}<br>Corpo: ${font(typography.body)} ${typography.body ? `<span class="muted">· ${num(typography.body.sizePx.desktop)}px / ${num(typography.body.sizePx.mobile)}px · altura de linha ${num(typography.body.lineHeight)}</span>` : ""}</p>
<table><thead><tr><th>nível</th><th>desktop px</th><th>mobile px</th><th>peso</th><th>altura de linha</th></tr></thead><tbody>${scaleRows}</tbody></table>

<h2>Layout, botões e cards</h2>
<p>Contêiner desktop: ${num(layout.desktop?.containerWidthPx)}px (margem ${num(layout.desktop?.gutterPx)}px) · mobile: ${layout.mobile?.containerWidthPx === null ? "fluido" : num(layout.mobile?.containerWidthPx) + "px"} (margem ${num(layout.mobile?.gutterPx)}px) · espaçamento de seção ${num(layout.desktop?.sectionPaddingPx)}px</p>
<div class="scroll"><table><thead><tr><th>botão</th><th>raio</th><th>padding</th><th>altura</th><th>peso</th><th>cores (fundo / texto)</th></tr></thead><tbody>${buttonRows}</tbody></table></div>
<pre>${escapeHtml(JSON.stringify({ productCard: blueprint.tokens.productCard, input: blueprint.tokens.input }, null, 2))}</pre>

<h2>Responsivo</h2>
<table><thead><tr><th>seção</th><th>propriedade</th><th>desktop</th><th>mobile</th></tr></thead><tbody>${changeRows || '<tr><td colspan="4">—</td></tr>'}</tbody></table>

<h2>Desconhecido / sem evidência</h2>
<ul>${unknownRows || "<li>—</li>"}</ul>

<h2>Validação das entradas</h2>
<ul>${checkRows}</ul>
<ul>${inputRows}</ul>
<p class="muted">Blueprint SHA-256: <code>${text(meta.blueprintSha256)}</code></p>
</main>
</body>
</html>
`;
}
