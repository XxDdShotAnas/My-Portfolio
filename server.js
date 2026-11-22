require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// السماح للموقع المحلي بإرسال طلبات للباك إند
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 1) استقبال كود Discord OAuth2 وتبديله بـ Access Token ثم جلب بيانات المستخدم
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing OAuth2 code.');

  try {
    const params = new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI,
    });

    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const discordUser = userRes.data;
    const tokensStore = readJson(TOKENS_FILE, {});
    tokensStore[discordUser.id] = {
      access_token,
      username: discordUser.username,
      avatar: discordUser.avatar,
      updatedAt: Date.now(),
    };
    writeJson(TOKENS_FILE, tokensStore);

    const redirectUrl = new URL(process.env.FRONTEND_URL);
    redirectUrl.searchParams.set('user_id', discordUser.id);
    redirectUrl.searchParams.set('username', discordUser.username);
    if (discordUser.avatar) {
      redirectUrl.searchParams.set('avatar', discordUser.avatar);
    }

    return res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('OAuth Callback Error:', err.response?.data || err.message);
    return res.status(500).send('Discord OAuth2 authentication failed.');
  }
});

// 2) استقبال الطلب وإدخال العميل تلقائياً إلى سيرفر الطلبات
app.post('/api/orders', async (req, res) => {
  const { userId, username, package: plan, estimatedPrice, features = [], notes = '' } = req.body;

  if (!userId || !username || !plan) {
    return res.status(400).json({ message: 'Missing required order details.' });
  }

  const tokensStore = readJson(TOKENS_FILE, {});
  const userToken = tokensStore[userId];

  if (!userToken?.access_token) {
    return res.status(401).json({ message: 'Discord account is not linked. Please reconnect.' });
  }

  try {
    await axios.put(
      `https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${userId}`,
      { access_token: userToken.access_token },
      {
        headers: {
          Authorization: `Bot ${process.env.BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (joinErr) {
    console.error('Guild Auto-Join Error:', joinErr.response?.data || joinErr.message);
    return res.status(400).json({
      message: 'Failed to join the Discord server automatically. Check bot permissions and OAuth scope.',
    });
  }

  const orders = readJson(ORDERS_FILE, []);
  const newOrder = {
    id: `ORD-${Date.now().toString().slice(-6)}`,
    userId,
    username,
    plan,
    estimatedPrice,
    features,
    notes,
    status: 'pending', // pending | accepted | rejected | cancelled
    notifiedBot: false,
    createdAt: new Date().toISOString(),
  };

  orders.push(newOrder);
  writeJson(ORDERS_FILE, orders);

  return res.status(201).json({ ok: true, orderId: newOrder.id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend server listening on http://localhost:${PORT}`);
});