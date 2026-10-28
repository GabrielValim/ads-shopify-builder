/**
 * Inicialização do Chromium para captura.
 *
 * Camadas de rede:
 *  1. `--proxy-server` aponta para o proxy de saída; o Playwright força
 *     `<-loopback>` na bypass list, então nem loopback sai direto.
 *  2. `--host-resolver-rules` faz qualquer resolução DNS local falhar:
 *     nomes só são resolvidos pelo proxy (com o lookup protegido).
 *  3. WebRTC restrito a UDP via proxy (que não suporta UDP) e QUIC
 *     desativado: nenhum tráfego UDP sai do navegador.
 *  4. Contexto sem downloads, sem service workers e sem permissões.
 *  5. Sandbox do Chromium ativo por padrão.
 */

import { chromium } from "playwright";

import { ROBOTS_TOKEN, ENGINE_VERSION } from "../core/safe-fetch.mjs";

export const VIEWPORTS = Object.freeze({
    desktop: Object.freeze({
        name: "desktop",
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
    }),
    mobile: Object.freeze({
        name: "mobile",
        width: 390,
        height: 844,
        // Escala 1 mantém pixels CSS = pixels da imagem, o que simplifica a
        // comparação visual (M4). O layout responsivo depende do viewport.
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
    }),
});

const FORBIDDEN_ENV = "PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK";

/**
 * User-Agent honesto: identifica o robô e mantém os tokens de navegador
 * que os sites usam para escolher o layout.
 * @param {string} browserVersion
 * @param {boolean} mobile
 */
export function userAgentFor(browserVersion, mobile) {
    const bot = `${ROBOTS_TOKEN}/${ENGINE_VERSION}`;
    return mobile
        ? `Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Mobile Safari/537.36 ${bot}`
        : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36 ${bot}`;
}

/**
 * @param {object} options
 * @param {string} options.proxyUrl http://127.0.0.1:<porta>
 * @param {number} [options.jsHeapMb] Limite de heap JS por processo.
 * @param {boolean} [options.sandbox] Sandbox do Chromium (padrão: ativo).
 */
export async function launchCaptureBrowser({ proxyUrl, jsHeapMb = 512, sandbox = true }) {
    if (process.env[FORBIDDEN_ENV]) {
        throw new Error(`${FORBIDDEN_ENV} desativaria o proxy para loopback`);
    }
    const proxy = new URL(proxyUrl);
    if (proxy.hostname !== "127.0.0.1" || proxy.protocol !== "http:") {
        throw new Error("O proxy de captura deve ser http://127.0.0.1:<porta>");
    }

    return chromium.launch({
        headless: true,
        proxy: { server: proxy.origin },
        chromiumSandbox: sandbox,
        args: [
            `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`,
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--dns-prefetch-disable",
            "--no-pings",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-sync",
            "--disable-extensions",
            "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
            `--js-flags=--max-old-space-size=${jsHeapMb}`,
            "--font-render-hinting=none",
            "--hide-scrollbars",
        ],
    });
}

/**
 * @param {import("playwright").Browser} browser
 * @param {typeof VIEWPORTS[keyof typeof VIEWPORTS]} viewport
 */
export async function newCaptureContext(browser, viewport) {
    return browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        screen: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        userAgent: userAgentFor(browser.version(), viewport.isMobile),
        locale: "pt-BR",
        timezoneId: "America/Sao_Paulo",
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
        javaScriptEnabled: true,
        bypassCSP: false,
        ignoreHTTPSErrors: false,
    });
}
