/**
 * Registro de requisições observadas pelo navegador (eventos do Playwright),
 * para diagnóstico de recursos pendentes/bloqueados. Complementa o log do
 * proxy de saída, que em HTTPS só enxerga o túnel CONNECT (sem abrir TLS).
 *
 * Só metadados: método, tipo, URL sanitizada, status e falha. Nunca
 * cabeçalhos, cookies, corpos, query string, fragmento ou credenciais.
 */

const MAX_ENTRIES = 2000;
const MAX_URL = 300;
// Segmento de caminho com cara de token/identificador opaco.
const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_\-.~%]{32,}$/;
// Dados pessoais prováveis num segmento: e-mail ou sequência longa de dígitos
// (telefone, documento, número de pedido).
const PERSONAL_SEGMENT = /@|\d{8,}/;

function redactSegment(raw) {
    // Parâmetros de caminho (ex.: ";jsessionid=...") nunca são mantidos.
    const segment = raw.split(";")[0];
    let decoded = segment;
    try {
        decoded = decodeURIComponent(segment);
    } catch {
        /* segmento com % inválido: avaliado como está */
    }
    if (OPAQUE_SEGMENT.test(segment) || PERSONAL_SEGMENT.test(decoded)) return "[redigido]";
    return segment === raw ? segment : `${segment};[param]`;
}

/**
 * URL sem query, fragmento ou credenciais; segmentos opacos longos
 * redigidos; data:/blob: reduzidos ao esquema (e ao tipo, em data:).
 * @param {string} raw
 */
export function sanitizeUrl(raw) {
    const value = String(raw ?? "");
    if (/^data:/i.test(value)) return `data:${(value.slice(5).split(/[;,]/)[0] || "").slice(0, 40)}`;
    if (/^blob:/i.test(value)) return "blob:";
    let url;
    try {
        url = new URL(value);
    } catch {
        return "[url inválida]";
    }
    if (!["http:", "https:"].includes(url.protocol)) return `${url.protocol}`;
    const path = url.pathname.split("/").map(redactSegment).join("/");
    const out = `${url.protocol}//${url.host}${path}${url.search ? "?[query]" : ""}`;
    return out.length > MAX_URL ? `${out.slice(0, MAX_URL)}…` : out;
}

/**
 * Liga o registro a uma página. `blockedHeader`: cabeçalho que o proxy de
 * saída põe nas respostas que ele mesmo recusou (HTTP).
 * @param {import("playwright").Page} page
 * @param {{ blockedHeader: string }} options
 */
export function attachRequestLog(page, { blockedHeader }) {
    const entries = [];
    const byRequest = new Map();
    let dropped = 0;

    page.on("request", (request) => {
        if (entries.length >= MAX_ENTRIES) {
            dropped++;
            return;
        }
        const entry = { method: request.method(), type: request.resourceType(), url: sanitizeUrl(request.url()), status: null, outcome: "pending" };
        entries.push(entry);
        byRequest.set(request, entry);
    });
    page.on("response", (response) => {
        const entry = byRequest.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        const headers = response.headers();
        if (headers[blockedHeader]) entry.blockedBy = "egress-proxy";
    });
    page.on("requestfinished", (request) => {
        const entry = byRequest.get(request);
        if (entry) entry.outcome = entry.blockedBy ? "blocked" : entry.status >= 400 ? "http-error" : "ok";
    });
    page.on("requestfailed", (request) => {
        const entry = byRequest.get(request);
        if (!entry) return;
        const failure = String(request.failure()?.errorText ?? "falha").slice(0, 80);
        entry.outcome = /TUNNEL_CONNECTION|PROXY|BLOCKED_BY/i.test(failure) ? "blocked" : "failed";
        entry.failure = failure;
    });

    return {
        snapshot() {
            const stats = { total: entries.length, dropped, ok: 0, pending: 0, failed: 0, blocked: 0, httpError: 0, byType: {} };
            for (const entry of entries) {
                if (entry.outcome === "ok") stats.ok++;
                else if (entry.outcome === "pending") stats.pending++;
                else if (entry.outcome === "failed") stats.failed++;
                else if (entry.outcome === "blocked") stats.blocked++;
                else if (entry.outcome === "http-error") stats.httpError++;
                stats.byType[entry.type] = (stats.byType[entry.type] ?? 0) + 1;
            }
            return { stats, entries: entries.map((entry) => ({ ...entry })) };
        },
        /** Resultado de uma URL de imagem (pela URL sanitizada). */
        outcomeOf(rawUrl) {
            const url = sanitizeUrl(rawUrl);
            const found = entries.filter((entry) => entry.url === url).at(-1);
            return found ? { outcome: found.outcome, status: found.status, ...(found.failure ? { failure: found.failure } : {}) } : { outcome: "not-requested" };
        },
    };
}
