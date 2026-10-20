// Leitura automática de termo assinado escaneado (2026-10-16) — OCR local com
// Tesseract (nada sai do servidor). Serve pra SUGERIR: tipo do termo (resp./
// devolução), quem é o colaborador, e quais equipamentos aparecem na tabela —
// sempre com confirmação de uma pessoa antes de gravar qualquer coisa.
//
// Dependências do servidor (pacotes do sistema, não do npm):
//   sudo apt install -y tesseract-ocr tesseract-ocr-por poppler-utils
// Sem elas a plataforma continua funcionando; a leitura só fica "indisponível".
//
// Como lê: PDF -> imagens (pdftoppm, 300 dpi) -> tesseract em modo "texto
// esparso" (--psm 11) com saída TSV (posição de cada palavra). O modo comum do
// Tesseract ignora o conteúdo de tabelas com borda (nos termos reais a linha do
// equipamento sumia); o modo esparso acha as palavras e a posição delas permite
// remontar a tabela por colunas (Equipamento | Modelo | Número de série |
// Quantidade). Termo com camada de texto (PDF gerado pela plataforma) usa
// pdftotext direto, sem OCR.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { chave, padronizarServiceTag } = require('./padronizacaoEquipamentos');

const BIN_TESSERACT = process.env.OCR_TESSERACT_BIN || 'tesseract';
const BIN_PDFTOPPM = process.env.OCR_PDFTOPPM_BIN || 'pdftoppm';
const IDIOMA = process.env.OCR_IDIOMA || 'por';
const DPI = Number(process.env.OCR_DPI) || 300;
const MAX_PAGINAS = 4;
const PASTA_TMP = path.join(__dirname, '..', '..', 'dados', 'ocr-tmp');

function executar(bin, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

// --- Disponibilidade -------------------------------------------------------
let statusCache = null;
let statusEm = 0;

async function verificarProgramas() {
  try {
    const { stdout, stderr } = await executar(BIN_TESSERACT, ['--list-langs'], { timeout: 15000 });
    const idiomas = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim());
    if (!idiomas.includes(IDIOMA)) {
      return { disponivel: false, motivo: `Tesseract instalado, mas falta o idioma "${IDIOMA}" (sudo apt install tesseract-ocr-por).` };
    }
    await executar(BIN_PDFTOPPM, ['-v'], { timeout: 15000 }).catch((e) => {
      if (e.code === 'ENOENT') throw e; // -v sai com código != 0 em algumas versões; só importa se o programa existe
    });
    return { disponivel: true };
  } catch (e) {
    const faltando = e.code === 'ENOENT' ? (String(e.path || '').includes('pdftoppm') ? 'pdftoppm (poppler-utils)' : 'tesseract') : null;
    return { disponivel: false, motivo: faltando ? `OCR não instalado no servidor (falta ${faltando}) — sudo apt install tesseract-ocr tesseract-ocr-por poppler-utils.` : `OCR indisponível: ${e.message}` };
  }
}

async function statusOcr() {
  if (statusCache && Date.now() - statusEm < 60000) return statusCache;
  statusCache = await motor.verificar();
  statusEm = Date.now();
  return statusCache;
}

// --- Motor (troca-se nos testes) -------------------------------------------
// paginas: [{ palavras: [{ t, x0, y0, x1, y1, conf }] }]
const motor = {
  verificar: verificarProgramas,
  async lerPaginas(caminho, mimetype, pastaTmp) {
    let imagens;
    if (mimetype === 'application/pdf') {
      // Camada de texto? (PDF gerado pela plataforma) — pdftotext é instantâneo e exato.
      try {
        const { stdout } = await executar('pdftotext', ['-layout', '-f', '1', '-l', String(MAX_PAGINAS), caminho, '-'], { timeout: 30000 });
        if ((stdout.match(/[A-Za-zÀ-ú]{3,}/g) || []).length > 80) return { textoDireto: stdout };
      } catch (e) { /* sem pdftotext: segue pro OCR */ }
      const base = path.join(pastaTmp, 'pag');
      await executar(BIN_PDFTOPPM, ['-r', String(DPI), '-gray', '-png', '-f', '1', '-l', String(MAX_PAGINAS), caminho, base], { timeout: 120000 });
      imagens = fs.readdirSync(pastaTmp).filter((f) => f.startsWith('pag') && f.endsWith('.png')).sort().map((f) => path.join(pastaTmp, f));
    } else {
      imagens = [caminho];
    }
    const paginas = [];
    for (const img of imagens) {
      const { stdout } = await executar(BIN_TESSERACT, [img, 'stdout', '-l', IDIOMA, '--psm', '11', 'tsv'], { timeout: 120000 });
      paginas.push({ palavras: parseTsv(stdout) });
    }
    return { paginas };
  },
};

