/**
 * Proxy de saída do Chromium: a barreira de rede da captura.
 *
 * O navegador é iniciado com este proxy como única rota (inclusive para
 * loopback) e com resolução DNS local desativada. Assim, todo tráfego
 * efetivo (documento, sub-recursos, redirects, frames, workers,
 * WebSocket via CONNECT) chega aqui e é decidido pela mesma política de
 * URL do M1, com o DNS validado no momento da conexão.
 *
 *  - HTTP (absolute-form): valida URL e método, encaminha com limite de
 *    bytes por recurso e orçamento total; redirects voltam ao navegador
 *    e são revalidados como novas requisições.
 *  - CONNECT (HTTPS/WSS/WS): valida host:porta e abre o túnel com o
 *    lookup protegido; bytes contam para o orçamento total.
 *  - Upgrade direto e requisições origin-form são recusados.
 *
 * A interceptação do Playwright não é usada como barreira de segurança.
 */

import http from "node:http";
import net from "node:net";

import { ErrorCodes, ReferenceEngineError } from "../core/errors.mjs";
import {
    DEFAULT_POLICY,
    createGuardedLookup,
    exemptLoopbackOrigins,
    isTestLoopbackOrigin,
    parseTargetUrl,
} from "../core/url-policy.mjs";

export const VIA_HEADER = "1.1 ads-reference-proxy";
export const BLOCKED_HEADER = "x-ads-blocked";

