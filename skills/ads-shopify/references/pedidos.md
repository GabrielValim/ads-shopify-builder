# Pedidos de melhoria

1. **Entender**: traduza o pedido para regiões da página (`loja estado` lista as regiões da referência e onde cada uma está no tema).
   "Cabeçalho" = header; "topo/banner/primeira dobra" = hero; "celular" = viewport mobile da mesma região.
2. **Medir**: `ferramenta especificacao <captura> <y0> <y1> <projeto>/trabalho/<região>/especificacao.json --mobile <y0> <y1>`
   (y = posições da região na captura, de `componentes.json` do projeto).
3. **Menor mudança**:
   a) ajustar configurações da seção no `tema/templates/index.json` (ou grupo do cabeçalho/rodapé);
   b) instalar um componente da biblioteca (`loja instalar <p> ads-hero-dividido|ads-faixa-icones --regiao section-NN`)
      e configurá-lo com os valores medidos, mantendo o conteúdo que já estava na região;
   c) só se nada servir, escrever uma seção `tema/sections/ads-<nome>.liquid` seguindo `references/regras.md`.
   Altere só os arquivos da região pedida.
4. **Provar**: `ferramenta previa` + `ferramenta comparar`; mostre o lado a lado e a tabela de desvios; itere 1–3 vezes
   pelos desvios corrigíveis.
5. **Validar e versionar**: `loja validar`, `loja versao --nota … --solicitacao "<pedido literal>"`.
6. **Levar ao rascunho**: autorização vigente → `loja atualizar`; senão, pergunte.
7. **Responder**: o que mudou, números, o que ainda difere e por quê, links.
