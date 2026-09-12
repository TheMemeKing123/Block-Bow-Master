/* 方块弓箭大师 v4.0-CF · Cloudflare Workers 版后端
   账号API + KV存储 + Durable Object房间(WebSocket)
   静态前端由 wrangler assets 托管 */
import { RoomDO } from './do.js';
import { ADMIN_NAME, hex, hashPass, getDb, putDb, getSecret, hmacSign, issueToken, userFromToken, pubUser } from './auth.js';
export { RoomDO };

/* ---------------- 工具 ---------------- */
function json(data, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
async function presenceList(env) {
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
    const r = await stub.fetch('https://do/presence');
    const d = await r.json();
    return d.online || [];
  } catch (e) { return []; }
}

/* ---------------- API ---------------- */
const NAME_RE = /[<>"'\/\\]/;
const ADMIN_API = ['/api/admin/'];
const AUTH_API = ['/api/me', '/api/logout', '/api/online', '/api/users/public', '/api/score', '/api/settings/title'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* WebSocket upgrade -> Durable Object (原样转发, DO 自行验签) */
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      return stub.fetch(request);
    }

    if (!url.pathname.startsWith('/api/')) {
      try {
        const res = await env.ASSETS.fetch(request);
        const h = new Headers(res.headers);
        h.set('Cache-Control', 'private, no-store, max-age=0');
        h.set('CDN-Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      } catch (e) { return new Response('not found', { status: 404 }); }
    }

    const body = url.pathname === '/ws' ? {} : await readBody(request);
    const token = request.headers.get('X-User-Token');
    const me = await userFromToken(env, token);
    const path = url.pathname;

    if (path === '/api/skin/get' && request.method === 'GET') {
      const nm = String(url.searchParams.get('name') || '').slice(0, 16);
      const db = await getDb(env);
      const u = db[nm];
      return json({ skin: (u && u.skin) || null });
    }
    if (path === '/api/config' && request.method === 'GET') {
      return json({ config: { maxScore: 999999, server: 'bow-v4-cf' } });
    }
    if (path === '/api/register' && request.method === 'POST') {
      const name = String(body.username || '').trim();
      const pass = String(body.password || '');
      if (!name) return json({ error: '请输入姓名（账号）' }, 400);
      if (name === ADMIN_NAME) return json({ error: '该账号是管理员保留账号，不能注册' }, 400);
      if (NAME_RE.test(name)) return json({ error: '姓名里不能包含特殊符号' }, 400);
      if (name.length > 16) return json({ error: '姓名最长 16 字' }, 400);
      if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const db = await getDb(env);
      let dupInDO = false;
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const rr = await stub.fetch('https://do/user-exists?name=' + encodeURIComponent(name));
        if (rr.ok) { const d = await rr.json(); dupInDO = !!d.exists; }
      } catch (e) {}
      if (db[name] || dupInDO) return json({ error: '这个账号已经被注册过了' }, 400);
      const salt = hex(crypto.getRandomValues(new Uint8Array(8)));
      db[name] = { salt, pass: await hashPass(pass, salt), score: 0, arrows: 100, banned: false, isAdmin: false, isDeveloper: false, reg: Date.now(), lastLogin: 0 };
      /* 同步创建到房间服务(DO), 并验证确实写入; 失败则明确告知用户重试 */
      let doSynced = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
          await stub.fetch('https://do/user-create', { method: 'POST', body: JSON.stringify(db[name]) });
          const vr = await stub.fetch('https://do/user-exists?name=' + encodeURIComponent(name));
          const vd = await vr.json();
          if (vd.exists) { doSynced = true; break; }
          console.error('[register] user-create 验证未通过 attempt=' + attempt);
        } catch (e) { console.error('[register] user-create 失败 attempt=' + attempt, String(e).slice(0, 120)); }
        await new Promise(r => setTimeout(r, 700));
      }
      if (!doSynced) return json({ error: '注册服务繁忙，请稍后再试一次' }, 503);
      const u = { ...db[name], _name: name };
      return json({ token: await issueToken(env, name), user: pubUser(u) });
    }
    if (path === '/api/login' && request.method === 'POST') {
      try {
        const name = String(body.username || '').trim();
        const pass = String(body.password || '');
        const db = await getDb(env);
        let u = db[name];
        if (!u) {
          /* KV 副本可能滞后: 回源 DO 查询 */
          try {
            const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
            const rr = await stub.fetch('https://do/user-check?name=' + encodeURIComponent(name));
            if (rr.ok) { const d = await rr.json(); if (d.name && d.user) u = d.user; }
          } catch (e) {}
        }
        if (!u) return json({ error: '账号不存在，请先注册' }, 400);
        /* 自动建档账号(无密码)首次登录即认领: 设置密码 */
        if (!u.salt && !u.pass) {
          if (pass.length < 6) return json({ error: '密码至少 6 位' }, 400);
          const csalt = hex(crypto.getRandomValues(new Uint8Array(8)));
          u.salt = csalt;
          u.pass = await hashPass(pass, csalt);
          await putDb(env, db);
          return json({ token: await issueToken(env, name), user: pubUser({ ...u, _name: name }) });
        }
        if (await hashPass(pass, u.salt) !== u.pass) return json({ error: '密码错误！' }, 400);
        if (u.banned) return json({ error: 'banned' }, 403);
        u.lastLogin = Date.now();
        let uo = { ...u, _name: name };
        try {
          const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
          const r = await stub.fetch('https://do/user-score?name=' + encodeURIComponent(name));
          if (r.ok) { const dsc = await r.json(); if (dsc.score !== null) uo.score = dsc.score; if (dsc.arrows !== null) uo.arrows = dsc.arrows; }
        } catch (e) {}
        return json({ token: await issueToken(env, name), user: pubUser(uo) });
      } catch (e) { return json({ error: 'SRV ' + (e.message || String(e)) + ' :: ' + String(e.stack || '').slice(0, 400) }, 500); }
    }

    if (!me) {
      let dbg = '';
      try {
        const t = token || ''; const i2 = t.indexOf('.');
        const sec = await getSecret(env);
        const good = await hmacSign(sec, t.slice(0, i2));
        dbg = 'sec=' + sec.slice(0, 8) + ' macMatch=' + (good === t.slice(i2 + 1)) + ' dbKeys=' + Object.keys(await getDb(env)).length;
      } catch (e) { dbg = 'EXC ' + String(e).slice(0, 120); }
      return json({ error: '未登录或登录已过期', dbg }, 401);
    }

    if (path === '/api/me' && request.method === 'GET') {
      const online = (await presenceList(env)).includes(me.name);
      const uo = { ...me, _name: me.name, _online: online };
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/user-score?name=' + encodeURIComponent(me.name));
        if (r.ok) { const d = await r.json(); if (d.score !== null) uo.score = d.score; if (d.arrows !== null) uo.arrows = d.arrows; }
      } catch (e) {}
      return json({ user: pubUser(uo) });
    }
    if (path === '/api/logout' && request.method === 'POST') return json({ ok: true });
    const fop = async (act, other) => {
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      const r = await stub.fetch('https://do/friend-op', { method: 'POST', body: JSON.stringify({ name: me.name, other, act }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '操作失败');
      return d;
    };
    if (path === '/api/friend/list' && request.method === 'GET') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/friend?name=' + encodeURIComponent(me.name));
        return json(await r.json());
      } catch (e) { return json({ friends: [], requests: [], sent: [] }); }
    }
    if (path === '/api/friend/request' && request.method === 'POST') { try { return json(await fop('request', String(body.to || '').slice(0, 16))); } catch (e) { return json({ error: e.message }, 400); } }
    if (path === '/api/friend/accept' && request.method === 'POST') { try { return json(await fop('accept', String(body.from || '').slice(0, 16))); } catch (e) { return json({ error: e.message }, 400); } }
    if (path === '/api/friend/reject' && request.method === 'POST') { try { return json(await fop('reject', String(body.from || '').slice(0, 16))); } catch (e) { return json({ error: e.message }, 400); } }
    if (path === '/api/friend/cancel' && request.method === 'POST') { try { return json(await fop('cancel', String(body.to || '').slice(0, 16))); } catch (e) { return json({ error: e.message }, 400); } }
    if (path === '/api/ucdbg' && request.method === 'GET') {
      if (!me.isDeveloper) return json({ error: '无权' }, 403);
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      const nm = url.searchParams.get('name') || me.name;
      const which = url.searchParams.get('dump') || '';
      const rr = which ? await stub.fetch('https://do/' + which) : await stub.fetch('https://do/user-check?name=' + encodeURIComponent(nm));
      return new Response(await rr.text(), { status: rr.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/dbdbg' && request.method === 'GET') {
      if (!me.isDeveloper) return json({ error: '无权' }, 403);
      const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
      const r = await stub.fetch('https://do/dbdbg');
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/sync-me' && request.method === 'POST') {
      try {
        const db = await getDb(env);
        const u = db[me.name];
        if (!u) return json({ error: '账号不存在于主库' }, 400);
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/user-create', { method: 'POST', body: JSON.stringify(u) });
        const d = await r.json();
        return json({ ok: true, already: !!d.already });
      } catch (e) { return json({ error: '同步失败' }, 500); }
    }
    if (path === '/api/friend/gift' && request.method === 'POST') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/gift', { method: 'POST', body: JSON.stringify({ from: me.name, to: String(body.to || '').slice(0, 16), count: body.count | 0 }) });
        return json(await r.json());
      } catch (e) { return json({ error: '服务暂不可用' }, 500); }
    }
    if (path === '/api/friend/remove' && request.method === 'POST') { try { return json(await fop('remove', String(body.name || '').slice(0, 16))); } catch (e) { return json({ error: e.message }, 400); } }
    if (path === '/api/rooms' && request.method === 'GET') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/rooms');
        return json(await r.json());
      } catch (e) { return json({ rooms: [] }); }
    }
    const antiP = (r) => { try { return r; } catch (e) { return json({ error: e.message }, 400); } };
    if (path === '/api/score' && request.method === 'POST') {
      const d = body.delta | 0;
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/audit-score', { method: 'POST', body: JSON.stringify({ name: me.name, delta: d, fp: String(request.headers.get('X-Dev-FP') || ''), x: Number(body.x), z: Number(body.z) }) });
        if (r.status === 403) return json({ error: '行为异常已被记录', score: null }, 403);
        return json(await r.json());
      } catch (e) { return json({ error: '服务繁忙' }, 500); }
    }
    if ((path === '/api/event/shoot' || path === '/api/event/hit') && request.method === 'POST') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        await stub.fetch('https://do/audit-ev', { method: 'POST', body: JSON.stringify({ name: me.name, kind: path.endsWith('shoot') ? 'shoot' : 'hit' }) });
      } catch (e) {}
      return json({ ok: true });
    }
    if (path === '/api/skin/set' && request.method === 'POST') {
      const data = String(body.data || '');
      if (!data.startsWith('data:image/png;base64,') || data.length > 40000) return json({ error: '只支持 64x64 PNG（小于30KB）' }, 400);
      const db = await getDb(env);
      db[me.name].skin = data;
      await putDb(env, db);
      return json({ ok: true });
    }
    if (path === '/api/arrow/use' && request.method === 'POST') {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/arrow/use', { method: 'POST', body: JSON.stringify({ name: me.name }) });
        return json(await r.json());
      } catch (e) { return json({ error: '服务暂不可用' }, 500); }
    }
    if (path === '/api/shop/buy' && request.method === 'POST') {
      const count = Math.floor(Number(body.count) || 0);
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
        const r = await stub.fetch('https://do/shop/buy', { method: 'POST', body: JSON.stringify({ name: me.name, count }) });
        const d = await r.json();
        return json(d, r.status === 200 ? 200 : 400);
      } catch (e) { return json({ error: '服务暂不可用' }, 500); }
    }
    if (path === '/api/settings/title' && request.method === 'POST') {
      const db = await getDb(env);
      db[me.name].title = String(body.title || '').slice(0, 20);
      await putDb(env, db);
      return json({ ok: true });
    }
    if (path === '/api/users/public' && request.method === 'GET') {
      const db = await getDb(env);
      return json({ names: Object.keys(db) });
    }
    if (path === '/api/online' && request.method === 'POST') {
      const names = Array.isArray(body.names) ? body.names.slice(0, 200) : [];
      const online = await presenceList(env);
      return json({ online: names.filter((n) => online.includes(n)) });
    }

    if (path.startsWith('/api/admin/')) {
      if (!(me.isAdmin || me.isDeveloper)) return json({ error: '需要管理员权限' }, 403);
      const uname = String(body.username || '').trim();
      const target = uname ? (await getDb(env))[uname] : undefined;
      const isDev = (u) => u && u.isDeveloper;
      const canTouch = (u) => u && (me.name === ADMIN_NAME || (!isDev(u) && (!u.isAdmin || me.isDeveloper)));

      if (path === '/api/admin/warnings' && request.method === 'GET') {
        try {
          const stub = env.ROOM.get(env.ROOM.idFromName('bow-live5'));
          const r = await stub.fetch('https://do/audit');
          return json(await r.json());
        } catch (e) { return json({ players: [] }); }
      }
      if (path === '/api/admin/users' && request.method === 'GET') {
        const db = await getDb(env);
        const online = await presenceList(env);
        const users = Object.keys(db).map((k) => pubUser({ ...db[k], _name: k, _online: online.includes(k) }))
          .sort((a, b) => b.score - a.score);
        return json({ users });
      }
      if (request.method !== 'POST') return json({ error: 'not found' }, 404);

      const mutate = async (fn) => {
        try {
          const db = await getDb(env);
          const r = await fn(db, uname, db[uname]);
          if (r === false) return { __err: '操作失败' };
          await putDb(env, db);
          return r;
        } catch (e) { return { __err: e.message || '操作失败' }; }
      };

      if (path === '/api/admin/promote') {
        if (!me.isDeveloper) return json({ error: '只有开发者能任命管理员' }, 403);
        const r = await mutate((db, n, u) => {
          if (!u) throw new Error('这个玩家不存在');
          if (isDev(u)) throw new Error('该账号是开发者');
          u.isAdmin = true; return { ok: true };
        });
        return r.__err ? json({ error: r.__err }, 400) : json(r);
      }
      if (path === '/api/admin/demote') {
        if (!me.isDeveloper) return json({ error: '只有开发者能取消管理员' }, 403);
        const r = await mutate((db, n, u) => {
          if (!u) throw new Error('这个玩家不存在');
          if (isDev(u)) throw new Error('开发者账号不可降级');
          u.isAdmin = false; return { ok: true };
        });
        return r.__err ? json({ error: r.__err }, 400) : json(r);
      }
      if (path === '/api/admin/ban') {
        const r = await mutate((db, n, u) => {
          if (!canTouch(u)) throw new Error('无权操作该账号');
          u.banned = body.banned === false ? false : true;
          return { ok: true, banned: !!u.banned, name: n };
        });
        if (r.ok && r.banned) await (await env.ROOM.get(env.ROOM.idFromName('bow-live5'))).fetch('https://do/kick', { method: 'POST', body: JSON.stringify({ username: r.name }) });
        return r.__err ? json({ error: r.__err }, 400) : json({ ok: true });
      }
      if (path === '/api/admin/setdeveloper' && request.method === 'POST') {
        if (!me.isDeveloper) return json({ error: '只有开发者能任命开发者' }, 403);
        const r = await mutate((db, n, u) => {
          if (!u) throw new Error('这个玩家不存在');
          if (body.on === false) { if (n === ADMIN_NAME) throw new Error('内置开发者不可降级'); u.isDeveloper = false; }
          else u.isDeveloper = true;
          return { ok: true };
        });
        return r.__err ? json({ error: r.__err }, 400) : json(r);
      }
      if (path === '/api/admin/delete') {
        const r = await mutate((db, n, u) => {
          if (!canTouch(u)) throw new Error('无权删除该账号');
          delete db[n];
          return { ok: true, name: n };
        });
        if (r.ok) await (await env.ROOM.get(env.ROOM.idFromName('bow-live5'))).fetch('https://do/kick', { method: 'POST', body: JSON.stringify({ username: r.name, deleted: true }) });
        return r.__err ? json({ error: r.__err }, 400) : json({ ok: true });
      }
      if (path === '/api/admin/setpassword') {
        const pass = String(body.password || '');
        const r = await mutate(async (db, n, u) => {
          if (!canTouch(u)) throw new Error('无权操作该账号');
          if (pass.length < 6) throw new Error('密码至少 6 位');
          u.salt = hex(crypto.getRandomValues(new Uint8Array(8)));
          u.pass = await hashPass(pass, u.salt);
          return { ok: true };
        });
        return r.__err ? json({ error: r.__err }, 400) : json(r);
      }
      if (path === '/api/admin/score') {
        const r = await mutate((db, n, u) => {
          const d = Math.max(-500, Math.min(500, body.delta | 0));
          if (body.zero) { Object.keys(db).forEach((k) => { if (!isDev(db[k])) db[k].score = 0; }); return { ok: true }; }
          if (body.all) { Object.keys(db).forEach((k) => { const x = db[k]; if (!isDev(x)) x.score = Math.max(0, (x.score || 0) + d); }); return { ok: true }; }
          if (!canTouch(u)) throw new Error('无权操作该账号');
          u.score = Math.max(0, (u.score || 0) + d);
          return { ok: true, score: u.score };
        });
        return r.__err ? json({ error: r.__err }, 400) : json(r);
      }
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  },
};
