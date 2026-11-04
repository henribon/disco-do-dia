/**
 * Roda no GitHub Actions. Le a base DiscoDoDia do Notion e escreve o JSON
 * que a pagina consome.
 *
 * A base e preenchida na mao, um disco por dia, e carrega duas marcas disso:
 *
 *   1. Discos repetidos. Houve uma importacao em lote que recadastrou dezenas
 *      de albuns que ja estavam la, sem nota. O mesmo disco aparece duas
 *      vezes, uma com a nota e uma sem.
 *   2. Discos sem nota. Alguns foram so anotados pra escutar depois.
 *
 * Entao o script nao copia a base: ele junta as duplicatas pelo id do album
 * no Spotify (o mesmo disco tem o mesmo id, mesmo com o nome escrito
 * diferente) e separa quem tem nota de quem nao tem.
 *
 * As capas vem do oEmbed publico da Spotify, que nao pede autenticacao. As
 * que ja estao no JSON anterior sao reaproveitadas, entao a execucao semanal
 * so busca capa de disco novo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Base DiscoDoDia em https://app.notion.com/.../27de6c681b6880da96d3e3ed41ce30c6 */
const DATABASE_ID = process.env.NOTION_DATABASE_ID ?? '27de6c68-1b68-80da-96d3-e3ed41ce30c6';
const NOTION_VERSION = '2022-06-28';

/** Quantas capas buscar ao mesmo tempo. A Spotify nao publica o limite do oEmbed. */
const CONCORRENCIA = 6;

const DATA_DIR = path.join(process.cwd(), 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'discos.json');

/* ------------------------------------------------------------------ Notion */

async function buscaNotion() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('Falta o secret NOTION_TOKEN.');
    process.exit(1);
  }

  const linhas = [];
  let cursor;

  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });

    const body = await r.json();

    if (r.status === 404) {
      // O token existe mas a integracao nao foi convidada pra pagina.
      console.error(
        'O Notion devolveu 404. A integracao provavelmente nao tem acesso a base:\n' +
        'abre a pagina Disco do Dia no Notion, menu "..." -> Connections -> e\n' +
        'adiciona a integracao do NOTION_TOKEN.',
      );
      process.exit(1);
    }
    if (!r.ok) throw new Error(`Notion -> ${r.status} ${JSON.stringify(body)}`);

    linhas.push(...body.results);
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);

  return linhas.map((p) => {
    const prop = p.properties ?? {};
    return {
      Nome: (prop.Nome?.title ?? []).map((t) => t.plain_text).join('').trim() || null,
      Artista: (prop.Artista?.rich_text ?? []).map((t) => t.plain_text).join('').trim() || null,
      Nota: prop.Nota?.number ?? null,
      Link: prop.Link?.url ?? null,
      Genero: (prop.Genero?.multi_select ?? []).map((o) => o.name),
      'Criado em': p.created_time ?? null,
    };
  });
}

/* ------------------------------------------------------------- normalizacao */

/** O id do album no link da Spotify. E a unica chave confiavel de duplicata. */
function albumId(link) {
  return link?.match(/\/album\/([A-Za-z0-9]+)/)?.[1] ?? null;
}