function parseTsv(tsv) {
  const palavras = [];
  for (const linha of tsv.split(/\r?\n/).slice(1)) {
    const c = linha.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const t = c.slice(11).join('\t').trim();
    if (!t) continue;
    const x0 = Number(c[6]); const y0 = Number(c[7]);
    palavras.push({ t, x0, y0, x1: x0 + Number(c[8]), y1: y0 + Number(c[9]), conf: Number(c[10]) });
  }
  return palavras;
}

// --- Interpretação (função pura, testável) ----------------------------------
function agruparEmLinhas(palavras) {
  const ordenadas = [...palavras].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const linhas = [];
  for (const w of ordenadas) {
    const cy = (w.y0 + w.y1) / 2;
    const alvo = linhas.find((l) => Math.abs(l.cy - cy) < Math.max(8, (w.y1 - w.y0) * 0.6));
    if (alvo) { alvo.ws.push(w); alvo.cy = (alvo.cy * (alvo.ws.length - 1) + cy) / alvo.ws.length; }
    else linhas.push({ cy, ws: [w] });
  }
  for (const l of linhas) l.ws.sort((a, b) => a.x0 - b.x0);
  return linhas.sort((a, b) => a.cy - b.cy);
}

const textoDe = (ws) => ws.map((w) => w.t).join(' ').replace(/\s+/g, ' ').trim();
const FIM_DE_TABELA = /^(PAR[AÁ]GRAFO|CL[AÁ]USULA|Cl[aá]usulas?:?|Assinatura|Estando|S[aã]o Paulo|Outros:?)/i;
const SO_TRACOS = /^[\s\-_—–.|]*$/;

// Acha, numa linha, a palavra onde começa um trecho (o OCR às vezes parte uma
// palavra: "M" + "odelo"). Compara sem espaços/acentos.
function acharPalavra(ws, re) {
  let acc = '';
  const inicios = [];
  for (const w of ws) { inicios.push(acc.length); acc += chave(w.t).replace(/[^A-Z]/g, ''); }
  const m = re.exec(acc);
  if (!m) return null;
  let k = inicios.length - 1;
  while (k > 0 && inicios[k] > m.index) k--;
  return ws[k];
}

const LETRAS = /[A-Za-zÀ-ú]/g;

function linhaDeEquipamentoValida(equipamento, modelo, st, totalPalavras) {
  if (!equipamento || (!modelo && !st) || totalPalavras > 12) return false;
  if (equipamento.split(/\s+/).length > 3 || equipamento.length < 3 || equipamento.length > 40) return false;
  if (/[.,;:]/.test(equipamento)) return false;
  if ((equipamento.match(LETRAS) || []).length / equipamento.length < 0.75) return false;
  if (modelo && modelo.split(/\s+/).length > 6) return false;
  return true;
}

