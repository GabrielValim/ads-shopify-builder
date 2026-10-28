/**
 * Relatório de conversão (HTML sem scripts, CSP restritiva, tudo escapado).
 */

import { escapeHtml } from "../analyzer/report.mjs";

const text = (value) => (value === null || value === undefined ? "—" : escapeHtml(typeof value === "string" ? value : JSON.stringify(value)));
const list = (items, render) => (items?.length ? `<ul>${items.map((item) => `<li>${render(item)}</li>`).join("")}</ul>` : `<span class="muted">—</span>`);
const HEX = /^#[0-9A-Fa-f]{6}$/;
const swatch = (hex) => (HEX.test(hex ?? "") ? `<span class="swatch" style="background:${hex}"></span><code>${escapeHtml(hex)}</code>` : "—");

function sectionBlock(record) {
    const target = record.target ? `${text(record.target.type)} <span class="muted">${text(record.target.file)} → ${text(record.target.key)}</span>` : "—";
    const status = record.status === "generated" ? `<span class="ok">gerada</span>` : `<span class="warn">não suportada</span>`;
    return `<section class="card">
<h3>${text(record.blueprintSectionId)} · ${text(record.blueprintType)} → ${target}</h3>
<p>${status} · confiança ${text(record.confidence)} · posição ${text(record.position)}${record.content ? ` · conteúdo: ${text(record.content)}` : ""}</p>
${record.reason ? `<p class="warn">${text(record.reason)}${record.hints?.length ? ` · hipóteses: ${record.hints.map(text).join(", ")}` : ""}</p>` : ""}
${record.applied ? `<details open><summary>Configurações aplicadas (${record.applied.length})</summary><table><thead><tr><th>configuração</th><th>valor</th><th>origem</th><th>nota</th></tr></thead><tbody>${record.applied.map((item) => `<tr><td><code>${text(item.setting)}</code></td><td>${text(item.value)}</td><td><code>${text(item.from)}</code></td><td>${text(item.note)}</td></tr>`).join("")}</tbody></table></details>` : ""}
${record.adaptations ? `<p><strong>Adaptações</strong></p>${list(record.adaptations, text)}` : ""}
${record.ignored ? `<p><strong>Ignorados</strong></p>${list(record.ignored, (item) => `<code>${text(item.field)}</code>: ${text(item.reason)}`)}` : ""}
${record.dependencies ? `<p><strong>Dependências</strong></p>${list(record.dependencies, (item) => `${text(item.kind)}: ${text(item.detail)}`)}` : ""}
${record.fidelity ? `<p><strong>Limitações de fidelidade</strong></p>${list(record.fidelity, (item) => `${text(item.aspect)}: esperado ${text(item.expected)} · obtido ${text(item.achieved)}${item.note ? ` · ${text(item.note)}` : ""}`)}` : ""}
</section>`;
}

