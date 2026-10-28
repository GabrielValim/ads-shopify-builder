# Fluxo técnico (para o Claude)

Todos os comandos: `node ${CLAUDE_SKILL_DIR}/scripts/ads.mjs <comando> …`, de qualquer pasta (não faça `cd` para a Skill).
Área de trabalho fixa: `~/ADS-AutoStore` (`.ads/` = motor e navegador; `lojas/<projeto>/` = projetos; `ambiente` mostra o caminho).

| etapa | comando | observações |
|---|---|---|
| diagnóstico | `ambiente --url <referência>` | última linha = JSON (`sandbox`, `nodeOk`, `preparado`, `loja`) |
| preparação | `preparar` | npm ci + Chromium; 2–6 min; rode em segundo plano se preciso |
| login | `conectar --loja <x.myshopify.com>` | abre o navegador; mostra código e link |
| conexão | `conexao --loja <x.myshopify.com>` | `CONECTADO` → loja e publicado gravados; `AGUARDANDO` → espere e repita |
| projeto | `loja iniciar <p> --url <referência>` | captura (robots.txt respeitado) → análise → tema → validação → v001 |
| estado | `loja estado <p>` | versões, rascunho, autorização, regiões, pendências |
| validação | `loja validar <p>` | tema inteiro; obrigatório antes de versão |
| versão | `loja versao <p> --nota "…" --solicitacao "<pedido literal>"` | só com validação OK |
| componente | `loja instalar <p> ads-hero-dividido --regiao section-NN` | biblioteca: `ads-hero-dividido`, `ads-faixa-icones` |
| preflight | `loja preflight <p>` | Shopify só leitura; fixa o publicado da conexão |
| autorização | `loja autorizar <p> --operacao criar|atualizar --citacao "…" [--horas N] [--uso-unico] [--arquivos a,b]` | só com palavras da pessoa |
| envio | `loja enviar <p>` | tema NOVO `--unpublished`; confere por pull; registra ID |
| atualização | `loja atualizar <p>` | backup → editor preservado → só alterados → conferência |
| desfazer | `loja rollback <p> vNNN` | nova versão com o conteúdo antigo; depois `atualizar` |
| links | `loja abrir <p>` | prévia e editor |
| medir região | `ferramenta especificacao <captura> <y0> <y1> <saída.json> --mobile <y0> <y1>` | captura em `.ads/motor/runs/<domínio>/<execução>` |
| prévia local | `ferramenta previa <seção.liquid> <template.json> <saída> --chave <seção> [--tema tema.json]` | só seções `ads-*` |
| comparar | `ferramenta comparar <captura> <especificação> <prévia> <saída>` | lado a lado, diferenças, tabela |

Caminhos de projeto para as ferramentas: `~/ADS-AutoStore/lojas/<p>/tema/…` e `~/ADS-AutoStore/lojas/<p>/trabalho/…`; captura: `~/ADS-AutoStore/.ads/motor/<referencia.captura do projeto>`.
Mostre imagens de comparação lendo os PNG gerados (`lado-a-lado-desktop.png`, `lado-a-lado-mobile.png`).