// Procura tabelas "Equipamento | Modelo | Número de série | Quantidade" e devolve
// as linhas preenchidas (modelo ou nº de série presentes).
function extrairTabelas(linhas) {
  const itens = [];
  for (let i = 0; i < linhas.length; i++) {
    const ws = linhas[i].ws;
    const wEq = acharPalavra(ws, /EQUIPAMENTO/);
    const wMod = acharPalavra(ws, /MODELO/);
    if (!wEq || !wMod || wMod.x0 <= wEq.x0) continue;
    if (ws.length > 14) continue; // linha de parágrafo que cita as duas palavras

    // "Número de série" pode ter caído na linha de cima (cabeçalho quebrado).
    const vizinhas = [linhas[i - 1], linhas[i]].filter(Boolean);
    const wNum = vizinhas.map((l) => acharPalavra(l.ws, /NUMERO/)).find((w) => w && w.x0 > wMod.x0);
    const wQtd = acharPalavra(ws, /QUANTIDADE/);
    const wEstado = acharPalavra(ws, /ESTADO/);
    const xEq = wEq.x0;
    const xMod = wMod.x0;
    const xQtd = wQtd ? wQtd.x0 : null;
    const xSer = wNum ? wNum.x0 : xQtd ? Math.round(xMod + (xQtd - xMod) / 2) : xMod + 400;
    const xFim = wEstado ? wEstado.x0 : Infinity;
    const tol = Math.max(15, Math.round((xMod - xEq) * 0.18));

    for (let j = i + 1; j < Math.min(linhas.length, i + 14); j++) {
      const l = linhas[j];
      const texto = textoDe(l.ws);
      if (FIM_DE_TABELA.test(texto) || l.ws.length > 12) break;
      if (acharPalavra(l.ws, /EQUIPAMENTO/) && acharPalavra(l.ws, /MODELO/)) break;
      const col = { eq: [], mod: [], ser: [], qtd: [] };
      for (const w of l.ws) {
        if (w.x0 >= xFim - tol) continue;
        if (/^[|\[\]\!_]+$/.test(w.t)) continue;
        if (w.x0 < xMod - tol) col.eq.push(w.t);
        else if (w.x0 < xSer - tol) col.mod.push(w.t);
        else if (xQtd === null || w.x0 < xQtd - tol) col.ser.push(w.t);
        else col.qtd.push(w.t);
      }
      const equipamento = col.eq.join(' ').trim();
      const modelo = col.mod.join(' ').replace(/[|\[\]]/g, '').trim();
      const stBruto = col.ser.join('').replace(/[|\[\]]/g, '');
      const st = SO_TRACOS.test(stBruto) ? null : padronizarServiceTag(stBruto);
      const qtd = parseInt(col.qtd.join('').replace(/\D/g, ''), 10);
      // Lixo de borda de tabela: modelo sem 2 caracteres úteis / nº de série curto demais.
      const modeloLimpo = (modelo.match(/[A-Za-z0-9À-ú]/g) || []).length >= 2 ? modelo : '';
      const stLimpo = st && st.length >= 4 ? st : null;
      if (!linhaDeEquipamentoValida(equipamento, modeloLimpo, stLimpo, l.ws.length)) continue;
      itens.push({ equipamento, modelo: modeloLimpo || null, st: stLimpo, quantidade: Number.isFinite(qtd) && qtd > 0 ? qtd : 1 });
    }
  }
  return itens;
}

function detectarTipo(textoCompleto) {
  const t = chave(textoCompleto);
  if (/TERMO DE DEVOLUCAO/.test(t) || (/ESTADO DE CONSERVACAO/.test(t) && /DATA DA DEVOLUCAO/.test(t))) return 'devolucao';
  if (/TERMO DE RESPONSABILIDADE/.test(t)) return 'responsabilidade';
  return null;
}

