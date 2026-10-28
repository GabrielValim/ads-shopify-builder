# Conexão com a Shopify

## Métodos
| método | o que está verificado | uso nesta versão |
|---|---|---|
| **Shopify CLI** (instalada pela preparação, login pelo navegador com código de ativação) | listar temas, criar tema não publicado, atualizar arquivos de um tema não publicado, baixar para conferência | **operações de tema** (criar, atualizar, conferir) |
| **Conector oficial Shopify para Claude** (`Shopify`, publicado pela Shopify) | segundo a Shopify: lê dados da loja; edita temas **não publicados**; não publica nem exclui temas; pede confirmação antes de mudanças por GraphQL | identificação da loja e verificação de leitura; escrita de tema **ainda não verificada** — não usar para escrever |

Nunca peça token, senha ou chave. Nunca crie integração própria.

## A. Verificação pelo conector oficial (opcional, só leitura)
Se ferramentas do conector Shopify estiverem disponíveis nesta conversa (ex.: `get-shop-info`, `graphql_query`):
1. `get-shop-info` → confirme o domínio `*.myshopify.com` com a pessoa.
2. `graphql_query` (somente leitura):
   ```graphql
   { shop { name myshopifyDomain } themes(first: 50) { nodes { id name role processing } }
     currentAppInstallation { accessScopes { handle } } }
   ```
   Relate: loja, tema publicado (`role: MAIN`), quantidade de temas, e se `read_themes` / `write_themes` aparecem.
3. Não execute `graphql_mutation` de tema. A escrita pelo conector será habilitada numa versão futura, depois de verificada.
Se o conector não estiver ativo, siga só com a CLI.

## B. Conexão pela Shopify CLI (padrão)
1. `conectar --loja <x.myshopify.com>`: o navegador abre em accounts.shopify.com com um código. Peça para a pessoa
   conferir que o código da página é o mesmo e aprovar com a conta que administra a loja.
2. `conexao --loja …` até `CONECTADO`. Confirme a loja e o tema publicado com a pessoa.
3. A sessão fica guardada pela própria Shopify CLI no computador da pessoa. Para trocar de conta ou de loja, ou quando a
   pessoa pedir para desconectar: `desconectar` (logout da CLI) e conecte de novo. Nunca manipule arquivos de sessão.

## C. Falhas
- `enviar` parcial (a Shopify recusou arquivos): o rascunho existe mas está incompleto. Pare, mostre o motivo
  (mensagem da Shopify), corrija localmente, crie nova versão e peça autorização de **atualizar** só os arquivos que faltam
  (`--uso-unico --arquivos a,b`). Nunca crie outro tema para "tentar de novo".
- `atualizar` com conflito: a mesma parte foi editada no Theme Editor e no pedido. Pare e pergunte qual manter.
- Lista de temas mudou de forma inesperada ou tema publicado diferente: nada é enviado; explique.
