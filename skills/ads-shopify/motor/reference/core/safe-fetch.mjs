/**
 * GET HTTP(S) com política de SSRF aplicada a cada salto.
 *
 * - Valida estaticamente a URL inicial e cada `Location` de redirecionamento.
 * - Usa `createGuardedLookup` no connect, recusando IPs não públicos.
 * - Prazo total, limite de bytes e limite de redirecionamentos.
 * - Sem descompressão (`accept-encoding: identity`) para evitar bombas zip.
 * - Sem pool de conexões: cada salto passa pelo lookup protegido.
 */

import http from "node:http";
import https from "node:https";

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";
import {
    DEFAULT_POLICY,
    createGuardedLookup,
    isTestLoopbackOrigin,
    parseTargetUrl,
} from "./url-policy.mjs";

export const ENGINE_VERSION = "0.1.0";
export const ROBOTS_TOKEN = "ADS-AutoStore-ReferenceBot";
export const USER_AGENT =
    `Mozilla/5.0 (compatible; ${ROBOTS_TOKEN}/${ENGINE_VERSION})`;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const POLICY_CODES = new Set([
    ErrorCodes.URL_INVALID,
    ErrorCodes.URL_SCHEME_BLOCKED,
    ErrorCodes.URL_CREDENTIALS,
    ErrorCodes.URL_PORT_BLOCKED,
    ErrorCodes.HOST_BLOCKED,
    ErrorCodes.ADDRESS_BLOCKED,
]);

/**
 * @typedef {object} SafeGetOptions
 * @property {Readonly<import("./url-policy.mjs").UrlPolicy>} [policy]
 * @property {number} [timeoutMs] Prazo total, incluindo redirecionamentos.
 * @property {number} [maxBytes] Tamanho máximo do corpo.
 * @property {"error" | "truncate"} [onLimit] Comportamento ao exceder maxBytes.
 * @property {number} [maxRedirects]
 * @property {string} [accept]
 * @property {typeof import("node:dns").lookup} [lookup] DNS injetável (testes).
 */

/**
 * @typedef {object} SafeResponse
 * @property {string} url URL final.
 * @property {number} status
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Buffer} body
 * @property {boolean} truncated
 * @property {Array<{ from: string, to: string, status: number }>} redirects
 */

/**
 * @param {string | URL} input
 * @param {SafeGetOptions} [options]
 * @returns {Promise<SafeResponse>}
 */
export async function safeGet(input, options = {}) {
    const {
        policy = DEFAULT_POLICY,
        timeoutMs = 10_000,
        maxBytes = 1_000_000,
        onLimit = "error",
        maxRedirects = 5,
        accept = "*/*",
        lookup,
    } = options;

    const guardedLookup = createGuardedLookup(lookup ? { lookup } : {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const redirects = [];

    try {
        let current = parseTargetUrl(input, policy);

        for (let hop = 0; ; hop++) {
            let response;
            try {
                response = await requestOnce(current, {
                    policy,
                    guardedLookup,
                    signal: controller.signal,
                    accept,
                    maxBytes,
                    onLimit,
                    timeoutMs,
                });
            } catch (error) {
                throw wrapHopError(error, hop, current, controller, timeoutMs);
            }

            if (!REDIRECT_STATUSES.has(response.status)) {
                return { ...response, url: current.href, redirects };
            }

            const location = response.headers.location;
            if (typeof location !== "string" || !location) {
                return { ...response, url: current.href, redirects };
            }

            if (redirects.length >= maxRedirects) {
                throw new ReferenceEngineError(
                    ErrorCodes.REDIRECT_LIMIT,
                    `Mais de ${maxRedirects} redirecionamentos`,
                    { url: current.href, redirects }
                );
            }

            let next;
            try {
                next = parseTargetUrl(new URL(location, current), policy);
            } catch (error) {
                throw redirectBlocked(error, current, location);
            }

            redirects.push({
                from: current.href,
                to: next.href,
                status: response.status,
            });
            current = next;
        }
    } finally {
        clearTimeout(timer);
    }
}

function redirectBlocked(error, from, location) {
    const reason =
        error instanceof ReferenceEngineError ? error.code : ErrorCodes.URL_INVALID;
    return new ReferenceEngineError(
        ErrorCodes.REDIRECT_BLOCKED,
        `Redirecionamento recusado (${reason})`,
        { from: from.href, location: String(location), reason }
    );
}

function wrapHopError(error, hop, url, controller, timeoutMs) {
    if (controller.signal.aborted) {
        return new ReferenceEngineError(
            ErrorCodes.TIMEOUT,
            `Prazo de ${timeoutMs} ms excedido`,
            { url: url.href }
        );
    }

    if (error instanceof ReferenceEngineError) {
        if (hop > 0 && POLICY_CODES.has(error.code)) {
            return redirectBlocked(error, url, url.href);
        }
        return error;
    }

    return new ReferenceEngineError(
        ErrorCodes.NETWORK_ERROR,
        `Falha de rede: ${error?.code ?? error?.message ?? "desconhecida"}`,
        { url: url.href, cause: error?.code }
    );
}

/**
 * @param {URL} url
 */
function requestOnce(url, context) {
    const { policy, guardedLookup, signal, accept, maxBytes, onLimit, timeoutMs } =
        context;
    const client = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const request = client.request(
            url,
            {
                method: "GET",
                agent: false,
                signal,
                timeout: timeoutMs,
                // Origens loopback de teste usam IP literal; nas demais o
                // DNS sempre passa pelo lookup protegido.
                lookup: isTestLoopbackOrigin(url, policy) ? undefined : guardedLookup,
                headers: {
                    "user-agent": USER_AGENT,
                    accept,
                    "accept-encoding": "identity",
                },
            },
            (response) => {
                const status = response.statusCode ?? 0;

                if (REDIRECT_STATUSES.has(status)) {
                    response.resume();
                    resolve({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
                    return;
                }

                const declared = Number(response.headers["content-length"]);
                if (onLimit === "error" && Number.isFinite(declared) && declared > maxBytes) {
                    response.destroy();
                    reject(tooLarge(url, declared, maxBytes));
                    return;
                }

                const chunks = [];
                let received = 0;
                let settled = false;

                response.on("data", (chunk) => {
                    if (settled) return;
                    received += chunk.length;

                    if (received > maxBytes) {
                        settled = true;
                        if (onLimit === "truncate") {
                            const keep = chunk.length - (received - maxBytes);
                            chunks.push(chunk.subarray(0, keep));
                            response.destroy();
                            resolve({
                                status,
                                headers: response.headers,
                                body: Buffer.concat(chunks),
                                truncated: true,
                            });
                        } else {
                            response.destroy();
                            reject(tooLarge(url, received, maxBytes));
                        }
                        return;
                    }

                    chunks.push(chunk);
                });

                response.on("end", () => {
                    if (settled) return;
                    settled = true;
                    resolve({
                        status,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                        truncated: false,
                    });
                });

                response.on("error", (error) => {
                    if (settled) return;
                    settled = true;
                    reject(error);
                });
            }
        );

        request.on("timeout", () => {
            request.destroy(
                new ReferenceEngineError(
                    ErrorCodes.TIMEOUT,
                    `Socket inativo por ${timeoutMs} ms`,
                    { url: url.href }
                )
            );
        });

        request.on("error", reject);
        request.end();
    });
}

function tooLarge(url, bytes, maxBytes) {
    return new ReferenceEngineError(
        ErrorCodes.RESPONSE_TOO_LARGE,
        `Resposta excede ${maxBytes} bytes`,
        { url: url.href, bytes, maxBytes }
    );
}
