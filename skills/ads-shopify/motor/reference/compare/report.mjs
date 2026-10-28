/**
 * Relatório HTML da comparação visual. Sem scripts; imagens embutidas
 * como data: (somente os PNGs gerados pela própria comparação).
 */

import { escapeHtml } from "../analyzer/report.mjs";

const text = (value) => (value === null || value === undefined ? "—" : escapeHtml(typeof value === "string" ? value : JSON.stringify(value)));
const pct = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 1000) / 10}%`);
const img = (images, name, alt) => (images[name] ? `<img alt="${escapeHtml(alt)}" src="data:image/png;base64,${images[name].toString("base64")}">` : `<p class="muted">sem imagem</p>`);
const CAT_CLASS = { "dawn-limitation": "dawn", "blueprint-gap": "gap", "not-implemented": "todo", "conversion-issue": "bug" };

function sectionTable(viewport) {
    return `<div class="scroll"><table><thead><tr><th>seção</th><th>tipo → Shopify</th><th>status</th><th>altura ref → cand</th><th>estrutura</th><th>cor</th><th>geometria</th><th>efeito imagem</th><th>cor dominante (ΔE)</th><th>pontuação</th></tr></thead><tbody>${viewport.sections
        .map(
            (s) => `<tr><td>${text(s.blueprintSectionId)}</td><td>${text(s.blueprintType)} → ${text(s.shopifyType)}</td><td>${text(s.status)}</td>
<td>${s.candidate ? `${text(s.reference.height)} → ${text(s.candidate.height)} (${s.geometry.heightDelta >= 0 ? "+" : ""}${text(s.geometry.heightDelta)})` : text(s.reference?.height)}</td>
<td>${text(s.pixels?.masked?.structure ?? s.pixels?.full?.structure)}</td><td>${text(s.pixels?.masked?.color ?? s.pixels?.full?.color)}</td><td>${text(s.geometry?.score)}</td>
<td>${text(s.pixels?.imageEffect)}</td><td>${s.dominantColor ? `${text(s.dominantColor.reference)} → ${text(s.dominantColor.candidate)} (${text(s.dominantColor.deltaE)})` : "—"}</td><td><strong>${text(s.score)}</strong></td></tr>`
        )
        .join("")}</tbody></table></div>`;
}

export function renderComparisonReport(result, images) {
    const findingsRows = result.findings
        .map((f) => `<tr class="${CAT_CLASS[f.category] ?? ""}"><td>${text(f.section)}</td><td>${text(f.viewport)}</td><td>${text(f.aspect)}</td><td>${text(f.expected)}</td><td>${text(f.measured)}</td><td>${text(result.method.categories[f.category] ?? f.category)}</td><td>${text(f.explanation)}</td></tr>`)
        .join("");
    const declaredRows = result.declared
        .map((d) => `<tr class="${CAT_CLASS[d.category] ?? ""}"><td>${text(d.section ?? "global")}</td><td>${text(d.aspect)}</td><td>${text(result.method.categories[d.category] ?? d.category)}</td><td>${text(d.explanation)}</td></tr>`)
        .join("");
    const recRows = result.recommendations
        .map((r) => `<tr><td>${text(r.priority)}</td><td>${text(r.text)}</td><td>${text(result.method.categories[r.category] ?? r.category)}</td><td>${text(r.impact)}</td><td>${r.sections.map(text).join(", ")}</td></tr>`)
        .join("");
    const historyRows = result.history.length
        ? result.history.map((h) => `<tr><td>${text(h.runId)}</td><td>${text(h.candidate)}</td><td>${text(h.generation)}</td><td>${text(h.scores?.desktop)}</td><td>${text(h.scores?.mobile)}</td><td>${text(h.scores?.overall)}</td></tr>`).join("")
        : `<tr><td colspan="6">primeira comparação</td></tr>`;

    const block = (name) => {
        const v = result.viewports[name];
        return `<h2>${name === "desktop" ? "Desktop 1440×900" : "Mobile 390×844"}</h2>
