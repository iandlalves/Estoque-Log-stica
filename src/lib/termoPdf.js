// Gera o PDF do Termo de Responsabilidade e do Termo de Devolução de
// Equipamentos direto (sem passar por .docx) — pedido explícito do usuário
// pra simplificar o fluxo (antes gerava .docx e quem precisasse de PDF
// convertia à mão). Usa pdfkit (pura JS, sem binário nativo — mesmo motivo
// de node:sqlite ter sido escolhido em vez de um driver externo, ver
// src/lib/db.js) em vez de gerar .docx e converter com LibreOffice, porque
// o servidor não tem LibreOffice instalado e instalar um binário externo só
// pra isso seria uma dependência nova desnecessária.
//
// EXISTE UM MODELO SÓ pro Termo de Responsabilidade — o mesmo enviado pelo
// usuário (conferido campo a campo contra o termo real de "Alessandra Gomes
// Camilo da Silva"). Todo termo de responsabilidade gerado pela plataforma
// usa gerarPdfTermo() abaixo, sem variação — não existe um "modelo B" pra
// esse tipo. O Termo de Devolução é um modelo DIFERENTE (confirmado pelo
// usuário com o arquivo "MODELO DE TERMO DE DEVOLUÇÃO DE EQUIPAMENTOS.docx"
// em 2026-08-31 — texto idêntico ao que já estava implementado; só a
// logo/cabeçalho visual estavam faltando, adicionados agora).
//
// Cabeçalho (logo + título) extraído do .docx real de devolução que o
// usuário mandou: logo em src/lib/assets/telehelp-logo.png (imagem
// original da empresa, extraída de dentro do .docx — word/media/image1.png
// — não recriada/aproximada), título no estilo "Título" do Word: cor
// #17365D com uma linha #4F81BD por baixo. Aplicado igual nos dois modelos
// porque é o mesmo cabeçalho visual da empresa nos dois documentos reais.

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const PASTA_TERMOS = path.join(__dirname, '..', '..', 'dados', 'termos');
fs.mkdirSync(PASTA_TERMOS, { recursive: true });

const LOGO_PATH = path.join(__dirname, 'assets', 'telehelp-logo.png');
const LOGO_ASPECT = 3383 / 1685; // largura/altura da imagem original

const COR_TITULO = '#17365D';
const COR_LINHA_TITULO = '#4F81BD';
const COR_CABECALHO_TABELA = '#E8E8E8';
const COR_BORDA_TABELA = '#999999';

const MARGEM = 56; // ~2cm
const LARGURA_UTIL = 595.28 - MARGEM * 2; // A4 em pt, menos as duas margens

// O modelo real usa Cambria (corpo) + Calibri (título), fontes do tema do
// Word — tentamos usar essas fontes de verdade (arquivos do próprio
// Windows) e revertemos pra Helvetica: essas fontes têm ligaduras (ex.:
// "fi"/"fl" viram um glifo só) que confundem a geração do texto invisível
// por trás do desenho no pdfkit — o PDF fica visualmente idêntico ao
// modelo, mas letras isoladas em certas palavras acentuadas podem sumir do
// texto ao copiar/colar ou numa busca/leitor de tela. Pedido explícito
// (2026-09-01): preferir Helvetica, com o texto 100% íntegro, a Cambria/
// Calibri com esse defeito na camada de texto — mesmo perdendo a fonte
// exata do modelo.
function novoDocumento() {
  return new PDFDocument({ size: 'A4', margins: { top: MARGEM, bottom: MARGEM, left: MARGEM, right: MARGEM } });
}

function paraBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
  });
}

