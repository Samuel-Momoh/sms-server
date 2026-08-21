# SMS Gateway Server

A lightweight Node.js/Express server that forwards SMS via **Infobip**, exposing both a modern REST API and a classic SMS gateway-style URL.

---

## Setup

### 1. Copy the env file and fill in your credentials

```bash
cp .env.example .env
```

Open `.env` and set the following — all values come from your [Infobip portal](https://portal.infobip.com):

| Variable | Where to find it | Example |
|---|---|---|
| `INFOBIP_API_KEY` | Portal → API Keys | `abc123...` |
| `INFOBIP_BASE_URL` | Portal → Home page (your unique API base URL) | `https://xxxxx.api.infobip.com` |
| `INFOBIP_SENDER` | Portal → Channels → SMS → Senders | `InfoSMS` or `+44...` |

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start          # production
npm run dev        # development (auto-restarts on file changes)
```

---

## API

### Health check

```
GET http://localhost:3000/
```

---

### Send SMS — REST

```
POST http://localhost:3000/send-sms
Content-Type: application/json

{
  "number":  "+447911123456",
  "message": "Hello from the gateway!"
}
```

**Response (success)**
```json
{
  "success": true,
  "data": { ...infobip response... }
}
```

---

### Send SMS — Classic gateway URL

Drop-in replacement for the old-style gateway URL:

```
GET http://localhost:3000/sendsms.php?number=%NUMBER%&message=%MESSAGE%
```

Example:
```
GET http://localhost:3000/sendsms.php?number=+447911123456&message=Hello+World
```

> **Note:** Authentication is handled by the `INFOBIP_API_KEY` in `.env` rather than `username`/`password` query params — no credentials are exposed in URLs.

---

## Project Structure

```
sms-gateway-server/
├── src/
│   └── infobip.js     ← Infobip API client
├── index.js           ← Express server & routes
├── .env               ← Your secrets (not committed)
├── .env.example       ← Template to share
└── package.json
```
