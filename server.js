
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, "uploads");
const GAMES_DIR = path.join(UPLOADS_DIR, "games");
const DATA_FILE = path.join(UPLOADS_DIR, "games.json");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

fs.mkdirSync(GAMES_DIR, { recursive: true });

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-password"]
}));

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 500
  }
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
      error: "ADMIN_PASSWORD has not been set in Render environment variables."
    });
  }

  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }

  next();
}

function safeRelativePath(input) {
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
  const matches = [];

  function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);

      if (item.isDirectory()) {
        walk(full);
      } else if (item.name.toLowerCase() === "index.html") {
        matches.push(full);
      }
    }
  }

  walk(folder);
  return matches[0] || null;
}

function getGameName(req, fallback) {
  const name = String(req.body.name || fallback || "Uploaded Game").trim();
  return name.slice(0, 80) || "Uploaded Game";
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

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ success: true });
});

app.get("/api/games", (req, res) => {
  const uploaded = readGames();

  const builtIn = [
    { name: "Coolmath Games", url: "https://www.coolmathgames.com", type: "website" },
    { name: "Poki", url: "https://poki.com", type: "website" },
    { name: "CrazyGames", url: "https://www.crazygames.com", type: "website" },
    { name: "Chess", url: "https://www.chess.com", type: "website" }
  ];

  res.json([...builtIn, ...uploaded]);
});

app.post("/api/games/upload", requireAdmin, upload.array("files", 500), (req, res) => {
  let gameId;

  try {
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({ error: "No files were uploaded." });
    }

    gameId = crypto.randomUUID();

    const gameFolder = path.join(GAMES_DIR, gameId);
    fs.mkdirSync(gameFolder, { recursive: true });

    const isZip = files.length === 1 &&
      path.extname(files[0].originalname).toLowerCase() === ".zip";

    if (isZip) {
      const zip = new AdmZip(files[0].buffer);
      const entries = zip.getEntries();

      if (entries.length > 3000) {
        throw new Error("That ZIP contains too many files.");
      }

      let totalSize = 0;

      for (const entry of entries) {
        if (entry.isDirectory) continue;

        const relative = safeRelativePath(entry.entryName);
        const destination = path.resolve(gameFolder, relative);

        if (!destination.startsWith(path.resolve(gameFolder) + path.sep)) {
          throw new Error("Invalid ZIP file path.");
        }

        const data = entry.getData();
        totalSize += data.length;

        if (totalSize > 100 * 1024 * 1024) {
          throw new Error("The uncompressed ZIP is too large.");
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data);
      }
    } else {
      for (const file of files) {
        const relative = safeRelativePath(file.originalname);
        const destination = path.resolve(gameFolder, relative);

        if (!destination.startsWith(path.resolve(gameFolder) + path.sep)) {
          throw new Error("Invalid uploaded file path.");
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.buffer);
      }
    }

    const indexFile = findIndexFile(gameFolder);

    if (!indexFile) {
      fs.rmSync(gameFolder, { recursive: true, force: true });
      return res.status(400).json({
        error: "Couldn't find index.html. Your game needs an index.html file."
      });
    }

    const games = readGames();

    const game = {
      id: gameId,
      name: getGameName(req, path.basename(files[0].originalname, path.extname(files[0].originalname))),
      type: "uploaded",
      entry: path.relative(gameFolder, indexFile).split(path.sep).join("/")
    };

    games.push(game);
    writeGames(games);

    res.json({ success: true, game });
  } catch (error) {
    if (gameId) {
      fs.rmSync(path.join(GAMES_DIR, gameId), { recursive: true, force: true });
    }

    res.status(400).json({
      error: error.message || "Upload failed."
    });
  }
});

app.get("/play/:id", (req, res) => {
  const game = readGames().find(item => item.id === req.params.id);

  if (!game) {
    return res.status(404).send("Game not found.");
  }

  const folder = path.resolve(GAMES_DIR, game.id);
  const entry = path.resolve(folder, game.entry || "index.html");

  if (!entry.startsWith(folder + path.sep) || !fs.existsSync(entry)) {
    return res.status(404).send("Game files could not be found.");
  }

  res.sendFile(entry);
});

app.use("/game-files", express.static(GAMES_DIR, {
  fallthrough: false,
  dotfiles: "deny",
  index: false
}));

app.delete("/api/games/:id", requireAdmin, (req, res) => {
  const games = readGames();
  const game = games.find(item => item.id === req.params.id);

  if (!game) {
    return res.status(404).json({ error: "Game not found." });
  }

  const folder = path.join(GAMES_DIR, game.id);
  fs.rmSync(folder, { recursive: true, force: true });

  writeGames(games.filter(item => item.id !== game.id));

  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Adrian's Hub running on port ${PORT}`);
});