export function renderGenerationReport(plan, meta) {
    const settings = plan.files["config/settings_data.json"];
    const schemes = settings.presets[settings.current].color_schemes;
    const schemeRows = Object.entries(schemes)
        .map(([id, scheme]) => `<tr><td>${text(id)}</td>${["background", "text", "button", "button_label", "secondary_button_label"].map((field) => `<td>${swatch(scheme.settings[field])}</td>`).join("")}</tr>`)
        .join("");
    const check = meta.themeCheck;
    const checkBlock = check?.status === "ok"
        ? `<p>Baseline (Dawn base): <strong>${text(check.comparison.baseline)}</strong> ofensas · tema gerado: <strong>${text(check.comparison.generated)}</strong> · novas: <strong class="${check.comparison.newOffenses.length ? "warn" : "ok"}">${text(check.comparison.newOffenses.length)}</strong></p>${list(check.generated, (o) => `${text(o.severity)} <code>${text(o.check)}</code> ${text(o.path)} — ${text(o.message)}`)}`
        : `<p class="warn">Theme Check: ${text(check?.status ?? "não executado")} ${text(check?.reason)}</p>`;

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de geração</title>
<style>
body { margin:0; padding:24px 16px; font:14px/1.5 system-ui, sans-serif; color:#1f2328; background:#fff; }
main { max-width:1100px; margin:0 auto; } h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 8px; border-bottom:1px solid #d0d7de; }
h3 { font-size:15px; margin:0 0 6px; } table { border-collapse:collapse; width:100%; margin:6px 0; } td, th { border:1px solid #d0d7de; padding:3px 6px; text-align:left; vertical-align:top; font-size:13px; }
th { background:#f6f8fa; } code { font-size:12px; background:#f6f8fa; padding:0 3px; word-break:break-all; } .muted { color:#656d76; font-size:12px; }
.card { border:1px solid #d0d7de; border-radius:8px; padding:12px; margin:12px 0; } .ok { color:#1a7f37; } .warn { color:#9a6700; }
.swatch { display:inline-block; width:14px; height:14px; border:1px solid #d0d7de; vertical-align:middle; margin-right:4px; } .scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
<h1>Relatório de geração</h1>
<p class="muted">Gerador ${text(plan.generator.version)} · alvo ${text(plan.generator.target)} · preset ${text(plan.generator.preset)} · análise ${text(plan.provenance.analysisRunId)} · blueprint <code>${text(plan.provenance.blueprintSha256)}</code></p>
<p><strong>${text(plan.stats.generated)}</strong> de ${text(plan.stats.sections)} seções geradas · <strong>${text(plan.stats.unsupported)}</strong> não suportadas · ${text(plan.dependencies.length)} dependências · conteúdo: ${text(plan.content.id ?? "placeholders")}${plan.content.authorization ? ` (${text(plan.content.authorization.basis)}: ${text(plan.content.authorization.owner)})` : ""}</p>

<h2>Dawn base</h2>
<p>commit <code>${text(meta.dawn.commit)}</code> · tree <code>${text(meta.dawn.tree)}</code> · versão ${text(meta.dawn.themeVersion)} · ${text(meta.dawn.files)} arquivos, ${text(meta.dawn.hashVerified)} conferidos por SHA-256 com o lockfile</p>

<h2>Escalas e configurações globais</h2>
<p>body_scale ${text(plan.scales.bodyScale)} (corpo ${text(plan.scales.achieved.bodyPx.desktop)}/${text(plan.scales.achieved.bodyPx.mobile)}px; alvo ${text(plan.scales.targets.bodyPx.desktop)}/${text(plan.scales.targets.bodyPx.mobile)}px) · page_width ${text(plan.scales.pageWidth)} (≈ ${text(plan.scales.achieved.containerPx)}px; alvo ${text(plan.scales.targets.containerPx)}px) · heading_scale ${text(plan.scales.headingScale)}</p>
<div class="scroll"><table><thead><tr><th>configuração</th><th>valor</th><th>origem</th><th>nota</th></tr></thead><tbody>${plan.global.applied.map((item) => `<tr><td><code>${text(item.setting)}</code></td><td>${text(item.value)}</td><td><code>${text(item.from)}</code></td><td>${text(item.note)}</td></tr>`).join("")}</tbody></table></div>
${list(plan.global.notes, text)}
<div class="scroll"><table><thead><tr><th>esquema</th><th>fundo</th><th>texto</th><th>botão</th><th>rótulo</th><th>botão secundário</th></tr></thead><tbody>${schemeRows}</tbody></table></div>

<h2>Seções</h2>
${plan.sections.map(sectionBlock).join("\n")}

<h2>Dependências não resolvidas</h2>
${list(plan.dependencies, (item) => `<code>${text(item.section ?? "global")}</code> ${text(item.kind)}: ${text(item.detail)}`)}

<h2>Limitações de fidelidade</h2>
${list(plan.fidelity, (item) => `${item.section ? `<code>${text(item.section)}</code> ` : ""}${text(item.aspect)}: esperado ${text(item.expected)} · obtido ${text(item.achieved)}${item.note ? ` · ${text(item.note)}` : ""}`)}

<h2>Theme Check</h2>
${checkBlock}
</main>
</body>
</html>
`;
}

export function printGeneration(result) {
    if (!result.ok) {
        console.error(`[FALHA] ${result.error.code}: ${result.error.message}`);
        for (const issue of result.error.details?.issues ?? result.error.details?.errors ?? []) console.error(`  - ${issue}`);
        return 1;
    }
    const { plan } = result;
    console.log(`Dawn base: commit ${result.dawn.commit.slice(0, 12)} · ${result.dawn.hashVerified}/${result.dawn.files} arquivos conferidos com o lockfile`);
    console.log(`Conteúdo: ${plan.content.id ?? "placeholders neutros"}${plan.content.authorization ? ` (${plan.content.authorization.basis})` : ""}`);
    console.log(`Loja de destino: ${plan.provenance?.targetStore ?? "não informada (imagens da Shopify ficam como placeholder)"}`);
    console.log(`Escalas: body_scale ${plan.scales.bodyScale} · page_width ${plan.scales.pageWidth} · heading_scale ${plan.scales.headingScale}`);
    console.log("\nSeções:");
    for (const record of plan.sections) {
        const target = record.target ? `${record.target.type} (${record.target.file} → ${record.target.key})` : `NÃO SUPORTADA: ${record.reason}`;
        console.log(`  ${record.blueprintSectionId}  ${record.blueprintType.padEnd(16)} → ${target}`);
    }
    console.log(`\nConfigurações globais: ${plan.global.applied.length} · esquemas de cor: ${plan.global.colorSchemes.length}`);
    console.log(`Validação contra os schemas do Dawn: OK`);
    console.log("\nDependências não resolvidas:");
    for (const dependency of plan.dependencies) console.log(`  [!] ${dependency.section ?? "global"} ${dependency.kind}: ${dependency.detail}`);
    console.log(`\nLimitações de fidelidade: ${plan.fidelity.length} (detalhes no relatório)`);

    if (result.mode === "simulation") {
        console.log("\nSIMULAÇÃO: nenhum arquivo gravado. Use --apply para gerar o tema em runs/generated/.");
        return 0;
    }
    console.log(`\n[OK] Tema gerado: ${result.themeDir}`);
    console.log(`Execução: ${result.run.dir}`);
    const check = result.themeCheck;
    if (check.status === "ok") {
        console.log(`Theme Check: ${check.comparison.generated} ofensas (baseline ${check.comparison.baseline}) · novas: ${check.comparison.newOffenses.length}`);
        for (const offense of check.comparison.newOffenses) console.log(`  [NOVA] ${offense.severity} ${offense.check} ${offense.path}: ${offense.message}`);
    } else {
        console.log(`Theme Check: ${check.status} (${check.reason})`);
    }
    return check.status === "ok" && check.comparison.newOffenses.length ? 1 : 0;
}
