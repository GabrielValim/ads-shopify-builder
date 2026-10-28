/**
 * CF-01 — SVG do placeholder de mídia do render (`placeholder_svg_tag`). Separado de liquid-lite.mjs só para que o fecho
 * de importações da ferramenta de pré-verificação exportada à área do agente não carregue código de render (que contém
 * a URI de namespace do SVG). Recebe `name` e `cls` JÁ escapados; saída idêntica à de antes da separação.
 */
/** Paleta do placeholder do harness (fundo e hachura): permite reconhecê-lo nos pixels do retrato. */
export const PLACEHOLDER_COLORS = Object.freeze({ fill: [230, 225, 223], stroke: [210, 203, 200] });
export const placeholderSvg = (name, cls) => `<svg class="${cls}" data-cf-placeholder="${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 525" preserveAspectRatio="xMidYMid slice"><rect width="525" height="525" fill="#e6e1df"/><path d="M0 525L525 0M-131 394L394-131M131 656L656 131" stroke="#d2cbc8" stroke-width="18"/></svg>`;
