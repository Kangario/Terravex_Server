const express = require("express");
const { createClient } = require("redis");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

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

    app.get("/auth/google", async (req, res) => {
        const code = req.query.code;
        const state = req.query.state; // AuthUID от игры

        if (!code || !state) {
            return res.status(400).send("Missing code or state");
        }

        try {
            // 1. code → token
            const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    code,
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: "https://terravex-server.onrender.com/auth/google",
                    grant_type: "authorization_code",
                }),
            });

            const tokenData = await tokenResponse.json();

            if (!tokenData.id_token) {
                console.error("Token error:", tokenData);
                return res.status(401).send("Failed to get id_token");
            }

            const ticket = await googleClient.verifyIdToken({
                idToken: tokenData.id_token,
                audience: process.env.GOOGLE_CLIENT_ID,
            });

            const payload = ticket.getPayload();
            const userId = payload.sub; // ← ТВОЙ ОСНОВНОЙ USER ID

            // 2. Создаём пользователя если нет
            let userData = await redis.get(`user:${userId}`);

            if (!userData) {
                const newUser = {
                    userId,
                    email: payload.email,
                    level: 1,
                    gold: 10000,
                    victories: 0,
                    defeats: 0,
                    rating: 0,
                    dateRegistration: Date.now(),
                    heroesBought: [],
                    lastShopUpdate: 0,
                };

                await redis.set(`user:${userId}`, JSON.stringify(newUser));
                console.log("🆕 New Google user:", userId);
            } else {
                console.log("✅ Existing Google user:", userId);
            }

            // 3. 🔥 Связываем state → userId (на 2 минуты)
            await redis.set(`auth:${state}`, userId, { EX: 120 });

            // 4. 🔥 РЕДИРЕКТ ОБРАТНО В ИГРУ (ТОЛЬКО state)
            res.redirect(`terravex://login?state=${state}`);

        } catch (err) {
            console.error("Google auth error:", err);
            res.status(500).send("Google auth failed");
        }
    });


    app.post("/user/create", async (req, res) => {
        try {
            const userId = uuidv4();
            
            const newUser = {
                userId,
                username: `Player_${userId.slice(0, 6)}`,
                level: 1,
                gold: 10000,
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


    app.listen(3000, "0.0.0.0", () => {
        console.log("🚀 Server started on port 3000 on all interfaces");
    });
    
    app.post("/auth/result", async (req, res) => {
        const { state } = req.body;

        if (!state) {
            return res.status(400).json({ error: "Missing state" });
        }

        const userId = await redis.get(`auth:${state}`);

        if (!userId) {
            return res.status(404).json({ error: "Not ready" });
        }

        // Одноразово
        await redis.del(`auth:${state}`);

        res.json({ userId });
    });


}

start();
