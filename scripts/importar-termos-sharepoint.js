// Importa termos de responsabilidade já assinados (baixados do SharePoint
// pra uma pasta local — o Conditional Access da organização bloqueia o
// Claude Code de ler o conteúdo desses arquivos direto do SharePoint,
// então o caminho é baixar manualmente e apontar essa pasta aqui) pro
// cadastro de Colaboradores + histórico de Termos.
//
// Rodar de novo é seguro (idempotente): cada termo vira uma linha com id
// determinístico (hash do caminho do arquivo), então re-rodar com a pasta
// tendo mais arquivos novos só importa o que ainda não tinha entrado.
// Colaborador é casado por nome normalizado (sem acento/maiúscula) — achou
// um já cadastrado, só completa os campos que ainda estavam vazios (nunca
// sobrescreve o que já foi preenchido/editado à mão no site).
//
// Uso:
//   node scripts/importar-termos-sharepoint.js "C:\caminho\para\pasta\com\termos"
//
// O que cada .docx precisa ter pra ser reconhecido: título "TERMO DE
// RESPONSABILIDADE" + os campos NOME/NACIONALIDADE/ESTADO CIVIL/ENDEREÇO/
// CPF como no modelo em uso (ver src/lib/termoPdf.js) + a tabela de
// equipamentos (PARÁGRAFO TERCEIRO). Arquivo que não bate com esse formato
// (ex.: Termo de Confidencialidade, Termo de Crachá, modelo de PJ) é
// pulado e listado no resumo final — não trava o import dos outros.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { db } = require('../src/lib/db');
const { PASTA_TERMOS } = require('../src/lib/termoPdf');

const pastaOrigem = process.argv[2];
if (!pastaOrigem) {
  console.error('Uso: node scripts/importar-termos-sharepoint.js "C:\\caminho\\para\\pasta"');
  process.exit(1);
}
if (!fs.existsSync(pastaOrigem)) {
  console.error(`Pasta não encontrada: ${pastaOrigem}`);
  process.exit(1);
}

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

// --- Encontra todos os .docx recursivamente (pastas por pessoa OU tudo solto) ---

function listarDocx(pasta) {
  const resultado = [];
  for (const nome of fs.readdirSync(pasta)) {
    const caminho = path.join(pasta, nome);
    const stat = fs.statSync(caminho);
    if (stat.isDirectory()) resultado.push(...listarDocx(caminho));
    else if (nome.toLowerCase().endsWith('.docx') && !nome.startsWith('~$')) resultado.push(caminho);
  }
  return resultado;
}

// --- Extrai parágrafos (texto) e tabelas (linhas de células) do document.xml ---

function extrairParagrafos(xml) {
  return xml
    .split(/<\/w:p>/)
    .map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .filter((t) => t.trim());
}