function extrairNomeLido(linhas) {
  for (const l of linhas) {
    const m = textoDe(l.ws).match(/^Nome\s*:\s*(.{4,80})$/i);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

// paginas: [{palavras}] ou { textoDireto } (PDF com camada de texto)
function interpretarLeitura(leitura) {
  if (leitura.textoDireto !== undefined) {
    const texto = leitura.textoDireto;
    const linhas = texto.split(/\r?\n/);
    const nome = (linhas.map((l) => l.match(/^\s*Nome\s*:\s*(.{4,80})$/i)).find(Boolean) || [])[1] || null;
    // PDF da plataforma: linhas de tabela "EQUIPAMENTO  MODELO  SERIE  QTD" separadas por 2+ espaços
    const itens = [];
    let dentro = false;
    for (const l of linhas) {
      if (/Equipamento\s{2,}Modelo/i.test(l)) { dentro = true; continue; }
      if (dentro) {
        if (!l.trim() || FIM_DE_TABELA.test(l.trim())) { dentro = false; continue; }
        const c = l.trim().split(/\s{2,}/);
        const st = c[2] && !SO_TRACOS.test(c[2]) ? padronizarServiceTag(c[2]) : null;
        if (c[0] && (c[1] || st)) itens.push({ equipamento: c[0], modelo: c[1] || null, st, quantidade: parseInt(c[3], 10) || 1 });
      }
    }
    return { tipoSugerido: detectarTipo(texto), nomeLido: nome, itensLidos: itens, textoNormalizado: chave(texto).replace(/\s+/g, ' '), paginasLidas: 1, origemTexto: 'pdf' };
  }
  const linhasPorPagina = leitura.paginas.map((p) => agruparEmLinhas(p.palavras));
  const todasLinhas = linhasPorPagina.flat();
  const textoCompleto = linhasPorPagina.map((ls) => ls.map((l) => textoDe(l.ws)).join('\n')).join('\n');
  const itensLidos = linhasPorPagina.flatMap((ls) => extrairTabelas(ls));
  return {
    tipoSugerido: detectarTipo(textoCompleto),
    nomeLido: extrairNomeLido(todasLinhas),
    itensLidos,
    textoNormalizado: chave(textoCompleto).replace(/\s+/g, ' '),
    paginasLidas: leitura.paginas.length,
    origemTexto: 'ocr',
  };
}

// --- Cruzamento com o que a pessoa já tem em mãos -----------------------------
// Troca letras que o OCR confunde (O/0, I/1/L, S/5, B/8, Z/2, G/6) pra comparar
// número de série mesmo com 1 caractere mal lido.
const CONFUSAO = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const paraComparar = (s) => chave(s).replace(/[^A-Z0-9]/g, '').replace(/[OQDILSBZG]/g, (c) => CONFUSAO[c]);

function correspondenciasComEquipamentos(interpretacao, itensEmMaos) {
  const textoSimples = paraComparar(interpretacao.textoNormalizado);
  const lidosPorSt = interpretacao.itensLidos.filter((i) => i.st).map((i) => paraComparar(i.st));
  const encontrados = [];
  for (const item of itensEmMaos) {
    const st = item.st ? paraComparar(item.st) : '';
    if (st.length >= 5 && (textoSimples.includes(st) || lidosPorSt.includes(st))) {
      encontrados.push({ itemId: item.id, motivo: `nº de série ${item.st} encontrado no documento` });
      continue;
    }
    // Sem ST: casa pelo equipamento + modelo lidos na tabela.
    const lido = interpretacao.itensLidos.find((l) => !l.st && chave(l.equipamento) === chave(item.equipamento) && l.modelo && chave(l.modelo) === chave(item.modelo || ''));
    if (!st && lido) encontrados.push({ itemId: item.id, motivo: 'equipamento e modelo encontrados na tabela do documento' });
  }
  const idsEncontrados = new Set(encontrados.map((e) => e.itemId));
  const itensDoItem = (i) => itensEmMaos.find((x) => idsEncontrados.has(x.id) && ((x.st && i.st && paraComparar(x.st) === paraComparar(i.st)) || (!x.st && chave(x.equipamento) === chave(i.equipamento))));
  const novos = interpretacao.itensLidos.filter((i) => !itensDoItem(i));
  return { encontrados, novos };
}

// Colaboradores cujo nome aparece no documento (todas as palavras do nome, 2+).
function sugerirColaboradores(interpretacao, colaboradores) {
  const textoPalavras = new Set(interpretacao.textoNormalizado.split(/[^A-Z0-9]+/).filter(Boolean));
  const alvoNome = interpretacao.nomeLido ? new Set(chave(interpretacao.nomeLido).split(/[^A-Z0-9]+/).filter(Boolean)) : null;
  const ligacao = new Set(['DE', 'DA', 'DO', 'DOS', 'DAS', 'E']);
  const sugeridos = [];
  for (const c of colaboradores) {
    const tokens = chave(c.nome).split(/[^A-Z0-9]+/).filter((t) => t.length > 1 && !ligacao.has(t));
    if (tokens.length < 2) continue;
    const base = alvoNome || textoPalavras;
    const achados = tokens.filter((t) => base.has(t)).length;
    const pontos = achados / tokens.length;
    if (pontos >= 0.75) sugeridos.push({ id: c.id, nome: c.nome, pontos: Math.round(pontos * 100) / 100, pelaLinhaNome: !!alvoNome });
  }
  return sugeridos.sort((a, b) => b.pontos - a.pontos || b.nome.length - a.nome.length).slice(0, 5);
}

// --- Fila (um OCR por vez; o servidor é pequeno) ------------------------------
let fila = Promise.resolve();

function lerArquivo(caminho, mimetype) {
  const executa = async () => {
    const status = await statusOcr();
    if (!status.disponivel) return { disponivel: false, motivo: status.motivo };
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimetype)) {
      return { disponivel: false, motivo: 'A leitura automática só funciona com PDF, JPEG ou PNG.' };
    }
    fs.mkdirSync(PASTA_TMP, { recursive: true });
    const pasta = path.join(PASTA_TMP, crypto.randomUUID());
    fs.mkdirSync(pasta, { recursive: true });
    try {
      const bruto = await motor.lerPaginas(caminho, mimetype, pasta);
      return { disponivel: true, ...interpretarLeitura(bruto) };
    } catch (e) {
      return { disponivel: false, motivo: `Não consegui ler o documento: ${e.killed ? 'demorou demais' : e.message}` };
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  };
  const resultado = fila.then(executa, executa);
  fila = resultado.catch(() => {});
  return resultado;
}

module.exports = {
  statusOcr, lerArquivo, interpretarLeitura, correspondenciasComEquipamentos, sugerirColaboradores,
  _motor: motor, _agruparEmLinhas: agruparEmLinhas, _extrairTabelas: extrairTabelas,
};
