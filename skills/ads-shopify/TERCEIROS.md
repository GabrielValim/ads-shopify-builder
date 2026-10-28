# Componentes de terceiros

- **Dawn 16.0.0** (Copyright (c) 2021-present Shopify Inc.) — **não incluído neste pacote**. Na preparação, é baixado do repositório oficial da Shopify (github.com/Shopify/dawn, commit 258f00f64365e2018ca4c62778a6bf55a5d3cd18) e cada arquivo é conferido com `motor/themes/dawn.sha256.json`.
  Rege-se pela licença da Shopify (`LICENSE.md` do próprio Dawn), não pela licença MIT do ADS: permite usar, copiar, modificar e distribuir **somente para desenvolver temas que se integrem ou interoperem com a Shopify**, mantendo o aviso de copyright e de permissão. Os temas gerados pelo ADS derivam do Dawn e seguem essa licença.
- **Dependências npm** (não incluídas; instaladas na máquina do usuário pela preparação, versões fixas no `package-lock.json`): playwright 1.64.0 (Apache-2.0), zod 4.6.7 (MIT), @shopify/cli 4.9.4 (MIT) e suas dependências (MIT, ISC, BSD-3-Clause, Apache-2.0).
- **Navegador sem janela** (Chrome for Testing headless shell) baixado pelo Playwright na preparação, sob os termos do próprio distribuidor; não incluído.