const HOP_BY_HOP = new Set([
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Códigos que representam decisão da política (e não falha de rede).
const BLOCKING_CODES = new Set([
    ErrorCodes.URL_INVALID,
    ErrorCodes.URL_SCHEME_BLOCKED,
    ErrorCodes.URL_CREDENTIALS,
    ErrorCodes.URL_PORT_BLOCKED,
    ErrorCodes.HOST_BLOCKED,
    ErrorCodes.ADDRESS_BLOCKED,
    ErrorCodes.METHOD_BLOCKED,
    ErrorCodes.RESOURCE_LIMIT,
    ErrorCodes.RESPONSE_TOO_LARGE,
]);

const decisionFor = (code) => (BLOCKING_CODES.has(code) ? "blocked" : "failed");

const CONNECT_TARGET = /^(\[[0-9a-f:.]+\]|[^:[\]/@\s]+):(\d{1,5})$/i;

/**
 * @typedef {object} ProxyLimits
 * @property {number} maxResourceBytes Limite por resposta HTTP.
 * @property {number} maxTotalBytes Orçamento total (HTTP + túneis).
 * @property {number} maxRequests Requisições + túneis.
 * @property {number} upstreamTimeoutMs Inatividade com o destino.
 * @property {number} maxEvents Eventos guardados no log.
 */

export const DEFAULT_PROXY_LIMITS = Object.freeze({
    maxResourceBytes: 15 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxRequests: 2000,
    upstreamTimeoutMs: 20_000,
    maxEvents: 5000,
});

/**
 * @typedef {object} ProxyEvent
 * @property {"http" | "connect" | "upgrade" | "invalid"} type
 * @property {string} target URL ou host:porta.
 * @property {"allowed" | "blocked" | "failed"} decision
 * @property {string} [method]
 * @property {string} [code]
 * @property {number} [status]
 * @property {number} [bytes]
 */

/**
 * @param {object} [options]
 * @param {Readonly<import("../core/url-policy.mjs").UrlPolicy>} [options.policy]
 * @param {Partial<ProxyLimits>} [options.limits]
 * @param {typeof import("node:dns").lookup} [options.lookup] DNS injetável (testes).
 */
export async function startEgressProxy({ policy = DEFAULT_POLICY, limits = {}, lookup } = {}) {
    const config = { ...DEFAULT_PROXY_LIMITS, ...limits };
    const guardedLookup = createGuardedLookup(lookup ? { lookup } : {});

    /** @type {ProxyEvent[]} */
    const events = [];
    const stats = {
        requests: 0,
        allowed: 0,
        blocked: 0,
        failed: 0,
        bytes: 0,
        droppedEvents: 0,
        /** @type {string | null} */
        limitExceeded: null,
    };
    const sockets = new Set();
    // Portas locais das conexões abertas pelo proxy até os destinos.
    // Permite provar em teste que toda conexão recebida veio do proxy.
    const upstreamPorts = new Set();
    const trackUpstream = (socket) =>
        socket.once("connect", () => upstreamPorts.add(socket.localPort));

    function record(event) {
        if (event.decision === "allowed") stats.allowed++;
        else if (event.decision === "blocked") stats.blocked++;
        else stats.failed++;

        if (events.length < config.maxEvents) events.push(event);
        else stats.droppedEvents++;
    }

    function exceed(reason) {
        if (!stats.limitExceeded) stats.limitExceeded = reason;
    }

    /** Conta bytes no orçamento total; false quando o orçamento estoura. */
    function spend(count) {
        stats.bytes += count;
        if (stats.bytes > config.maxTotalBytes) {
            exceed("maxTotalBytes");
            return false;
        }
        return true;
    }

    /** Reserva uma requisição; false quando o limite estoura. */
    function admit() {
        if (stats.limitExceeded) return false;
        stats.requests++;
        if (stats.requests > config.maxRequests) {
            exceed("maxRequests");
            return false;
        }
        return true;
    }

    function policyCode(error) {
        return error instanceof ReferenceEngineError ? error.code : ErrorCodes.NETWORK_ERROR;
    }

    function deny(res, status, code, message) {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            [BLOCKED_HEADER]: code,
            "cache-control": "no-store",
            connection: "close",
        });
        res.end(`${code}: ${message}\n`);
    }

    // --- HTTP absolute-form -------------------------------------------------

    const server = http.createServer((req, res) => {
        const raw = req.url ?? "";
        const method = (req.method ?? "GET").toUpperCase();

        // HTTPS sempre chega via CONNECT; aqui só http:// absoluto.
        if (!/^http:\/\//i.test(raw)) {
            record({ type: "invalid", target: raw.slice(0, 200), decision: "blocked", code: ErrorCodes.URL_INVALID });
            deny(res, 400, ErrorCodes.URL_INVALID, "Requisição sem URL http:// absoluta");
            return;
        }

        if (!admit()) {
            record({ type: "http", target: raw, method, decision: "blocked", code: ErrorCodes.RESOURCE_LIMIT });
            deny(res, 503, ErrorCodes.RESOURCE_LIMIT, stats.limitExceeded ?? "limite");
            return;
        }

        let url;
        try {
            url = parseTargetUrl(raw, policy);
        } catch (error) {
            const code = policyCode(error);
            record({ type: "http", target: raw, method, decision: "blocked", code });
            deny(res, 403, code, error.message);
            return;
        }

        if (!ALLOWED_METHODS.has(method)) {
            record({ type: "http", target: url.href, method, decision: "blocked", code: ErrorCodes.METHOD_BLOCKED });
            deny(res, 405, ErrorCodes.METHOD_BLOCKED, `Método ${method} não permitido na captura`);
            req.resume();
            return;
        }

        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
        }
        headers.host = url.host;
        headers.via = VIA_HEADER;
        // Sem compressão: os limites de bytes passam a refletir o conteúdo real.
        headers["accept-encoding"] = "identity";

        const upstream = http.request({
            host: url.hostname.replace(/^\[|\]$/g, ""),
            port: Number(url.port || 80),
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            agent: false,
            timeout: config.upstreamTimeoutMs,
            lookup: isTestLoopbackOrigin(url, policy) ? undefined : guardedLookup,
        });

        let bytes = 0;
        let finished = false;

        const fail = (code, status, message) => {
            if (finished) return;
            finished = true;
            record({ type: "http", target: url.href, method, decision: decisionFor(code), code, bytes });
            upstream.destroy();
            deny(res, status, code, message);
        };

        upstream.on("socket", trackUpstream);
        upstream.on("timeout", () => fail(ErrorCodes.TIMEOUT, 504, "Destino não respondeu"));
        upstream.on("error", (error) => {
            const code = policyCode(error);
            fail(code, code === ErrorCodes.ADDRESS_BLOCKED ? 403 : 502, error.message);
        });

        upstream.on("response", (response) => {
            const declared = Number(response.headers["content-length"]);
            if (Number.isFinite(declared) && declared > config.maxResourceBytes) {
                response.destroy();
                fail(ErrorCodes.RESPONSE_TOO_LARGE, 502, `Recurso declara ${declared} bytes`);
                return;
            }

            const outHeaders = {};
            for (const [name, value] of Object.entries(response.headers)) {
                if (!HOP_BY_HOP.has(name.toLowerCase())) outHeaders[name] = value;
            }
            res.writeHead(response.statusCode ?? 502, outHeaders);

            response.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > config.maxResourceBytes) {
                    response.destroy();
                    fail(ErrorCodes.RESPONSE_TOO_LARGE, 502, "Recurso excedeu o limite");
                    return;
                }
                if (!spend(chunk.length)) {
                    response.destroy();
                    fail(ErrorCodes.RESOURCE_LIMIT, 503, "Orçamento total excedido");
                    return;
                }
                res.write(chunk);
            });

            response.on("end", () => {
                if (finished) return;
                finished = true;
                record({ type: "http", target: url.href, method, decision: "allowed", status: response.statusCode, bytes });
                res.end();
            });

            response.on("error", () => fail(ErrorCodes.NETWORK_ERROR, 502, "Resposta interrompida"));
        });

        req.on("aborted", () => upstream.destroy());
        req.pipe(upstream);
    });

    // --- CONNECT ------------------------------------------------------------

    server.on("connect", (req, clientSocket, head) => {
        const target = req.url ?? "";
        sockets.add(clientSocket);
        clientSocket.on("close", () => sockets.delete(clientSocket));
        clientSocket.on("error", () => {});

        const refuse = (code, statusLine) => {
            record({ type: "connect", target, decision: decisionFor(code), code });
            if (clientSocket.writable) {
                clientSocket.end(`HTTP/1.1 ${statusLine}\r\n${BLOCKED_HEADER}: ${code}\r\nConnection: close\r\n\r\n`);
            }
            clientSocket.destroy();
        };

        if (!admit()) {
            refuse(ErrorCodes.RESOURCE_LIMIT, "503 Service Unavailable");
            return;
        }

        const match = CONNECT_TARGET.exec(target);
        const host = match?.[1].replace(/^\[|\]$/g, "");
        const port = Number(match?.[2]);
        const exempt = exemptLoopbackOrigins(policy).includes(`http://${target.toLowerCase()}`);

        try {
            if (!match || port < 1 || port > 65535) {
                throw new ReferenceEngineError(ErrorCodes.URL_INVALID, "Alvo CONNECT inválido");
            }
            // Origem loopback de teste (ex.: WebSocket da fixture) ou destino
            // aceito pela política como https (ou http, se permitido).
            if (!exempt) {
                try {
                    parseTargetUrl(`https://${match[1]}:${port}/`, policy);
                } catch (error) {
                    if (!policy.allowHttp) throw error;
                    parseTargetUrl(`http://${match[1]}:${port}/`, policy);
                }
            }
        } catch (error) {
            refuse(policyCode(error), "403 Forbidden");
            return;
        }

        const upstream = net.connect({
            host,
            port,
            lookup: exempt ? undefined : guardedLookup,
            timeout: config.upstreamTimeoutMs,
        });
        sockets.add(upstream);
        trackUpstream(upstream);

        let bytes = 0;
        let established = false;
        let closed = false;

        const close = (code) => {
            if (closed) return;
            closed = true;
            if (established) {
                record({
                    type: "connect",
                    target,
                    decision: code ? "blocked" : "allowed",
                    ...(code ? { code } : {}),
                    bytes,
                });
            }
            upstream.destroy();
            clientSocket.destroy();
        };

        upstream.on("timeout", () => {
            if (!established) {
                closed = true;
                upstream.destroy();
                refuse(ErrorCodes.TIMEOUT, "504 Gateway Timeout");
            } else {
                close();
            }
        });

        upstream.on("error", (error) => {
            if (!established) {
                closed = true;
                const code = policyCode(error);
                refuse(code, code === ErrorCodes.ADDRESS_BLOCKED ? "403 Forbidden" : "502 Bad Gateway");
            } else {
                close();
            }
        });

        upstream.on("connect", () => {
            established = true;
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head?.length) upstream.write(head);

            upstream.on("data", (chunk) => {
                bytes += chunk.length;
                if (!spend(chunk.length)) {
                    close(ErrorCodes.RESOURCE_LIMIT);
                    return;
                }
                if (!clientSocket.write(chunk)) upstream.pause();
            });
            clientSocket.on("drain", () => upstream.resume());
            clientSocket.on("data", (chunk) => {
                if (!upstream.write(chunk)) clientSocket.pause();
            });
            upstream.on("drain", () => clientSocket.resume());

            upstream.on("end", () => close());
            clientSocket.on("end", () => close());
            clientSocket.on("close", () => close());
            upstream.on("close", () => close());
        });
    });

    // Upgrade direto (sem CONNECT) não é suportado: recusar.
    server.on("upgrade", (req, socket) => {
        record({ type: "upgrade", target: String(req.url).slice(0, 200), decision: "blocked", code: ErrorCodes.METHOD_BLOCKED });
        socket.on("error", () => {});
        socket.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: ${ErrorCodes.METHOD_BLOCKED}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
    });

    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });

    server.on("clientError", (error, socket) => {
        socket.destroy();
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = /** @type {net.AddressInfo} */ (server.address());

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        events,
        stats,
        /** @param {number} port */
        ownsLocalPort: (port) => upstreamPorts.has(port),
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