<p>Pontuação <strong>${text(v.score)}</strong> · cobertura ${pct(v.coverage)} da altura da referência · ordem das seções ${v.orderPreserved ? "preservada" : "<strong>alterada</strong>"} · altura da página ${text(v.reference.pageHeight)} → ${text(v.candidate.pageHeight)}px · diferença de pixels (alinhada ao topo, informativa) ${pct(v.pageDiff.changedRatio)}</p>
${v.extras.length ? `<p class="muted">Seções extras no tema renderizado: ${v.extras.map((e) => `${text(e.id)} (${text(e.height)}px)`).join(", ")}</p>` : ""}
${sectionTable(v)}
<div class="frames">
<figure>${img(images, `sidebyside-${name}.png`, `lado a lado ${name}`)}<figcaption>Referência (esquerda) × tema gerado na Shopify (direita)</figcaption></figure>
<figure>${img(images, `diff-${name}.png`, `diferenças ${name}`)}<figcaption>Diferenças pixel a pixel alinhadas ao topo (vermelho = diferente)</figcaption></figure>
</div>
<figure>${img(images, `sections-${name}.png`, `seções ${name}`)}<figcaption>Por seção: referência · tema gerado · diferença (tema redimensionado à referência)</figcaption></figure>`;
    };

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Validação visual</title>
<style>
body { margin:0; padding:24px 16px; font:14px/1.5 system-ui, sans-serif; color:#1f2328; background:#fff; }
main { max-width:1500px; margin:0 auto; } h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 8px; border-bottom:1px solid #d0d7de; }
table { border-collapse:collapse; width:100%; margin:6px 0; } td, th { border:1px solid #d0d7de; padding:3px 6px; text-align:left; vertical-align:top; font-size:13px; }
th { background:#f6f8fa; } .muted { color:#656d76; font-size:12px; } .scroll { overflow-x:auto; }
img { max-width:100%; height:auto; border:1px solid #d0d7de; } figure { margin:12px 0; } figcaption { color:#656d76; font-size:12px; }
.frames { display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start; } .frames figure { flex:1 1 420px; }
tr.dawn td:nth-child(6), tr.dawn td:nth-child(3) { color:#6f42c1; } tr.gap td { color:#0969da; } tr.todo td { color:#9a6700; } tr.bug td { color:#cf222e; font-weight:600; }
code { font-size:12px; background:#f6f8fa; padding:0 3px; }
</style>
</head>
<body>
<main>
<h1>Validação visual</h1>
<p class="muted">Comparador ${text(result.comparator)} · referência ${text(result.reference.runId)} · tema renderizado ${text(result.candidate.runId)} (${text(result.candidate.url)}) · geração ${text(result.generation.runId)} · blueprint <code>${text(result.analysis.blueprintSha256)}</code></p>
<p>Pontuação: desktop <strong>${text(result.scores.desktop)}</strong> · mobile <strong>${text(result.scores.mobile)}</strong> · média <strong>${text(result.scores.overall)}</strong> — cobertura ${pct(result.scores.coverage.desktop)} (desktop) / ${pct(result.scores.coverage.mobile)} (mobile).</p>
<p class="muted"><strong>Como foi calculada:</strong> ${text(result.method.formula)}. <strong>Fora da pontuação:</strong> ${result.method.excluded.map(text).join("; ")}.</p>

<h2>Recomendações priorizadas</h2>
<table><thead><tr><th>#</th><th>recomendação</th><th>categoria</th><th>impacto estimado</th><th>seções</th></tr></thead><tbody>${recRows}</tbody></table>

${block("desktop")}
${block("mobile")}

<h2>Diferenças medidas</h2>
<div class="scroll"><table><thead><tr><th>seção</th><th>viewport</th><th>aspecto</th><th>referência</th><th>tema gerado</th><th>categoria</th><th>explicação</th></tr></thead><tbody>${findingsRows || '<tr><td colspan="7">nenhuma acima das tolerâncias</td></tr>'}</tbody></table></div>

<h2>Limitações declaradas na geração (não medidas)</h2>
<div class="scroll"><table><thead><tr><th>seção</th><th>aspecto</th><th>categoria</th><th>detalhe</th></tr></thead><tbody>${declaredRows}</tbody></table></div>

<h2>Histórico de comparações</h2>
<table><thead><tr><th>comparação</th><th>captura do tema</th><th>geração</th><th>desktop</th><th>mobile</th><th>média</th></tr></thead><tbody>${historyRows}</tbody></table>
</main>
</body>
</html>
`;
}
