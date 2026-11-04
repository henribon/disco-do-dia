/*
 * Monta a imagem de preview: a parede de capas que aparece quando alguem
 * cola o link da pagina no WhatsApp, no Twitter, no Slack.
 *
 * Roda depois do update.mjs, lendo o discos.json que ele acabou de gravar.
 * Nao busca nada no Notion — so as capas que ja estao no JSON.
 *
 * A saida e deterministica: mesmas capas na mesma ordem dao bytes iguais,
 * entao o `git add` do workflow so vai ver mudanca quando a parede mudou
 * de verdade. Nao precisa de cache nem de arquivo de controle.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRADA = path.join(RAIZ, 'data', 'discos.json');
const SAIDA = path.join(RAIZ, 'og.jpg');

/* 1200x630 e o tamanho que o Twitter, o Facebook e o WhatsApp esperam. */
const LARGURA = 1200;
const ALTURA = 630;
const COLUNAS = 10;
const LADO = LARGURA / COLUNAS;               // 120: tile quadrado, sem distorcer a capa
const LINHAS = Math.ceil(ALTURA / LADO);      // 6 linhas dao 720 de altura
const ALTURA_CHEIA = LINHAS * LADO;
const RECORTE = Math.round((ALTURA_CHEIA - ALTURA) / 2);
const TILES = COLUNAS * LINHAS;

const CONCORRENCIA = 8;
const QUALIDADE = 82;

/** Metade das capas faltando ja e sinal de problema: melhor manter a antiga. */
const MINIMO = Math.ceil(TILES / 2);

async function emLotes(itens, tamanho, tarefa) {
  const fila = [...itens];
  const saida = [];

  async function trabalha() {
    for (let item = fila.shift(); item !== undefined; item = fila.shift()) {
      saida.push(await tarefa(item));
    }
  }

  await Promise.all(Array.from({ length: tamanho }, trabalha));
  return saida;
}

async function buscaTile(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;

    const img = await Jimp.read(Buffer.from(await r.arrayBuffer()));
    /* cover recorta o excesso em vez de espremer — capa quadrada fica quadrada */
    img.cover({ w: LADO, h: LADO });
    return img;
  } catch {
    return null;
  }
}

const dados = JSON.parse(await fs.readFile(ENTRADA, 'utf8'));

/*
 * Os com nota vem primeiro no JSON, entao a parede comeca pelos melhores e
 * completa com a fila. Sem capa nao entra.
 */
const capas = [...dados.discos, ...dados.sem_nota]
  .map((d) => d.capa)
  .filter(Boolean)
  .slice(0, TILES);

if (!capas.length) {
  console.error('og: nenhuma capa no discos.json, nao ha o que montar.');
  process.exit(1);
}

const tiles = await emLotes(
  [...capas.entries()],
  CONCORRENCIA,
  async ([i, url]) => [i, await buscaTile(url)],
);

const bons = tiles.filter(([, img]) => img);

if (bons.length < MINIMO) {
  console.error(`og: so ${bons.length} de ${capas.length} capas vieram, mantendo a imagem anterior.`);
  process.exit(1);
}

const canvas = new Jimp({ width: LARGURA, height: ALTURA_CHEIA, color: 0x0a0a0aff });
for (const [i, img] of bons) {
  canvas.composite(img, (i % COLUNAS) * LADO, Math.floor(i / COLUNAS) * LADO);
}

/* o recorte no meio faz a primeira e a ultima fileira sangrarem pra fora */
canvas.crop({ x: 0, y: RECORTE, w: LARGURA, h: ALTURA });

await fs.writeFile(SAIDA, await canvas.getBuffer('image/jpeg', { quality: QUALIDADE }));

const { size } = await fs.stat(SAIDA);
console.log(`og.jpg: ${bons.length} capas, ${LARGURA}x${ALTURA}, ${(size / 1024).toFixed(0)} KB`);
