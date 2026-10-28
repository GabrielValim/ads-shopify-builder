/**
 * Resumo de terminal de uma análise. Devolve o código de saída.
 * @param {Awaited<ReturnType<typeof import("./analyze.mjs").analyzeCapture>>} result
 */
export function printAnalysisResult(result) {
    if (!result.ok) {
        console.error(`[FALHA] ${result.error.code}: ${result.error.message}`);
        if (result.error.details?.issues) {
            for (const issue of result.error.details.issues) console.error(`  - ${issue}`);
        }
        console.error(result.run ? `Análise registrada como "failed": ${result.run.dir}` : "Nenhuma análise criada.");
        return 1;
    }

    const { blueprint, run } = result;
    console.log(`[OK] Blueprint gerado: ${blueprint.stats.recognized}/${blueprint.stats.sections} seções reconhecidas, ${blueprint.stats.unknown} desconhecidas`);
    console.log(`Análise: ${run.dir}`);
    for (const artifact of run.getManifest().artifacts) {
        console.log(`  ${artifact.path.padEnd(22)} ${String(artifact.bytes).padStart(8)} bytes  sha256 ${artifact.sha256.slice(0, 16)}…`);
    }

    console.log("\nSeções (ordem da página):");
    for (const section of blueprint.sections) {
        const d = section.viewports.desktop;
        const m = section.viewports.mobile;
        const dims = (p) => (p ? `${p.box.width}x${p.box.height}${p.columns > 1 ? ` ${p.columns}col` : ""}` : "-");
        const hint = section.hints.length ? ` (hipótese: ${section.hints.map((h) => h.type).join(", ")})` : "";
        console.log(
            `  ${section.id}  ${section.type.padEnd(16)} conf ${section.type === "unknown" ? " -  " : section.confidence.toFixed(2)}  desktop ${dims(d).padEnd(16)} mobile ${dims(m)}${hint}`
        );
    }

    const roles = blueprint.tokens.colors.roles;
    const typo = blueprint.tokens.typography;
    const layout = blueprint.tokens.layout;
    console.log("\nTokens:");
    console.log(`  cores: fundo ${roles.background ?? "?"} · texto ${roles.text ?? "?"} · primária ${roles.primary ?? "?"} · superfície ${roles.surface ?? "?"} · inversa ${roles.inverseBackground ?? "?"}`);
    console.log(`  tipografia: títulos ${typo.heading?.family ?? "?"} · corpo ${typo.body?.family ?? "?"} ${typo.body?.sizePx.desktop ?? "?"}px`);
    console.log(`  layout: contêiner ${layout.desktop?.containerWidthPx ?? "fluido"}px · margem ${layout.desktop?.gutterPx ?? "?"}/${layout.mobile?.gutterPx ?? "?"}px · seção ${layout.desktop?.sectionPaddingPx ?? "?"}px`);
    console.log(`  esquemas de cor: ${blueprint.tokens.colorSchemes.length} · variantes de botão: ${blueprint.tokens.buttons.length}`);

    if (blueprint.unknowns.length) {
        console.log("\nSem evidência suficiente:");
        for (const item of blueprint.unknowns) console.log(`  [?] ${item.scope} (${item.reason})`);
    }
    return 0;
}
