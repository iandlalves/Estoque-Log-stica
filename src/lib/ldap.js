// Consulta direta ao Active Directory via LDAP (2026-09-18) — substitui a
// leitura do Mapeamento-AD-Dados.json (gerado por um processo agendado
// numa máquina Windows separada, que o servidor Linux não tinha como
// alcançar de verdade sem depender daquele PC específico ficar de pé).
// O projeto de mapeamento de AD (GPO + script de logon) continua
// existindo e gravando host/service tag/IP/SO/último login nas
// propriedades de cada usuário no AD — só paramos de depender do arquivo
// exportado por ele; aqui a gente lê o mesmo dado direto da fonte.
//
// Conta de bind (LDAP_BIND_DN/LDAP_BIND_PASSWORD) precisa ser só-leitura
// — nunca escreve nada de volta no AD. Config no .env: LDAP_URL,
// LDAP_BIND_DN, LDAP_BIND_PASSWORD, LDAP_BASE_DN.
//
// Mapeamento dos 5 atributos customizados (msDS-cloudExtensionAttribute1-5)
// assumido na mesma ordem documentada no README (host, service tag, IP,
// SO, último login) — CONFERIR contra o JSON antigo na primeira consulta
// real; se a ordem não bater, é só trocar os índices abaixo.

// Require "preguiçoso"/defensivo de propósito (2026-09-18): o servidor de
// produção já mostrou não ter acesso de internet confiável pro registro do
// npm (ver scripts/deploy-remoto.sh, timeout de 30s no npm install) — se
// "ldapjs" não tiver sido instalado a tempo num deploy, isso NÃO PODE
// derrubar o app inteiro (chamados/estoque/CPD não têm nada a ver com
// LDAP). Sem o pacote instalado, ldapConfigurado() abaixo simplesmente
// devolve false e a tela mostra o aviso de sempre, em vez de crashar tudo.
let ldap = null;
try {
  ldap = require('ldapjs');
} catch (_) {
  // Sem o pacote — buscarUsuariosAD() nunca é chamada de verdade nesse
  // caso, porque ldapConfigurado() já vai barrar antes (ver abaixo).
}

const ATRIBUTOS = [
  'displayName',
  'sAMAccountName',
  'department',
  'mail',
  'title', // cargo — usado por scripts/importar-cargos-ad.js
  'manager', // DN do gestor (resolvido pra nome depois da busca, ver buscarUsuariosAD)
  'msDS-cloudExtensionAttribute1', // host
  'msDS-cloudExtensionAttribute2', // service tag
  'msDS-cloudExtensionAttribute3', // IP
  'msDS-cloudExtensionAttribute4', // sistema operacional
  'msDS-cloudExtensionAttribute5', // último login
];

// Filtro LDAP (2026-09-18, ajustado depois do primeiro teste real): o
// filtro original (objectCategory=person + objectClass=user) também
// trazia CONTA DE SERVIÇO (ex.: "MSSQL-Develop") — colaborador de verdade
// tem caixa de e-mail corporativa (mail preenchido) e conta ativa; conta
// de serviço normalmente não tem "mail". "!(userAccountControl:...:=2)" é
// o jeito padrão de excluir conta desabilitada (bit ACCOUNTDISABLE) —
// tira quem já foi desligado/desativado no AD.
const FILTRO_USUARIOS = '(&(objectCategory=person)(objectClass=user)(sAMAccountName=*)(mail=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))';

function ldapConfigurado() {
  return Boolean(ldap && process.env.LDAP_URL && process.env.LDAP_BIND_DN && process.env.LDAP_BIND_PASSWORD && process.env.LDAP_BASE_DN);
}

// Mensagem específica pra quando o .env está certo mas o pacote não foi
// instalado — ajuda a diagnosticar em vez de cair no aviso genérico.
function motivoNaoConfigurado() {
  if (!ldap) return 'Pacote "ldapjs" não está instalado no servidor (rode "npm install" na pasta do projeto).';
  return 'LDAP não configurado no .env (LDAP_URL/LDAP_BIND_DN/LDAP_BIND_PASSWORD/LDAP_BASE_DN).';
}

