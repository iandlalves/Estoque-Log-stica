// Consulta a iDRAC de cada servidor físico Dell (aba "Atualizações",
// 2026-09-23) via Redfish.
//
// 1) Inventário de firmware instalado (buscarInventarioFirmware) — Redfish
//    padrão (/redfish/v1/UpdateService/FirmwareInventory), estável desde
//    iDRAC8.
// 2) Comparação com o catálogo online da Dell (buscarAtualizacoesDisponiveis)
//    — ações OEM da Dell, fora do padrão Redfish/DMTF. Testado de verdade
//    contra uma iDRAC real (SERVERBI2, 2026-09-23) — o fluxo real difere
//    do que a documentação sugere à primeira vista:
//      a) POST InstallFromRepository (com ApplyUpdate:"False" — só
//         compara com o catálogo em downloads.dell.com, NÃO instala nada)
//         dispara um job e devolve o Location dele.
//      b) Espera o job (formato OEM Job da Dell: campo JobState, não o
//         TaskState do Redfish padrão).
//      c) SÓ DEPOIS disso, POST GetRepoBasedUpdateList (corpo vazio) devolve
//         o resultado — chamar direto sem o passo (a) dá erro "did not
//         complete successfully" (a Dell exige rodar o InstallFromRepository
//         primeiro pra popular o resultado que o GetRepoBasedUpdateList só
//         busca em cache).
//    O resultado (`PackageList`) vem como uma STRING XML no formato CIM da
//    Dell, não JSON — ver extrairPacotesDoXmlCim. Continua com try/catch
//    próprio em verificarServidor: se uma geração de iDRAC mais antiga
//    devolver algo fora desse formato, essa parte falha sozinha e o
//    inventário (a parte 100% padrão Redfish) continua valendo.

const https = require('node:https');

// iDRAC usa certificado autoassinado por padrão na interface de
// gerenciamento — este agente é de uso EXCLUSIVO das chamadas deste
// arquivo, não afeta TLS de nenhuma outra chamada do projeto (ex.
// Microsoft Graph em src/lib/email.js continua validando certificado normal).
const agenteIdrac = new https.Agent({ rejectUnauthorized: false });

function credenciaisIdrac() {
  const usuario = process.env.IDRAC_USUARIO;
  const senha = process.env.IDRAC_SENHA;
  if (!usuario || !senha) {
    throw new Error('IDRAC_USUARIO/IDRAC_SENHA não configurados (ver .env.example).');
  }
  return { usuario, senha };
}

