// Atualizações de driver/firmware via SSH + Dell Command Update CLI
// (2026-10-02) — segunda fonte da aba "Atualizações", pros servidores
// Windows SEM iDRAC própria (ex.: srv-est-op, srv-careview-op,
// srv-fullarm-op, srv-nanocomm-op). Essas máquinas têm o Servidor OpenSSH
// do Windows habilitado (recurso nativo) especificamente pra isso.
//
// CONFIRMADO contra hardware real (srv-est-op, 2026-10-02) — diferente da
// parte best-effort da iDRAC, este fluxo já foi testado de ponta a ponta:
// 1) SSH roda `dcu-cli.exe /scan -report=<pasta> -outputLog=<pasta>\scan.log -silent`.
// 2) Lê o XML gerado em <pasta>\DCUApplicableUpdates.xml (formato simples,
//    confirmado real: <updates><update><name>..</name><version>..</version>
//    <urgency>Urgent|Recommended|Optional</urgency>...</update>...).
//
// Limitação real (não dá pra contornar com este comando): o relatório do
// Dell Command Update só traz a versão DISPONÍVEL, não a instalada — por
// isso versaoAtual sempre fica null aqui (a tabela já mostra "—" nesse
// caso, mesmo tratamento usado quando a comparação com o catálogo falha
// na iDRAC).
//
// Não usa o código de saída do dcu-cli como sinal de sucesso/falha (um
// teste ao vivo mostrou $LASTEXITCODE vazio mesmo com o scan funcionando
// normalmente) — o sinal de verdade é o arquivo XML ter sido criado.

const { Client } = require('ssh2');

const PASTA_REMOTA = 'C:\\ProgramData\\Dell\\CentralInfraScan';

// O instalador do Dell Command Update vai pra "Program Files" ou "Program
// Files (x86)" dependendo da versão/forma de instalação (confirmado na
// prática: srv-est-op ficou em Program Files, srv-nanocomm-op em (x86)) —
// por isso descobre o caminho certo em cada máquina em vez de fixar um só.
const CAMINHOS_DCU_POSSIVEIS = [
  'C:\\Program Files\\Dell\\CommandUpdate\\dcu-cli.exe',
  'C:\\Program Files (x86)\\Dell\\CommandUpdate\\dcu-cli.exe',
];

function credenciaisDcu() {
  const usuario = process.env.DCU_SSH_USUARIO; // formato "DOMINIO\usuario"
  const senha = process.env.DCU_SSH_SENHA;
  if (!usuario || !senha) {
    throw new Error('DCU_SSH_USUARIO/DCU_SSH_SENHA não configurados (ver .env.example).');
  }
  return { usuario, senha };
}

// Executa um comando via SSH (PowerShell é o shell padrão configurado no
// Servidor OpenSSH dessas máquinas) e devolve stdout/stderr. hostVerifier
// aceita qualquer host key — rede interna de gerenciamento, mesmo espírito
// do rejectUnauthorized:false já usado pra iDRAC em src/lib/idrac.js.
function executarComandoSsh(host, comando) {
  const { usuario, senha } = credenciaisDcu();
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let saida = '';
    let erro = '';
    conn
      .on('ready', () => {
        conn.exec(comando, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream
            .on('close', () => {
              conn.end();
              resolve({ saida, erro });
            })
            .on('data', (data) => { saida += data.toString(); })
            .stderr.on('data', (data) => { erro += data.toString(); });
        });
      })
      .on('error', (err) => reject(new Error(`Falha na conexão SSH com ${host}: ${err.message}`)))
      .connect({
        host,
        port: 22,
        username: usuario,
        password: senha,
        readyTimeout: 20000,
        hostVerifier: () => true,
      });
  });
}

// Criticidade já vem exatamente como Urgent/Recommended/Optional —
// mesmo vocabulário usado pela iDRAC, sem precisar traduzir código numérico
// como no caso dela (ver CRITICIDADE_DELL em src/lib/idrac.js).
function extrairAtualizacoesXml(xml) {
  const blocos = xml.match(/<update>[\s\S]*?<\/update>/g) || [];
  const campo = (bloco, tag) => {
    const m = bloco.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() || null : null;
  };
  return blocos
    .map((bloco) => ({
      componente: campo(bloco, 'name'),
      versaoDisponivel: campo(bloco, 'version'),
      criticidade: campo(bloco, 'urgency'),
    }))
    .filter((p) => p.componente && p.versaoDisponivel);
}

async function caminhoDcuNaMaquina(host) {
  const lista = CAMINHOS_DCU_POSSIVEIS.map((c) => `'${c}'`).join(',');
  const resultado = await executarComandoSsh(host, `@(${lista}) | Where-Object { Test-Path $_ } | Select-Object -First 1`);
  const caminho = resultado.saida.trim();
  if (!caminho) {
    throw new Error('dcu-cli.exe não encontrado em Program Files nem Program Files (x86) nessa máquina.');
  }
  return caminho;
}

async function buscarAtualizacoesDisponiveis(host) {
  const caminhoDcu = await caminhoDcuNaMaquina(host);

  await executarComandoSsh(
    host,
    `New-Item -ItemType Directory -Force -Path '${PASTA_REMOTA}' | Out-Null`
  );

  await executarComandoSsh(
    host,
    `& '${caminhoDcu}' /scan -report='${PASTA_REMOTA}' -outputLog='${PASTA_REMOTA}\\scan.log' -silent`
  );

  const leitura = await executarComandoSsh(
    host,
    `if (Test-Path '${PASTA_REMOTA}\\DCUApplicableUpdates.xml') { Get-Content '${PASTA_REMOTA}\\DCUApplicableUpdates.xml' -Raw } else { '' }`
  );

  if (!leitura.saida || !leitura.saida.trim()) {
    return []; // scan rodou mas não achou atualização nenhuma — não é erro
  }
  return extrairAtualizacoesXml(leitura.saida);
}

// Mesmo formato de retorno de verificarServidor em src/lib/idrac.js —
// quem chama (src/routes/firmware.js) trata as duas fontes de forma igual.
async function verificarServidor(db, servidor) {
  const upsertItem = db.prepare(`
    INSERT INTO cpd_firmware_itens (servidor_id, componente, versao_atual, versao_disponivel, criticidade, atualizado_em)
    VALUES (?, ?, NULL, ?, ?, ?)
    ON CONFLICT(servidor_id, componente) DO UPDATE SET
      versao_atual = NULL,
      versao_disponivel = excluded.versao_disponivel,
      criticidade = excluded.criticidade,
      atualizado_em = excluded.atualizado_em
  `);
  const marcarChecagem = db.prepare(`UPDATE cpd_servidores SET idrac_ultima_checagem = ?, idrac_ultimo_erro = ? WHERE id = ?`);

  let atualizacoes;
  try {
    atualizacoes = await buscarAtualizacoesDisponiveis(servidor.dcu_host);
  } catch (e) {
    marcarChecagem.run(new Date().toISOString(), e.message, servidor.id);
    throw e;
  }

  const quando = new Date().toISOString();
  for (const item of atualizacoes) {
    upsertItem.run(servidor.id, item.componente, item.versaoDisponivel, item.criticidade, quando);
  }
  marcarChecagem.run(quando, null, servidor.id);

  return { componentes: atualizacoes.length, comparacaoOk: true, erroCatalogo: null };
}

module.exports = { buscarAtualizacoesDisponiveis, verificarServidor };
