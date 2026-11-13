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

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add your Render PostgreSQL Internal Database URL to the web service environment.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined
});
const dbReady = pool.query(`
  CREATE TABLE IF NOT EXISTS characters (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    job TEXT NOT NULL DEFAULT 'Novice',
    zone TEXT NOT NULL DEFAULT 'Prontera',
    x REAL NOT NULL DEFAULT 390,
    y REAL NOT NULL DEFAULT 280,
    hp INTEGER NOT NULL DEFAULT 100,
    mp INTEGER NOT NULL DEFAULT 100,
    level INTEGER NOT NULL DEFAULT 1,
    skill_points INTEGER NOT NULL DEFAULT 0,
    skill_levels JSONB NOT NULL DEFAULT '{}'::jsonb,
    skill_branch TEXT,
    inventory JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
async function savePlayer(p) {
  if (!p || !p.username || !p.passwordHash) return;
  await dbReady;
  await pool.query(`
    INSERT INTO characters
      (username,password_hash,name,job,zone,x,y,hp,mp,level,skill_points,skill_levels,skill_branch)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (username) DO UPDATE SET
      name=EXCLUDED.name, job=EXCLUDED.job, zone=EXCLUDED.zone,
      x=EXCLUDED.x, y=EXCLUDED.y, hp=EXCLUDED.hp, mp=EXCLUDED.mp,
      level=EXCLUDED.level, skill_points=EXCLUDED.skill_points,
      skill_levels=EXCLUDED.skill_levels, skill_branch=EXCLUDED.skill_branch,
      updated_at=NOW()
  `, [p.username,p.passwordHash,p.name,p.job,p.zone,p.x,p.y,p.hp,p.mp,p.level,p.skillPoints||0,p.skillLevels||{},p.skillBranch||null]);
}


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
  return { id: p.id, name: p.name, zone: p.zone, x: p.x, y: p.y, hp: p.hp, mp: p.mp, level: p.level, job: p.job, skillPoints: p.skillPoints || 0, skillLevels: p.skillLevels || {}, effect: p.effect || null, effectAt: p.effectAt || 0, direction: p.direction || 0, action: p.action || "idle", actionAt: p.actionAt || 0 };
}
function sendZone(zone) {
  io.to(zone).emit("world", {
    players: [...players.values()].filter(p => p.zone === zone).map(publicPlayer),
    monsters: spawnMonsters(zone)
  });
}

io.on("connection", socket => {
  socket.on("join", async payload => {
    try {
      await dbReady;
      payload = payload && typeof payload === "object" ? payload : { name: payload };
      const username = String(payload.username || "").trim().toLowerCase();
      const password = String(payload.password || "");
      if (!/^[a-z0-9_]{3,20}$/.test(username) || password.length < 6 || password.length > 72) {
        socket.emit("joinError", { message: "กรุณาใช้ Username 3-20 ตัว (a-z, 0-9, _) และรหัสผ่านอย่างน้อย 6 ตัว" });
        return;
      }
      const allowedJobs = ["Novice", "Knight", "Wizard", "Hunter", "Assassin"];
      const requestedJob = allowedJobs.includes(payload.job) ? payload.job : "Novice";
      let result = await pool.query("SELECT * FROM characters WHERE username = $1", [username]);
      let row = result.rows[0];
      if (row) {
        const valid = await bcrypt.compare(password, row.password_hash);
        if (!valid) {
          socket.emit("joinError", { message: "Username นี้มีบัญชีแล้ว แต่รหัสผ่านไม่ถูกต้อง" });
          return;
        }
      } else {
        const name = String(payload.name || username).replace(/[^a-zA-Z0-9ก-๙_ -]/g, "").trim().slice(0, 16) || username;
        const passwordHash = await bcrypt.hash(password, 12);
        const initialSkills = requestedJob === "Knight" ? { bash: 1 } : requestedJob === "Wizard" ? { firebolt: 1 } : requestedJob === "Hunter" ? { "double-strafe": 1 } : requestedJob === "Assassin" ? { "sonic-blow": 1 } : {};
        result = await pool.query(
          "INSERT INTO characters (username,password_hash,name,job,skill_levels) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [username,passwordHash,name,requestedJob,JSON.stringify(initialSkills)]
        );
        row = result.rows[0];
      }
      const p = {
        id: socket.id, username, passwordHash: row.password_hash,
        name: row.name, job: row.job, zone: zones.includes(row.zone) ? row.zone : "Prontera",
        x: Number(row.x), y: Number(row.y), hp: row.hp, mp: row.mp, level: row.level,
        skillPoints: row.skill_points || 0, skillLevels: row.skill_levels || {},
        skillBranch: row.skill_branch || null, inventory: row.inventory || [],
        effect: null, effectAt: 0, lastSkillAt: 0, direction: 0, action: "idle", actionAt: Date.now()
      };
      players.set(socket.id, p);
      socket.join(p.zone);
      socket.emit("joined", { player: publicPlayer(p), zones });
      io.to(p.zone).emit("chat", { system: true, text: p.name + " เข้าสู่โลก Runevale" });
      sendZone(p.zone);
    } catch (err) {
      console.error("Login/join failed:", err);
      socket.emit("joinError", { message: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }
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
      p.skillPoints = (p.skillPoints || 0) + 1;
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
      Knight: p.skillBranch === "defense" ? { key: "shield-bash", name: "Shield Bash", mp: 18, damage: 14, perLevel: 4, cooldown: 2000, range: 110, effect: "shield" } : { key: "bash", name: "Bash", mp: 20, damage: 18, perLevel: 5, cooldown: 1800, range: 115, effect: "slash" },
      Wizard: p.skillBranch === "ice" ? { key: "icebolt", name: "Ice Bolt", mp: 25, damage: 22, perLevel: 6, cooldown: 2200, range: 260, effect: "ice" } : { key: "firebolt", name: "Fire Bolt", mp: 25, damage: 24, perLevel: 6, cooldown: 2200, range: 260, effect: "fire" },
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
    const skillLevel = Math.max(1, Math.min(5, Number((p.skillLevels || {})[skill.key]) || 1));
    const damage = (skill.damage + (skillLevel - 1) * (skill.perLevel || 0)) * (skill.hits || 1);
    target.hp = Math.max(0, target.hp - damage);
    socket.emit("skillResult", { ok: true, name: skill.name, damage, mp: p.mp });
    io.to(p.zone).emit("chat", { system: true, text: p.name + " ใช้ " + skill.name + " ใส่ " + target.name + " สร้างความเสียหาย " + damage });
    sendZone(p.zone);
    if (target.hp === 0) {
      p.level += 1;
      p.skillPoints = (p.skillPoints || 0) + 1;
      p.hp = 100;
      io.to(p.zone).emit("chat", { system: true, text: p.name + " กำจัด " + target.name + " ได้รับ EXP! (เลเวล " + p.level + ")" });
      setTimeout(() => {
        target.hp = target.maxHp;
        sendZone(p.zone);
      }, 8000);
    }
  });


  socket.on("chooseBranch", branch => {
    const p = players.get(socket.id);
    if (!p) return;
    const choices = { Knight: ["sword", "defense"], Wizard: ["fire", "ice"] };
    if (!choices[p.job] || !choices[p.job].includes(branch)) {
      socket.emit("branchResult", { ok: false, message: "สายสกิลนี้ไม่ตรงกับอาชีพของคุณ" });
      return;
    }
    p.skillBranch = branch;
    socket.emit("branchResult", { ok: true, branch, skillBranch: branch });
    sendZone(p.zone);
  });

  socket.on("upgradeSkill", skillKey => {
    const p = players.get(socket.id);
    if (!p) return;
    const classSkill = p.job === "Knight" ? (p.skillBranch === "defense" ? "shield-bash" : "bash") : p.job === "Wizard" ? (p.skillBranch === "ice" ? "icebolt" : "firebolt") : ({ Hunter: "double-strafe", Assassin: "sonic-blow" }[p.job]);
    if (!classSkill || skillKey !== classSkill) {
      socket.emit("skillUpgradeResult", { ok: false, message: "สกิลนี้ไม่ใช่ของอาชีพคุณ" });
      return;
    }
    p.skillLevels = p.skillLevels || {};
    const current = Math.max(1, Number(p.skillLevels[skillKey]) || 1);
    if (current >= 5) {
      socket.emit("skillUpgradeResult", { ok: false, message: "สกิลถึงเลเวลสูงสุดแล้ว" });
      return;
    }
    if ((p.skillPoints || 0) < 1) {
      socket.emit("skillUpgradeResult", { ok: false, message: "แต้มสกิลไม่เพียงพอ: กำจัดมอนสเตอร์เพื่อเลื่อนเลเวล" });
      return;
    }
    p.skillPoints -= 1;
    p.skillLevels[skillKey] = current + 1;
    socket.emit("skillUpgradeResult", { ok: true, skillKey, level: current + 1, skillPoints: p.skillPoints });
    io.to(p.zone).emit("chat", { system: true, text: p.name + " อัปเกรด " + skillKey + " เป็นเลเวล " + (current + 1) });
    sendZone(p.zone);
  });

  socket.on("chat", raw => {
    const p = players.get(socket.id);
    if (!p) return;
    const text = String(raw || "").trim().slice(0, 180);
    if (text) io.to(p.zone).emit("chat", { name: p.name, text });
  });

  socket.on("disconnect", async () => {
    const p = players.get(socket.id);
    if (!p) return;
    try { await savePlayer(p); } catch (err) { console.error("Character save failed:", err); }
    players.delete(socket.id);
    io.to(p.zone).emit("chat", { system: true, text: p.name + " ออกจากเกม" });
    sendZone(p.zone);
  });
});

setInterval(() => {
  for (const p of players.values()) savePlayer(p).catch(err => console.error("Periodic save failed:", err));
}, 15000);

dbReady.then(() => {
  server.listen(PORT, () => console.log("Runevale Online listening on " + PORT));
}).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
