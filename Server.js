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

        
        if (!code) {
            return res.status(400).send("Missing code");
        }

        try {
            
            // 1. Обмениваем code → token у Google
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

            console.log("🔴 TOKEN RESPONSE FULL:", tokenData);

            if (!tokenData.id_token) {
                console.error("Token error:", tokenData);
                return res.status(401).send("Failed to get id_token");
            }

            // 2. Проверяем id_token
            const ticket = await googleClient.verifyIdToken({
                idToken: tokenData.id_token,
                audience: process.env.GOOGLE_CLIENT_ID,
            });

            const payload = ticket.getPayload();

            const googleUserId = payload.sub;
            const email = payload.email;
            const name = payload.name;

            // 3. Проверяем / создаём пользователя
            const linkKey = `google:link:${googleUserId}`;
            let userId = await redis.get(linkKey);

            if (!userId) {
                userId = uuidv4();

                const newUser = {
                    userId,
                    email,
                    name,
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
                await redis.set(linkKey, userId);

                console.log("🆕 New Google user:", userId);
            } else {
                console.log("✅ Existing Google user:", userId);
            }

            // 4. Создаём сессию
            const sessionToken = uuidv4();
            await redis.set(`session:${sessionToken}`, userId, { EX: 60 * 60 * 24 * 7 }); // 7 дней

            // 5. 🔥 РЕДИРЕКТ ОБРАТНО В ИГРУ
            res.redirect(`terravex://login?session=${sessionToken}`);

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

}

start();
