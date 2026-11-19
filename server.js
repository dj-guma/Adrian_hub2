
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, "uploads");
const GAMES_DIR = path.join(UPLOADS_DIR, "games");
const DATA_FILE = path.join(UPLOADS_DIR, "games.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

fs.mkdirSync(GAMES_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// PostgreSQL connection
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

let databaseReady = false;

if (pool) {
  pool.on("error", error => {
    console.error("PostgreSQL error:", error.message);
    databaseReady = false;
  });
}

async function setupDatabase() {
  if (!pool) {
    console.error("DATABASE_URL is missing in Render.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_chat (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hub_suggestions (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  databaseReady = true;
  console.log("PostgreSQL connected. Chat and suggestions tables are ready.");
}

function requireDatabase(req, res, next) {
  if (!pool || !databaseReady) {
    return res.status(503).json({
      error: "The database is not connected yet. Try again in a moment."
    });
  }

  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 500 }
});

function readGames() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeGames(games) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(games, null, 2));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "ADMIN_PASSWORD is missing in Render."
    });
  }

  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }

  next();
}

function safePath(input) {
  const cleaned = String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const parts = cleaned.split("/").filter(Boolean);

  if (
    !parts.length ||
    parts.some(part => part === "." || part === "..") ||
    cleaned.includes("\0")
  ) {
    throw new Error("Invalid file path.");
  }

  return parts.join(path.sep);
}

function findIndexFile(folder) {
  const found = [];

  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);

      if (item.isDirectory()) {
        walk(full);
      } else if (item.name.toLowerCase() === "index.html") {
        found.push(full);
      }
    }
  }

  walk(folder);
  return found[0] || null;
}

function getGame(id) {
  return readGames().find(game => game.id === id);
}

// Basic status check
app.get("/", (req, res) => {
  res.send("Adrian's Hub backend is running!");
});

app.get("/api/health", async (req, res) => {
  let connected = false;

  if (pool && databaseReady) {
    try {
      await pool.query("SELECT 1");
      connected = true;
    } catch (error) {
      console.error("Database health check failed:", error.message);
      databaseReady = false;
    }
  }

  res.status(connected ? 200 : 503).json({
    status: "online",
    name: "Adrian's Hub",
    version: "3.1.0",
    database: connected ? "connected" : "disconnected"
  });
});

// SHARED CHAT
app.get("/api/chat", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, message, created_at
      FROM (
        SELECT id, username, message, created_at
        FROM hub_chat
        ORDER BY created_at DESC
        LIMIT 100
      ) recent
      ORDER BY created_at ASC
    `);

    const messages = result.rows.map(row => ({
      id: row.id,
      username: row.username,
      message: row.message,
      text: row.message,
      content: row.message,
      created_at: row.created_at,
      createdAt: row.created_at
    }));

    res.json(messages);
  } catch (error) {
    console.error("Chat load error:", error);
    res.status(500).json({ error: "Could not load chat messages." });
  }
});

app.post("/api/chat", requireDatabase, async (req, res) => {
  try {
    const username = String(req.body.username || "Guest")
      .trim()
      .slice(0, 30) || "Guest";

    const message = String(
      req.body.message || req.body.text || req.body.content || ""
    ).trim();

    if (!message) {
      return res.status(400).json({ error: "Message cannot be empty." });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        error: "Messages must be 1,000 characters or fewer."
      });
    }

    const result = await pool.query(
      `INSERT INTO hub_chat (username, message)
       VALUES ($1, $2)
       RETURNING id, username, message, created_at`,
      [username, message]
    );

    const row = result.rows[0];

    res.status(201).json({
      success: true,
      id: row.id,
      username: row.username,
      message: row.message,
      text: row.message,
      content: row.message,
      created_at: row.created_at,
      createdAt: row.created_at
    });
  } catch (error) {
    console.error("Chat send error:", error);
    res.status(500).json({ error: "Could not send your message." });
  }
});

// SHARED SUGGESTIONS
app.get("/api/suggestions", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, suggestion, created_at
      FROM hub_suggestions
      ORDER BY created_at DESC
      LIMIT 200
    `);

    res.json(result.rows.map(row => ({
      id: row.id,
      username: row.username,
      suggestion: row.suggestion,
      text: row.suggestion,
      message: row.suggestion,
      created_at: row.created_at,
      createdAt: row.created_at
    })));
  } catch (error) {
    console.error("Suggestions load error:", error);
    res.status(500).json({ error: "Could not load suggestions." });
  }
});

app.post("/api/suggestions", requireDatabase, async (req, res) => {
  try {
    const username = String(req.body.username || "Guest")
      .trim()
      .slice(0, 30) || "Guest";

    const suggestion = String(
      req.body.suggestion || req.body.text || req.body.message || ""
    ).trim();

    if (!suggestion) {
      return res.status(400).json({ error: "Suggestion cannot be empty." });
    }

    if (suggestion.length > 1000) {
      return res.status(400).json({
        error: "Suggestions must be 1,000 characters or fewer."
      });
    }

    const result = await pool.query(
      `INSERT INTO hub_suggestions (username, suggestion)
       VALUES ($1, $2)
       RETURNING id, username, suggestion, created_at`,
      [username, suggestion]
    );

    const row = result.rows[0];

    res.status(201).json({
      success: true,
      id: row.id,
      username: row.username,
      suggestion: row.suggestion,
      text: row.suggestion,
      message: row.suggestion,
      created_at: row.created_at,
      createdAt: row.created_at
    });
  } catch (error) {
    console.error("Suggestion save error:", error);
    res.status(500).json({ error: "Could not save your suggestion." });
  }
});

