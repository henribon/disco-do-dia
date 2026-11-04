# disco-do-dia

Os discos do **Disco do Dia** (a base do Notion) em ordem de nota, com capa e
link direto pro Spotify. Sem backend, sem build — irmã da
[listening-spotify](https://bonbap.com.br/listening-spotify/).

Pra publicar em <https://bonbap.com.br/disco-do-dia/>.

## Como funciona

Um GitHub Action roda toda madrugada, lê a base do Notion, busca as capas e
grava `data/discos.json`. O Pages serve o arquivo e a página monta a lista.

```
index.html          # a página (CSS e JS embutidos)
scripts/update.mjs  # roda no Action: Notion -> data/discos.json
data/discos.json    # o que a página consome
```

### O que o script faz com a base

A base é preenchida na mão e carrega duas marcas disso:

**Discos repetidos.** Houve uma importação em lote que recadastrou dezenas de
álbuns que já estavam lá, sem nota — o mesmo disco aparece duas vezes, uma com
nota e uma sem. O script junta as duplicatas pelo id do álbum no Spotify, que é
o mesmo mesmo quando o nome está escrito diferente (`Saci Perere` e
`Saci Pererê`, `SAMBA BLIM` e `Samba Blim`). Fica a linha que tem nota, e os
campos vazios dela são preenchidos com o que a outra tiver.

Das 84 linhas da base saem 69 discos.

**Discos sem nota.** Alguns foram só anotados pra escutar depois. Esses não
entram no ranking: ficam numa lista separada no pé da página, em ordem de
quando entraram.

> Quem tem id diferente continua separado, mesmo com nome parecido — o script
> não tenta adivinhar que `Os Ticoãs` e `Os Tincoãs` são o mesmo disco, porque
> às vezes não são. Pra juntar, é só deixar o mesmo link nas duas linhas do
> Notion.

### Os links

O Notion guarda o link como ele saiu do "copiar link" da Spotify, com o
`?si=` grudado no fim — um token de rastreio da sessão de quem copiou. O
script corta a query antes de qualquer outra coisa, então o que vai pro ar é
só `open.spotify.com/.../album/<id>`.

Isso não mexe na deduplicação: o id do álbum é extraído por regex que para no
`?`, então link sujo e link limpo sempre casaram. É só pra não publicar
rastreio alheio.

### As capas

Vêm do oEmbed público da Spotify (`open.spotify.com/oembed`), que não pede
autenticação — por isso aqui não tem secret de Spotify nenhum. As capas que já
estão no JSON anterior são reaproveitadas, então a execução diária só busca
capa de disco novo.

Disco sem `Link` no Notion fica sem capa e sem clique: aparece com um ♪ no
lugar. Hoje são dois, `Saudade` e `Nightingale` — é só pôr o link na base.

### A nota

É o número cru do Notion. Nota 9 pra cima acende em branco, o resto fica
cinza. A escala não é checada em lugar nenhum: o `Di Melo` está com 11 e a
página mostra 11.

## Setup

### 1. Cria a integração no Notion

Em <https://www.notion.so/profile/integrations>, **New integration**, escopo de
leitura. Copia o *Internal Integration Secret* (começa com `ntn_`).

Depois **abre a página Disco do Dia no Notion** e dá acesso a ela: menu `...` →
*Connections* → *Connect to* → a integração que você acabou de criar. Sem esse
passo o token existe mas não enxerga nada, e o Action falha com 404.

### 2. Guarda o secret

```bash
gh secret set NOTION_TOKEN
```

O prompt pede o valor. Ou clicando: **Settings → Secrets and variables →
Actions → New repository secret**.

O id da base já está fixo no `scripts/update.mjs`. Pra apontar pra outra, usa a
variável de ambiente `NOTION_DATABASE_ID`.

### 3. Liga o Pages e roda a primeira coleta

- **Settings → Pages** → Source: *Deploy from a branch* → `main` / `/ (root)`.
- **Actions → Atualiza os discos do Notion → Run workflow**, pra não esperar
  até de madrugada.

Como o CNAME `bonbap.com.br` está no repo de user site (`henribon.github.io`),
este project site é servido em `bonbap.com.br/disco-do-dia/` — mesmo domínio,
então a página busca o JSON por caminho relativo.

### 4. Linka no bonbap.com.br

Já está feito: a home tem a porta **Música** abrindo as duas páginas, no mesmo
padrão do `Loja e Conteúdos`. Fica registrado aqui porque o `index.html` da
home mora em outro repo (`henribon.github.io`) e isto aqui é o único lugar que
conta a história inteira.

```html
<button class="door door--toggle reveal" style="--d:.36s" type="button"
        aria-expanded="false" aria-controls="musica" data-toggle>
  <span class="label">Música</span>
  <span class="arr arr--down" aria-hidden="true">&#8595;</span>
</button>

<div class="sub" id="musica" hidden>
  <a class="leaf" href="/disco-do-dia/">
    <span class="label">Disco do Dia</span>
    <span class="arr" aria-hidden="true">&#8599;</span>
  </a>
  <a class="leaf" href="/listening-spotify/">
    <span class="label">Ouvindo no Spotify</span>
    <span class="arr" aria-hidden="true">&#8599;</span>
  </a>
</div>
```

O script da home precisou de um ajuste junto: ele pegava
`querySelector('[data-toggle]')`, no singular, e só ligava a primeira porta —
com duas, a `Loja e Conteúdos` pararia de abrir. Agora percorre todas com
`querySelectorAll`. Se algum dia entrar uma terceira porta dessas, já funciona.

## Mexer na página sem token

`DISCOS_FROM` faz o script pular o Notion e ler um dump da base, pra testar
layout offline:

```bash
DISCOS_FROM=dump.json node scripts/update.mjs
```

O dump é um array no formato que a API do Notion devolve depois de mapeado —
`{ Nome, Artista, Nota, Link, Genero, "Criado em" }` por linha.

## Notas

- A ordem de empate é por data: entre dois discos nota 10, o mais recente fica
  em cima.
- O filtro de gênero não refaz o ranking. Filtrar por JAZZ mostra o `Maestro`
  como 6º, que é a posição dele na lista inteira — não como 1º.
- Os gêneros dos chips saem da própria base, ordenados por quantos discos têm
  cada um. Gênero que ninguém usa não vira chip.