// Logo centralizada + título no estilo do modelo da empresa (cor + linha
// por baixo), igual nos dois tipos de termo.
function cabecalho(doc, titulo) {
  const larguraLogo = 150;
  const alturaLogo = larguraLogo / LOGO_ASPECT;
  const xLogo = MARGEM + (LARGURA_UTIL - larguraLogo) / 2;
  doc.image(LOGO_PATH, xLogo, doc.y, { width: larguraLogo });
  doc.y += alturaLogo + 22;

  doc.font('Helvetica-Bold').fontSize(26).fillColor(COR_TITULO).text(titulo, MARGEM, doc.y, {
    width: LARGURA_UTIL,
    align: 'left',
  });
  doc.y += 6;
  doc.moveTo(MARGEM, doc.y).lineTo(MARGEM + LARGURA_UTIL, doc.y).lineWidth(1.2).strokeColor(COR_LINHA_TITULO).stroke();
  doc.y += 18;
  doc.fillColor('#000000');
}

function paragrafo(doc, texto, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor('#000000');
  doc.text(texto, MARGEM, doc.y, { width: LARGURA_UTIL, align: opts.align || 'justify' });
  doc.y += opts.espacoDepois ?? 10;
}

// Linha "RÓTULO: valor" (rótulo em negrito), como o Termo de Responsabilidade usa.
function campo(doc, rotulo, valor) {
  doc.fontSize(11).fillColor('#000000');
  doc.font('Helvetica-Bold').text(`${rotulo}: `, MARGEM, doc.y, { continued: true, width: LARGURA_UTIL });
  doc.font('Helvetica').text(valor || '—');
  doc.y += 5;
}

// Tabela simples com bordas — cabeçalho sombreado + linhas de dados, altura
// fixa por linha (os valores aqui são sempre textos curtos de uma linha:
// nome de equipamento, modelo, número de série, quantidade etc., então não
// precisa de wrap/altura dinâmica).
function tabela(doc, larguras, linhas, { alturaLinha = 22 } = {}) {
  quebrarPaginaSeNecessario(doc, alturaLinha * linhas.length);
  const xInicial = MARGEM;
  let y = doc.y;
  linhas.forEach((linha, i) => {
    let x = xInicial;
    const cabecalhoLinha = i === 0;
    larguras.forEach((largura, j) => {
      doc.rect(x, y, largura, alturaLinha).fillAndStroke(cabecalhoLinha ? COR_CABECALHO_TABELA : '#FFFFFF', COR_BORDA_TABELA);
      doc.fillColor('#000000');
      if (cabecalhoLinha) {
        // Cabeçalho pode ter texto mais longo que a coluna (ex.: "Estado de
        // Conservação") — permite quebrar em 2 linhas em vez de cortar com "...".
        doc.font('Helvetica-Bold').fontSize(7.5);
        doc.text(String(linha[j] ?? '—'), x + 3, y + 3, { width: largura - 6, height: alturaLinha - 4, lineBreak: true });
      } else {
        doc.font('Helvetica').fontSize(9);
        doc.text(String(linha[j] ?? '—'), x + 4, y + alturaLinha / 2 - 5, {
          width: largura - 8,
          height: alturaLinha - 4,
          ellipsis: true,
          lineBreak: false,
        });
      }
      x += largura;
    });
    y += alturaLinha;
  });
  doc.x = MARGEM;
  doc.y = y + 14;
}

// Categorias reconhecidas (Headset/Notebook/Smartphone/Tablet/Teclado) —
// usadas só pra normalizar o texto digitado no campo Equipamento, não mais
// pra forçar linha fixa nenhuma (ver tabelaEquipamentos abaixo).
const CATEGORIAS_FIXAS_EQUIPAMENTO = ['Headset', 'Notebook', 'Smartphone', 'Tablet', 'Teclado'];

