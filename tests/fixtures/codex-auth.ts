// Synthetic JWT-shaped token; never accepted by a real provider.
export function codexToken(expires = Date.now() + 3_600_000, account = 'test-account') {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    exp: Math.floor(expires / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: account },
  })).toString('base64url')}.fixture-signature`;
}