function requisicaoRedfish(host, caminho, { metodo = 'GET', corpo = null } = {}) {
  const { usuario, senha } = credenciaisIdrac();
  const auth = Buffer.from(`${usuario}:${senha}`).toString('base64');
  const dadosCorpo = corpo ? JSON.stringify(corpo) : null;
  // Aceita "host" simples (padrão, porta 443) ou "host:porta" (iDRAC com
  // porta HTTPS não-padrão) — também é o que permite apontar pra um mock
  // local em teste (ver scripts de verificação do plano).
  const alvo = new URL(`https://${host}`);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: alvo.hostname,
        port: alvo.port || 443,
        path: caminho,
        method: metodo,
        agent: agenteIdrac,
        timeout: 30000,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(dadosCorpo ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dadosCorpo) } : {}),
        },
      },
      (res) => {
        let dados = '';
        res.on('data', (chunk) => { dados += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = dados ? JSON.parse(dados) : null; } catch (e) { /* resposta não-JSON (ex. erro HTML da iDRAC) — json fica null */ }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Tempo esgotado consultando ${host}${caminho}`)));
    req.on('error', reject);
    if (dadosCorpo) req.write(dadosCorpo);
    req.end();
  });
}

// A Dell devolve o motivo real do erro em error["@Message.ExtendedInfo"]
// (2026-09-23, achado testando contra hardware real — sem isso, todo erro
// vira só "status 400" sem dizer o quê, difícil de diagnosticar de longe).
function extrairMensagemErroRedfish(resp) {
  const info = resp.json && resp.json.error && resp.json.error['@Message.ExtendedInfo'];
  const mensagem = Array.isArray(info) && info[0] && info[0].Message;
  return mensagem || (resp.json && resp.json.error && resp.json.error.message) || null;
}

async function buscarInventarioFirmware(host) {
  const resp = await requisicaoRedfish(host, '/redfish/v1/UpdateService/FirmwareInventory?$expand=*($levels=1)');
  if (resp.status < 200 || resp.status >= 300) {
    const detalhe = extrairMensagemErroRedfish(resp);
    throw new Error(`iDRAC (${host}) respondeu ${resp.status} ao consultar inventário de firmware.${detalhe ? ` Detalhe: ${detalhe}` : ''}`);
  }
  const membros = (resp.json && resp.json.Members) || [];
  return membros
    .filter((m) => m && m.Name && m.Version) // slot vazio/sem versão fica de fora
    .map((m) => ({ componente: m.Name, versaoAtual: m.Version }));
}

async function aguardarJobCatalogo(host, caminhoJob, tentativasRestantes = 30) {
  const resp = await requisicaoRedfish(host, caminhoJob);
  const estado = resp.json && resp.json.JobState; // Job OEM da Dell, não Task Redfish padrão
  if (estado && /completed/i.test(estado)) return resp.json;
  if (estado && /(failed|error)/i.test(estado)) {
    throw new Error(`iDRAC (${host}) reportou falha na comparação com o catálogo: ${estado} — ${resp.json.Message || ''}`.trim());
  }
  if (tentativasRestantes <= 0) {
    throw new Error(`iDRAC (${host}) não terminou a comparação com o catálogo a tempo (timeout).`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return aguardarJobCatalogo(host, caminhoJob, tentativasRestantes - 1);
}

// Criticidade vem como código numérico no XML CIM da Dell — mapeamento
// confirmado contra hardware real (2026-09-23): 1=Urgent, 2=Recommended,
// 3=Optional (mesma numeração usada pelo Dell Update Catalog há anos).
// Código desconhecido: devolve o código cru em vez de esconder a info.
const CRITICIDADE_DELL = { 1: 'Urgent', 2: 'Recommended', 3: 'Optional' };

// GetRepoBasedUpdateList devolve PackageList como uma STRING XML (formato
// CIM da Dell, não JSON) — um bloco <INSTANCENAME CLASSNAME=
// "DCIM_RepoUpdateSWID"> por pacote disponível, com propriedades simples
// (<PROPERTY NAME="..."><VALUE>...</VALUE></PROPERTY>) e uma propriedade
// em array pra versão instalada (ComponentInstalledVersion). Extração via
// regex de propósito — não vale trazer uma lib de XML só pra isso, o
// formato é simples e regular (confirmado contra hardware real).
function extrairPacotesDoXmlCim(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const blocos = xml.split('<INSTANCENAME').slice(1);

  const campoSimples = (bloco, nome) => {
    const m = bloco.match(new RegExp(`<PROPERTY NAME="${nome}" TYPE="string"><VALUE>([^<]*)</VALUE></PROPERTY>`));
    return m ? m[1].trim() || null : null;
  };
  const campoArray = (bloco, nome) => {
    const m = bloco.match(new RegExp(`<PROPERTY\\.ARRAY NAME="${nome}"[^>]*>\\s*<VALUE\\.ARRAY>\\s*<VALUE>([^<]*)</VALUE>`));
    return m ? m[1].trim() || null : null;
  };

  return blocos
    .map((bloco) => {
      const criticidadeCodigo = campoSimples(bloco, 'Criticality');
      return {
        componente: campoSimples(bloco, 'DisplayName'),
        versaoDisponivel: campoSimples(bloco, 'PackageVersion'),
        versaoAtual: campoArray(bloco, 'ComponentInstalledVersion'),
        criticidade: criticidadeCodigo ? (CRITICIDADE_DELL[Number(criticidadeCodigo)] || criticidadeCodigo) : null,
      };
    })
    .filter((p) => p.componente && p.versaoDisponivel);
}

async function buscarAtualizacoesDisponiveis(host) {
  const disparo = await requisicaoRedfish(
    host,
    '/redfish/v1/Systems/System.Embedded.1/Oem/Dell/DellSoftwareInstallationService/Actions/DellSoftwareInstallationService.InstallFromRepository',
    {
      metodo: 'POST',
      // ApplyUpdate:"False" é o que faz isso ser só COMPARAÇÃO — a Dell
      // nunca instala nem reinicia nada com esse valor (confirmado contra
      // hardware real). Aplicar de verdade está fora do escopo deste v1.
      corpo: { ApplyUpdate: 'False', IPAddress: 'downloads.dell.com', ShareType: 'HTTPS', IgnoreCertWarning: 'On', CatalogFile: 'Catalog.xml' },
    }
  );
  if (disparo.status < 200 || disparo.status >= 300) {
    const detalhe = extrairMensagemErroRedfish(disparo);
    throw new Error(`iDRAC (${host}) recusou o pedido de comparação com o catálogo (status ${disparo.status}).${detalhe ? ` Detalhe: ${detalhe}` : ''}`);
  }
  const localizacaoJob = disparo.headers.location;
  if (!localizacaoJob) {
    throw new Error(`iDRAC (${host}) não devolveu um job de acompanhamento pra comparação com o catálogo.`);
  }
  await aguardarJobCatalogo(host, localizacaoJob);

  const resultado = await requisicaoRedfish(
    host,
    '/redfish/v1/Systems/System.Embedded.1/Oem/Dell/DellSoftwareInstallationService/Actions/DellSoftwareInstallationService.GetRepoBasedUpdateList',
    { metodo: 'POST', corpo: {} }
  );
  if (resultado.status < 200 || resultado.status >= 300) {
    const detalhe = extrairMensagemErroRedfish(resultado);
    // "same version installed" (2026-09-23, achado testando contra
    // hardware real) não é falha de verdade — é a Dell dizendo, de um
    // jeito estranho (via erro 400 em vez de lista vazia), que já está
    // tudo na versão do catálogo. Trata como "sem atualização" em vez de
    // erro — senão todo servidor em dia mostraria um alerta vermelho à toa.
    if (detalhe && /same version installed/i.test(detalhe)) return [];
    throw new Error(`iDRAC (${host}) recusou o pedido da lista de atualizações (status ${resultado.status}).${detalhe ? ` Detalhe: ${detalhe}` : ''}`);
  }
  return extrairPacotesDoXmlCim(resultado.json && resultado.json.PackageList);
}

// Orquestra as duas chamadas acima pra um servidor e grava o resultado.
// Falha no inventário = falha total (propaga o erro, nada é gravado nos
// itens). Falha só na comparação com o catálogo = falha PARCIAL: o
// inventário grava normalmente, e o erro fica registrado em
// idrac_ultimo_erro (versao_disponivel/criticidade ficam NULL pros itens
// dessa checagem).
async function verificarServidor(db, servidor) {
  const upsertItem = db.prepare(`
    INSERT INTO cpd_firmware_itens (servidor_id, componente, versao_atual, versao_disponivel, criticidade, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(servidor_id, componente) DO UPDATE SET
      versao_atual = excluded.versao_atual,
      versao_disponivel = excluded.versao_disponivel,
      criticidade = excluded.criticidade,
      atualizado_em = excluded.atualizado_em
  `);
  const marcarChecagem = db.prepare(`UPDATE cpd_servidores SET idrac_ultima_checagem = ?, idrac_ultimo_erro = ? WHERE id = ?`);

  let inventario;
  try {
    inventario = await buscarInventarioFirmware(servidor.idrac_host);
  } catch (e) {
    marcarChecagem.run(new Date().toISOString(), e.message, servidor.id);
    throw e;
  }

  let disponiveis = [];
  let erroCatalogo = null;
  try {
    disponiveis = await buscarAtualizacoesDisponiveis(servidor.idrac_host);
  } catch (e) {
    erroCatalogo = e.message;
  }
  // Os nomes de componente não batem 100% entre as duas fontes (ex.: a
  // comparação com o catálogo chama de "Integrated Dell Remote Access
  // Controller" o que o inventário chama de "iDRAC" — confirmado contra
  // hardware real). Por isso: grava primeiro o que veio da comparação com
  // o catálogo (já traz versão atual + disponível + criticidade, mais
  // completo), e só depois preenche com o inventário os componentes que
  // ainda não foram gravados — evita perder uma atualização confirmada só
  // porque o nome não bateu exatamente com o do inventário.
  const quando = new Date().toISOString();
  const jaGravados = new Set();
  for (const pacote of disponiveis) {
    upsertItem.run(servidor.id, pacote.componente, pacote.versaoAtual, pacote.versaoDisponivel, pacote.criticidade, quando);
    jaGravados.add(pacote.componente);
  }
  // Duas fontes podem repetir o mesmo nome de componente entre si E dentro
  // de si mesmas (ex.: a Dell às vezes lista "PERC H330 Adapter" duas vezes
  // no inventário — firmware de slots/imagens diferentes do mesmo
  // controlador). Como a chave é (servidor_id, componente), a última
  // versão processada é a que fica — jaGravados também evita contar a
  // mesma linha duas vezes no total.
  for (const item of inventario) {
    if (jaGravados.has(item.componente)) continue;
    upsertItem.run(servidor.id, item.componente, item.versaoAtual, null, null, quando);
    jaGravados.add(item.componente);
  }

  marcarChecagem.run(quando, erroCatalogo, servidor.id);
  return { componentes: jaGravados.size, atualizacoesDisponiveis: disponiveis.length, comparacaoOk: !erroCatalogo, erroCatalogo };
}

module.exports = { buscarInventarioFirmware, buscarAtualizacoesDisponiveis, verificarServidor };
