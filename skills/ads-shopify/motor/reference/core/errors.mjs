/**
 * Erros tipados do Reference Engine.
 *
 * Toda falha esperada (política, rede, limites, acesso) é lançada como
 * ReferenceError com um `code` estável, para que CLI, testes e etapas
 * seguintes tratem cada caso explicitamente.
 */

export const ErrorCodes = Object.freeze({
    URL_INVALID: "URL_INVALID",
    URL_SCHEME_BLOCKED: "URL_SCHEME_BLOCKED",
    URL_CREDENTIALS: "URL_CREDENTIALS",
    URL_PORT_BLOCKED: "URL_PORT_BLOCKED",
    HOST_BLOCKED: "HOST_BLOCKED",
    ADDRESS_BLOCKED: "ADDRESS_BLOCKED",
    DNS_FAILED: "DNS_FAILED",
    REDIRECT_BLOCKED: "REDIRECT_BLOCKED",
    REDIRECT_LIMIT: "REDIRECT_LIMIT",
    TIMEOUT: "TIMEOUT",
    RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
    NETWORK_ERROR: "NETWORK_ERROR",
    ACCESS_RESTRICTED: "ACCESS_RESTRICTED",
    ROBOTS_DISALLOWED: "ROBOTS_DISALLOWED",
    ARTIFACT_PATH_INVALID: "ARTIFACT_PATH_INVALID",
    ARTIFACT_EXISTS: "ARTIFACT_EXISTS",
    ARTIFACT_TOO_LARGE: "ARTIFACT_TOO_LARGE",
    RUN_ROOT_FORBIDDEN: "RUN_ROOT_FORBIDDEN",
    // Captura (M2)
    NAVIGATION_FAILED: "NAVIGATION_FAILED",
    HTTP_ERROR: "HTTP_ERROR",
    CHALLENGE_DETECTED: "CHALLENGE_DETECTED",
    RESOURCE_LIMIT: "RESOURCE_LIMIT",
    BROWSER_ERROR: "BROWSER_ERROR",
    CAPTURE_INVALID: "CAPTURE_INVALID",
    METHOD_BLOCKED: "METHOD_BLOCKED",
    // Análise (M3)
    RUN_INVALID: "RUN_INVALID",
    RUN_NOT_OK: "RUN_NOT_OK",
    ARTIFACT_MISSING: "ARTIFACT_MISSING",
    ARTIFACT_TAMPERED: "ARTIFACT_TAMPERED",
    VIEWPORT_MISSING: "VIEWPORT_MISSING",
    CAPTURE_INCONSISTENT: "CAPTURE_INCONSISTENT",
    BLUEPRINT_INVALID: "BLUEPRINT_INVALID",
    // Geração (M4)
    GENERATION_INVALID: "GENERATION_INVALID",
    THEME_WRITE_FAILED: "THEME_WRITE_FAILED",
    CONTENT_INVALID: "CONTENT_INVALID",
    ASSET_INVALID: "ASSET_INVALID",
});

export class ReferenceEngineError extends Error {
    /**
     * @param {keyof typeof ErrorCodes} code
     * @param {string} message
     * @param {Record<string, unknown>} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = "ReferenceEngineError";
        this.code = code;
        this.details = details;
    }
}

/**
 * @param {unknown} error
 * @param {string} code
 */
export function isEngineError(error, code) {
    return (
        error instanceof ReferenceEngineError &&
        (code === undefined || error.code === code)
    );
}
