/* RoomDO: 多人房间实时转发（结构优化版）
   纯转发职责: 房间/姿态/聊天/私信提醒。账号数据在 KV 按用户分键(Worker 层), 与 DO 无关 */
import { nameToId } from './auth.js';

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();   // code -> {host:{ws,name}, players:Map, pass, max, code}
    this.online = new Map();  // name -> ws
    this.meta = new Map();    // ws -> {name, room, role}
  }

  genCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
    return s;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/rooms') {
      const list = [...this.rooms.entries()].map(([code, r]) => ({
        code, host: r.host ? r.host.name : '', count: r.players.size, max: r.max, hasPass: !!r.pass, full: r.players.size >= r.max,
      }));
      return new Response(JSON.stringify({ rooms: list }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/presence') {
      return new Response(JSON.stringify({ online: [...this.online.keys()] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/notify' && request.method === 'POST') {
      const b = await request.json();
      const ws = this.online.get(String(b.to || '').slice(0, 16));
      if (ws) { try { ws.send(JSON.stringify(b.payload)); } catch (e) {} }
      return new Response('ok');
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
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
    else if (d.t === 'g') { this.forward(ws, { t: 'g', d: d.d }); }
    else if (d.t === 'leave') this.leaveAll(ws);
    else if (d.t === 'dm') {
      const text = String(d.text || '').slice(0, 200);
      const to = String(d.to || '').slice(0, 16);
      if (!name || !text || !to || name === to) return;
      const target = this.online.get(to);
      if (target) {
        try { target.send(JSON.stringify({ t: 'dm', from: name, text: text, ts: Date.now() })); } catch (e) {}
        try { ws.send(JSON.stringify({ t: 'dm-ok', to: to })); } catch (e) {}
      } else {
        /* 离线队列: 写入按用户 KV 键, 对方上线拉取 */
        try {
          var qk = 'dmq:' + (await nameToId(to));
          var q = JSON.parse((await this.env.BOW_KV.get(qk)) || '[]');
          q.push({ from: name, to: to, text: text, ts: Date.now() }); q = q.slice(-100);
          await this.env.BOW_KV.put(qk, JSON.stringify(q));
        } catch (e) {}
        try { ws.send(JSON.stringify({ t: 'dm-queued', to: to })); } catch (e) {}
      }
    }
    else if (d.t === 'dm-pull') {
      try {
        var qk = 'dmq:' + (await nameToId(name));
        var q = JSON.parse((await this.env.BOW_KV.get(qk)) || '[]');
        if (q.length) {
          try { ws.send(JSON.stringify({ t: 'dm-offline', msgs: q.slice(-100) })); } catch (e) {}
          await this.env.BOW_KV.delete(qk);
        }
      } catch (e) {}
    }
  }

  async webSocketMessage(ws, raw) { await this.onMsg(ws, raw); }

  handleCreate(ws, name, pass, max) {
    this.leaveAll(ws);
    let code;
    do { code = this.genCode(); } while (this.rooms.has(code));
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
    try { ws.send(JSON.stringify({ t: 'joined', players: names, foeName: r.host.name })); } catch (e) {}
    /* 通知房主与房内其他玩家 */
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(JSON.stringify({ t: 'peer-joined', name: name, players: names })); } catch (e) {}
    }
  }

  forward(ws, obj) {
    const att = this.meta.get(ws) || {};
    const r = this.rooms.get(att.room);
    if (!r) return;
    const tagged = JSON.stringify({ t: 'g', d: { ...(obj.d || {}), from: att.name } });
    for (const [w, p] of r.players) {
      if (w === ws) continue;
      try { w.send(tagged); } catch (e) {}
    }
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

  onClose(ws) {
    this.leaveAll(ws);
    var nm = (this.meta.get(ws) || {}).name;
    if (nm && this.online.get(nm) === ws) this.online.delete(nm);
  }
}
