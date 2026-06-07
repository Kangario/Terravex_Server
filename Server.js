const express = require("express");
const { createClient } = require("redis");
const { OAuth2Client } = require("google-auth-library");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const DEFAULT_GOOGLE_REDIRECT_URI = "https://terravexloginserver-254547110109.europe-west4.run.app/auth/google";
const VALID_GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

function getGoogleWebClientId() {
    return process.env.GOOGLE_WEB_CLIENT_ID || process.env.SERVER_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
}

function getGoogleOAuthClientId() {
    return process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || getGoogleWebClientId();
}

function getGoogleOAuthClientSecret() {
    return process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
}

async function verifyGoogleIdToken(googleClient, idToken, audience) {
    if (!audience) {
        const err = new Error("Missing Google Web Client ID");
        err.statusCode = 500;
        throw err;
    }

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.sub) {
        const err = new Error("Google token payload is missing sub");
        err.statusCode = 401;
        throw err;
    }

    if (!VALID_GOOGLE_ISSUERS.has(payload.iss)) {
        const err = new Error("Invalid Google token issuer");
        err.statusCode = 401;
        throw err;
    }

    return payload;
}

async function getOrCreateGoogleUser(redis, payload) {
    const userId = payload.sub;
    const redisKey = `user:${userId}`;
    const userData = await redis.get(redisKey);

    if (userData) {
        console.log("Existing Google user:", userId);
        return userId;
    }

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

    await redis.set(redisKey, JSON.stringify(newUser));
    console.log("New Google user:", userId);

    return userId;
}

async function start() {
    const port = Number(process.env.PORT) || 8080;
    let redisReady = false;
    const googleWebClientId = getGoogleWebClientId();
    const googleOAuthClientId = getGoogleOAuthClientId();
    const googleOAuthClientSecret = getGoogleOAuthClientSecret();
    const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || DEFAULT_GOOGLE_REDIRECT_URI;

    const redis = createClient({
        socket: {
            host: process.env.REDIS_HOST || "redis-17419.c328.europe-west3-1.gce.cloud.redislabs.com",
            port: Number(process.env.REDIS_PORT) || 17419,
        },
        password: process.env.REDIS_PASSWORD || "af0gO9r23iS9w7sYd8T0XtQktQR0ZXnl",
    });

    redis.on("error", (err) => console.error("Redis error:", err));

    const googleClient = new OAuth2Client(googleWebClientId);

    const app = express();
    app.use(express.json());

    app.get("/health", (req, res) => {
        res.status(200).json({
            ok: true,
            redisReady,
        });
    });

    app.use((req, res, next) => {
        if (!redisReady && req.path !== "/health") {
            return res.status(503).json({
                error: "Service is starting, Redis is not ready yet",
            });
        }

        next();
    });

    app.get("/auth/google", async (req, res) => {
        const code = req.query.code;
        const state = req.query.state;

        if (!code || !state) {
            return res.status(400).send("Missing code or state");
        }

        if (!googleOAuthClientId || !googleOAuthClientSecret) {
            return res.status(500).send("Google OAuth client is not configured");
        }

        try {
            const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    code,
                    client_id: googleOAuthClientId,
                    client_secret: googleOAuthClientSecret,
                    redirect_uri: googleRedirectUri,
                    grant_type: "authorization_code",
                }),
            });

            const tokenData = await tokenResponse.json();

            if (!tokenData.id_token) {
                console.error("Token error:", tokenData);
                return res.status(401).send("Failed to get id_token");
            }

            const payload = await verifyGoogleIdToken(googleClient, tokenData.id_token, googleOAuthClientId);
            const userId = await getOrCreateGoogleUser(redis, payload);

            await redis.set(`auth:${state}`, userId, { EX: 120 });

            res.redirect(`terravex://login?state=${encodeURIComponent(state)}`);
        } catch (err) {
            console.error("Google auth error:", err);
            res.status(500).send("Google auth failed");
        }
    });

    async function handleGoogleIdToken(req, res) {
        const { idToken, state } = req.body || {};

        if (!idToken) {
            return res.status(400).json({ error: "Missing idToken" });
        }

        try {
            const payload = await verifyGoogleIdToken(googleClient, idToken, googleWebClientId);
            const userId = await getOrCreateGoogleUser(redis, payload);

            if (state) {
                await redis.set(`auth:${state}`, userId, { EX: 120 });
            }

            res.json({
                ok: true,
                userId,
            });
        } catch (err) {
            console.error("Google id token auth error:", err);
            res.status(err.statusCode || 401).json({ error: "Invalid Google idToken" });
        }
    }

    app.post("/auth/google", handleGoogleIdToken);
    app.post("/auth/google/id-token", handleGoogleIdToken);

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
                user: newUser,
            });
        } catch (err) {
            console.error("Create user error:", err);
            res.status(500).json({
                error: "Failed to create user",
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

    app.post("/auth/result", async (req, res) => {
        const { state } = req.body;

        if (!state) {
            return res.status(400).json({ error: "Missing state" });
        }

        const userId = await redis.get(`auth:${state}`);

        if (!userId) {
            return res.status(404).json({ error: "Not ready" });
        }

        await redis.del(`auth:${state}`);

        res.json({ userId });
    });

    app.listen(port, "0.0.0.0", () => {
        console.log(`Server started on port ${port} on all interfaces`);
    });

    try {
        await redis.connect();
        redisReady = true;
        console.log("Redis connected");
    } catch (err) {
        console.error("Redis connect failed during startup:", err);
    }
}

start().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
