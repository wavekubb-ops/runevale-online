const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Runevale Online" }));

const zones = ["Prontera", "Prontera Field", "Payon Forest", "Morroc Desert"];
const players = new Map();
const monsters = new Map();

function spawnMonsters(zone) {
  if (!monsters.has(zone)) {
    monsters.set(zone, [
      { id: zone + "-p1", name: "Poring", x: 250, y: 210, hp: 30, maxHp: 30 },
      { id: zone + "-p2", name: "Poring", x: 470, y: 330, hp: 30, maxHp: 30 },
      { id: zone + "-l1", name: "Lunatic", x: 650, y: 190, hp: 55, maxHp: 55 }
    ]);
  }
  return monsters.get(zone);
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, zone: p.zone, x: p.x, y: p.y, hp: p.hp, mp: p.mp, level: p.level, job: p.job, effect: p.effect || null, effectAt: p.effectAt || 0, direction: p.direction || 0, action: p.action || "idle", actionAt: p.actionAt || 0 };
}
function sendZone(zone) {
  io.to(zone).emit("world", {
    players: [...players.values()].filter(p => p.zone === zone).map(publicPlayer),
    monsters: spawnMonsters(zone)
  });
}

io.on("connection", socket => {
  socket.on("join", rawName => {
    const payload = rawName && typeof rawName === "object" ? rawName : { name: rawName, job: "Novice" };
    const name = String(payload.name || "Novice").replace(/[^a-zA-Z0-9ก-๙_ -]/g, "").trim().slice(0, 16) || "Novice";
    const allowedJobs = ["Novice", "Knight", "Wizard", "Hunter", "Assassin"];
    const job = allowedJobs.includes(payload.job) ? payload.job : "Novice";
    const p = { id: socket.id, name, zone: "Prontera", x: 390, y: 280, hp: 100, mp: 100, level: 1, job, effect: null, effectAt: 0, lastSkillAt: 0, direction: 0, action: "idle", actionAt: Date.now() };
    players.set(socket.id, p);
    socket.join(p.zone);
    socket.emit("joined", { player: publicPlayer(p), zones });
    io.to(p.zone).emit("chat", { system: true, text: name + " เข้าสู่โลก Runevale" });
    sendZone(p.zone);
  });

  socket.on("move", pos => {
    const p = players.get(socket.id);
    if (!p || !pos) return;
    p.x = Math.max(35, Math.min(765, Number(pos.x) || p.x));
    p.y = Math.max(65, Math.min(465, Number(pos.y) || p.y));
    p.direction = [0,1,2,3].includes(Number(pos.direction)) ? Number(pos.direction) : p.direction;
    p.action = "walk"; p.actionAt = Date.now();
    sendZone(p.zone);
  });

  socket.on("travel", zone => {
    const p = players.get(socket.id);
    if (!p || !zones.includes(zone) || p.zone === zone) return;
    const old = p.zone;
    socket.leave(old);
    p.zone = zone;
    p.x = 390; p.y = 280; p.action = "idle"; p.actionAt = Date.now();
    socket.join(zone);
    socket.emit("travelled", { zone });
    io.to(zone).emit("chat", { system: true, text: p.name + " เดินทางมาถึง " + zone });
    sendZone(old);
    sendZone(zone);
  });

  socket.on("attack", monsterId => {
    const p = players.get(socket.id);
    if (!p) return;
    const list = spawnMonsters(p.zone);
    const m = list.find(x => x.id === monsterId);
    if (!m || m.hp <= 0) return;
    p.action = "attack"; p.actionAt = Date.now();
    sendZone(p.zone);
    m.hp = Math.max(0, m.hp - 10);
    if (m.hp === 0) {
      p.level += 1;
      p.hp = 100;
      io.to(p.zone).emit("chat", { system: true, text: p.name + " กำจัด " + m.name + " ได้รับ EXP! (เลเวล " + p.level + ")" });
      setTimeout(() => { m.hp = m.maxHp; sendZone(p.zone); }, 8000);
    }
    sendZone(p.zone);
  });


  socket.on("skill", skillKey => {
    const p = players.get(socket.id);
    if (!p) return;
    const skillBook = {
      Knight: { key: "bash", name: "Bash", mp: 20, damage: 18, cooldown: 1800, range: 115, effect: "slash" },
      Wizard: { key: "firebolt", name: "Fire Bolt", mp: 25, damage: 24, cooldown: 2200, range: 260, effect: "fire" },
      Hunter: { key: "double-strafe", name: "Double Strafe", mp: 18, damage: 12, hits: 2, cooldown: 2000, range: 240, effect: "arrow" },
      Assassin: { key: "sonic-blow", name: "Sonic Blow", mp: 30, damage: 32, cooldown: 2600, range: 105, effect: "sonic" }
    };
    const skill = skillBook[p.job];
    if (!skill || skill.key !== skillKey) {
      socket.emit("skillResult", { ok: false, message: "อาชีพนี้ไม่สามารถใช้สกิลดังกล่าวได้" });
      return;
    }
    const now = Date.now();
    if (now - p.lastSkillAt < skill.cooldown) {
      socket.emit("skillResult", { ok: false, message: "สกิลกำลังรอคูลดาวน์" });
      return;
    }
    if (p.mp < skill.mp) {
      socket.emit("skillResult", { ok: false, message: "MP ไม่เพียงพอ" });
      return;
    }
    const list = spawnMonsters(p.zone);
    const target = list.filter(m => m.hp > 0 && Math.hypot(m.x - p.x, m.y - p.y) <= skill.range)
      .sort((a, b) => Math.hypot(a.x-p.x,a.y-p.y) - Math.hypot(b.x-p.x,b.y-p.y))[0];
    if (!target) {
      socket.emit("skillResult", { ok: false, message: "ไม่มีมอนสเตอร์อยู่ในระยะสกิล" });
      return;
    }
    p.mp -= skill.mp;
    p.lastSkillAt = now;
    p.action = "attack";
    p.actionAt = now;
    p.effect = skill.effect;
    p.effectAt = now;
    const damage = skill.damage * (skill.hits || 1);
    target.hp = Math.max(0, target.hp - damage);
    socket.emit("skillResult", { ok: true, name: skill.name, damage, mp: p.mp });
    io.to(p.zone).emit("chat", { system: true, text: p.name + " ใช้ " + skill.name + " ใส่ " + target.name + " สร้างความเสียหาย " + damage });
    sendZone(p.zone);
    if (target.hp === 0) {
      p.level += 1;
      p.hp = 100;
      io.to(p.zone).emit("chat", { system: true, text: p.name + " กำจัด " + target.name + " ได้รับ EXP! (เลเวล " + p.level + ")" });
      setTimeout(() => {
        target.hp = target.maxHp;
        sendZone(p.zone);
      }, 8000);
    }
  });

  socket.on("chat", raw => {
    const p = players.get(socket.id);
    if (!p) return;
    const text = String(raw || "").trim().slice(0, 180);
    if (text) io.to(p.zone).emit("chat", { name: p.name, text });
  });

  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (!p) return;
    players.delete(socket.id);
    io.to(p.zone).emit("chat", { system: true, text: p.name + " ออกจากเกม" });
    sendZone(p.zone);
  });
});

server.listen(PORT, () => console.log("Runevale Online listening on " + PORT));
