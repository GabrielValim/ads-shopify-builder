/**
 * Funções executadas DENTRO da página (via page.evaluate/addInitScript).
 * Precisam ser autocontidas: sem imports nem variáveis externas.
 */

/**
 * Script de inicialização para reprodutibilidade: Math.random com
 * semente fixa, sem popups e sem diálogos bloqueantes.
 * @param {{ seed: number }} options
 */
export function deterministicInit({ seed }) {
    let state = seed >>> 0;
    Math.random = function random() {
        // mulberry32
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    window.open = () => null;
    window.alert = () => {};
    window.confirm = () => false;
    window.prompt = () => null;
}

/**
 * Sinais de páginas de desafio/anti-bot. Não tentamos contorná-las:
 * a captura é encerrada com CHALLENGE_DETECTED.
 */
export function detectChallenge() {
    const title = (document.title || "").toLowerCase();
    const text = (document.body?.innerText || "").slice(0, 4000).toLowerCase();
    const titles = ["just a moment", "attention required", "access denied", "verify you are human", "are you a robot", "security check"];
    const selectors = [
        "#challenge-form",
        "#challenge-running",
        ".cf-challenge",
        "#cf-challenge-running",
        "iframe[src*='challenges.cloudflare.com']",
        "iframe[src*='hcaptcha.com/captcha']",
        "#px-captcha",
        "[data-ads-challenge]",
    ];
    const reasons = [];
    for (const value of titles) if (title.includes(value)) reasons.push(`title:${value}`);
    for (const selector of selectors) if (document.querySelector(selector)) reasons.push(`selector:${selector}`);
    if (text.includes("checking your browser") || text.includes("enable javascript and cookies to continue")) {
        reasons.push("text:interstitial");
    }
    return reasons;
}

/**
 * Página de senha da loja (storefront protegido). A captura NÃO tenta
 * entrar: encerra com ACCESS_RESTRICTED.
 */
export function detectAccessGate() {
    const reasons = [];
    if (/^\/password\/?$/.test(location.pathname)) reasons.push("path:/password");
    if (document.querySelector('form[action$="/password"], form[action*="/password?"]')) reasons.push("form:password");
    return reasons;
}

export function documentMetrics() {
    const root = document.documentElement;
    const body = document.body;
    return {
        scrollHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0),
        scrollWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0),
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
    };
}

/** @param {number} y */
export function scrollToY(y) {
    window.scrollTo(0, y);
    return window.scrollY;
}

export function fontStatus() {
    return document.fonts ? document.fonts.status : "loaded";
}

export function imageStatus() {
    const images = Array.from(document.images);
    let pending = 0;
    let failed = 0;
    for (const image of images) {
        if (!image.complete) pending++;
        else if (image.naturalWidth === 0 && (image.currentSrc || image.src)) failed++;
    }
    return { total: images.length, pending, failed };
}

/**
 * Estado de cada imagem, sem alterar nada: carregada, pendente, com falha,
 * oculta (não renderizada — não é erro) ou placeholder embutido (data:/sem
 * src). `inRangePending`: pendentes visíveis a até `rangePx` da janela.
 * @param {number} rangePx
 */
export function imageReport(rangePx) {
    const view = window.innerHeight;
    const out = { total: 0, loaded: 0, pending: 0, failed: 0, hidden: 0, placeholder: 0, inRangePending: 0, pendingSrc: [], failedSrc: [] };
    for (const image of Array.from(document.images)) {
        out.total++;
        const src = image.currentSrc || image.src || "";
        if (!src || /^(data|about):/i.test(src)) {
            out.placeholder++;
            continue;
        }
        const rect = image.getBoundingClientRect();
        const rendered =
            rect.width > 0 &&
            rect.height > 0 &&
            (typeof image.checkVisibility === "function" ? image.checkVisibility({ visibilityProperty: true }) : getComputedStyle(image).visibility !== "hidden");
        if (!rendered) {
            out.hidden++;
            continue;
        }
        if (!image.complete) {
            out.pending++;
            if (rect.bottom >= -rangePx && rect.top <= view + rangePx) out.inRangePending++;
            if (out.pendingSrc.length < 20) out.pendingSrc.push(src);
            continue;
        }
        if (image.naturalWidth === 0) {
            out.failed++;
            if (out.failedSrc.length < 20) out.failedSrc.push(src);
            continue;
        }
        out.loaded++;
    }
    return out;
}

