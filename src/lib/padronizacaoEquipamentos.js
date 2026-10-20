// Padrão dos nomes de equipamento (2026-10-09) — o mesmo equipamento aparecia
// como "Notebook", "NOTEBOOK", "notebook", "Notbook"... e isso quebrava a
// busca, o saldo e o vínculo entre termo e equipamento.
//
// Regras (todas aplicadas no momento de gravar — ver src/routes/estoque.js — e
// também na limpeza dos dados antigos, scripts/padronizar-equipamentos.js):
//  - equipamento, modelo e service tag ficam em MAIÚSCULAS, sem espaço sobrando
//    (o catálogo de itens do estoque já é todo em maiúsculas — o padrão segue o
//    que já existia);
//  - se o nome bate (sem acento/maiúscula, singular/plural) com um item do
//    catálogo, usa a grafia exata do catálogo ("mouse" -> "MOUSES");
//  - só a PRIMEIRA palavra (o tipo do equipamento) recebe correção de digitação
//    e de sinônimo ("Notbook" -> "NOTEBOOK", "Smartphone" -> "CELULAR"). O resto
//    do nome nunca é "corrigido" por semelhança, porque modelos diferem por
//    um dígito ("3440" x "3450") e juntar os dois seria um erro grave;
//  - service tag: sem espaços; "N/A", "-", "----" etc. viram vazio.

function chave(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

function colapsar(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Palavras que sempre valem como "tipo de equipamento", além do que o
// catálogo já traz. Sinônimos trocam a palavra por outra do padrão.
const TIPOS_BASE = [
  'NOTEBOOK', 'DESKTOP', 'MONITOR', 'TECLADO', 'MOUSE', 'HEADSET', 'CELULAR', 'TABLET',
  'CAMERA', 'WEBCAM', 'ROTEADOR', 'PROJETOR', 'CARREGADOR', 'IMPRESSORA', 'TONER',
];
const SINONIMOS_TIPO = { SMARTPHONE: 'CELULAR', LAPTOP: 'NOTEBOOK', COMPUTADOR: 'DESKTOP' };

function distancia(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Corrige erro de digitação numa palavra de tipo ("NOTBOOK" -> "NOTEBOOK").
// Só mexe em palavra 100% letras, com 5+ letras, e só se existir UMA palavra
// do vocabulário a no máximo 1 letra de diferença (2, se a palavra tem 8+).
function corrigirTipo(palavraChave, vocabulario) {
  if (!/^[A-Z]{5,}$/.test(palavraChave)) return null;
  if (vocabulario.includes(palavraChave)) return null;
  const limite = palavraChave.length >= 8 ? 2 : 1;
  let melhor = null;
  let melhorDist = Infinity;
  let empate = false;
  for (const v of vocabulario) {
    if (Math.abs(v.length - palavraChave.length) > limite) continue;
    const d = distancia(palavraChave, v);
    if (d < melhorDist) { melhor = v; melhorDist = d; empate = false; }
    else if (d === melhorDist && v !== melhor) empate = true;
  }
  return melhor && melhorDist <= limite && !empate ? melhor : null;
}

function vocabularioDe(catalogoNomes) {
  const primeiras = catalogoNomes.map((n) => chave(n).split(/\s+/)[0]).filter((p) => /^[A-Z]{4,}$/.test(p));
  return [...new Set([...TIPOS_BASE, ...primeiras])];
}

function acharNoCatalogo(texto, porChave) {
  const k = chave(texto);
  for (const cand of [k, `${k}S`, k.replace(/S$/, '')]) {
    if (cand && porChave.has(cand)) return porChave.get(cand);
  }
  return null;
}

// Nome incompleto que termina igual a UM único item do catálogo (ex.: "ZONE 300"
// -> "HEADSET ZONE 300"). Só vale com espaço no nome e 6+ caracteres, pra não
// casar palavra solta.
function acharPorSufixo(texto, catalogoNomes) {
  const k = chave(texto);
  if (k.length < 6 || !k.includes(' ')) return null;
  const achados = catalogoNomes.filter((n) => chave(n).endsWith(` ${k}`));
  return achados.length === 1 ? achados[0] : null;
}

// catalogoNomes: lista com os nomes dos itens do catálogo (estoque_itens.item).
function padronizarEquipamento(nome, catalogoNomes = []) {
  const limpo = colapsar(nome).toUpperCase();
  if (!limpo) return '';
  const porChave = new Map(catalogoNomes.map((n) => [chave(n), n]));

  const exato = acharNoCatalogo(limpo, porChave) || acharPorSufixo(limpo, catalogoNomes);
  if (exato) return exato;

  const palavras = limpo.split(' ');
  const primeira = chave(palavras[0]);
  const vocab = vocabularioDe(catalogoNomes);
  const trocada = SINONIMOS_TIPO[primeira] || corrigirTipo(primeira, vocab);
  if (trocada) palavras[0] = trocada;
  const resultado = palavras.join(' ');

  return acharNoCatalogo(resultado, porChave) || resultado;
}

function padronizarModelo(modelo) {
  const limpo = colapsar(modelo).toUpperCase();
  return limpo || null;
}

const SEM_SERVICE_TAG = /^(N\/?A|-+|SEM.*|NAO.*|\?+)$/;

function padronizarServiceTag(st) {
  const limpo = chave(st).replace(/\s+/g, '');
  if (!limpo || SEM_SERVICE_TAG.test(limpo)) return null;
  return limpo;
}

module.exports = { padronizarEquipamento, padronizarModelo, padronizarServiceTag, chave };
