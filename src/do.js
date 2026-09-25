/* RoomDO: 全局唯一 Durable Object，承载所有房间 + 在线名单
   使用 hibernation API（免费额度友好） */
import { userFromToken, ADMIN_NAME, ADMIN_DEFAULT_PASS, nameToId } from './auth.js';
const b64u = (buf) => { let s=''; const b=new Uint8Array(buf); for (const c of b) s+=String.fromCharCode(c); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); };

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();   // code -> {host:{ws,name}, guest:{ws,name}}
    this.online = new Map();  // name -> ws
    this.meta = new Map();    // ws -> {name, room, role} (非hibernation模式下serializeAttachment不可靠)
    this.db = null;           // 账号库(内存为准)
    this.secret = null;       // token签名密钥
    this.offlineMsgs = new Map();
    this.audit = {};          // 反作弊审计 (含 tens 十环计数) // 离线私信: name -> [{from,text,ts}]
    this.siteClosed = false;
  }
  async ensure() {
    if (this.db && this.secret) return;
    /* 数据加载优先级: DO 自带存储(强一致, 最新) -> S3 备份 -> KV 兜底 */
    try { if (!this.db) this.db = (await this.state.storage.get('db')) || null; } catch (e) {}
    try { if (!this.db) this.db = JSON.parse((await this.s3GetObj('bow-db.json')) || 'null'); } catch (e) {}
    try { if (!this.db || !Object.keys(this.db).length) this.db = JSON.parse((await this.env.BOW_KV.get('db')) || 'null'); } catch (e) {}
    if (!this.secret) this.secret = await this.sha256((this.env.SECRET_PEPPER || 'bow-fallback-v2') + '|bow-master|v1');
    if (!this.secret) { try { this.secret = (await this.s3GetObj('bow-secret')) || null; } catch (e) {} }
    if (this.db) for (const k of Object.keys(this.db)) { if (this.db[k].arrows === undefined) this.db[k].arrows = 100; }
    if (!this.db || !Object.keys(this.db).length) {
      const salt = [...crypto.getRandomValues(new Uint8Array(8))].map(c=>c.toString(16).padStart(2,'0')).join('');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ADMIN_DEFAULT_PASS), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt: new Uint8Array(salt.match(/../g).map(b=>parseInt(b,16))).buffer, iterations:100000, hash:'SHA-256' }, key, 256);
      const pass = [...new Uint8Array(bits)].map(c=>c.toString(16).padStart(2,'0')).join('');
      this.db = {};
      this.db[ADMIN_NAME] = { salt, pass, score:0, arrows:100, banned:false, isAdmin:true, isDeveloper:true, reg:Date.now(), lastLogin:0 };
    }
    if (!this.secret) this.secret = b64u(crypto.getRandomValues(new Uint8Array(32)).buffer);
    try { await this.env.BOW_KV.put('db', JSON.stringify(this.db)); } catch (e) {}
    try {
      const sc = await this.state.storage.get('site_closed');
      if (sc === '1' || sc === true) this.siteClosed = true;
    } catch (e) {}
    if (!this.siteClosed) {
      try { this.siteClosed = (await this.env.BOW_KV.get('site_closed')) === '1'; } catch (e) {}
    }
    await this.persistDb();
  }

  async syncUsersFromKV(needName) {
    for (let i = 0; i < 3; i++) {
      try {
        const fresh = JSON.parse((await this.env.BOW_KV.get('db')) || 'null');
        if (fresh) {
          for (const k of Object.keys(fresh)) { if (!this.db[k]) this.db[k] = fresh[k]; }
          if (this.db[needName]) return true;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 700));
    }
    return !!this.db[needName];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        rooms: [...this.rooms.entries()].map(([code, r]) => ({ code, host: r.host.name, players: [...r.players.values()].map(p => p.name) })),
        fwdCount: this.fwdCount || 0,
        fwdLog: this.fwdLog || [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/rooms') {
      const list = [...this.rooms.entries()].map(([code, r]) => ({
        code, host: r.host ? r.host.name : '', count: r.players.size, max: r.max, hasPass: !!r.pass, full: r.players.size >= r.max,
      }));
      return new Response(JSON.stringify({ rooms: list }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/friend' && request.method === 'GET') {
      await this.ensure();
      const name = url.searchParams.get('name');
      const u = this.db[name];
      if (!u) return new Response(JSON.stringify({ friends: [], requests: [], sent: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ friends: u.friends||[], requests: u.requests||[], sent: u.sent||[] }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/audit' && request.method === 'GET') {
      await this.ensure();
      const out = [];
      for (const n of Object.keys(this.audit)) {
        const a = this.audit[n];
        if (a.warns && a.warns.length) out.push({ name: n, warns: a.warns.slice(-10), ops: (a.ops||[]).length, shots: a.shots||0, hits: a.hits||0, tens: a.tens||0, fps: (a.fps||new Set()).size });
      }
      return new Response(JSON.stringify({ players: out }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/audit-score' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      const name = b.name, delta = b.delta, fp = b.fp;
      if (!this.db[name]) { try { await this.syncUsersFromKV(name); } catch (e) {} }
      let u = this.db[name];
      if (!u) {
        /* 令牌已验签(账号在注册链路中存在), 这里自动建档兜底, 避免滚动窗口期丢分 */
        if (!delta || delta < 1 || delta > 10) return new Response(JSON.stringify({ error: '账号不存在' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        this.db[name] = { salt: '', pass: '', score: 0, arrows: 100, banned: false, isAdmin: false, isDeveloper: false, reg: Date.now(), lastLogin: Date.now() };
        u = this.db[name];
        try { await this.state.storage.put('db', this.db); } catch (e) {}   // 建档立即持久化
      }
      if (!Number.isInteger(delta) || delta < 1 || delta > 10) {
        this.warn(name, '非法加分请求 delta=' + delta);
        return new Response(JSON.stringify({ error: '作弊数据已记录', score: u.score }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      /* v5: 距靶太近(贴脸) 服务端拒绝加分 */
      const T1 = { x: -2.0, z: -22 }, T2 = { x: 2.0, z: -22 };
      const px = Number(b.x), pz = Number(b.z);
      if (Number.isFinite(px) && Number.isFinite(pz)) {
        const d1 = Math.hypot(px - T1.x, pz - T1.z), d2 = Math.hypot(px - T2.x, pz - T2.z);
        if (Math.min(d1, d2) < 12) {
          this.warn(name, '贴脸得分请求(距靶' + Math.round(Math.min(d1, d2)) + 'm<12m)');
          return new Response(JSON.stringify({ error: '贴脸得分已被拒绝', score: u.score }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
      }
      const a = this.auditRow(name);
      const now = Date.now();
      a.ops.push({ t: now, d: delta });
      a.ops = a.ops.filter(o => now - o.t < 60000);
      if (a.ops.length > 900) this.warn(name, '加分频率异常: '+a.ops.length+'次/60秒 (≈'+(Math.round(a.ops.length/6)/10)+' CPS, 远超人类手速)');
      if (fp) { a.fps.add(fp); if (a.fps.size > 3) this.warn(name, '异常多设备指纹(' + a.fps.size + '种)'); }
      u.score = Math.max(0, (u.score || 0) + delta);
      await this.persistDb();
      return new Response(JSON.stringify({ score: u.score }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/arrow/use' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      if (!this.db[b.name]) { try { await this.syncUsersFromKV(b.name); } catch (e) {} }
      const u = this.db[b.name];
      if (!u) return new Response(JSON.stringify({ error: '账号不存在' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      u.arrows = Math.max(0, (u.arrows || 0) - 1);
      await this.persistDb();
      return new Response(JSON.stringify({ arrows: u.arrows }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/user-score') {
      await this.ensure();
      const n = String(url.searchParams.get('name') || '').slice(0, 16);
      const u = this.db[n];
      return new Response(JSON.stringify({ score: u ? (u.score|0) : null, arrows: u ? (u.arrows|0) : null }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/dbdbg') {
      const mem = Object.keys(this.db || {});
      let st = null, stErr = '';
      try { const v = await this.state.storage.get('db'); st = v ? Object.keys(v) : null; } catch (e) { stErr = String(e).slice(0, 100); }
      return new Response(JSON.stringify({ memKeys: mem, stateKeys: st, stErr, hasPepper: !!this.env.SECRET_PEPPER }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/user-check') {
      await this.ensure();
      const want = String(url.searchParams.get('userId') || '');
      const byName = String(url.searchParams.get('name') || '');
      const scan = async () => {
        for (const [name, u] of Object.entries(this.db)) {
          if ((byName && name === byName) || (want && (await nameToId(name)) === want)) {
            return { name, user: u };
          }
        }
        return null;
      };
      let f = await scan();
      if (!f) { try { await this.syncUsersFromKV(byName || want); f = await scan(); } catch (e) {} }
      if (f) return new Response(JSON.stringify({ name: f.name, user: f.user }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/user-exists') {
      await this.ensure();
      const n = String(url.searchParams.get('name') || '').slice(0, 16);
      return new Response(JSON.stringify({ exists: !!this.db[n] }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/user-create' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      const name = String(b.name || '').slice(0, 16);
      if (!name) return new Response(JSON.stringify({ error: '无用户名' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (this.db[name]) return new Response(JSON.stringify({ ok: true, already: true }), { headers: { 'Content-Type': 'application/json' } });
      this.db[name] = {
        salt: String(b.salt || ''), pass: String(b.pass || ''),
        score: b.score|0, arrows: (b.arrows === undefined ? 100 : (b.arrows|0)),
        banned: false, isAdmin: false, isDeveloper: false,
        reg: b.reg || Date.now(), lastLogin: b.lastLogin || 0,
      };
      await this.persistDb();   // 注册用户立即持久化到 DO 强一致存储
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/gift' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      const from = String(b.from || '').slice(0, 16);
      const to = String(b.to || '').slice(0, 16);
      const cnt = Math.max(1, Math.min(100, b.count | 0));
      if (!this.db[from]) { try { await this.syncUsersFromKV(from); } catch (e) {} }
      if (!this.db[to]) { try { await this.syncUsersFromKV(to); } catch (e) {} }
      const uf = this.db[from], ut = this.db[to];
      if (from === to) return new Response(JSON.stringify({ error: '不能送给自己' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (!uf || !ut) return new Response(JSON.stringify({ error: '对方账号不存在' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const fl = uf.friends || [];
      if (!fl.includes(to)) return new Response(JSON.stringify({ error: '只能赠送给好友' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if ((uf.arrows|0) < cnt) return new Response(JSON.stringify({ error: '箭矢不足' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      uf.arrows = (uf.arrows|0) - cnt;
      ut.arrows = (ut.arrows|0) + cnt;
      const now = Date.now();
      const text = '🎁 送了你 ' + cnt + ' 支箭';
      if (!uf.dm) uf.dm = []; uf.dm.push({ from, to, text, ts: now }); uf.dm = uf.dm.slice(-300);
      if (!ut.dm) ut.dm = []; ut.dm.push({ from, to, text, ts: now }); ut.dm = ut.dm.slice(-300);
      await this.persistDb();
      const target = this.online.get(to);
      if (target) { try { target.send(JSON.stringify({ t: 'gift', from, count: cnt })); } catch (e) {} }
      return new Response(JSON.stringify({ ok: true, arrows: uf.arrows }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/shop/buy' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      if (!this.db[b.name]) { try { await this.syncUsersFromKV(b.name); } catch (e) {} }
      const u = this.db[b.name];
      if (!u) return new Response(JSON.stringify({ error: '账号不存在' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const count = Math.floor(b.count | 0);
      if (count < 1 || count > 10000) return new Response(JSON.stringify({ error: '数量无效' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const cost = count;
      if ((u.score || 0) < cost) return new Response(JSON.stringify({ error: '积分不足' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      u.score -= cost;
      u.arrows = (u.arrows || 0) + count;
      await this.persistDb();
      return new Response(JSON.stringify({ score: u.score, arrows: u.arrows }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/audit-ev' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      const name = b.name, kind = b.kind;
      const a = this.auditRow(name);
      if (kind === 'shoot') a.shots = (a.shots || 0) + 1;
      else if (kind === 'hit') {
        a.hits = (a.hits || 0) + 1;
        if ((b.ring | 0) === 10) a.tens = (a.tens || 0) + 1;
        if ((a.shots || 0) >= 80 && (a.tens || 0) >= 80 && a.tens === a.shots) this.warn(name, '十环率100%: 射'+a.shots+' 十环'+a.tens+' (疑似挂)');
      }
      return new Response('ok');
    }
    if (url.pathname === '/friend-op' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json();
      const name = b.name, other = b.other, act = b.act;
      const f = (n) => { const u = this.db[n] || (this.db[n] = { score:0, salt:'', pass:'', banned:false, isAdmin:false, isDeveloper:false, reg:0, lastLogin:0 }); if (!u.friends) u.friends = []; if (!u.requests) u.requests = []; if (!u.sent) u.sent = []; return u; };
      const ok = (msg) => new Response(JSON.stringify({ ok: true, msg, friends: f(name).friends, requests: f(name).requests, sent: f(name).sent }), { headers: { 'Content-Type': 'application/json' } });
      const bad = (msg) => new Response(JSON.stringify({ error: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (!name || !other) return bad('参数缺失');
      if (name === other) return bad('不能添加自己');
      const A = f(name), B = f(other);
      const notify = (t, extra) => { const w = this.online.get(other); if (w) { try { w.send(JSON.stringify({ t, ...extra })); } catch (e) {} } };
      if (act === 'request') {
        if (A.friends.includes(other)) return bad('已经是好友了');
        if (B.requests.includes(name)) return bad('已发送过申请，等待对方回复');
        B.requests.push(name); A.sent.push(other);
        notify('friend-req', { from: name });
        return ok('申请已发送');
      }
      if (act === 'accept') {
        const i = A.requests.indexOf(other);
        if (i < 0) return bad('没有这条申请');
        A.requests.splice(i, 1);
        const j = B.sent.indexOf(name); if (j >= 0) B.sent.splice(j, 1);
        if (!A.friends.includes(other)) A.friends.push(other);
        if (!B.friends.includes(name)) B.friends.push(name);
        notify('friend-accepted', { from: name });
        return ok('已同意，你们现在是好友了');
      }
      if (act === 'reject') {
        const i = A.requests.indexOf(other); if (i >= 0) A.requests.splice(i, 1);
        const j = B.sent.indexOf(name); if (j >= 0) B.sent.splice(j, 1);
        notify('friend-rejected', { from: name });
        return ok('已拒绝');
      }
      if (act === 'cancel') {
        const i = B.requests.indexOf(name); if (i >= 0) B.requests.splice(i, 1);
        const j = A.sent.indexOf(other); if (j >= 0) A.sent.splice(j, 1);
        return ok('已撤销申请');
      }
      if (act === 'remove') {
        const rm = (arr, v) => { const k = arr.indexOf(v); if (k >= 0) arr.splice(k, 1); };
        rm(A.friends, other); rm(B.friends, name);
        return ok('已删除好友');
      }
      return bad('未知操作');
    }
    if (url.pathname === '/db') { await this.ensure(); return new Response(JSON.stringify(this.db), { headers:{'Content-Type':'application/json'} }); }
    if (url.pathname === '/db-set') { await this.ensure(); this.db = await request.json(); try { await this.env.BOW_KV.put('db', JSON.stringify(this.db)); } catch (e) {} return new Response('ok'); }
    if (url.pathname === '/secret') { await this.ensure(); return new Response(this.secret); }
    if (url.pathname === '/presence') {
      return new Response(JSON.stringify({ online: [...this.online.keys()] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/site-closed' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json().catch(() => ({}));
      this.siteClosed = !!b.closed;
      try { await this.state.storage.put('site_closed', this.siteClosed ? '1' : '0'); } catch (e) {}
      if (this.siteClosed) this.kickNonDevelopers();
      return new Response(JSON.stringify({ ok: true, closed: this.siteClosed }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/admin-grant' && request.method === 'POST') {
      await this.ensure();
      const b = await request.json().catch(() => ({}));
      const scoreDelta = Number.isFinite(b.scoreDelta) ? (b.scoreDelta | 0) : 0;
      const arrowsDelta = Number.isFinite(b.arrowsDelta) ? (b.arrowsDelta | 0) : 0;
      const applyOne = (u) => {
        if (!u) return;
        if (b.zero) u.score = 0;
        else if (scoreDelta) u.score = Math.max(0, (u.score || 0) + scoreDelta);
        if (b.zeroArrows) u.arrows = 0;
        else if (arrowsDelta) u.arrows = Math.max(0, (u.arrows === undefined ? 100 : (u.arrows | 0)) + arrowsDelta);
      };
      if (b.all) {
        for (const k of Object.keys(this.db || {})) applyOne(this.db[k]);
      } else {
        const n = String(b.name || '').slice(0, 16);
        if (n && this.db[n]) applyOne(this.db[n]);
      }
      await this.persistDb();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/kick') {
      const { username, deleted } = await request.json();
      const ws = this.online.get(username);
      if (ws) {
        try { if (deleted) ws.send(JSON.stringify({ t: 'kicked', reason: 'deleted' })); } catch (e) {}
        try { ws.close(4001, 'kicked'); } catch (e) {}
      }
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const u = new URL(request.url);
      const user = await userFromToken(this.env, u.searchParams.get('token'));
      if (!user) return new Response('unauthorized', { status: 401 });
      await this.ensure();
      if (this.siteClosed && !user.isDeveloper) return new Response('网站已关闭，请过一会儿再来', { status: 403 });
      const name = user.name;
      const pair = new WebSocketPair();
      this.online.set(name, pair[1]);
      this.meta.set(pair[1], { name });
      pair[1].accept();
      pair[1].addEventListener('message', async (e) => {
        try { await this.onMsg(pair[1], e.data); } catch (err) { console.error('[do] msg err:', err.message); }
      });
      pair[1].addEventListener('close', () => { try { this.onClose(pair[1]); } catch (err) {} });
      pair[1].addEventListener('error', () => { try { this.onClose(pair[1]); } catch (err) {} });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('not found', { status: 404 });
  }

  async onMsg(ws, raw) {
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return; }
    const att = this.meta.get(ws) || {};
    const name = att.name || '';
    if (d.t === 'create') this.handleCreate(ws, name, String(d.pass || '').slice(0, 16), Math.max(2, Math.min(8, d.max | 0 || 2)));
    else if (d.t === 'join') this.handleJoin(ws, name, String(d.code || '').toUpperCase(), String(d.pass || '').slice(0, 16));
    else if (d.t === 'room-invite') {
      const target = this.online.get(String(d.to || '').slice(0, 16));
      if (target) { try { target.send(JSON.stringify({ t: 'room-invite', from: name, code: String(d.code || '').slice(0, 8) })); } catch (e) {} }
      else { try { ws.send(JSON.stringify({ t: 'g', d: { t: 'invite-fail', to: d.to, reason: '对方不在线' } })); } catch (e) {} }
    }
    else if (d.t === 'g') { this.fwdCount = (this.fwdCount || 0) + 1; this.fwdLog = (this.fwdLog || []).concat([{ from: name, t: d.d && d.d.t, at: Date.now() }]).slice(-10); this.forward(ws, { t: 'g', d: d.d }); }
    else if (d.t === 'leave') this.leaveAll(ws);
    else if (d.t === 'dm') {
      const from = name;
      const text = String(d.text || '').slice(0, 200);
      const to = String(d.to || '').slice(0, 16);
      if (!from || !text || !to || from === to) return;
      await this.ensure();
      const uf = this.db[from], ut = this.db[to];
      const now = Date.now();
      if (uf) { if (!uf.dm) uf.dm = []; uf.dm.push({ from, to, text, ts: now }); uf.dm = uf.dm.slice(-300); }
      if (ut) { if (!ut.dm) ut.dm = []; ut.dm.push({ from, to, text, ts: now }); ut.dm = ut.dm.slice(-300); }
      if (uf || ut) await this.persistDb();
      const target = this.online.get(to);
      if (target) {
        try { target.send(JSON.stringify({ t: 'dm', from, text, ts: now })); } catch (e) {}
        try { ws.send(JSON.stringify({ t: 'dm-ok', to })); } catch (e) {}
      } else {
        try { ws.send(JSON.stringify({ t: 'dm-queued', to })); } catch (e) {}
      }
    }
    else if (d.t === 'dm-pull') {
      await this.ensure();
      const me = this.db[name];
      const arr = (me && me.dm) ? me.dm.slice(-100) : [];
      try { ws.send(JSON.stringify({ t: 'dm-offline', msgs: arr })); } catch (e) {}
    }
  }
  async webSocketMessage(ws, raw) { await this.onMsg(ws, raw); }

  handleCreate(ws, name, pass, max) {
    this.leaveAll(ws);
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = { host: { ws, name }, players: new Map(), pass, max, code };
    room.players.set(ws, { name, ws, score: 0 });
    this.rooms.set(code, room);
    this.meta.set(ws, { name, room: code, role: 'host' });
    try { ws.send(JSON.stringify({ t: 'created', code })); } catch (e) {}
  }

  handleJoin(ws, name, code, pass) {
    this.leaveAll(ws);
    const r = this.rooms.get(code);
    if (!r) { try { ws.send(JSON.stringify({ t: 'no-room' })); } catch (e) {} return; }
    if (r.pass && r.pass !== pass) { try { ws.send(JSON.stringify({ t: 'need-pass' })); } catch (e) {} return; }
    if (r.players.size >= r.max) { try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {} return; }
    r.players.set(ws, { name, ws, score: 0 });
    this.meta.set(ws, { name, room: code, role: 'player' });
    const names = [...r.players.values()].map((p) => p.name);
    try { ws.send(JSON.stringify({ t: 'joined', foeName: r.host.name, players: names })); } catch (e) {}
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(JSON.stringify({ t: 'peer-joined', name, players: names })); } catch (e) {}
    }
  }

  forward(ws, obj) {
    const att = this.meta.get(ws) || {};
    const r = this.rooms.get(att.room);
    if (!r) { console.log('[fwd] no room for', att.name); return; }
    const tagged = JSON.stringify({ t: 'g', d: { ...(obj.d || {}), from: att.name } });
    let sent = 0;
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(tagged); sent++; } catch (e) {}
    }
    if (sent === 0 || (obj.d && obj.d.t === 'pose')) console.log('[fwd]', att.name, '->', sent, 'of', r.players.size, 't=' + (obj.d && obj.d.t));
  }

  leaveAll(ws) {
    const att = this.meta.get(ws) || {};
    const r = att.room ? this.rooms.get(att.room) : null;
    if (!r) return;
    if (r.host && r.host.ws === ws) {
      this.rooms.delete(att.room);
      for (const [w, p] of r.players) {
        if (w === ws) continue;
        try { w.send(JSON.stringify({ t: 'room-closed' })); } catch (e) {}
      }
    } else if (r.players.has(ws)) {
      r.players.delete(ws);
      const names = [...r.players.values()].map((p) => p.name);
      for (const [w, p] of r.players) {
        try { w.send(JSON.stringify({ t: 'peer-left', name: att.name, players: names })); } catch (e) {}
      }
    }
  }

  kickNonDevelopers() {
    const msg = JSON.stringify({ t: 'site-closed', reason: '网站已关闭，请过一会儿再来' });
    for (const [name, ws] of [...this.online.entries()]) {
      const u = this.db && this.db[name];
      if (u && u.isDeveloper) continue;
      try { ws.send(msg); } catch (e) {}
      try { ws.close(4003, 'site-closed'); } catch (e) {}
    }
  }
  onClose(ws) {
    this.leaveAll(ws);
    try { const att = this.meta.get(ws) || {}; if (att.name) { this.online.delete(att.name); this.meta.delete(ws); } } catch (e) {}
  }
  webSocketClose(ws) { this.onClose(ws); }
  webSocketError(ws) { this.onClose(ws); }

  /* ------- 雨云S3持久化 (SigV4) ------- */
  async hmac(key, msg) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  }
  hx(buf) { return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  async sha256(msg) {
    const enc = new TextEncoder();
    return this.hx(await crypto.subtle.digest('SHA-256', typeof msg === 'string' ? enc.encode(msg) : msg));
  }
  async s3Auth(method, uri, body, ct) {
    const env = this.env;
    const now = new Date();
    const amz = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const date = amz.slice(0, 8);
    const region = 'cn-nb-2', svc = 's3', host = env.S3_ENDPOINT;
    const payloadHash = await this.sha256(body);
    let canonHeaders, signed;
    if (ct) {
      canonHeaders = 'content-type:' + ct + '\nhost:' + host + '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amz + '\n';
      signed = 'content-type;host;x-amz-content-sha256;x-amz-date';
    } else {
      canonHeaders = 'host:' + host + '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amz + '\n';
      signed = 'host;x-amz-content-sha256;x-amz-date';
    }
    const canonical = method + '\n' + uri + '\n\n' + canonHeaders + '\n' + signed + '\n' + payloadHash;
    const scope = date + '/' + region + '/' + svc + '/aws4_request';
    const sts = 'AWS4-HMAC-SHA256\n' + amz + '\n' + scope + '\n' + await this.sha256(canonical);
    const kDate = await this.hmac(new TextEncoder().encode('AWS4' + env.S3_SK), date);
    const kRegion = await this.hmac(kDate, region);
    const kService = await this.hmac(kRegion, svc);
    const kSign = await this.hmac(kService, 'aws4_request');
    const sig = await this.hmac(kSign, sts);
    return {
      'X-Amz-Date': amz,
      'X-Amz-Content-Sha256': payloadHash,
      Authorization: 'AWS4-HMAC-SHA256 Credential=' + env.S3_AK + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + this.hx(sig),
    };
  }
  async s3FetchT(url, headers, ms) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('S3 timeout ' + ms + 'ms')), ms || 4500); });
    try { return await Promise.race([fetch(url, { headers }), t]); } finally { clearTimeout(timer); }
  }
  async s3GetObj(key) {
    try {
      const uri = '/' + this.env.S3_BUCKET + '/' + key;
      const h = await this.s3Auth('GET', uri, '');
      const res = await this.s3FetchT('https://' + this.env.S3_ENDPOINT + uri, h);
      if (res.ok) return await res.text();
      return null;
    } catch (e) { return null; }
  }
  async s3SaveNow() {
    const bodyJson = JSON.stringify(this.db);
    try {
      const uri = '/' + this.env.S3_BUCKET + '/bow-db.json';
      const h = await this.s3Auth('PUT', uri, bodyJson, 'application/json');
      await this.s3FetchT('https://' + this.env.S3_ENDPOINT + uri, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: bodyJson }, 6000);
    } catch (e) {}
    try { await this.env.BOW_KV.put('db', bodyJson); } catch (e) {}
  }
  async persistDb() {
    this.s3ScheduleSave();   // 尽力而为的异地备份(可失败)
    try { await this.state.storage.put('db', this.db); } catch (e) {}   // 权威持久化
  }
  s3ScheduleSave() {
    if (this._s3T) return;
    this._s3T = setTimeout(async () => {
      this._s3T = null;
      try {
        const body = JSON.stringify(this.db);
        const uri = '/' + this.env.S3_BUCKET + '/bow-db.json';
        const h = await this.s3Auth('PUT', uri, body, 'application/json');
        await this.s3FetchT('https://' + this.env.S3_ENDPOINT + uri, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body });
        const sec = this.secret || '';
        const uri2 = '/' + this.env.S3_BUCKET + '/bow-secret';
        const h2 = await this.s3Auth('PUT', uri2, sec, 'text/plain');
        await fetch('https://' + this.env.S3_ENDPOINT + uri2, { method: 'PUT', headers: { ...h2, 'Content-Type': 'text/plain' }, body: sec });
      } catch (e) {}
    }, 4000);
  }

  auditRow(name) {
    if (!this.audit[name]) this.audit[name] = { ops: [], shots: 0, hits: 0, tens: 0, fps: new Set(), warns: [] };
    return this.audit[name];
  }
  warn(name, msg) {
    const a = this.auditRow(name);
    if (a.warns.length && a.warns[a.warns.length - 1].w === msg && Date.now() - a.warns[a.warns.length - 1].t < 60000) return;
    a.warns.push({ t: Date.now(), w: msg });
    try { const ws = this.online.get(name); if (ws) ws.send(JSON.stringify({ t: 'warn', msg })); } catch (e) {}
  }
}

function genCode() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
  return s;
}

/* v5.3.1 */

/* v5.3.2 */

/* v5.3.3 重启测试 */

/* v5.3.4 重启验证 */

/* v5.3.5 */

/* v5.3.6 */

/* v5.3.7 */
