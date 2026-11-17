
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Homepage
app.get("/", (req, res) => {
  res.send("Adrian's Hub backend is running!");
});

// Server status
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    name: "Adrian's Hub",
    version: "1.0.0"
  });
});

// Games directory
app.get("/api/games", (req, res) => {
  res.json([
    {
      name: "Coolmath Games",
      url: "https://www.coolmathgames.com"
    },
    {
      name: "Poki",
      url: "https://poki.com"
    },
    {
      name: "CrazyGames",
      url: "https://www.crazygames.com"
    },
    {
      name: "Chess",
      url: "https://www.chess.com"
    }
  ]);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Adrian's Hub running on port ${PORT}`);
});
