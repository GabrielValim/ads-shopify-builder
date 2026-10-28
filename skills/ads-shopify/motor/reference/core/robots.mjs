/**
 * Avaliação de robots.txt (RFC 9309) para o token do Reference Engine.
 *
 * Decisões:
 *  - 2xx: interpretar as regras.
 *  - 404/410 e demais 4xx: sem restrições (RFC 9309, "unavailable").
 *  - 401/403: tratados como bloqueio total. Mais conservador que a RFC,
 *    para nunca prosseguir quando o site restringe acesso.
 *  - 5xx, falha de rede, timeout ou redirecionamento recusado: bloqueio
 *    total (RFC 9309, "unreachable").
 */

import { ErrorCodes, ReferenceEngineError } from "./errors.mjs";
import { ROBOTS_TOKEN, safeGet } from "./safe-fetch.mjs";

const MAX_ROBOTS_BYTES = 512 * 1024;

/**
 * @typedef {{ type: "allow" | "disallow", path: string }} RobotsRule
 * @typedef {{ agents: string[], rules: RobotsRule[] }} RobotsGroup
 */

/**
 * @param {string} text
 * @returns {RobotsGroup[]}
 */
export function parseRobots(text) {
    /** @type {RobotsGroup[]} */
    const groups = [];
    /** @type {RobotsGroup | null} */
    let current = null;
    let lastWasAgent = false;

    for (const rawLine of String(text).split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        const separator = line.indexOf(":");
        if (separator <= 0) continue;

        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();

        if (key === "user-agent") {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }

        if (key === "allow" || key === "disallow") {
            lastWasAgent = false;
            if (!current) continue; // regra fora de grupo
            current.rules.push({ type: key, path: value });
            continue;
        }

        // sitemap, crawl-delay etc. não encerram o grupo.
    }

    return groups;
}

/**
 * @param {RobotsGroup[]} groups
 * @param {string} [token]
 * @returns {RobotsRule[]}
 */
export function rulesFor(groups, token = ROBOTS_TOKEN) {
    const wanted = token.toLowerCase();
    const specific = groups.filter((group) => group.agents.includes(wanted));
    const chosen = specific.length
        ? specific
        : groups.filter((group) => group.agents.includes("*"));
    return chosen.flatMap((group) => group.rules);
}

function patternToRegExp(pattern) {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/**
 * Regra mais específica (maior padrão) vence; empate favorece `allow`.
 * @param {RobotsRule[]} rules
 * @param {string} pathWithQuery
 */
export function isPathAllowed(rules, pathWithQuery) {
    if (pathWithQuery === "/robots.txt") return true;

    let best = null;
    for (const rule of rules) {
        if (!rule.path) continue; // "Disallow:" vazio não restringe
        if (!patternToRegExp(rule.path).test(pathWithQuery)) continue;

        if (
            !best ||
            rule.path.length > best.path.length ||
            (rule.path.length === best.path.length && rule.type === "allow")
        ) {
            best = rule;
        }
    }

    return !best || best.type === "allow";
}

/**
 * @typedef {object} RobotsDecision
 * @property {boolean} allowed
 * @property {"rules" | "missing" | "restricted" | "unreachable"} source
 * @property {string} robotsUrl
 * @property {number | null} status
 * @property {string} [reason]
 * @property {boolean} [truncated]
 */

/**
 * Busca o robots.txt da origem e decide se o caminho pode ser acessado.
 * @param {URL} target
 * @param {import("./safe-fetch.mjs").SafeGetOptions} [fetchOptions]
 * @returns {Promise<RobotsDecision>}
 */
export async function checkRobots(target, fetchOptions = {}) {
    const robotsUrl = new URL("/robots.txt", target.origin).href;
    const path = `${target.pathname}${target.search}`;

    let response;
    try {
        response = await safeGet(robotsUrl, {
            timeoutMs: 8_000,
            ...fetchOptions,
            maxBytes: MAX_ROBOTS_BYTES,
            onLimit: "truncate",
            maxRedirects: 5,
            accept: "text/plain,*/*;q=0.1",
        });
    } catch (error) {
        if (!(error instanceof ReferenceEngineError)) throw error;
        return {
            allowed: false,
            source: "unreachable",
            robotsUrl,
            status: null,
            reason: error.code,
        };
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
        const rules = rulesFor(parseRobots(response.body.toString("utf8")));
        const allowed = isPathAllowed(rules, path);
        return {
            allowed,
            source: "rules",
            robotsUrl,
            status,
            truncated: response.truncated,
            ...(allowed ? {} : { reason: ErrorCodes.ROBOTS_DISALLOWED }),
        };
    }

    if (status === 401 || status === 403) {
        return {
            allowed: false,
            source: "restricted",
            robotsUrl,
            status,
            reason: ErrorCodes.ACCESS_RESTRICTED,
        };
    }

    if (status >= 400 && status < 500) {
        return { allowed: true, source: "missing", robotsUrl, status };
    }

    return {
        allowed: false,
        source: "unreachable",
        robotsUrl,
        status,
        reason: `HTTP_${status}`,
    };
}
