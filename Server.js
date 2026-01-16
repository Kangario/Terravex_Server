const express = require("express");
const { createClient } = require("redis");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");

async function start() {
    const redis = createClient({
        socket: {
            host: "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com",
            port: 17419,
        },
        password: "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
    });

    redis.on("error", (err) => console.error("Redis error:", err));
    await redis.connect();

    console.log("✅ Redis connected");

    const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    const app = express();
    app.use(express.json());
    
    app.post("/auth/google", async (req, res) => {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({ error: "Missing idToken" });
        }

        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });

            const payload = ticket.getPayload();
            const googleUserId = payload.sub;

            const redisKey = `google:user:${googleUserId}`;

            await redis.set(
                redisKey,
                "1"
            );

            res.json({
                ok: true,
                googleUserId,
            });

        } catch (err) {
            console.error("Auth error:", err);
            res.status(401).json({ error: "Invalid Google token" });
        }
    });

    app.post("/user/create", async (req, res) => {
        try {
            const userId = uuidv4();
            
            const newUser = {
                userId,
                username: `Player_${userId.slice(0, 6)}`,
                level: 1,
                gold: 100,
                victories: 0,
                defeats: 0,
                rating: 0,
                dateRegistration: Date.now(),

                heroesBought: [],
                lastShopUpdate: 0,
            };

            const redisKey = `user:${userId}`;

            await redis.set(redisKey, JSON.stringify(newUser));

            res.status(201).json({
                ok: true,
                user: newUser
            });

        } catch (err) {
            console.error("Create user error:", err);
            res.status(500).json({
                error: "Failed to create user"
            });
        }
    });

    app.get("/user/:id", async (req, res) => {
        const user = await redis.get(`user:${req.params.id}`);

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(JSON.parse(user));
    });


    app.listen(3000, () => {
        console.log("🚀 Server started on port 3000");
    });
}

start();
