
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const GAMES_DIR = path.join(DATA_DIR, "games");
const DB_FILE = path.join(DATA_DIR, "games.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "adrianhubv3";

fs.mkdirSync(GAMES_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 200 }
});

function readGames() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveGames(games) {
  fs.writeFileSync(DB_FILE, JSON.stringify(games, null, 2));
}

function checkAdmin(req, res, next) {
  const password = req.headers["x-admin-password"];

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Admin password is incorrect." });
  }

  next();
}

function safePath(name) {
  const cleaned = String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const parts = cleaned.split("/");

  if (
    !cleaned ||
    parts.some(part => part === ".." || part === "." || !part)
  ) {
    throw new Error("Invalid file path.");
  }

  return parts.join("/");
}

function writeGameFile(gameDir, relativeName, buffer) {
  const safeName = safePath(relativeName);
  const destination = path.resolve(gameDir, safeName);
  const base = path.resolve(gameDir) + path.sep;

  if (!destination.startsWith(base)) {
    throw new Error("Invalid file location.");
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
}

function findIndexFile(folder, relative = "") {
  const entries = fs.readdirSync(folder, { withFileTypes: true });

  for (const entry of entries) {
    const rel = path.posix.join(relative, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === "index.html") {
      return rel;
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findIndexFile(
        path.join(folder, entry.name),
        path.posix.join(relative, entry.name)
      );

      if (found) return found;
    }
  }

  return null;
}

function makeGame(name, files) {
  const id = crypto.randomUUID();
  const gameDir = path.join(GAMES_DIR, id);

  fs.mkdirSync(gameDir, { recursive: true });

  for (const file of files) {
    writeGameFile(gameDir, file.name, file.data);
  }

  const entry = findIndexFile(gameDir);

  if (!entry) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    throw new Error("No index.html was found in that game.");
  }

  const game = {
    id,
    name: String(name || "Uploaded Game").slice(0, 80),
    entry,
    createdAt: new Date().toISOString()
  };

  const games = readGames();
  games.push(game);
  saveGames(games);

  return game;
}

app.get("/", (req, res) => {
  res.send("Adrian's Hub backend is running!");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    name: "Adrian's Hub",
    version: "2.0.0"
  });
});

app.post("/api/admin/login", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  res.json({ success: true });
});

app.get("/api/games", (req, res) => {
  const uploaded = readGames();

  res.json([
    {
      name: "Coolmath Games",
      url: "https://www.coolmathgames.com",
      type: "external"
    },
    {
      name: "Poki",
      url: "https://poki.com",
      type: "external"
    },
    {
      name: "CrazyGames",
      url: "https://www.crazygames.com",
      type: "external"
    },
    {
      name: "Chess",
      url: "https://www.chess.com",
      type: "external"
    },
    ...uploaded.map(game => ({
      ...game,
      type: "uploaded",
      url: `/play/${game.id}`
    }))
  ]);
});

// Upload a ZIP or a folder of game files.
app.post(
  "/api/games/upload",
  checkAdmin,
  upload.array("files", 200),
  (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files were uploaded." });
      }

      let files = [];

      for (const file of req.files) {
        const originalName = file.originalname.replace(/\\/g, "/");

        if (originalName.toLowerCase().endsWith(".zip")) {
          const zip = new AdmZip(file.buffer);

          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;

            files.push({
              name: entry.entryName,
              data: entry.getData()
            });
          }
        } else {
          files.push({
            name: originalName,
            data: file.buffer
          });
        }
      }

      if (files.length === 0) {
        return res.status(400).json({ error: "The upload contained no files." });
      }

      const game = makeGame(req.body.name, files);
      res.json({ success: true, game });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

// Publish raw HTML code as a game.
app.post("/api/games/raw", checkAdmin, (req, res) => {
  try {
    const html = req.body.html;

    if (typeof html !== "string" || !html.trim()) {
      return res.status(400).json({ error: "Paste your game's HTML first." });
    }

    const game = makeGame(req.body.name, [
      { name: "index.html", data: Buffer.from(html, "utf8") }
    ]);

    res.json({ success: true, game });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Serve uploaded game files.
app.get("/play/:id", (req, res) => {
  const game = readGames().find(item => item.id === req.params.id);

  if (!game) return res.status(404).send("Game not found.");

  res.redirect(`/play/${game.id}/${game.entry.split("/").map(encodeURIComponent).join("/")}`);
});

app.get("/play/:id/*", (req, res) => {
  const game = readGames().find(item => item.id === req.params.id);

  if (!game) return res.status(404).send("Game not found.");

  try {
    const requested = safePath(req.params[0] || game.entry);
    const gameDir = path.resolve(GAMES_DIR, game.id);
    const filePath = path.resolve(gameDir, requested);

    if (!filePath.startsWith(gameDir + path.sep) || !fs.existsSync(filePath)) {
      return res.status(404).send("Game file not found.");
    }

    res.sendFile(filePath);
  } catch {
    res.status(400).send("Invalid file path.");
  }
});

// Only an authenticated admin can delete games.
app.delete("/api/games/:id", checkAdmin, (req, res) => {
  const games = readGames();
  const game = games.find(item => item.id === req.params.id);

  if (!game) return res.status(404).json({ error: "Game not found." });

  fs.rmSync(path.join(GAMES_DIR, game.id), {
    recursive: true,
    force: true
  });

  saveGames(games.filter(item => item.id !== game.id));
  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Adrian's Hub running on port ${PORT}`);
});
