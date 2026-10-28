# Changelog

## 0.3.1 — correção de compatibilidade com Windows
Seis defeitos impediam a Skill de completar o fluxo em Windows. Nenhum deles aparece em macOS ou Linux.
Nenhuma mudança de comportamento nessas plataformas: as correções usam as funções de caminho do próprio Node.

- `reference/core/safe-read.mjs`: `readStandaloneFile` separava diretório e nome cortando a string no `/`.
  Em Windows (`\`) o nome resultante era o caminho inteiro e caía na validação de nome simples
  (`ARTIFACT_PATH_INVALID`), bloqueando a leitura do ContentPack e, com ela, toda a geração.
  Agora usa `dirname`/`basename`.
- `ads/scripts/projeto.mjs`: a extração do diretório do tema gerado exigia `/theme` na saída do `generate`.
  Em Windows a saída traz `\theme` e o projeto abortava com “geração sem diretório” mesmo com o tema pronto.
  O padrão agora aceita os dois separadores.
- `reference/preview/verify-theme.mjs`: `analysisRunAvailable` obtinha o host com `dir.split("/")`.
  Em Windows o resultado era `undefined` e o `join` lançava `ERR_INVALID_ARG_TYPE`. Agora usa `basename(dirname(...))`.
- `reference/compare/compare.mjs`: mesmo padrão em `previousComparisons` (histórico de comparações).
- `ads/scripts/*.mjs`: `import()` dinâmico recebia caminho absoluto do Windows e o Node recusava
  com `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`Received protocol 'c:'`). Os 10 pontos passam por `pathToFileURL`.
- CLI da Shopify: o motor a invocava pelo nome (`shopify`), que não está no PATH — ela é dependência do próprio
  motor — e em Windows é um atalho `.cmd` que o `execFile` não executa. Afetava `theme check`, `preflight`,
  `enviar` e `atualizar`. Agora o entrypoint JS (`@shopify/cli/bin/run.js`) é executado com o Node atual,
  sem shell e sem depender do PATH. O ambiente repassado aos processos filhos também passou a incluir as
  variáveis que o Windows exige e que a CLI usa para localizar a sessão de login
  (`SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `PATHEXT`, `COMSPEC`, `TEMP`, `TMP`).

## 0.3.0 — primeira versão pública
- Licença MIT para o código do ADS (Copyright (c) 2026 Gabriel Valim); terceiros em THIRD_PARTY_NOTICES.md.
- O Dawn deixa de acompanhar o pacote: é baixado do repositório oficial da Shopify na preparação e verificado por sha256.
- README simplificado: instalar, conectar a Shopify, primeiro rascunho.

## 0.2.0
- Distribuição pelo GitHub: instalação por `npx skills add` e como plugin (marketplace) do Claude Code / Claude Desktop.
- Aviso de terceiros corrigido: o Dawn usa a licença da Shopify (não MIT); lista de licenças das dependências.
- Atualização da Skill troca o código do motor local preservando capturas e projetos.
- `.gitattributes` impede conversão de fim de linha (os arquivos do Dawn são verificados por hash).

## 0.1.0
- Primeira versão instalável por ZIP: geração de tema completo, validação, rascunho não publicado, atualização do mesmo
  rascunho com backup e preservação do Theme Editor, versões e desfazer.
