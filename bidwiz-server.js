#!/usr/bin/env node
/* ============================================================
   BidWiz ONLINE beta server — zero dependencies, Node 18+
   Run:  node bidwiz-server.js [port]      (default port 8080)
   Needs bidwiz.html (the game engine) in the same folder.
   Friends play from a browser: http://<your-ip>:<port>
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PORT, 10) || 8080;

// ---------- stub browser env, then load the REAL game engine from bidwiz.html ----------
const els = {};
global.document = { getElementById: id => (els[id] = els[id] || { innerHTML: '' }), createElement: () => ({ innerHTML: '' }) };
global.window = global;
global.location = { reload: () => {} };

const html = fs.readFileSync(path.join(__dirname, 'bidwiz.html'), 'utf8');
const engineBody = html.split('<script>')[1].split('</script>')[0];

// Each room gets its own isolated engine instance (its own G) via new Function.
function makeEngine() {
  const api = `
  return { Gref:()=>G, startGame, doDraw, confirmDraw, deal, submitBid, chooseBlind, playCard,
    legalCards, nextAfterTrick, nextHand, throwIn, playOut, sides, effectiveBidOfSide,
    bidOptions, bidderSeat, pushEligible, formeEligible2, partnerNotActed, TARGET,
    aiBid, aiPlay, aiChooseBlind, sideOfSeat, sortHand, TRUMP_CYCLE };
  `;
  return new Function(engineBody + api)();
}

// ---------- rooms ----------
const rooms = new Map();
function randCode() {
  let c; do { c = Array.from({length:4},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); } while (rooms.has(c));
  return c;
}
function tok() { return crypto.randomBytes(12).toString('hex'); }

function createRoom(hostName, mode, push) {
  const code = randCode();
  const room = { code, mode: mode||'partners', push: !!push, seats:[null,null,null,null], E: makeEngine(), started:false, order:0 };
  const t = tok();
  room.seats[0] = { name: clean(hostName)||'Host', token: t, robot:false };
  rooms.set(code, room);
  return { room, token: t, seat: 0 };
}
function joinRoom(code, name) {
  const room = rooms.get(String(code||'').toUpperCase());
  if (!room) return null;
  const i = room.seats.findIndex(s => !s); // first empty seat
  if (i < 0) return null;
  const t = tok();
  room.seats[i] = { name: clean(name)||('P'+(i+1)), token: t, robot:false };
  return { room, token: t, seat: i };
}
function seatByToken(room, token) {
  const i = room.seats.findIndex(s => s && s.token === token);
  return i;
}
function clean(s){ return String(s||'').replace(/[<>&"]/g,'').slice(0,16); }

// ---------- drive the engine until a human seat must act ----------
function isHuman(room, seat){ const s = room.seats[seat]; return !!(s && !s.robot); }
function advanceRoom(room) {
  const E = room.E, G = E.Gref();
  let guard = 0;
  while (guard++ < 3000) {
    if (G.phase === 'over' || G.phase === 'summary') return;
    if (G.phase === 'draw') { E.doDraw(); continue; }
    if (G.phase === 'drawShow') { E.confirmDraw(); continue; }
    if (G.phase === 'deal') { E.deal(); continue; }
    if (G.phase === 'blind') {
      const sd = E.sides().find(x => x.id === G.blindQueue[0]);
      if (sd.seats.some(s => isHuman(room, s))) return;
      E.chooseBlind(G.blindQueue[0], E.aiChooseBlind()); continue;
    }
    if (G.phase === 'bidding') {
      const b = E.bidderSeat();
      if (isHuman(room, b)) return;
      E.submitBid(b, E.aiBid(b), false, false); continue;
    }
    if (G.phase === 'throwchoice') {
      const sd = E.sides().find(x => x.id === G.pendingChoice.who);
      if (sd.seats.some(s => isHuman(room, s))) return;
      if (G.pendingChoice.blind) E.playOut(); else E.throwIn(); continue;
    }
    if (G.phase === 'play') {
      if (isHuman(room, G.turn)) return;
      E.playCard(G.turn, E.aiPlay(G.turn)); continue;
    }
    if (G.phase === 'trickwon') { E.nextAfterTrick(G.lastWin); continue; }
    return;
  }
}

// ---------- what one seat may see ----------
function viewFor(room, seat) {
  const E = room.E, G = E.Gref();
  const myTurnPlay = G.phase==='play' && G.turn===seat;
  const myBid = G.phase==='bidding' && E.bidderSeat()===seat;
  return {
    code: room.code, mode: G.mode, phase: G.phase, handNum: G.handNum,
    trump: G.trump, dealer: G.dealerIdx, names: G.names,
    robots: room.seats.map(s => !s || s.robot),
    connected: room.seats.map(s => !!s),
    scores: G.scores, target: E.TARGET[G.mode],
    yourSeat: seat,
    yourHand: G.hands[seat] ? E.sortHand(G.hands[seat].slice(), G.trump) : [],
    legal: myTurnPlay ? E.legalCards(seat) : [],
    turn: G.turn, trick: G.trick, trickNum: G.trickNum, lastWin: G.lastWin,
    tricksWon: G.tricksWon,
    bids: G.bids,                    // bids are public info
    bidOptions: myBid ? E.bidOptions(seat) : null,
    pushEligible: E.pushEligible(seat),
    formeEligible: E.formeEligible2(seat),
    blindQueue: G.blindQueue, blind: G.blind, eligible: G.eligible||[],
    pendingChoice: G.pendingChoice,
    handCounts: (G.hands||[]).map(h => h ? h.length : 0),
    summaryRows: G.phase==='summary' ? G.summaryRows : null,
    summaryThrown: G.summaryThrown,
    winner: G.winner || null,
    log: (G.log||[]).slice(-6),
    host: seat===0,
  };
}

// ---------- SSE clients ----------
function broadcast(room) {
  const payload = room.seats.map((s, i) => s ? JSON.stringify(viewFor(room, i)) : null);
  for (const s of room.seats) {
    if (s && s.res) {
      try { s.res.write('data: ' + payload[room.seats.indexOf(s)] + '\n\n'); } catch(e){}
    }
  }
}

// ---------- HTTP ----------
const clientHtml = () => fs.readFileSync(path.join(__dirname, 'bidwiz-online.html'));
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(b);
}
function body(req) {
  return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{ r(JSON.parse(d||'{}')); }catch(e){ r({}); } }); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, {'Content-Type':'text/html'}); res.end(clientHtml()); return;
  }
  if (req.method === 'GET' && u.pathname === '/solo') {
    res.writeHead(200, {'Content-Type':'text/html'}); res.end(fs.readFileSync(path.join(__dirname,'bidwiz.html'))); return;
  }
  if (req.method === 'GET' && u.pathname === '/api/stream') {
    const token = u.searchParams.get('token');
    for (const room of rooms.values()) {
      const i = seatByToken(room, token);
      if (i >= 0) {
        const s = room.seats[i];
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
        res.write('data: ' + JSON.stringify(viewFor(room, i)) + '\n\n');
        s.res = res;
        const wasRobot = s.robot; s.robot = false;         // back at the table
        if (wasRobot && room.started) { advanceRoom(room); }
        broadcast(room);
        req.on('close', () => {
          if (s.res === res) s.res = null;
          if (room.started && !s.robot) { s.robot = true; advanceRoom(room); broadcast(room); } // seat plays on as robot
        });
        return;
      }
    }
    json(res, 404, { error: 'unknown session' }); return;
  }
  if (req.method === 'GET' && u.pathname === '/api/state') {
    const token = u.searchParams.get('token');
    for (const room of rooms.values()) {
      const i = seatByToken(room, token);
      if (i >= 0) return json(res, 200, viewFor(room, i));
    }
    return json(res, 404, { error:'unknown session' });
  }
  if (req.method === 'POST' && u.pathname === '/api/create') {
    const b = await body(req);
    const { room, token, seat } = createRoom(b.name, b.mode, b.push);
    return json(res, 200, { code: room.code, token, seat });
  }
  if (req.method === 'POST' && u.pathname === '/api/join') {
    const b = await body(req);
    const r = joinRoom(b.code, b.name);
    if (!r) return json(res, 404, { error: 'room not found or full' });
    return json(res, 200, { code: r.room.code, token: r.token, seat: r.seat });
  }
  if (req.method === 'POST' && u.pathname === '/api/start') {
    const b = await body(req);
    for (const room of rooms.values()) {
      const i = seatByToken(room, b.token);
      if (i === 0) {
        if (room.started) return json(res, 400, { error:'already started' });
        room.started = true;
        const names = room.seats.map((s,idx) => s ? s.name : ('Bot '+(idx+1)));
        room.E.startGame(room.mode, names, room.push);
        const G = room.E.Gref();
        G.robots = room.seats.map(s => !s);
        G.fast = true;
        advanceRoom(room); broadcast(room);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 403, { error: 'host only' });
  }
  if (req.method === 'POST' && u.pathname === '/api/action') {
    const b = await body(req);
    for (const room of rooms.values()) {
      const i = seatByToken(room, b.token);
      if (i < 0) continue;
      const E = room.E, G = E.Gref();
      const reply = (ok, err) => { advanceRoom(room); broadcast(room); json(res, ok?200:400, ok?{ok:true}:{error:err||'illegal'}); };
      if (b.type === 'bid' && G.phase==='bidding' && E.bidderSeat()===i) {
        const num = Math.max(1, Math.min(13, parseInt(b.num,10)||1));
        E.submitBid(i, num, !!b.push && E.pushEligible(i), !!b.forme && E.formeEligible2(i));
        return reply(true);
      }
      if (b.type === 'play' && G.phase==='play' && G.turn===i) {
        const card = (G.hands[i]||[]).find(c => c.s===b.suit && c.r===parseInt(b.rank,10));
        if (!card) return json(res, 400, { error:'no such card' });
        E.playCard(i, card);
        return reply(true);
      }
      if (b.type === 'blind' && G.phase==='blind' && G.blindQueue.length) {
        const sd = E.sides().find(x => x.id === G.blindQueue[0]);
        if (!sd.seats.includes(i)) return json(res, 403, { error:'not your call' });
        E.chooseBlind(G.blindQueue[0], [0,7,10].includes(+b.num) ? +b.num : 0);
        return reply(true);
      }
      if (b.type === 'throw' && G.phase==='throwchoice') {
        const sd = E.sides().find(x => x.id === G.pendingChoice.who);
        if (!sd.seats.includes(i)) return json(res, 403, { error:'not your call' });
        b.choice==='out' ? E.playOut() : E.throwIn();
        return reply(true);
      }
      if (b.type === 'next' && G.phase==='summary') {
        E.nextHand();
        return reply(true);
      }
      if (b.type === 'again' && G.phase==='over' && i===0) {
        room.E.startGame(room.mode, room.seats.map((s,idx)=> s?s.name:('Bot '+(idx+1))), room.push);
        const G2 = room.E.Gref(); G2.robots = room.seats.map(s=>!s); G2.fast = true;
        return reply(true);
      }
      return json(res, 400, { error:'wrong phase or not your turn' });
    }
    return json(res, 404, { error:'unknown session' });
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🂡 BidWiz ONLINE beta — server running');
  console.log('  Local play:    http://localhost:' + PORT);
  console.log('  Friends (same Wi-Fi):  http://<this-computer-ip>:' + PORT);
  console.log('  Find this computer\'s IP with:  ipconfig  (Windows)  or  ifconfig/ip addr  (Mac/Linux)');
  console.log('  Across the internet: use Tailscale (free) on every player\'s device,');
  console.log('  then share http://<your-tailscale-ip>:' + PORT + ' — no router changes.');
  console.log('');
});
