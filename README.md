# ADS Shopify Builder

Crie uma loja Shopify editável a partir de um site de referência, conversando com o Claude.

Você informa um site e a sua loja. O Claude analisa o site, gera um tema completo (baseado no Dawn), cria um
**rascunho não publicado** na sua loja — só com a sua autorização — e aplica no mesmo rascunho os ajustes que você pedir.

Versão 0.3.1 · Skill para o Claude Code (inclusive a aba **Code** do Claude Desktop) · licença MIT

## 1. Instalar

```bash
npx skills add GabrielValim/ads-shopify-builder --skill ads-shopify -a claude-code -g -y
```

Ou pela interface do Claude Desktop: **Personalizar → Plugins → Adicionar → Adicionar marketplace** →
`GabrielValim/ads-shopify-builder` → instalar **ADS Shopify Builder**.

Requisitos: Claude Code em sessão **local** (no Chat e no Cowork a Skill só orienta), **Node.js 22.12+** e internet na
primeira vez (cerca de 300 MB de ferramentas, baixadas uma vez).

## 2. Começar

Abra uma sessão local (Claude Desktop → **Code** → Nova sessão → **Local**) e escreva:

> Crie uma loja Shopify baseada em https://site-de-referencia.com.br/

Na primeira vez, o Claude prepara as ferramentas sozinho — aprove os pedidos de permissão.

## 3. Conectar a Shopify

Informe o endereço da loja (`sua-loja.myshopify.com`, em **Configurações → Domínios** no admin). Uma página da Shopify
abre no navegador com um código: **confira se é o mesmo que o Claude mostrou** e aprove com a conta da loja.
O Claude confirma a loja e o tema publicado — que **nunca é alterado**.

## 4. Primeiro rascunho

O Claude gera o tema no seu computador e mostra o que ficou e o que não ficou parecido. Para enviar, **escreva que
autoriza** a criação do rascunho. Você recebe os links de **prévia** e do **editor de temas**. Depois, peça ajustes em
linguagem normal ("deixe o topo mais parecido"); para atualizar o mesmo rascunho, o Claude pede uma nova autorização.

## Proteções

- Só cria temas **novos e não publicados**; nunca publica, exclui ou altera o tema ativo.
- Nada é enviado à loja sem **autorização escrita**; atualizações fazem **backup** antes e **preservam** o que você mudou no editor.
- Login pelo navegador, na página da própria Shopify — sem tokens ou senhas.
- Textos, imagens e logotipos do site de referência **não são copiados**; o tema usa textos de exemplo editáveis.
- Projetos ficam no seu computador (pasta `ADS-AutoStore`); nada é enviado ao autor do ADS.

## Atualizar e remover

- Atualizar: `npx skills update ads-shopify -g` (ou atualize o plugin em Personalizar → Plugins).
- Remover: `npx skills remove ads-shopify -g`; para apagar os dados locais, remova a pasta `ADS-AutoStore`.

O [Skills CLI](https://github.com/vercel-labs/skills) envia dados anônimos de uso; para desativar, use `DISABLE_TELEMETRY=1`.

## Limitações

Não é uma cópia idêntica do site de referência: estrutura e estilo são medidos e reproduzidos, conteúdo de terceiros não.
Funciona no Claude Code local; Chat e Cowork não acessam o seu computador.

## Licença

Código do ADS: [MIT](LICENSE). Componentes de terceiros têm licenças próprias — veja
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). O tema **Dawn** não faz parte deste repositório: é baixado da fonte
oficial da Shopify na preparação, verificado por hash, e segue a licença da Shopify.
