/**
 * Política de URL do Reference Engine (proteção contra SSRF).
 *
 * Duas camadas:
 *  1. `parseTargetUrl`: validação estática (esquema, credenciais, porta,
 *     nomes internos e IPs literais). Aplicada à URL inicial e a cada
 *     redirecionamento.
 *  2. `createGuardedLookup`: substitui o DNS no momento da conexão e recusa
 *     qualquer endereço resolvido que não seja público. Como a checagem
 *     acontece no próprio connect, não há janela entre validar e conectar
 *     (DNS rebinding).
 */

import dns from "node:dns";
import net from "node:net";
import { z } from "zod";

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";

const MAX_URL_LENGTH = 2048;

const BLOCKED_HOST_SUFFIXES = [
    ".localhost",
    ".local",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".corp",
    ".home.arpa",
    ".localdomain",
    ".in-addr.arpa",
    ".ip6.arpa",
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

// Faixas não roteáveis publicamente (RFC 6890 e correlatas).
const IPV4_BLOCKED = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

const IPV6_BLOCKED = [
    ["::", 96], // não especificado, loopback e IPv4-compatível
    ["64:ff9b::", 96], // NAT64 pode alcançar IPv4 privado
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23], // atribuições IETF, incluindo Teredo
    ["2001:db8::", 32],
    ["2002::", 16], // 6to4 pode embutir IPv4 privado
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
];

const ipv4BlockList = new net.BlockList();
for (const [address, prefix] of IPV4_BLOCKED) {
    ipv4BlockList.addSubnet(address, prefix, "ipv4");
}

const ipv6BlockList = new net.BlockList();
for (const [address, prefix] of IPV6_BLOCKED) {
    ipv6BlockList.addSubnet(address, prefix, "ipv6");
}

const loopbackOrigin = z
    .string()
    .refine((value) => {
        try {
            const url = new URL(value);
            return (
                url.origin === value &&
                url.protocol === "http:" &&
                ["127.0.0.1", "[::1]"].includes(url.hostname)
            );
        } catch {
            return false;
        }
    }, "Origem de teste deve ser http://127.0.0.1:<porta> ou http://[::1]:<porta>");

const policySchema = z
    .object({
        allowHttp: z.boolean().default(false),
        allowedPorts: z
            .array(z.number().int().min(1).max(65535))
            .optional(),
        // Somente para testes automatizados: origens loopback isentas.
        // A CLI nunca preenche este campo.
        testLoopbackOrigins: z.array(loopbackOrigin).default([]),
        // Prévia local própria e autorizada (ex.: `shopify theme dev`):
        // origem EXATA (loopback, http, porta explícita), informada
        // explicitamente na CLI com --local-preview. Não libera outras
        // portas locais, IPs privados nem nomes internos.
        previewOrigins: z.array(loopbackOrigin).max(1).default([]),
    })
    .strict();

/**
 * @typedef {object} UrlPolicy
 * @property {boolean} allowHttp
 * @property {readonly number[]} allowedPorts
 * @property {readonly string[]} testLoopbackOrigins
 * @property {readonly string[]} previewOrigins
 */

/**
 * @param {Partial<UrlPolicy>} [options]
 * @returns {Readonly<UrlPolicy>}
 */
export function createUrlPolicy(options = {}) {
    const parsed = policySchema.parse(options);
    const allowedPorts =
        parsed.allowedPorts ?? (parsed.allowHttp ? [443, 80] : [443]);

    return Object.freeze({
        allowHttp: parsed.allowHttp,
        allowedPorts: Object.freeze([...allowedPorts]),
        testLoopbackOrigins: Object.freeze([...parsed.testLoopbackOrigins]),
        previewOrigins: Object.freeze([...parsed.previewOrigins]),
    });
}

export const DEFAULT_POLICY = createUrlPolicy();

/**
 * Expande um IPv6 textual em 8 grupos de 16 bits.
 * @param {string} address
 * @returns {number[] | null}
 */
function expandIPv6(address) {
    let text = address.split("%")[0];
    const groups = [];

    // IPv4 embutido no final (ex.: ::ffff:127.0.0.1).
    const lastColon = text.lastIndexOf(":");
    const tail = text.slice(lastColon + 1);
    if (net.isIPv4(tail)) {
        const [a, b, c, d] = tail.split(".").map(Number);
        text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }

    const halves = text.split("::");
    if (halves.length > 2) return null;

    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;

    if (halves.length === 1 && missing !== 0) return null;
    if (halves.length === 2 && missing < 1) return null;

    for (const part of [...head, ...Array(Math.max(missing, 0)).fill("0"), ...rest]) {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        groups.push(parseInt(part, 16));
    }

    return groups.length === 8 ? groups : null;
}

/**
 * Indica se um IP (v4 ou v6) pertence a uma faixa não pública.
 * Endereços inválidos são considerados bloqueados.
 * @param {string} address
 */
export function isBlockedAddress(address) {
    const clean = String(address).replace(/^\[|\]$/g, "").split("%")[0];
    const family = net.isIP(clean);

    if (family === 4) {
        return ipv4BlockList.check(clean, "ipv4");
    }

    if (family !== 6) return true;

    const groups = expandIPv6(clean);
    if (!groups) return true;

    // IPv4 mapeado (::ffff:a.b.c.d): avaliar como IPv4.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        const v4 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
        return ipv4BlockList.check(v4, "ipv4");
    }

    return ipv6BlockList.check(clean, "ipv6");
}