function criarClienteConectado() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: process.env.LDAP_URL, timeout: 15000, connectTimeout: 10000 });
    client.on('error', (err) => reject(new Error(`Falha de conexão com o LDAP (${process.env.LDAP_URL}): ${err.message}`)));
    client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD, (err) => {
      if (err) return reject(new Error(`Falha ao autenticar no LDAP com a conta de bind: ${err.message}`));
      resolve(client);
    });
  });
}

// Devolve { usuarios: [...], atualizadoEm } no MESMO formato que a tela já
// espera (era o formato do Mapeamento-AD-Dados.json) — assim o front não
// precisa mudar nada além do rótulo da aba.
async function buscarUsuariosAD() {
  if (!ldapConfigurado()) {
    throw new Error('LDAP não configurado no .env (LDAP_URL/LDAP_BIND_DN/LDAP_BIND_PASSWORD/LDAP_BASE_DN).');
  }

  const client = await criarClienteConectado();
  const usuarios = [];

  try {
    await new Promise((resolve, reject) => {
      client.search(
        process.env.LDAP_BASE_DN,
        {
          filter: FILTRO_USUARIOS,
          scope: 'sub',
          attributes: ATRIBUTOS,
          paged: true,
        },
        (err, res) => {
          if (err) return reject(new Error(`Falha ao iniciar a busca no LDAP: ${err.message}`));

          res.on('searchEntry', (entry) => {
            const obj = entry.pojo ? Object.fromEntries(entry.pojo.attributes.map((a) => [a.type, a.values[0]])) : entry.object;
            const dn = entry.pojo ? entry.pojo.objectName : entry.objectName || entry.dn?.toString() || '';
            const host = obj['msDS-cloudExtensionAttribute1'] || '';
            const tag = obj['msDS-cloudExtensionAttribute2'] || '';
            const ip = obj['msDS-cloudExtensionAttribute3'] || '';
            const so = obj['msDS-cloudExtensionAttribute4'] || '';
            const login = obj['msDS-cloudExtensionAttribute5'] || '';
            usuarios.push({
              dn,
              nome: obj.displayName || obj.sAMAccountName || '',
              usuario: obj.sAMAccountName || '',
              email: obj.mail || '',
              departamento: obj.department || '',
              cargo: obj.title || '',
              gestorDn: obj.manager || '',
              host,
              tag,
              ip,
              so,
              login,
              coletado: Boolean(host && tag && ip && so && login),
            });
          });
          res.on('error', (errBusca) => reject(new Error(`Erro durante a busca no LDAP: ${errBusca.message}`)));
          res.on('end', () => resolve());
        }
      );
    });
  } finally {
    client.unbind();
  }

  // "manager" no AD vem como DN (ex.: "CN=Mirella de Oliveira
  // Silva,OU=..."), não como nome — resolve pra nome E e-mail usando o
  // próprio resultado da busca (o gestor quase sempre também está no mesmo
  // conjunto, já que está na mesma árvore de departamentos). Se o gestor
  // não aparecer aqui (fora do OU pesquisado, ou sem "mail"/desativado),
  // cai pro CN extraído do DN como nome, e sem e-mail (gestorEmail fica
  // vazio — quem chama precisa tratar esse caso, ex.: pedir o e-mail à
  // mão em vez de travar o envio). gestorEmail (2026-09-21) é usado pra
  // colocar o líder em cópia no e-mail de boas-vindas.
  const nomePorDn = new Map(usuarios.filter((u) => u.dn).map((u) => [u.dn.toLowerCase(), u.nome]));
  const emailPorDn = new Map(usuarios.filter((u) => u.dn).map((u) => [u.dn.toLowerCase(), u.email]));
  for (const u of usuarios) {
    if (!u.gestorDn) { u.gestor = ''; u.gestorEmail = ''; continue; }
    const chave = u.gestorDn.toLowerCase();
    const porMapa = nomePorDn.get(chave);
    u.gestorEmail = emailPorDn.get(chave) || '';
    if (porMapa) { u.gestor = porMapa; continue; }
    const cn = /^CN=([^,]+)/i.exec(u.gestorDn);
    u.gestor = cn ? cn[1] : u.gestorDn;
  }

  return { usuarios, atualizadoEm: new Date().toISOString() };
}

module.exports = { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado };
