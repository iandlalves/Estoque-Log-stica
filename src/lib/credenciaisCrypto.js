// Cifra/decifra as senhas guardadas em onboarding_credenciais (2026-09-18)
// — mesmo com essa tabela já restrita a papel=atendente, senha nunca fica
// legível em repouso no banco. AES-256-GCM (autenticado — detecta se o
// valor foi adulterado, não só criptografa) com `node:crypto`, sem
// dependência nova.
//
// Chave vem de CREDENCIAIS_ENC_KEY no .env — 32 bytes em hex. Gerar uma
// vez com:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Perder essa chave = perder todas as senhas guardadas (não tem como
// recuperar); trocar de chave sem re-cifrar as linhas existentes também
// invalida tudo que já foi salvo — troque com cuidado.

const crypto = require('node:crypto');

function chaveConfigurada() {
  return Boolean(process.env.CREDENCIAIS_ENC_KEY && process.env.CREDENCIAIS_ENC_KEY.length === 64);
}

function obterChave() {
  if (!chaveConfigurada()) {
    throw new Error(
      'CREDENCIAIS_ENC_KEY não configurada (ou não tem 64 caracteres hex = 32 bytes) no .env — gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(process.env.CREDENCIAIS_ENC_KEY, 'hex');
}

// texto claro -> "ivHex:authTagHex:cifradoHex"
function criptografar(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const iv = crypto.randomBytes(12); // 96 bits, padrão pra GCM
  const cifra = crypto.createCipheriv('aes-256-gcm', obterChave(), iv);
  const cifrado = Buffer.concat([cifra.update(String(texto), 'utf-8'), cifra.final()]);
  const authTag = cifra.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${cifrado.toString('hex')}`;
}

// "ivHex:authTagHex:cifradoHex" -> texto claro
function descriptografar(valor) {
  if (!valor) return null;
  const partes = valor.split(':');
  if (partes.length !== 3) throw new Error('Valor cifrado em formato inesperado.');
  const [ivHex, authTagHex, cifradoHex] = partes;
  const decifra = crypto.createDecipheriv('aes-256-gcm', obterChave(), Buffer.from(ivHex, 'hex'));
  decifra.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decifrado = Buffer.concat([decifra.update(Buffer.from(cifradoHex, 'hex')), decifra.final()]);
  return decifrado.toString('utf-8');
}

module.exports = { criptografar, descriptografar, chaveConfigurada };
