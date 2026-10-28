# Limites conhecidos (versão 0.1.0)

- **Chat e Cowork**: sem acesso ao computador nem à internet em geral → não capturam a referência, não instalam o motor
  e não enviam o tema. O fluxo completo roda na aba **Code** do Claude Desktop (sessão local), sem terminal.
- **Conector oficial Shopify**: usado só para leitura nesta versão; a escrita de temas por ele não foi verificada.
- **Prévia local**: só seções `ads-*`; seções padrão do Dawn aparecem apenas na prévia do rascunho na Shopify.
- **Fidelidade**: estrutura e estilo medidos; imagens, logos e textos de terceiros nunca são copiados; fontes dependem
  do catálogo de fontes da Shopify.
- **Arquivos removidos** localmente continuam no rascunho (envio sem exclusão).
- **Requisitos**: Node ≥ 22.12 e internet na preparação (npm e navegador sem janela do Playwright, cerca de 300 MB).
