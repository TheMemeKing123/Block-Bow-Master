/* 共享: 存储 + token 鉴权 (Worker 与 Durable Object 共用) */
const ADMIN_NAME = '为啥全部姓名都在';
const ADMIN_DEFAULT_PASS = 'abc198992';
const TOKEN_TTL = 30 * 24 * 3600 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (buf) => {
  let s = ''; const b = new Uint8Array(buf);
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const bytesFromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((c) => c.toString(16).padStart(2, '0')).join('');
const bytesFromHex = (h) => new Uint8Array((h || '').match(/../g).map((b) => parseInt(b, 16)));

async function sha1Hex(s) { return hex(await crypto.subtle.digest('SHA-1', enc.encode(s))); }
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function nameToId(name) { return 'u' + (await sha1Hex('bow:' + name)).slice(0, 15); }
async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function hashPass(pass, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bytesFromHex(saltHex).buffer, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return hex(bits);
}

/* 存储: KV 直读直写(绕开 DO 免费层请求限额); DO 仅用于 WS 房间(WS 内消息不计请求数) */
let dbCache = null;
async function getDb(env) {
  if (dbCache) return dbCache;
  try { const s = await env.BOW_KV.get('db'); if (s) { dbCache = JSON.parse(s); return dbCache; } } catch (e) {}
  try { const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
    const r = await stub.fetch('https://do/db');
    if (r.ok) { dbCache = await r.json(); return dbCache; } } catch (e) {}
  return {};
}
async function putDb(env, d) {
  dbCache = d;
  try { await env.BOW_KV.put('db', JSON.stringify(d)); } catch (e) {}
  return true;
}
async function getSecret(env) {
  /* 确定性密钥: 由 SECRET_PEPPER 推导, Worker 与 DO 各自本地计算, 永远一致(不再经 KV 分发) */
  return await sha1Hex((env.SECRET_PEPPER || 'bow-fallback-v2') + '|bow-master|v1') + sha256Hex((env.SECRET_PEPPER || 'bow-fallback-v2') + '|bow-master|v1');
}
async function issueToken(env, name) {
  const sec = await getSecret(env);
  const userId = await nameToId(name);
  const payload = b64u(enc.encode(JSON.stringify({ userId, name, exp: Date.now() + TOKEN_TTL })));
  return payload + '.' + await hmacSign(sec, payload);
}
async function userFromToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 0) return null;
  const head = token.slice(0, i), mac = token.slice(i + 1);
  const sec = await getSecret(env);
  const good = await hmacSign(sec, head);
  if (mac !== good) return null;
  try {
    const p = JSON.parse(dec.decode(bytesFromB64u(head)));
    if (!p.name || !p.exp || p.exp < Date.now()) return null;
    if (await nameToId(p.name) !== p.userId) return null;   // 防伪造
    const rec = await readUser(env, p.name);
    if (!rec) return null;
    if (rec.banned) return null;
    return { name: p.name, ...rec };
  } catch (e) { return null; }
}

/* ---------------- 按用户 KV 存取 ---------------- */
const UKEY = (name) => 'u:' + name;
async function readUser(env, name) {
  try { const v = await env.BOW_KV.get(UKEY(name)); if (v) return JSON.parse(v); } catch (e) {}
  /* 旧整库迁移: 首次访问时拆出独立键 */
  try {
    const blob = JSON.parse((await env.BOW_KV.get('db')) || 'null');
    if (blob && blob[name]) {
      const rec = blob[name];
      try { await env.BOW_KV.put(UKEY(name), JSON.stringify(rec)); } catch (e) {}
      return rec;
    }
  } catch (e) {}
  return null;
}
async function writeUser(env, name, rec) {
  await env.BOW_KV.put(UKEY(name), JSON.stringify(rec));
}
async function delUser(env, name) {
  await env.BOW_KV.delete(UKEY(name));
}

function pubUser(u) {
  return {
    username: u._name, score: u.score || 0, banned: !!u.banned,
    isAdmin: !!u.isAdmin, isDeveloper: !!u.isDeveloper, arrows: (u.arrows === undefined ? 100 : (u.arrows | 0)),
    sp: u.sp || {},
    best: u.best || {},
    reg: u.reg || 0, lastLogin: u.lastLogin || 0, online: u._online || false,
  };
}

export {
  ADMIN_NAME, ADMIN_DEFAULT_PASS, TOKEN_TTL,
  b64u, hex, hashPass, getDb, putDb, getSecret, hmacSign,
  issueToken, userFromToken, pubUser, nameToId, readUser, writeUser, delUser,
};
