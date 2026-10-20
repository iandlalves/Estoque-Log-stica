// Import em massa da base real de Termos de Responsabilidade/Devolução
// (2026-09-22) — pasta extraída do .zip exportado do SharePoint (uma
// subpasta por colaborador, um PDF por termo) + um JSON consolidado com os
// dados de cada PDF, já extraídos (o texto desses PDFs não é extraível por
// nenhuma ferramenta — pdftotext e pdf-parse falharam nos dois, a fonte
// incorporada não tem mapeamento de caractere legível por máquina; os
// dados vieram de leitura visual, feita à parte).
//
// Mesmo padrão do importador antigo (scripts/importar-termos-sharepoint.js:
// casar colaborador por nome normalizado, cruzar com o AD ao vivo pra
// usuario/cargo/departamento, id de termo determinístico pra ser
// idempotente) — MAS pra PDF em vez de .docx, e com uma diferença
// deliberada: quando uma pessoa tem mais de um termo, os dados pessoais
// (CPF/RG/nacionalidade/estado civil/endereço) do colaborador são
// SOBRESCRITOS pelo termo de assinatura MAIS RECENTE (pedido explícito do
// usuário — "o mais recente prevalece"), diferente do script antigo, que só
// completa campo vazio. Reexecutar mais pra frente com termos novos vai
// reavaliar "o mais recente" só dentro do que for passado nessa execução —
// não compara contra o que já está gravado, então rodar de novo bem depois
// de alguém ter editado os dados à mão no site pode sobrescrever essa
// edição. Aceitável pra este import (é essencialmente um evento único).
//
// Uso:
//   node scripts/importar-termos-pdf.js "<pasta extraída>" "<json consolidado>"

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { PASTA_TERMOS } = require('../src/lib/termoPdf');
const { verificarColaboradoresAtivos } = require('../src/lib/estoqueColaboradores');
const { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado } = require('../src/lib/ldap');

const pastaOrigem = process.argv[2];
const caminhoJson = process.argv[3];
if (!pastaOrigem || !caminhoJson) {
  console.error('Uso: node scripts/importar-termos-pdf.js "<pasta extraída>" "<json consolidado>"');
  process.exit(1);
}
if (!fs.existsSync(pastaOrigem)) {
  console.error(`Pasta não encontrada: ${pastaOrigem}`);
  process.exit(1);
}
if (!fs.existsSync(caminhoJson)) {
  console.error(`JSON não encontrado: ${caminhoJson}`);
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

// "25/03/2025" -> "2025-03-25" (comparável como string, e Date-parseável
// pelo fmtDataHora do front). null se não bater o formato esperado.
function paraIso(dataBr) {
  if (!dataBr) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dataBr).trim());
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  return `${aaaa}-${mm}-${dd}`;
}

function termoMaisRecente(lista) {
  let melhor = null;
  let melhorIso = null;
  for (const t of lista) {
    const iso = paraIso(t.dataAssinatura);
    if (!iso) continue;
    if (!melhorIso || iso > melhorIso) {
      melhor = t;
      melhorIso = iso;
    }
  }
  return melhor || lista[0];
}

function buscarColaboradorPorNomeNormalizado(nomeAlvo) {
  const chave = normKey(nomeAlvo);
  const todos = db.prepare(`SELECT * FROM estoque_colaboradores`).all();
  return todos.find((c) => normKey(c.nome) === chave) || null;
}

const registros = JSON.parse(fs.readFileSync(caminhoJson, 'utf-8'));
console.log(`Registros no JSON consolidado: ${registros.length}`);

const porPasta = new Map();
for (const r of registros) {
  if (!r.arquivo) continue;
  const pasta = r.arquivo.split('/')[0];
  if (!porPasta.has(pasta)) porPasta.set(pasta, []);
  porPasta.get(pasta).push(r);
}
console.log(`Pastas (pessoas) distintas: ${porPasta.size}`);

(async () => {
  let usuariosAd = [];
  if (ldapConfigurado()) {
    try {
      usuariosAd = (await buscarUsuariosAD()).usuarios;
      console.log(`Usuários do AD carregados: ${usuariosAd.length}`);
    } catch (e) {
      console.warn(`Não consegui consultar o AD agora (${e.message}) — segue sem enriquecer usuario/cargo/departamento.`);
    }
  } else {
    console.warn(`LDAP não configurado (${motivoNaoConfigurado()}) — segue sem enriquecer usuario/cargo/departamento.`);
  }
  const adPorNome = new Map(usuariosAd.map((u) => [normKey(u.nome), u]));

  const inserirColaborador = db.prepare(
    `INSERT INTO estoque_colaboradores (id, nome, usuario, cpf, rg, nacionalidade, estado_civil, endereco, cargo, departamento, origem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sharepoint')`
  );
  const atualizarColaborador = db.prepare(
    `UPDATE estoque_colaboradores SET usuario = ?, cpf = ?, rg = ?, nacionalidade = ?, estado_civil = ?, endereco = ?, cargo = ?, departamento = ? WHERE id = ?`
  );
  const buscarTermoPorId = db.prepare(`SELECT id FROM estoque_termos WHERE id = ?`);
  const inserirTermo = db.prepare(
    `INSERT INTO estoque_termos (id, colaborador_id, tipo, itens_snapshot, arquivo, origem, data_assinatura) VALUES (?, ?, ?, ?, ?, 'sharepoint', ?)`
  );

  const resumo = {
    colaboradoresCriados: 0,
    colaboradoresAtualizados: 0,
    termosImportados: 0,
    termosJaExistiam: 0,
    termosSemArquivoNoDisco: [],
  };

  for (const [pasta, termosPessoa] of porPasta) {
    const nomeExtraido = termosPessoa.find((t) => t.nome)?.nome;
    const nome = (nomeExtraido || pasta).trim();
    const doAd = adPorNome.get(normKey(nome));
    const termoRef = termoMaisRecente(termosPessoa);

    let colaborador = buscarColaboradorPorNomeNormalizado(nome);
    const camposPessoais = {
      usuario: (doAd && doAd.usuario) || null,
      cpf: termoRef.cpf || null,
      rg: termoRef.rg || null,
      nacionalidade: termoRef.nacionalidade || null,
      estadoCivil: termoRef.estadoCivil || null,
      endereco: termoRef.endereco || null,
      cargo: (doAd && doAd.cargo) || termoRef.cargo || null,
      departamento: (doAd && doAd.departamento) || termoRef.departamento || null,
    };

    if (!colaborador) {
      const id = crypto.randomUUID();
      inserirColaborador.run(
        id, nome, camposPessoais.usuario, camposPessoais.cpf, camposPessoais.rg,
        camposPessoais.nacionalidade, camposPessoais.estadoCivil, camposPessoais.endereco,
        camposPessoais.cargo, camposPessoais.departamento
      );
      colaborador = { id };
      resumo.colaboradoresCriados++;
    } else {
      atualizarColaborador.run(
        camposPessoais.usuario, camposPessoais.cpf, camposPessoais.rg,
        camposPessoais.nacionalidade, camposPessoais.estadoCivil, camposPessoais.endereco,
        camposPessoais.cargo, camposPessoais.departamento, colaborador.id
      );
      resumo.colaboradoresAtualizados++;
    }

    for (const termo of termosPessoa) {
      const id = crypto.createHash('sha256').update(termo.arquivo).digest('hex').slice(0, 32);
      if (buscarTermoPorId.get(id)) {
        resumo.termosJaExistiam++;
        continue;
      }
      const caminhoArquivoOrigem = path.join(pastaOrigem, ...termo.arquivo.split('/'));
      let arquivoSalvo = null;
      if (fs.existsSync(caminhoArquivoOrigem)) {
        arquivoSalvo = `termo-sharepoint-${id}.pdf`;
        fs.copyFileSync(caminhoArquivoOrigem, path.join(PASTA_TERMOS, arquivoSalvo));
      } else {
        resumo.termosSemArquivoNoDisco.push(termo.arquivo);
      }

      const tipo = termo.tipo === 'devolucao' ? 'devolucao' : 'responsabilidade';
      const itens = Array.isArray(termo.itens) ? termo.itens : [];
      inserirTermo.run(id, colaborador.id, tipo, JSON.stringify(itens), arquivoSalvo, paraIso(termo.dataAssinatura));
      resumo.termosImportados++;
    }
  }

  console.log('\n--- Resumo do import ---');
  console.log(`Colaboradores novos: ${resumo.colaboradoresCriados}`);
  console.log(`Colaboradores atualizados: ${resumo.colaboradoresAtualizados}`);
  console.log(`Termos importados agora: ${resumo.termosImportados}`);
  console.log(`Termos que já existiam (pulados): ${resumo.termosJaExistiam}`);
  if (resumo.termosSemArquivoNoDisco.length) {
    console.log(`\nTermos sem arquivo PDF encontrado no disco (${resumo.termosSemArquivoNoDisco.length}):`);
    resumo.termosSemArquivoNoDisco.forEach((a) => console.log(`  - ${a}`));
  }

  if (usuariosAd.length) {
    const resultadoAtivos = verificarColaboradoresAtivos(db, usuariosAd);
    console.log('\n--- Arquivo morto ---');
    console.log(`Colaboradores verificados: ${resultadoAtivos.verificados}`);
    console.log(`Reativados: ${resultadoAtivos.ativados}`);
    console.log(`Movidos pra arquivo morto agora: ${resultadoAtivos.arquivados}`);
  } else {
    console.log('\nSem lista do AD carregada — não rodei a verificação de arquivo morto agora. Rode scripts/verificar-colaboradores-ativos.js separado depois.');
  }
})();