/** Sem acento, sem pontuacao, caixa baixa — pra casar nome escrito diferente. */
function chave(texto) {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Junta as duplicatas. Fica a linha que tem nota — ela e a que foi ouvida e
 * avaliada; a importada em lote so repete o album. Os campos vazios dessa
 * linha sao preenchidos com o que a outra tiver.
 */
function juntaDuplicatas(linhas) {
  const porChave = new Map();

  for (const linha of linhas) {
    if (!linha.Nome) continue;

    const id = albumId(linha.Link);
    const k = id ? `sp:${id}` : `nome:${chave(linha.Nome)}|${chave(linha.Artista)}`;
    const atual = porChave.get(k);

    if (!atual) {
      porChave.set(k, { ...linha });
      continue;
    }

    // Quem tem nota manda. Empatando, fica a linha mais recente.
    const trocaBase =
      (linha.Nota != null && atual.Nota == null) ||
      (linha.Nota != null && atual.Nota != null &&
        (linha['Criado em'] ?? '') > (atual['Criado em'] ?? ''));

    const base = trocaBase ? { ...linha } : { ...atual };
    const outra = trocaBase ? atual : linha;

    base.Nota ??= outra.Nota;
    base.Artista ??= outra.Artista;
    base.Link ??= outra.Link;
    if (!base.Genero?.length) base.Genero = outra.Genero ?? [];

    porChave.set(k, base);
  }

  return [...porChave.values()];
}

/* ------------------------------------------------------------------- capas */

/**
 * Capa pelo oEmbed publico (sem token). Devolve null em qualquer falha: capa
 * e enfeite, nao vale derrubar a coleta por causa de uma.
 */
async function buscaCapa(link) {
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`);
    if (!r.ok) return null;
    return (await r.json()).thumbnail_url ?? null;
  } catch {
    return null;
  }
}

/** Fila simples: CONCORRENCIA tarefas em voo, sem dependencia externa. */
async function emLotes(itens, tamanho, tarefa) {
  const fila = [...itens.entries()];
  const trabalhadores = Array.from({ length: Math.min(tamanho, fila.length) }, async () => {
    for (let item = fila.shift(); item; item = fila.shift()) {
      await tarefa(item[1], item[0]);
    }
  });
  await Promise.all(trabalhadores);
}

/** Capas do JSON anterior, pra nao buscar de novo o que nao mudou. */
async function capasConhecidas() {
  try {
    const anterior = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
    const mapa = new Map();
    for (const d of [...(anterior.discos ?? []), ...(anterior.sem_nota ?? [])]) {
      if (d.spotify_id && d.capa) mapa.set(d.spotify_id, d.capa);
    }
    return mapa;
  } catch {
    return new Map();
  }
}

/* ------------------------------------------------------------------- saida */

const bruto = process.env.DISCOS_FROM
  // Rebuild offline a partir de um dump da base, pra mexer na pagina sem token.
  ? JSON.parse(await fs.readFile(process.env.DISCOS_FROM, 'utf8'))
  : await buscaNotion();

const discos = juntaDuplicatas(bruto).map((linha) => ({
  nome: linha.Nome,
  artista: linha.Artista,
  nota: linha.Nota,
  generos: linha.Genero ?? [],
  url: linha.Link,
  spotify_id: albumId(linha.Link),
  capa: null,
  adicionado_em: linha['Criado em'],
}));

const cache = await capasConhecidas();
let buscadas = 0;

await emLotes(discos, CONCORRENCIA, async (disco) => {
  if (!disco.url) return;
  if (cache.has(disco.spotify_id)) {
    disco.capa = cache.get(disco.spotify_id);
    return;
  }
  disco.capa = await buscaCapa(disco.url);
  buscadas++;
});

/** Nota alta primeiro; empate decide pelo mais recente. */
const porNota = (a, b) => (b.nota - a.nota) || (b.adicionado_em ?? '').localeCompare(a.adicionado_em ?? '');
/** Sem nota nao tem ranking: fica em ordem de quando entrou, mais novo em cima. */
const porData = (a, b) => (b.adicionado_em ?? '').localeCompare(a.adicionado_em ?? '');

const comNota = discos.filter((d) => d.nota != null).sort(porNota);
const semNota = discos.filter((d) => d.nota == null).sort(porData);

const out = {
  generated_at: new Date().toISOString(),
  total: discos.length,
  discos: comNota,
  sem_nota: semNota,
};

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2) + '\n');

console.log(
  `${bruto.length} linhas na base -> ${discos.length} discos ` +
  `(${comNota.length} com nota, ${semNota.length} sem), ${buscadas} capas novas`,
);
if (comNota[0]) console.log(`#1: ${comNota[0].nome} — ${comNota[0].artista} (${comNota[0].nota})`);