/**
 * Textos curtos com dígitos visíveis na página (ex.: contadores), com a
 * posição vertical, para observar se ainda estão mudando. Só leitura.
 */
export function numericTexts() {
    const entries = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && entries.length < 300; node = walker.nextNode()) {
        const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 24 || !/\d/.test(text)) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        entries.push({ text, y: Math.round(rect.top + window.scrollY) });
    }
    return entries;
}

/** Assinatura barata do conteúdo para detectar quando a página parou de montar. */
export function contentSignature() {
    const root = document.documentElement;
    return {
        height: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
        elements: document.getElementsByTagName("*").length,
        images: document.images.length,
    };
}

/**
 * Congela elementos dinâmicos: animações, transições, cursor, vídeos.
 */
export function freezeDynamicContent() {
    const style = document.createElement("style");
    style.setAttribute("data-ads-capture", "freeze");
    style.textContent = `
        *, *::before, *::after {
            animation-delay: 0s !important;
            animation-duration: 0s !important;
            animation-iteration-count: 1 !important;
            animation-play-state: paused !important;
            transition: none !important;
            caret-color: transparent !important;
            scroll-behavior: auto !important;
        }
    `;
    document.head.appendChild(style);
    for (const media of document.querySelectorAll("video, audio")) {
        try {
            media.pause();
            media.currentTime = 0;
        } catch {
            /* mídia sem controle */
        }
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * Extrai a estrutura visual do documento.
 * @param {{ maxNodes: number, maxTextLength: number, maxDepth: number }} options
 */
export function extractDom({ maxNodes, maxTextLength, maxDepth }) {
    const STYLE_PROPS = [
        "display", "position", "zIndex", "flexDirection", "flexWrap", "justifyContent", "alignItems",
        "gap", "gridTemplateColumns", "maxWidth", "paddingTop", "paddingRight", "paddingBottom",
        "paddingLeft", "marginTop", "marginBottom", "color", "backgroundColor", "backgroundImage",
        "backgroundSize", "backgroundPosition", "opacity", "fontFamily", "fontSize", "fontWeight",
        "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform", "textDecorationLine",
        "borderTopWidth", "borderTopStyle", "borderTopColor", "borderTopLeftRadius", "boxShadow",
        "objectFit", "overflow",
    ];
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "BASE", "TITLE"]);
    const IMPLICIT_ROLES = {
        HEADER: "banner", NAV: "navigation", MAIN: "main", FOOTER: "contentinfo", ASIDE: "complementary",
        SECTION: "region", FORM: "form", A: "link", BUTTON: "button", IMG: "img", UL: "list", OL: "list",
        H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    };
    const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "region"]);

    const round = (value) => Math.round(value * 100) / 100;
    const clip = (value, limit) => (value.length > limit ? value.slice(0, limit) : value);
    const normalize = (value) => value.replace(/\s+/g, " ").trim();

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const nodes = [];
    const elementIds = new Map();
    let truncated = false;
    let totalElements = 0;

    function ownText(element) {
        let text = "";
        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue;
        }
        return normalize(text);
    }

    function attributes(element) {
        const attrs = {};
        if (element.id) attrs.id = clip(element.id, 120);
        const classes = Array.from(element.classList).slice(0, 8).join(" ");
        if (classes) attrs.class = clip(classes, 200);
        const role = element.getAttribute("role");
        if (role) attrs.role = clip(role, 40);
        const label = element.getAttribute("aria-label");
        if (label) attrs.ariaLabel = clip(normalize(label), maxTextLength);
        // Estado observado de componentes interativos (sem abrir/fechar nada).
        for (const [name, key] of [["aria-expanded", "ariaExpanded"], ["aria-controls", "ariaControls"], ["aria-hidden", "ariaHidden"], ["aria-selected", "ariaSelected"]]) {
            const value = element.getAttribute(name);
            if (value !== null) attrs[key] = clip(normalize(value), 120);
        }
        if (element instanceof HTMLDetailsElement) attrs.open = element.open ? "true" : "false";
        if (element instanceof HTMLAnchorElement && element.href) attrs.href = clip(element.href, 500);
        if (element instanceof HTMLImageElement) {
            if (element.currentSrc || element.src) attrs.src = clip(element.currentSrc || element.src, 500);
            if (element.alt) attrs.alt = clip(normalize(element.alt), maxTextLength);
            if (element.loading) attrs.loading = element.loading;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
            if (element.type) attrs.type = element.type;
        }
        if (element instanceof HTMLInputElement && element.placeholder) {
            attrs.placeholder = clip(normalize(element.placeholder), maxTextLength);
        }
        return attrs;
    }

    function visit(element, parentId, depth) {
        if (SKIP.has(element.tagName)) return;
        totalElements++;
        if (nodes.length >= maxNodes || depth > maxDepth) {
            truncated = true;
            return;
        }

        const style = getComputedStyle(element);
        if (style.display === "none") return;

        const rect = element.getBoundingClientRect();
        const visible =
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            Number(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0;

        const record = visible || element.children.length > 0 || element === document.body;
        let id = parentId;

        if (record) {
            id = nodes.length;
            elementIds.set(element, id);
            const tag = element.tagName.toLowerCase();
            const fullText = ownText(element);
            const node = {
                id,
                parent: parentId,
                depth,
                tag,
                role: element.getAttribute("role") || IMPLICIT_ROLES[element.tagName] || null,
                visible,
                box: {
                    x: round(rect.left + scrollX),
                    y: round(rect.top + scrollY),
                    width: round(rect.width),
                    height: round(rect.height),
                },
                attrs: attributes(element),
                text: clip(fullText, maxTextLength),
                textLength: fullText.length,
                styles: {},
            };

            if (/^h[1-6]$/.test(tag)) node.headingLevel = Number(tag[1]);

            if (visible) {
                for (const prop of STYLE_PROPS) node.styles[prop] = style[prop];
            }

            if (element instanceof HTMLImageElement) {
                node.media = {
                    kind: "img",
                    naturalWidth: element.naturalWidth,
                    naturalHeight: element.naturalHeight,
                    complete: element.complete,
                };
            } else if (element instanceof HTMLVideoElement) {
                node.media = { kind: "video", naturalWidth: element.videoWidth, naturalHeight: element.videoHeight, complete: element.readyState >= 2 };
            } else if (tag === "svg") {
                node.media = { kind: "svg", naturalWidth: round(rect.width), naturalHeight: round(rect.height), complete: true };
            }

            nodes.push(node);
        }

        // Conteúdo interno de SVG não é estrutura de layout.
        if (element.tagName.toLowerCase() === "svg") return;

        for (const child of element.children) visit(child, id, depth + 1);
    }

    if (document.body) visit(document.body, null, 0);

    // Hierarquia: filhos por nó.
    const children = new Map();
    for (const node of nodes) {
        if (node.parent === null) continue;
        if (!children.has(node.parent)) children.set(node.parent, []);
        children.get(node.parent).push(node.id);
    }

    function descendants(id) {
        const result = [];
        const stack = [...(children.get(id) || [])];
        while (stack.length) {
            const next = stack.pop();
            result.push(next);
            stack.push(...(children.get(next) || []));
        }
        return result;
    }

    function summarize(id) {
        const ids = [id, ...descendants(id)];
        const counts = { images: 0, links: 0, buttons: 0, inputs: 0, headings: 0, textChars: 0 };
        const headings = [];
        for (const nodeId of ids) {
            const node = nodes[nodeId];
            if (!node.visible) continue;
            if (node.media) counts.images++;
            if (node.tag === "a") counts.links++;
            if (node.tag === "button" || node.role === "button") counts.buttons++;
            if (["input", "select", "textarea"].includes(node.tag)) counts.inputs++;
            if (node.headingLevel) {
                counts.headings++;
                if (headings.length < 5 && node.text) headings.push(node.text);
            }
            counts.textChars += node.textLength;
        }
        return { counts, headings };
    }

    // Seções candidatas: landmarks, seções Shopify e faixas horizontais.
    const docWidth = Math.max(document.documentElement.scrollWidth, viewport.width);
    const sections = [];
    const seen = new Set();

    function addSection(id, kind) {
        if (id === undefined || seen.has(id)) return;
        const node = nodes[id];
        if (!node || !node.visible || node.box.height < 8) return;
        seen.add(id);
        sections.push({ nodeId: id, kind, tag: node.tag, role: node.role, box: node.box, ...summarize(id) });
    }

    for (const node of nodes) {
        if (node.role && LANDMARK_ROLES.has(node.role)) addSection(node.id, "landmark");
    }
    for (const element of document.querySelectorAll(".shopify-section")) {
        addSection(elementIds.get(element), "shopify-section");
    }
    const container = document.querySelector("main") || document.body;
    const containerId = elementIds.get(container);
    for (const childId of children.get(containerId) || []) {
        const node = nodes[childId];
        if (node.visible && node.box.height >= 24 && node.box.width >= docWidth * 0.6) addSection(childId, "band");
    }
    sections.sort((a, b) => a.box.y - b.box.y || a.nodeId - b.nodeId);

    const headings = nodes
        .filter((node) => node.visible && node.headingLevel)
        .map((node) => ({
            nodeId: node.id,
            level: node.headingLevel,
            text: node.text,
            fontSize: node.styles.fontSize,
            fontWeight: node.styles.fontWeight,
            box: node.box,
        }));

    const viewportArea = viewport.width * viewport.height;
    const fixedElements = nodes
        .filter((node) => node.visible && (node.styles.position === "fixed" || node.styles.position === "sticky"))
        .map((node) => ({
            nodeId: node.id,
            position: node.styles.position,
            box: node.box,
            overlay: node.styles.position === "fixed" && (node.box.width * node.box.height) / viewportArea >= 0.3,
        }));

    const fonts = [];
    if (document.fonts) {
        const keys = new Set();
        for (const face of document.fonts) {
            const key = `${face.family}|${face.weight}|${face.style}|${face.status}`;
            if (keys.has(key) || fonts.length >= 100) continue;
            keys.add(key);
            fonts.push({ family: face.family.replace(/^["']|["']$/g, ""), weight: face.weight, style: face.style, status: face.status });
        }
        fonts.sort((a, b) => (`${a.family}${a.weight}${a.style}` < `${b.family}${b.weight}${b.style}` ? -1 : 1));
    }

    const images = Array.from(document.images);

    return {
        document: {
            url: location.href,
            title: clip(normalize(document.title || ""), 300),
            lang: document.documentElement.lang || null,
            dir: document.documentElement.dir || null,
            viewport,
            scroll: {
                width: document.documentElement.scrollWidth,
                height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
            },
            devicePixelRatio: window.devicePixelRatio,
        },
        stats: {
            totalElements,
            recordedNodes: nodes.length,
            truncated,
            images: {
                total: images.length,
                complete: images.filter((image) => image.complete && image.naturalWidth > 0).length,
                failed: images.filter((image) => image.complete && image.naturalWidth === 0 && (image.currentSrc || image.src)).length,
                pending: images.filter((image) => !image.complete).length,
            },
        },
        fonts,
        sections,
        headings,
        fixedElements,
        nodes,
    };
}
