/**
 * CF-01 — DADOS do render Liquid: rotas padrão da Shopify (objeto `routes`) e o menu local demonstrativo. Separados de
 * liquid-lite.mjs para que a ferramenta de pré-verificação exportada à área do agente leve só os NOMES das rotas (o
 * validador confere `routes.<nome>`), sem valores de render. Conteúdo idêntico ao de antes da separação.
 */
export const ROUTES = Object.freeze({ root_url: "/", account_url: "/account", account_login_url: "/account/login", account_register_url: "/account/register", account_logout_url: "/account/logout", search_url: "/search", predictive_search_url: "/search/suggest", cart_url: "/cart", cart_add_url: "/cart/add", cart_change_url: "/cart/change", cart_clear_url: "/cart/clear", cart_update_url: "/cart/update", collections_url: "/collections", all_products_collection_url: "/collections/all", product_recommendations_url: "/recommendations/products" });
export const DEMO_LINKLIST = Object.freeze(["Início|/", "Catálogo|/collections/all", "Coleções|/collections", "Busca|/search", "Minha conta|/account"]);