function extrairTabelas(xml) {
  const tabelas = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((m) => m[0]);
  return tabelas.map((tbl) => {
    const linhas = [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
    return linhas.map((linha) => {
      const celulas = [...linha.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
      return celulas.map((tc) => [...tc.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').trim());
    });
  });
}

function campoApos(paragrafos, rotulo) {
  const linha = paragrafos.find((p) => p.trim().toUpperCase().startsWith(rotulo.toUpperCase() + ':'));
  if (!linha) return null;
  const valor = linha.slice(linha.indexOf(':') + 1).trim();
  return valor || null;
}

// Tabela de equipamentos = a primeira tabela com cabeçalho "Equipamento" na
// 1ª célula — evita casar com a 2ª tabela (bloco "Outros:", vazia por
// padrão) ou com alguma outra tabela que o arquivo tenha por acaso.
function extrairItensEquipamento(tabelas) {
  const tabela = tabelas.find((t) => t[0] && normKey(t[0][0]).startsWith('EQUIPAMENTO'));
  if (!tabela) return [];
  const linhas = tabela.slice(1); // pula cabeçalho
  const itens = [];
  for (const [equipamento, modelo, serie, quantidade] of linhas) {
    // Linha só com o rótulo da categoria (ex.: "Headset" sem nada preenchido
    // do lado) não é um item de verdade — só as linhas com pelo menos um
    // dado a mais viram item.
    if (modelo || serie || (quantidade && quantidade.trim())) {
      itens.push({
        equipamento: equipamento || null,
        modelo: modelo || null,
        st: serie || null,
        quantidade: Number(quantidade) || 1,
      });
    }
  }
  return itens;
}

function parsearTermo(caminhoArquivo) {
  const zip = new AdmZip(caminhoArquivo);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) return null;
  const xml = entry.getData().toString('utf-8');

  const paragrafos = extrairParagrafos(xml);
  const textoCompleto = paragrafos.join(' ');
  if (!/TERMO DE RESPONSABILIDADE/i.test(textoCompleto) || !paragrafos.some((p) => /^NOME:/i.test(p.trim()))) {
    return null; // não é um Termo de Responsabilidade no formato esperado
  }

  const cargoParagrafo = paragrafos.find((p) => /CLÁUSULA PRIMEIRA/i.test(p)) || '';
  const cargoMatch = cargoParagrafo.match(/cargo que possui hoje de:\s*([^.]+?)\s+no departamento\s+([^.]+)\./i);

  const tabelas = extrairTabelas(xml);

  return {
    nome: campoApos(paragrafos, 'NOME'),
    nacionalidade: campoApos(paragrafos, 'NACIONALIDADE'),
    estadoCivil: campoApos(paragrafos, 'ESTADO CIVIL'),
    endereco: campoApos(paragrafos, 'ENDEREÇO'),
    cpf: campoApos(paragrafos, 'CPF'),
    cargo: cargoMatch ? cargoMatch[1].trim() : null,
    departamento: cargoMatch ? cargoMatch[2].trim() : null,
    itens: extrairItensEquipamento(tabelas),
  };
}

// --- AD (usuario/departamento/cargo mais atuais, quando o nome bate) ------

function carregarAd() {
  const caminho = process.env.AD_DADOS_JSON_PATH;
  if (!caminho || !fs.existsSync(caminho)) return [];
  const bruto = fs.readFileSync(caminho, 'utf-8');
  const semBom = bruto.charCodeAt(0) === 0xfeff ? bruto.slice(1) : bruto;
  try {
    return JSON.parse(semBom);
  } catch {
    return [];
  }
}

require('dotenv').config({ quiet: true });
const usuariosAd = carregarAd();
const adPorNome = new Map(usuariosAd.map((u) => [normKey(u.nome), u]));

// --- Import propriamente dito ----------------------------------------------

const arquivos = listarDocx(pastaOrigem);
console.log(`Encontrados ${arquivos.length} arquivo(s) .docx em "${pastaOrigem}".`);

const resumo = { importados: 0, jaExistiam: 0, pulados: [], colaboradoresCriados: 0, colaboradoresAtualizados: 0 };

const buscarColaboradorPorNome = db.prepare(`SELECT * FROM estoque_colaboradores WHERE UPPER(nome) = ?`);
const inserirColaborador = db.prepare(
  `INSERT INTO estoque_colaboradores (id, nome, usuario, cpf, nacionalidade, estado_civil, endereco, cargo, departamento, origem)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sharepoint')`
);
const atualizarColaboradorCampo = (id, coluna, valor) =>
  db.prepare(`UPDATE estoque_colaboradores SET ${coluna} = ? WHERE id = ?`).run(valor, id);
const buscarTermoPorId = db.prepare(`SELECT id FROM estoque_termos WHERE id = ?`);
const inserirTermo = db.prepare(
  `INSERT INTO estoque_termos (id, colaborador_id, itens_snapshot, arquivo, origem) VALUES (?, ?, ?, ?, 'sharepoint')`
);

for (const caminhoArquivo of arquivos) {
  let dados;
  try {
    dados = parsearTermo(caminhoArquivo);
  } catch (e) {
    resumo.pulados.push(`${caminhoArquivo} — erro ao ler: ${e.message}`);
    continue;
  }
  if (!dados || !dados.nome) {
    resumo.pulados.push(`${caminhoArquivo} — não parece um Termo de Responsabilidade no formato esperado`);
    continue;
  }

  const termoId = crypto.createHash('sha256').update(caminhoArquivo).digest('hex').slice(0, 32);
  if (buscarTermoPorId.get(termoId)) {
    resumo.jaExistiam += 1;
    continue;
  }

  const chaveNome = normKey(dados.nome);
  let colaborador = buscarColaboradorPorNome.get(chaveNome);
  const doAd = adPorNome.get(chaveNome);

  if (!colaborador) {
    const id = crypto.randomUUID();
    inserirColaborador.run(
      id,
      dados.nome,
      doAd ? doAd.usuario : null,
      dados.cpf,
      dados.nacionalidade,
      dados.estadoCivil,
      dados.endereco,
      (doAd && doAd.cargo) || dados.cargo,
      (doAd && doAd.departamento) || dados.departamento
    );
    colaborador = { id };
    resumo.colaboradoresCriados += 1;
  } else {
    // Só completa o que estava vazio — nunca sobrescreve dado já existente
    // (pode ter sido editado à mão no site depois de um import anterior).
    const completar = { cpf: dados.cpf, nacionalidade: dados.nacionalidade, estado_civil: dados.estadoCivil, endereco: dados.endereco, usuario: doAd ? doAd.usuario : null, cargo: (doAd && doAd.cargo) || dados.cargo, departamento: (doAd && doAd.departamento) || dados.departamento };
    let mudou = false;
    for (const [coluna, valor] of Object.entries(completar)) {
      if (valor && !colaborador[coluna]) {
        atualizarColaboradorCampo(colaborador.id, coluna, valor);
        mudou = true;
      }
    }
    if (mudou) resumo.colaboradoresAtualizados += 1;
  }

  // Preserva o .docx original (renomeado — mesmo padrão de dados/cpd-fotos/:
  // nunca guarda o nome original do arquivo).
  let arquivoSalvo = null;
  try {
    const nomeGerado = `termo-sharepoint-${termoId}.docx`;
    fs.copyFileSync(caminhoArquivo, path.join(PASTA_TERMOS, nomeGerado));
    arquivoSalvo = nomeGerado;
  } catch (e) {
    console.warn(`Não consegui copiar o arquivo de "${caminhoArquivo}": ${e.message}`);
  }

  inserirTermo.run(termoId, colaborador.id, JSON.stringify(dados.itens), arquivoSalvo);
  resumo.importados += 1;
}

console.log('\n--- Resumo ---');
console.log(`Termos importados agora: ${resumo.importados}`);
console.log(`Já tinham sido importados antes (pulados): ${resumo.jaExistiam}`);
console.log(`Colaboradores novos: ${resumo.colaboradoresCriados}`);
console.log(`Colaboradores com algum campo completado: ${resumo.colaboradoresAtualizados}`);
console.log(`Arquivos pulados (não reconhecidos como Termo de Responsabilidade): ${resumo.pulados.length}`);
if (resumo.pulados.length) {
  console.log('\nArquivos pulados:');
  resumo.pulados.forEach((p) => console.log(`  - ${p}`));
}