// ADMIN CHECK
app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ success: true });
});

// GAMES
app.get("/api/games", (req, res) => {
  const builtIn = [
    {
      id: "cookie-clicker",
      name: "Cookie Clicker",
      url: "https://orteil.dashnet.org/cookieclicker/",
      type: "website"
    },
    {
      id: "coolmath",
      name: "Coolmath Games",
      url: "https://www.coolmathgames.com/",
      type: "website"
    },
    {
      id: "poki",
      name: "Poki",
      url: "https://poki.com/",
      type: "website"
    },
    {
      id: "crazygames",
      name: "CrazyGames",
      url: "https://www.crazygames.com/",
      type: "website"
    },
    {
      id: "chess",
      name: "Chess",
      url: "https://www.chess.com/",
      type: "website"
    }
  ];

  res.json([...builtIn, ...readGames()]);
});

app.post(
  "/api/games/upload",
  requireAdmin,
  upload.array("files", 500),
  (req, res) => {
    let folder;

    try {
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({
          error: "Choose game files first."
        });
      }

      const id = crypto.randomUUID();
      folder = path.join(GAMES_DIR, id);
      fs.mkdirSync(folder, { recursive: true });

      const isZip =
        files.length === 1 &&
        path.extname(files[0].originalname).toLowerCase() === ".zip";

      if (isZip) {
        const zip = new AdmZip(files[0].buffer);
        const entries = zip.getEntries();

        if (entries.length > 3000) {
          throw new Error("Too many files in ZIP.");
        }

        let total = 0;

        for (const entry of entries) {
          if (entry.isDirectory) continue;

          const relative = safePath(entry.entryName);
          const destination = path.resolve(folder, relative);

          if (!destination.startsWith(path.resolve(folder) + path.sep)) {
            throw new Error("Invalid ZIP path.");
          }

          const data = entry.getData();
          total += data.length;

          if (total > 100 * 1024 * 1024) {
            throw new Error("Uncompressed ZIP is too large.");
          }

          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, data);
        }
      } else {
        for (const file of files) {
          const relative = safePath(file.originalname);
          const destination = path.resolve(folder, relative);

          if (!destination.startsWith(path.resolve(folder) + path.sep)) {
            throw new Error("Invalid uploaded path.");
          }

          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, file.buffer);
        }
      }

      const indexFile = findIndexFile(folder);

      if (!indexFile) {
        throw new Error("Your game needs an index.html file.");
      }

      const name = String(req.body.name || "Uploaded Game")
        .trim()
        .slice(0, 80) || "Uploaded Game";

      const game = {
        id,
        name,
        type: "uploaded",
        entry: path.relative(folder, indexFile).split(path.sep).join("/")
      };

      const games = readGames();
      games.push(game);
      writeGames(games);

      res.json({ success: true, game });
    } catch (error) {
      if (folder) {
        fs.rmSync(folder, { recursive: true, force: true });
      }

      res.status(400).json({
        error: error.message || "Upload failed."
      });
    }
  }
);

// Serve the game's main HTML file.
app.get("/play/:id", (req, res) => {
  const game = getGame(req.params.id);
  if (!game) return res.status(404).send("Game not found.");

  const folder = path.resolve(GAMES_DIR, game.id);
  const entry = path.resolve(folder, game.entry || "index.html");

  if (!entry.startsWith(folder + path.sep) || !fs.existsSync(entry)) {
    return res.status(404).send("Game files not found.");
  }

  let html = fs.readFileSync(entry, "utf8");
  const entryDirectory = path.dirname(game.entry || "index.html");
  const basePath = "/play/" + game.id + "/" +
    (entryDirectory === "." ? "" : entryDirectory.split(path.sep).join("/") + "/");

  const baseTag = `<base href="${basePath}">`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, match => match + baseTag);
  } else {
    html = baseTag + html;
  }

  res.type("html").send(html);
});

// Serve game scripts, images, stylesheets, and other files.
app.get("/play/:id/*", (req, res) => {
  const game = getGame(req.params.id);
  if (!game) return res.status(404).send("Game not found.");

  try {
    const relative = safePath(req.params[0]);
    const folder = path.resolve(GAMES_DIR, game.id);
    const file = path.resolve(folder, relative);

    if (!file.startsWith(folder + path.sep) || !fs.existsSync(file)) {
      return res.status(404).send("Game file not found.");
    }

    res.sendFile(file);
  } catch {
    res.status(400).send("Invalid file path.");
  }
});

app.delete("/api/games/:id", requireAdmin, (req, res) => {
  const games = readGames();
  const game = games.find(item => item.id === req.params.id);

  if (!game || game.type !== "uploaded") {
    return res.status(404).json({
      error: "Uploaded game not found."
    });
  }

  fs.rmSync(path.join(GAMES_DIR, game.id), {
    recursive: true,
    force: true
  });

  writeGames(games.filter(item => item.id !== req.params.id));

  res.json({ success: true });
});

// Start the server, then connect to the database.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Adrian's Hub running on port ${PORT}`);

  setupDatabase().catch(error => {
    databaseReady = false;
    console.error("Database setup failed:", error.message);
  });
});
