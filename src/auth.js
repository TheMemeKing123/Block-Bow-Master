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
  const payload = b64u(enc.encode(JSON.stringify({ userId, exp: Date.now() + TOKEN_TTL })));
  const t = payload + '.' + await hmacSign(sec, payload);
  console.log('[token] issue secret=', sec.slice(0,10), 'userId=', userId);
  return t;
}
async function userFromToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 0) return null;
  const head = token.slice(0, i), mac = token.slice(i + 1);
  const sec = await getSecret(env);
  const good = await hmacSign(sec, head);
  if (mac !== good) { console.log('[auth] mac mismatch sec=', sec.slice(0,10)); return null; }
  try {
    const p = JSON.parse(dec.decode(bytesFromB64u(head)));
    if (!p.userId || !p.exp || p.exp < Date.now()) { console.log('[auth] bad payload'); return null; }
    let db = await getDb(env);
    let f = null;
    for (const [name, u] of Object.entries(db)) {
      if (await nameToId(name) === p.userId) { f = { name, ...u }; break; }
    }
    /* 实例缓存可能滞后: 绕过缓存直读 KV, 找到新注册账号后刷新缓存 */
    if (!f) {
      try {
        const fresh = JSON.parse((await env.BOW_KV.get('db')) || 'null');
        if (fresh) {
          for (const [name, u] of Object.entries(fresh)) {
            if (await nameToId(name) === p.userId) { dbCache = fresh; f = { name, ...u }; break; }
          }
        }
      } catch (e) {}
    }
    /* 仍找不到: 回源 DO 查询 */
    if (!f) {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/user-check?userId=' + encodeURIComponent(p.userId));
        if (r.ok) {
          const d = await r.json();
          if (d.name && d.user && !d.user.banned) {
            try { const cur = await env.BOW_KV.get('db'); if (cur) dbCache = JSON.parse(cur); } catch (e) {}
            return { name: d.name, ...d.user };
          }
        }
      } catch (e) {}
    }
    if (f && f.banned) return null;
    if (!f) console.log('[auth] userId not found in db');
    return f;
  } catch (e) { return null; }
}
function pubUser(u) {
  return {
    username: u._name, score: u.score || 0, banned: !!u.banned,
    isAdmin: !!u.isAdmin, isDeveloper: !!u.isDeveloper, arrows: (u.arrows === undefined ? 100 : (u.arrows | 0)),
    reg: u.reg || 0, lastLogin: u.lastLogin || 0, online: u._online || false,
  };
}

export {
  ADMIN_NAME, ADMIN_DEFAULT_PASS, TOKEN_TTL,
  b64u, hex, hashPass, getDb, putDb, getSecret, hmacSign,
  issueToken, userFromToken, pubUser, nameToId,
};
