/**
 * Saída de terminal de uma captura. Devolve o código de saída.
 * @param {import("./capture.mjs").CaptureResult} result
 */
export function printCaptureResult(result) {
    if (!result.ok) {
        console.error(`[FALHA] ${result.error.code}: ${result.error.message}`);
        if (result.run) {
            console.error(`Execução registrada como "failed": ${result.run.dir}/manifest.json`);
        } else {
            console.error("Nenhuma execução criada (recusa antes da captura).");
        }
        return 1;
    }

    const manifest = result.run.getManifest();
    console.log(`[OK] Captura ${result.warnings.length ? "CONCLUÍDA COM AVISOS" : "COMPLETA"}`);
    console.log(`Execução: ${result.run.dir}`);
    for (const artifact of manifest.artifacts) {
        console.log(`  ${artifact.path.padEnd(24)} ${String(artifact.bytes).padStart(9)} bytes  sha256 ${artifact.sha256.slice(0, 16)}…`);
    }
    console.log("  manifest.json");
    for (const warning of result.warnings) {
        console.log(`[AVISO] ${warning.viewport}: ${warning.code} - ${warning.message}`);
    }
    return 0;
}