/**
 * @param {URL} url
 * @param {Readonly<UrlPolicy>} policy
 */
export function isTestLoopbackOrigin(url, policy) {
    return exemptLoopbackOrigins(policy).includes(url.origin);
}

/** Origens loopback isentas explicitamente (testes ou prévia local). */
export function exemptLoopbackOrigins(policy) {
    return [...policy.testLoopbackOrigins, ...(policy.previewOrigins ?? [])];
}

/** A URL pertence à prévia local autorizada? */
export function isPreviewOrigin(url, policy) {
    return (policy.previewOrigins ?? []).includes(url.origin);
}

/**
 * Validação estática de uma URL de destino.
 * @param {string | URL} input
 * @param {Readonly<UrlPolicy>} [policy]
 * @returns {URL}
 */
export function parseTargetUrl(input, policy = DEFAULT_POLICY) {
    const text = String(input ?? "").trim();

    if (!text || text.length > MAX_URL_LENGTH) {
        throw new ReferenceEngineError(
            ErrorCodes.URL_INVALID,
            "URL vazia ou longa demais",
            { length: text.length }
        );
    }

    let url;
    try {
        url = new URL(text);
    } catch {
        throw new ReferenceEngineError(ErrorCodes.URL_INVALID, "URL inválida");
    }

    if (isTestLoopbackOrigin(url, policy)) {
        return url;
    }

    const schemes = policy.allowHttp ? ["https:", "http:"] : ["https:"];
    if (!schemes.includes(url.protocol)) {
        throw new ReferenceEngineError(
            ErrorCodes.URL_SCHEME_BLOCKED,
            `Esquema não permitido: ${url.protocol}`,
            { protocol: url.protocol }
        );
    }

    if (url.username || url.password) {
        throw new ReferenceEngineError(
            ErrorCodes.URL_CREDENTIALS,
            "URLs com credenciais não são aceitas"
        );
    }

    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!policy.allowedPorts.includes(port)) {
        throw new ReferenceEngineError(
            ErrorCodes.URL_PORT_BLOCKED,
            `Porta não permitida: ${port}`,
            { port }
        );
    }

    // O parser WHATWG já normaliza IPv4 em decimal/hex/octal.
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    const literal = host.replace(/^\[|\]$/g, "");

    if (net.isIP(literal)) {
        if (isBlockedAddress(literal)) {
            throw new ReferenceEngineError(
                ErrorCodes.ADDRESS_BLOCKED,
                `Endereço não público: ${literal}`,
                { address: literal }
            );
        }
        return url;
    }

    if (
        BLOCKED_HOSTNAMES.has(host) ||
        BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
        !host.includes(".")
    ) {
        throw new ReferenceEngineError(
            ErrorCodes.HOST_BLOCKED,
            `Host interno ou não qualificado: ${host}`,
            { host }
        );
    }

    return url;
}

/**
 * Cria uma função `lookup` compatível com `net`/`http` que recusa
 * endereços não públicos no momento da conexão.
 *
 * @param {{ lookup?: typeof dns.lookup }} [options]
 */
export function createGuardedLookup({ lookup = dns.lookup } = {}) {
    /**
     * @param {string} hostname
     * @param {object | Function} options
     * @param {Function} [callback]
     */
    return function guardedLookup(hostname, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        const wantsAll = Boolean(options?.all);

        lookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) {
                callback(
                    new ReferenceEngineError(
                        ErrorCodes.DNS_FAILED,
                        `Falha de DNS para ${hostname}`,
                        { host: hostname, cause: error.code }
                    )
                );
                return;
            }

            const list = Array.isArray(addresses) ? addresses : [];
            if (list.length === 0) {
                callback(
                    new ReferenceEngineError(
                        ErrorCodes.DNS_FAILED,
                        `Nenhum endereço para ${hostname}`,
                        { host: hostname }
                    )
                );
                return;
            }

            // Basta um endereço privado para recusar o host inteiro.
            const blocked = list.find((entry) => isBlockedAddress(entry.address));
            if (blocked) {
                callback(
                    new ReferenceEngineError(
                        ErrorCodes.ADDRESS_BLOCKED,
                        `${hostname} resolve para endereço não público`,
                        { host: hostname, address: blocked.address }
                    )
                );
                return;
            }

            if (wantsAll) {
                callback(null, list);
            } else {
                callback(null, list[0].address, list[0].family);
            }
        });
    };
}

/**
 * Resolve e valida o host de uma URL (usado para diagnóstico na CLI).
 * @param {URL} url
 * @param {{ lookup?: typeof dns.lookup }} [options]
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
export function resolvePublicAddresses(url, options = {}) {
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal)) {
        if (isBlockedAddress(literal)) {
            return Promise.reject(
                new ReferenceEngineError(
                    ErrorCodes.ADDRESS_BLOCKED,
                    `Endereço não público: ${literal}`,
                    { address: literal }
                )
            );
        }
        return Promise.resolve([{ address: literal, family: net.isIP(literal) }]);
    }

    const guarded = createGuardedLookup(options);
    return new Promise((resolve, reject) => {
        guarded(url.hostname, { all: true }, (error, addresses) =>
            error ? reject(error) : resolve(addresses)
        );
    });
}