function normalizarCategoria(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

// Corrige o caso comum de alguém digitar o modelo junto no campo
// Equipamento (ex.: "HEADSET ZONE 300" em vez de "Headset" + modelo "ZONE
// 300") — reconhece pelo PREFIXO (não precisa mais ser exato), move o
// texto que sobrar pro Modelo (só se o Modelo já não tiver algo digitado).
function normalizarItemEquipamento(item) {
  const eqNormalizado = normalizarCategoria(item.equipamento);
  const categoria = CATEGORIAS_FIXAS_EQUIPAMENTO.find((c) => eqNormalizado.startsWith(normalizarCategoria(c)));
  if (!categoria) return item;
  const resto = String(item.equipamento || '').slice(categoria.length).trim();
  const temModelo = item.modelo && String(item.modelo).trim();
  return { ...item, equipamento: categoria, modelo: temModelo ? item.modelo : resto || item.modelo };
}

// Lista só os equipamentos escolhidos pro termo (pedido explícito
// 2026-09-01: sem linha em branco de categoria que a pessoa não recebeu —
// cada termo agora é gerado a partir de uma seleção específica de
// equipamentos, feita na tela antes de gerar, não mais "tudo que a pessoa
// tem" — ver POST /estoque/termos em src/routes/estoque.js). Isso diverge
// do modelo original da empresa nesse ponto específico (que sempre lista
// as 5 categorias fixas, em branco quando não há) — decisão consciente do
// usuário, preferindo o termo enxuto por entrega em vez de bater 100% com
// o modelo estrutural antigo.
function tabelaEquipamentos(doc, itens) {
  const larguras = [150, 165, 110, 70]; // soma = 495 = LARGURA_UTIL
  const linhas = (itens || [])
    .map(normalizarItemEquipamento)
    .map((i) => [i.equipamento || '', i.modelo || '', i.st || '', String(i.quantidade ?? 1)]);
  tabela(doc, larguras, [['Equipamento', 'Modelo', 'Número de série', 'Quantidade'], ...linhas]);
}

// Mesma ideia de tabelaEquipamentos(), só que pro Termo de Devolução: 2
// colunas extras (Estado de Conservação, Data da Devolução).
function tabelaEquipamentosDevolucao(doc, itens) {
  const larguras = [75, 80, 85, 55, 115, 85]; // soma = 495 = LARGURA_UTIL
  const cabecalhos = ['Equipamento', 'Modelo', 'Número de série', 'Quantidade', 'Estado de Conservação', 'Data da Devolução'];
  const linhas = (itens || [])
    .map(normalizarItemEquipamento)
    .map((i) => [i.equipamento || '', i.modelo || '', i.st || '', String(i.quantidade ?? 1), i.estadoConservacao || 'Íntegro', i.dataDevolucao || '']);
  tabela(doc, larguras, [cabecalhos, ...linhas], { alturaLinha: 22 });
}

// Tabela de rótulo:valor (2 colunas) — a coluna do rótulo vem sombreada e
// em negrito em TODA linha (diferente de tabela(), onde só a primeira
// linha é cabeçalho). É o que o cabeçalho do Termo de Devolução usa pra
// Nome/Cargo/Departamento/Data de Desligamento, igual ao modelo real.
function tabelaRotulos(doc, linhas, { larguraRotulo = 150 } = {}) {
  const alturaLinha = 20;
  quebrarPaginaSeNecessario(doc, alturaLinha * linhas.length);
  const larguraValor = LARGURA_UTIL - larguraRotulo;
  let y = doc.y;
  linhas.forEach(([rotulo, valor]) => {
    doc.rect(MARGEM, y, larguraRotulo, alturaLinha).fillAndStroke(COR_CABECALHO_TABELA, COR_BORDA_TABELA);
    doc.rect(MARGEM + larguraRotulo, y, larguraValor, alturaLinha).fillAndStroke('#FFFFFF', COR_BORDA_TABELA);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
    doc.text(rotulo, MARGEM + 4, y + alturaLinha / 2 - 5, { width: larguraRotulo - 8, height: alturaLinha - 4, ellipsis: true, lineBreak: false });
    doc.font('Helvetica').fontSize(9);
    doc.text(String(valor ?? '—'), MARGEM + larguraRotulo + 4, y + alturaLinha / 2 - 5, { width: larguraValor - 8, height: alturaLinha - 4, ellipsis: true, lineBreak: false });
    y += alturaLinha;
  });
  doc.x = MARGEM;
  doc.y = y + 14;
}

function quebrarPaginaSeNecessario(doc, alturaNecessaria) {
  const limite = doc.page.height - MARGEM;
  if (doc.y + alturaNecessaria > limite) {
    doc.addPage();
  }
}

function linhaAssinatura(doc, rotulo) {
  quebrarPaginaSeNecessario(doc, 70);
  doc.y += 18;
  doc.moveTo(MARGEM, doc.y).lineTo(MARGEM + 260, doc.y).lineWidth(0.8).strokeColor('#000000').stroke();
  doc.y += 4;
  doc.font('Helvetica').fontSize(10).fillColor('#000000').text(rotulo, MARGEM, doc.y);
  doc.y += 14;
  doc.text('Data: ____/____/______', MARGEM, doc.y);
  doc.y += 8;
}

// --- Termo de Responsabilidade ---------------------------------------------
// Único modelo pra esse tipo de termo — o mesmo enviado pelo usuário. Texto
// idêntico ao que já existia (conferido
// campo a campo contra o termo real de "Alessandra Gomes Camilo da
// Silva"), só que gerando PDF direto em vez de .docx.
//
// dados: { nome, nacionalidade, estadoCivil, endereco, rg, cpf, telefone, cargo, departamento }
// itens: [{ equipamento, modelo, st, quantidade }]
function gerarPdfTermo({ dados, itens }) {
  const doc = novoDocumento();
  const bufferPromise = paraBuffer(doc);

  cabecalho(doc, 'TERMO DE RESPONSABILIDADE');

  paragrafo(
    doc,
    'Pelo presente instrumento, de um lado, doravante designada EMPREGADORA, TELEHELP SISTEMAS DE ATENDIMENTO EMERGENCIAL S.A., sociedade anônima fechada, com sede em São Paulo, Estado de São Paulo, na Rua Dr. Geraldo Campos Moreira, 240, 9° andar, inscrita no CNPJ/MF sob nº. 07.778.393/0001-08, neste ato representada na forma do contrato social.'
  );
  paragrafo(doc, 'E, de outro lado, doravante designado EMPREGADO:');
  campo(doc, 'Nome', dados.nome);
  campo(doc, 'Nacionalidade', dados.nacionalidade);
  campo(doc, 'Estado Civil', dados.estadoCivil);
  campo(doc, 'Endereço', dados.endereco);
  if (dados.rg) campo(doc, 'RG', dados.rg);
  campo(doc, 'CPF', dados.cpf);
  if (dados.telefone) campo(doc, 'Telefone', dados.telefone);
  doc.y += 6;

  paragrafo(doc, 'Tem entre si justo e acordado o presente termo aditivo ao contrato de trabalho.');
  paragrafo(
    doc,
    `CLÁUSULA PRIMEIRA – DO CARGO – O EMPREGADO trabalhará para a EMPREGADORA exercendo as atuais funções com o mesmo cargo que possui hoje de: ${dados.cargo || '—'} no departamento ${dados.departamento || '—'}.`
  );
  paragrafo(
    doc,
    'CLÁUSULA SEGUNDA – DAS DISPOSIÇÕES ESPECIAIS - A empresa será responsável pela aquisição, manutenção e fornecimento dos equipamentos adequados à prestação do trabalho.'
  );
  paragrafo(
    doc,
    'PARÁGRAFO PRIMEIRO – As despesas para a instalação de equipamentos eletrônicos hábeis a permitir a comunicação entre as partes, bem como as despesas de consumo EXCLUSIVO para o labor contratado, serão custeadas pela EMPREGADORA e entregues ao EMPREGADO em regime de comodato, cabendo a este zelar pela correta separação entre as despesas incorridas no exercício de sua função e as despesas normais de sua família, sob pena de, em caso de mau uso, perda, avaria ou qualquer dano, arcar com os custos decorrentes do reparo ou substituição.'
  );
  paragrafo(
    doc,
    'PARÁGRAFO SEGUNDO – Os equipamentos entregues ao EMPREGADO para o exercício de suas atribuições deverão ser devolvidos à EMPREGADORA imediatamente em caso de rescisão do contrato de trabalho, sob pena de ser considerada apropriação indébita, passível de busca e apreensão.'
  );
  paragrafo(
    doc,
    'PARÁGRAFO TERCEIRO – Neste ato, o EMPREGADO recebe, em regime de comodato, os seguintes itens de propriedade da EMPREGADORA, comprometendo-se expressamente a devolvê-los em caso de rescisão do contrato de trabalho:'
  );

  tabelaEquipamentos(doc, itens);

  paragrafo(
    doc,
    'PARÁGRAFO QUARTO – Se o equipamento for danificado ou inutilizado por emprego inadequado, mau uso ou negligência, o EMPREGADO deverá comunicar imediatamente ao setor competente da EMPREGADORA, que fornecerá novo equipamento.'
  );
  paragrafo(
    doc,
    'PARÁGRAFO QUINTO - A EMPREGADORA cobrará o valor da manutenção ou, caso não seja possível reparar o equipamento, cobrará o valor de um equipamento da mesma marca e modelo do EMPREGADO, sendo que o valor cobrado será descontado em folha de pagamento, em momento e periodicidade a serem combinados entre as partes.'
  );
  paragrafo(
    doc,
    'PARÁGRAFO SEXTO – O EMPREGADO declara ainda que mantém e manterá sob sua guarda exclusiva cópias e/ou originais de documentos relativos à EMPREGADORA, bem como papelaria personalizada, aplicando-se a mesma regra das cláusulas acima em caso de término do vínculo empregatício.'
  );
  paragrafo(doc, 'Cláusulas:', { bold: true, align: 'left' });
  paragrafo(
    doc,
    '1. RESPONSABILIDADE: O EMPREGADO reconhece que a não devolução dos itens ou devolução em condições inadequadas implicará nas sanções previstas no contrato de trabalho e na legislação vigente, incluindo, se necessário, o desconto em folha do valor correspondente aos danos ou à substituição do equipamento.'
  );
  paragrafo(
    doc,
    '2. CONDUTA: O EMPREGADO compromete-se a devolver os equipamentos em suas condições originais de uso, zelando pelo bom estado dos mesmos durante o período em que estiverem sob sua responsabilidade.'
  );
  paragrafo(
    doc,
    '3. APROPRIAÇÃO INDÉBITA: A retenção indevida dos itens listados após a rescisão do contrato será considerada apropriação indébita, sujeitando-se o EMPREGADO às medidas legais cabíveis, incluindo busca e apreensão.'
  );
  paragrafo(doc, 'Estando em absoluto consenso, as partes assinam o presente instrumento em 2 vias de igual teor e forma.');
  paragrafo(doc, 'São Paulo, ____/____/______');
  paragrafo(doc, 'Assinaturas:', { bold: true, align: 'left', espacoDepois: 0 });
  linhaAssinatura(doc, 'Assinatura do Colaborador');
  linhaAssinatura(doc, 'Assinatura do Responsável pela Entrega dos Equipamentos');

  doc.end();
  return bufferPromise;
}

async function gerarArquivoTermo({ dados, itens }) {
  const buffer = await gerarPdfTermo({ dados, itens });
  const nomeArquivo = `termo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  fs.writeFileSync(path.join(PASTA_TERMOS, nomeArquivo), buffer);
  return nomeArquivo;
}

// --- Termo de Devolução de Equipamentos ------------------------------------
// Modelo diferente do Termo de Responsabilidade, confirmado pelo usuário
// com o arquivo real "MODELO DE TERMO DE DEVOLUÇÃO DE EQUIPAMENTOS.docx" —
// texto idêntico ao que já estava aqui (cabeçalho Nome/Cargo/Departamento
// numa tabela, tabela de itens com Estado de Conservação e Data da
// Devolução), só ganhou o mesmo cabeçalho visual (logo + título) agora.
//
// dados: { nome, cargo, departamento, motivo, dataDesligamento }
//   motivo: 'desligamento' (default) | 'outro' — nem toda devolução é
//   desligamento (2026-09-08); 'outro' tira a menção a desligamento do
//   texto e o campo "Data de Desligamento" da tabela de cabeçalho.
// itens: [{ equipamento, modelo, st, quantidade, estadoConservacao, dataDevolucao }]
function gerarPdfTermoDevolucao({ dados, itens }) {
  const doc = novoDocumento();
  const bufferPromise = paraBuffer(doc);
  const ehDesligamento = dados.motivo !== 'outro';

  cabecalho(doc, 'TERMO DE DEVOLUÇÃO DE EQUIPAMENTOS');

  paragrafo(doc, 'EMPREGADORA: TELEHELP SISTEMAS DE ATENDIMENTO EMERGENCIAL S.A.', { align: 'left', espacoDepois: 4 });
  paragrafo(doc, 'CNPJ: 07.778.393/0001-08', { align: 'left', espacoDepois: 4 });
  paragrafo(doc, 'Sede: Rua Dr. Geraldo Campos Moreira, 240 - 9° andar, São Paulo/SP', { align: 'left', espacoDepois: 10 });
  paragrafo(doc, 'EMPREGADO:', { bold: true, align: 'left' });

  tabelaRotulos(doc, [
    ['Nome', dados.nome],
    ['Cargo', dados.cargo],
    ['Departamento', dados.departamento],
    ...(ehDesligamento ? [['Data de Desligamento', dados.dataDesligamento]] : []),
  ]);

  paragrafo(
    doc,
    ehDesligamento
      ? 'Pelo presente termo, o(a) colaborador(a) acima identificado(a) declara que, em razão do desligamento de suas funções junto à empresa TELEHELP SISTEMAS DE ATENDIMENTO EMERGENCIAL S.A., devolveu à EMPREGADORA todos os equipamentos e materiais recebidos para o desempenho de suas atividades profissionais, conforme listado abaixo:'
      : 'Pelo presente termo, o(a) colaborador(a) acima identificado(a) declara que devolveu à EMPREGADORA os equipamentos e materiais abaixo relacionados, recebidos para o desempenho de suas atividades profissionais:'
  );
  paragrafo(doc, 'Equipamentos:', { align: 'left' });

  tabelaEquipamentosDevolucao(doc, itens);

  paragrafo(doc, 'Cláusulas:', { bold: true, align: 'left' });
  paragrafo(
    doc,
    '1. RESPONSABILIDADE: O EMPREGADO reconhece que a não devolução dos itens ou devolução em condições inadequadas implicará nas sanções previstas no contrato de trabalho e na legislação vigente, incluindo, se necessário, o desconto em folha do valor correspondente aos danos ou à substituição do equipamento.'
  );
  paragrafo(
    doc,
    '2. CONDUTA: O EMPREGADO compromete-se a devolver os equipamentos em suas condições originais de uso, zelando pelo bom estado dos mesmos durante o período em que estiverem sob sua responsabilidade.'
  );
  paragrafo(
    doc,
    '3. APROPRIAÇÃO INDÉBITA: A retenção indevida dos itens listados após a rescisão do contrato será considerada apropriação indébita, sujeitando-se o EMPREGADO às medidas legais cabíveis, incluindo busca e apreensão.'
  );
  paragrafo(doc, 'Assinaturas:', { bold: true, align: 'left', espacoDepois: 0 });
  linhaAssinatura(doc, 'Assinatura do Colaborador');
  linhaAssinatura(doc, 'Assinatura do Responsável pela Recepção dos Equipamentos');

  doc.end();
  return bufferPromise;
}

// --- Ficha de Acessos (2026-09-18, aba Colaboradores/onboarding) ----------
// Modelo baseado no PDF de exemplo do usuário ("Barbara_1.pdf"): logo,
// barra preta "PERFIL DE NOVO ACESSO", Nome/Cargo/Gestor em texto simples,
// tabela Sistema/Usuário/Senhas de acesso, rodapé de boas-vindas. Gerado
// sob demanda (nunca salvo em disco) — dado sensível (tem senha em texto
// legível DENTRO do PDF), então gerar na hora evita acumular cópia em
// dados/. Quem baixa ou o e-mail que recebe é responsável por guardar bem.
//
// dados: { nome, cargo, gestor, genero }
// itens: [{ sistema, usuario, senha }]
function gerarPdfFichaAcessos({ dados, itens }) {
  const doc = novoDocumento();
  const bufferPromise = paraBuffer(doc);

  const larguraLogo = 150;
  const alturaLogo = larguraLogo / LOGO_ASPECT;
  const xLogo = MARGEM + (LARGURA_UTIL - larguraLogo) / 2;
  doc.image(LOGO_PATH, xLogo, doc.y, { width: larguraLogo });
  doc.y += alturaLogo + 22;

  // Barra preta com o título — diferente do estilo azul do Termo de
  // Responsabilidade, mas é assim no modelo real da Ficha de Acessos.
  const alturaBarra = 22;
  doc.rect(MARGEM, doc.y, LARGURA_UTIL, alturaBarra).fill('#000000');
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text('PERFIL DE NOVO ACESSO', MARGEM, doc.y + 6, {
    width: LARGURA_UTIL,
    align: 'center',
  });
  doc.y += alturaBarra + 16;
  doc.fillColor('#000000');

  doc.font('Helvetica').fontSize(11);
  doc.text(`Nome do Colaborador: ${dados.nome || ''}`, MARGEM, doc.y, { width: LARGURA_UTIL });
  doc.y += 4;
  doc.text(`Cargo: ${dados.cargo || ''}`, MARGEM, doc.y, { width: LARGURA_UTIL });
  doc.y += 4;
  doc.text(`Gestor: ${dados.gestor || ''}`, MARGEM, doc.y, { width: LARGURA_UTIL });
  doc.y += 20;

  const larguras = [140, 195, 160]; // soma = 495 = LARGURA_UTIL
  const linhas = (itens || []).map((i) => [i.sistema || '', i.usuario || '', i.senha || '']);
  tabela(doc, larguras, [['Sistema', 'Usuário', 'Senhas de acesso'], ...linhas]);

  doc.y += 30;
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  // Mesma lógica de gênero do corpo do e-mail de boas-vindas (ver
  // montarCorpoEmail em src/routes/onboarding.js) — "b" minúsculo, forma
  // neutra "bem-vindo(a)" quando o gênero não foi informado (2026-09-21,
  // corrigido depois de sair sempre "Bem-vindo" com B maiúsculo e
  // masculino fixo, independente da pessoa).
  const saudacao = dados.genero === 'f' ? 'bem-vinda' : dados.genero === 'm' ? 'bem-vindo' : 'bem-vindo(a)';
  doc.text(`Seja ${saudacao} à Telehelp. É um prazer ter você aqui conosco!`, MARGEM, doc.y, { width: LARGURA_UTIL, align: 'center' });

  doc.end();
  return bufferPromise;
}

async function gerarArquivoTermoDevolucao({ dados, itens }) {
  const buffer = await gerarPdfTermoDevolucao({ dados, itens });
  const nomeArquivo = `termo-devolucao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  fs.writeFileSync(path.join(PASTA_TERMOS, nomeArquivo), buffer);
  return nomeArquivo;
}

module.exports = {
  gerarPdfTermo,
  gerarArquivoTermo,
  gerarPdfTermoDevolucao,
  gerarArquivoTermoDevolucao,
  gerarPdfFichaAcessos,
  PASTA_TERMOS,
};
