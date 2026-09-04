# GPS Tracking & Fleet Management Platform - Mobile App API Documentation

This document provides complete, production-ready REST API and Socket.IO WebSocket specifications for building the **Mobile Application (iOS / Android - React Native, Flutter, Swift, Kotlin)**.

---

## 1. Overview & Architecture

### Base URLs
- **HTTP REST API Base URL**: `http://<SERVER_IP_OR_DOMAIN>:3000` (or `https://your-domain.com`)
- **WebSocket (Socket.IO) URL**: `ws://<SERVER_IP_OR_DOMAIN>:3000` (or `wss://your-domain.com`)
- **API Prefix**: `/api/gps`

### Authentication Scheme
- **Standard**: JSON Web Token (JWT) via standard Authorization header:
  ```http
  Authorization: Bearer <JWT_TOKEN>
  ```
- **Token Expiry**: 30 days.

### User Roles & Isolation
- **`user`**: Regular mobile app user. Restricted **strictly** to devices registered under their account (`user_id`). Any attempt to control, view, or subscribe to another user's device returns `403 Forbidden`.
- **`admin`**: Fleet owner with access to all devices and global audit logs.

---

## 2. Authentication & User Profile APIs

### 2.1 Register New User (Email & Password)
Creates a new mobile app user account with `email` and `password` and immediately returns a signed JWT Bearer token for authentication.

- **Endpoint**: `POST /api/gps/auth/register`
- **Auth Required**: No (Public)
- **Headers**: `Content-Type: application/json`

#### Request Body:
```json
{
  "email": "samuel@example.com",
  "password": "SecurePassword123!",
  "name": "Samuel Momoh",
  "phone": "+2348012345678"
}
```

#### Success Response (`201 Created`):
```json
{
  "success": true,
  "message": "User registered successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "auth": {
    "type": "Bearer",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "header": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": "24h"
  },
  "user": {
    "id": 2,
    "email": "samuel@example.com",
    "username": "samuel",
    "name": "Samuel Momoh",
    "phone": "+2348012345678",
    "role": "user"
  }
}
```

#### Error Responses:
- `400 Bad Request`: `{ "success": false, "error": "email and password are required" }` (or invalid email format / password under 6 chars).
- `400 Bad Request`: `{ "success": false, "error": "Email or username 'samuel@example.com' is already registered." }`

---

### 2.2 User & Admin Login
Authenticates a user using `email` (or `username`) and `password`, returning a signed JWT token for subsequent API and WebSocket calls.
Supports optional `rememberMe: true` to keep the user logged in forever (10 years / 3650d).

- **Endpoint**: `POST /api/gps/auth/login`
- **Auth Required**: No (Public)
- **Headers**: `Content-Type: application/json`

#### Request Body:
```json
{
  "email": "samuel@example.com",
  "password": "SecurePassword123!",
  "rememberMe": true
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Authenticated successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "auth": {
    "type": "Bearer",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "header": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": "3650d",
    "rememberMe": true
  },
  "user": {
    "id": 2,
    "email": "samuel@example.com",
    "username": "samuel",
    "name": "Samuel Momoh",
    "phone": "+2348012345678",
    "role": "user"
  }
}
```

#### Error Responses:
- `400 Bad Request`: `{ "success": false, "error": "email/username and password are required" }`
- `401 Unauthorized`: `{ "success": false, "error": "Invalid credentials" }`

---

### 2.3 Password Recovery (Forgot & Reset Password Flow)

#### Step 1: Request 6-Digit Password Reset OTP
Sends a 6-digit verification code to the registered email address via SendGrid (valid for 15 minutes).

- **Endpoint**: `POST /api/gps/auth/forgot-password` (or `POST /api/gps/auth/reset-password` with `email` only)
- **Headers**: `Content-Type: application/json`

**Request Body:**
```json
{
  "email": "samuel@example.com"
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "verify": false,
  "email": "samuel@example.com",
  "message": "A 6-digit verification code has been sent to your email. Please submit the code with your new password to reset your account.",
  "expiresInMinutes": 15,
  "emailDispatched": true
}
```

---

#### Step 2: Confirm OTP & Set New Password
Validates the verification code and updates the account password in the database, automatically returning an active JWT token.

- **Endpoint**: `POST /api/gps/auth/reset-password`
- **Headers**: `Content-Type: application/json`

**Request Body:**
```json
{
  "email": "samuel@example.com",
  "code": "492815",
  "newPassword": "NewSecurePassword456!"
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "verify": true,
  "message": "Password has been reset successfully. You are now logged in.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "auth": {
    "type": "Bearer",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "header": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": "24h"
  },
  "user": {
    "id": 2,
    "email": "samuel@example.com",
    "username": "samuel",
    "name": "Samuel Momoh",
    "phone": "+2348012345678",
    "role": "user"
  }
}
```

**Error Responses:**
- `400 Bad Request`: `{ "success": false, "error": "6-digit verification code (code) is required" }`
- `400 Bad Request`: `{ "success": false, "error": "newPassword is required and must be at least 6 characters long" }`
- `400 Bad Request`: `{ "success": false, "error": "Invalid verification code. Please check your email and try again." }`
- `400 Bad Request`: `{ "success": false, "error": "Verification code has expired or was not requested. Please request a new code." }`
- `404 Not Found`: `{ "success": false, "error": "No registered account found with this email address." }`

---

### 2.4 Get Current User Profile
Retrieves the authenticated user's profile information.

- **Endpoint**: `GET /api/gps/auth/me`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "user": {
    "id": 2,
    "email": "samuel@example.com",
    "username": "samuel",
    "name": "Samuel Momoh",
    "phone": "+2348012345678",
    "role": "user",
    "registeredTokens": [
      "dKz3LpQ9abc123456...",
      "eX89mNo4def789012..."
    ]
  }
}
```

---

### 2.4 Delete User Account (2-Step Verification Flow)
Permanently deletes a user's account along with all their registered GPS tracking devices, vehicles, and location history.

- **Endpoint**: `POST /api/gps/auth/delete-account` (or `POST /api/gps/auth/account/delete`)
- **Headers**: `Content-Type: application/json`

#### Step 1: Request Deletion Verification Code
Dispatches a 6-digit OTP code to the user's registered email via SendGrid.

**Request Body (`verify: false`):**
```json
{
  "email": "samuel@example.com",
  "reason": "No longer need tracking service",
  "verify": false
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "verify": false,
  "email": "samuel@example.com",
  "message": "A 6-digit verification code has been sent to your email. Please submit the code with verify: true to confirm permanent deletion.",
  "expiresInMinutes": 15,
  "emailDispatched": true
}
```

---

#### Step 2: Confirm Deletion with OTP Code
Submits the 6-digit code received by email to permanently purge the account and devices.

**Request Body (`verify: true`):**
```json
{
  "email": "samuel@example.com",
  "code": "492815",
  "verify": true,
  "reason": "No longer need tracking service"
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "verify": true,
  "message": "Your account and all associated GPS devices and data have been permanently deleted.",
  "email": "samuel@example.com",
  "deletedAt": "2026-08-27T22:45:00.000Z"
}
```

**Error Responses:**
- `400 Bad Request`: `{ "success": false, "error": "Verification code (code) is required when verify is true" }`
- `400 Bad Request`: `{ "success": false, "error": "Invalid verification code. Please check your email and try again." }`
- `400 Bad Request`: `{ "success": false, "error": "Verification code has expired or was not requested. Please request a new code." }`
- `404 Not Found`: `{ "success": false, "error": "No registered account found with this email address." }`

---

## 3. Device Registration & Fleet Management APIs

### 3.1 Register / Add a Device to Account
Registers a GPS tracker (e.g. Cantrack G02) to the authenticated user's account.

- **Endpoint**: `POST /api/gps/devices`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "imei": "867232054850970",
  "name": "Toyota Corolla - Samuel",
  "plateNumber": "RSH-492-AA",
  "simNumber": "08012345678",
  "model": "Cantrack G02",
  "protocol": "HQ",
  "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99z\"/></svg>"
}
```
*(Note: `icon` is **optional**. Can be an SVG string, SVG URL, or icon name).*

#### Success Response (`201 Created`):
```json
{
  "success": true,
  "message": "Device 867232054850970 registered successfully",
  "device": {
    "imei": "867232054850970",
    "name": "Toyota Corolla - Samuel",
    "plateNumber": "RSH-492-AA",
    "simNumber": "08012345678",
    "model": "Cantrack G02",
    "userId": 2,
    "protocol": "HQ",
    "icon": "<svg ...></svg>"
  }
}
```

#### Duplicate IMEI Conflict Response (`409 Conflict`):
If a device with the same IMEI is already registered in the system, registration is prevented and an automatic security alert email is dispatched to the registered owner's email address.
```json
{
  "success": false,
  "error": "IMEI number is registered already",
  "message": "IMEI number is registered already"
}
```

---

### 3.2 List User's Devices & Live Telemetry
Fetches all vehicles registered to the user with real-time status (speed, ignition, location, battery, icon).

- **Endpoint**: `GET /api/gps/devices`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "count": 1,
  "devices": [
    {
      "imei": "867232054850970",
      "name": "Toyota Corolla - Samuel",
      "plate_number": "RSH-492-AA",
      "sim_number": "08012345678",
      "model": "Cantrack G02",
      "user_id": 2,
      "protocol": "HQ",
      "icon": "<svg ...></svg>",
      "connected": true,
      "last_latitude": 4.888188,
      "last_longitude": 6.913182,
      "speed_kmh": 45.0,
      "direction": 170,
      "acc_on": 1,
      "is_oil_cut": 0,
      "is_backup_battery": 0,
      "gps_status": "A",
      "battery_level": 100,
      "last_seen_at": "2026-08-25T13:30:00.000Z"
    }
  ]
}
```

---

### 3.3 Get Single Device Telemetry & State
- **Endpoint**: `GET /api/gps/devices/:imei`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "imei": "867232054850970",
  "connected": true,
  "device": {
    "imei": "867232054850970",
    "name": "Toyota Corolla - Samuel",
    "plate_number": "RSH-492-AA",
    "sim_number": "08012345678",
    "model": "Cantrack G02",
    "user_id": 2,
    "protocol": "HQ",
    "icon": "<svg ...></svg>",
    "connected": true,
    "last_latitude": 4.888188,
    "last_longitude": 6.913182,
    "speed_kmh": 45.0,
    "direction": 170,
    "acc_on": 1,
    "is_oil_cut": 0,
    "is_backup_battery": 0,
    "gps_status": "A",
    "battery_level": 100,
    "last_seen_at": "2026-08-25T13:30:00.000Z"
  }
}
```

---

### 3.4 Update Device Metadata & Icon
- **Endpoint**: `PUT /api/gps/devices/:imei`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "name": "Toyota Corolla 2022",
  "plateNumber": "RSH-492-BB",
  "simNumber": "08099887766",
  "model": "Cantrack G02",
  "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>"
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Device 867232054850970 updated successfully",
  "device": {
    "imei": "867232054850970",
    "name": "Toyota Corolla 2022",
    "plateNumber": "RSH-492-BB",
    "simNumber": "08099887766",
    "model": "Cantrack G02",
    "userId": 2,
    "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>"
  }
}
```

---

### 3.5 Delete Device & Permanently Purge All Records
Permanently unregisters a tracker and cascades the deletion to purge all associated records (location history, command logs, pending Redis queue, and in-memory cache).

- **Endpoint**: `DELETE /api/gps/devices/:imei`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Device 867232054850970 and all its records (location history, command logs, queue) were deleted successfully.",
  "imei": "867232054850970"
}
```

---

## 4. Vehicle Control & Commands (Online + Offline Queue Auto-Flush)

All command endpoints feature **Smart Offline Queuing**:
- **If Tracker is Online**: Dispatched over TCP immediately (`queued: false`).
- **If Tracker is Offline / Sleeping**: Queued in Redis & MySQL automatically (`queued: true`). As soon as the vehicle engine starts or tracker checks in, the server flushes and executes the command automatically.

---

### 4.1 Engine Cut / Immobilize Vehicle (S20)
Cuts fuel pump relay to stop the vehicle.

- **Endpoint**: `POST /api/gps/devices/:imei/cut-fuel` (or `POST /api/gps/command/:imei/cut_fuel`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body (Optional):
```json
{
  "dynamic": false
}
```

#### Response:
```json
{
  "success": true,
  "queued": false,
  "commandId": "cmd_1787663760888_rvgqp",
  "command": "*HQ,867232054850970,S20,132547,1,1#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 4.2 Engine Restore / Resume Fuel (S20)
Restores fuel pump relay to allow starting the vehicle.

- **Endpoint**: `POST /api/gps/devices/:imei/restore-fuel` (or `POST /api/gps/command/:imei/resume_fuel`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Response:
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S20,132547,1,0#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 4.3 Fast Locate / Check Current Position (D2)
Forces tracker to turn on GPS and return high-accuracy coordinates immediately.

- **Endpoint**: `POST /api/gps/devices/:imei/fast-locate` (or `POST /api/gps/command/:imei/check_location`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body (Optional):
```json
{
  "openGpsSeconds": 180
}
```

---

### 4.4 Set Overspeed Limit Alarm (S33)
Triggers alarm when vehicle exceeds speed limit.

- **Endpoint**: `POST /api/gps/devices/:imei/overspeed-alarm` (or `POST /api/gps/command/:imei/overspeed_alarm`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "speedLimit": 80
}
```

---

### 4.5 Set Circular Geofence Alarm (S21)
- **Endpoint**: `POST /api/gps/devices/:imei/geofence` (or `POST /api/gps/command/:imei/geofence`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "radius": 1000,
  "mode": 1
}
```
*(mode 1 = Alarm when exiting fence, mode 2 = Alarm when entering, mode 3 = Both)*

---

### 4.6 Set GPRS Upload Interval (D1)
Controls how frequently the tracker uploads GPS coordinates.

- **Endpoint**: `POST /api/gps/devices/:imei/interval` (or `POST /api/gps/command/:imei/set_upload_interval`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "interval": 30
}
```
*(interval in seconds, e.g. 10s - 300s)*

---

### 4.7 Set Vibration / Shock Alarm (S18)
- **Endpoint**: `POST /api/gps/devices/:imei/vibration-alarm` (or `POST /api/gps/command/:imei/vibration_alarm`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body:
```json
{
  "level": 3,
  "alertMode": 3
}
```
*(level: 1-5 sensitivity; alertMode: 1 = Call, 2 = SMS, 3 = GPRS platform upload)*

---

### 4.8 Reboot Tracker Device (R1)
- **Endpoint**: `POST /api/gps/devices/:imei/restart` (or `POST /api/gps/command/:imei/restart`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

---

### 4.9 Send Raw Tracker Command
Send custom or raw ASCII commands directly to the tracker socket over TCP.

- **Endpoint**: `POST /api/gps/devices/:imei/raw` (or `POST /api/gps/command/:imei/raw`)
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Request Body Options:
**Option A: Full Raw String (with or without leading `*`)**
```json
{
  "rawCommand": "HQ,867232054850970,S20,195440,1,1#"
}
```
*(Automatically formatted to `*HQ,867232054850970,S20,195440,1,1#\r\n` and sent directly to the device)*

**Option B: Command Code & Parameters**
```json
{
  "command": "WKMD",
  "params": ["0"]
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "message": "Command S20 processed successfully for device 867232054850970",
  "result": {
    "success": true,
    "imei": "867232054850970",
    "cmd": "S20",
    "command": "*HQ,867232054850970,S20,195440,1,1#",
    "hex": "2a48512c3836373233323035343835303937302c5332302c3139353434302c312c31230d0a",
    "sentAt": "2026-08-26T10:19:00.000Z"
  }
}
```

---

## 5. Offline Command Queue APIs

### 5.1 View Pending Queued Commands
- **Endpoint**: `GET /api/gps/devices/:imei/queue`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "imei": "867232054850970",
  "queued": [
    {
      "commandId": "cmd_1787663760888_rvgqp",
      "imei": "867232054850970",
      "cmd": "S20",
      "params": [1, 1],
      "createdAt": "2026-08-25T13:16:00.888Z"
    }
  ]
}
```

---

### 5.2 Cancel Single Queued Command
- **Endpoint**: `DELETE /api/gps/devices/:imei/queue/:commandId`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

---

### 5.3 Clear All Queued Commands
- **Endpoint**: `DELETE /api/gps/devices/:imei/queue`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

---

## 6. Trajectory History & Audit Logs APIs

### 6.1 Get Vehicle Route / Waypoint History
Retrieves persistent GPS breadcrumbs from MySQL for trip analysis and polyline route playback on mobile maps.

- **Endpoints**:
  - `GET /api/gps/devices/:imei/history`
  - `GET /api/gps/history/:imei`
  - `GET /api/gps/history?imei=867232054850970`
- **Auth Required**: Yes (`Bearer <TOKEN>`)
- **Query Parameters**:
  - `limit` (optional integer, default: `100`, max: `1000`)
  - `page` (optional integer, default: `1` — 1-indexed pagination)
  - `offset` (optional integer, default: `0`)
  - `since` or `from` (optional ISO date/timestamp string, e.g. `2026-08-25T00:00:00Z` or `2026-08-25`)
  - `until` or `to` (optional ISO date/timestamp string, e.g. `2026-08-30T23:59:59Z`)
  - `order` (optional string, `DESC` [default, newest first] or `ASC` [chronological for route playback])

#### Example Requests:
```http
GET /api/gps/devices/867232054850970/history?limit=50&order=ASC
GET /api/gps/devices/867232054850970/history?since=2026-08-29T00:00:00Z&until=2026-08-29T23:59:59Z&order=ASC
GET /api/gps/devices/867232054850970/history?page=2&limit=50
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "imei": "867232054850970",
  "count": 2,
  "total": 2,
  "pagination": {
    "limit": 50,
    "offset": 0,
    "page": 1,
    "totalPages": 1,
    "hasMore": false
  },
  "filter": {
    "since": "2026-08-29T00:00:00Z",
    "until": "2026-08-29T23:59:59Z",
    "order": "ASC"
  },
  "history": [
    {
      "id": 101,
      "imei": "867232054850970",
      "latitude": 4.917230,
      "longitude": 6.918442,
      "speed_kmh": 0.00,
      "direction": 0,
      "accOn": true,
      "acc_on": 1,
      "gpsStatus": "A",
      "gps_status": "A",
      "recorded_at": "2026-08-29T17:53:59.000Z",
      "created_at": "2026-08-29T17:54:01.000Z"
    },
    {
      "id": 102,
      "imei": "867232054850970",
      "latitude": 4.917543,
      "longitude": 6.918707,
      "speed_kmh": 22.50,
      "direction": 35,
      "accOn": true,
      "acc_on": 1,
      "gpsStatus": "A",
      "gps_status": "A",
      "recorded_at": "2026-08-29T17:54:39.000Z",
      "created_at": "2026-08-29T17:54:41.000Z"
    }
  ]
}
```

---

### 6.2 Get Command Execution History Logs
- **Endpoint**: `GET /api/gps/devices/:imei/command-logs?limit=50`
- **Auth Required**: Yes (`Bearer <TOKEN>`)

---

## 7. Real-Time WebSocket (Socket.IO) Integration

Mobile applications connect via **Socket.IO client**:

### 7.1 Connection Handshake
```javascript
import io from 'socket.io-client';

const socket = io('http://<YOUR_SERVER_IP>:3000', {
  auth: {
    token: userJwtToken, // JWT token from login/register API
  },
  transports: ['websocket'],
});
```

### 7.2 Automatic Room Subscription
When a user connects with a valid JWT token:
- The server **automatically joins** the socket to all rooms corresponding to vehicles registered to their `userId`.
- You will immediately receive live events without manual `join` calls.

### 7.3 Manual Device Room Subscription
```javascript
socket.emit('join', { imei: '867232054850970' });

socket.on('joined', (data) => {
  console.log('Subscribed to device room:', data.room);
});

socket.on('error', (err) => {
  console.error('Subscription error:', err.message); // Returns 403 Forbidden if not owner
});
```

### 7.4 Real-Time Events to Listen For

#### `gps:update` (Live Telemetry Update)
Fires whenever tracker transmits GPS location, speed, or ignition change.
```javascript
socket.on('gps:update', (telemetry) => {
  console.log('Live location update:', {
    imei: telemetry.imei,
    latitude: telemetry.latitude,
    longitude: telemetry.longitude,
    speed_kmh: telemetry.speed_kmh,
    accOn: telemetry.accOn, // true = Engine ON, false = Engine OFF
    batteryLevel: telemetry.batteryLevel,
    timestamp: telemetry.timestamp,
  });
});
```

#### `gps:heartbeat` (Tracker Ping & Battery Status)
```javascript
socket.on('gps:heartbeat', (data) => {
  console.log('Heartbeat received:', data.imei, data.batteryLevel);
});
```

#### `gps:command_queued` / `gps:command_dispatched`
```javascript
socket.on('gps:command_queued', (data) => {
  console.log('Command queued for sleeping vehicle:', data.commandId);
});

socket.on('gps:command_dispatched', (data) => {
  console.log('Queued command was flushed and executed:', data.commandId);
});
```

---

## 8. Mobile App Real-Time Testing & Route Simulator

### 8.1 Continuous Route Simulator from Coordinate Array (Live In-Memory Streaming)
Streams an array of rich telemetry objects or latitude/longitude coordinates sequentially to the mobile app over the WebSocket `gps:update` event, simulating live driving motion.
**Database remains 100% untouched** (no fake records saved in MySQL).

- **Endpoint**: `POST /api/gps/devices/simulate-trip` (or `POST /api/gps/devices/:imei/simulate-trip`)
- **Headers**: `Content-Type: application/json`

#### Request Body (Full-Fidelity Telemetry Log Objects):
```json
{
  "imei": "867232054850970",
  "intervalMs": 2000,
  "coordinates": [
    {
      "id": "1787599508144_zqka7u",
      "ts": "2026-08-24T19:25:08.144Z",
      "level": "INFO",
      "event": "HQ_GPS_UPDATE",
      "protocol": "HQ",
      "cmd": "V1",
      "imei": "867232054850970",
      "remote": "197.210.54.228:11610",
      "latitude": 4.898115,
      "longitude": 6.907373,
      "speed": 35,
      "speed_knots": 18.9,
      "speed_kmh": 35,
      "direction": 160,
      "gpsStatus": "A",
      "accOn": true,
      "isBackupBattery": false,
      "isOilCut": false,
      "equStatusHex": "FFFFFBFF",
      "timestamp": "2026-08-24 19:25:06 UTC"
    },
    {
      "latitude": 4.898600,
      "longitude": 6.907800,
      "speed": 40,
      "speed_kmh": 40,
      "direction": 165,
      "gpsStatus": "A",
      "accOn": true,
      "equStatusHex": "FFFFFBFF"
    }
  ]
}
```

> **Note**: You can also pass a simple array of `[lat, lon]` pairs or pass the JSON array directly in the request body `[ {...}, {...} ]`. If `imei` is inside the first element, the endpoint detects it automatically!

#### Parameters:
- `imei` *(string, required)*: Device IMEI to simulate.
- `coordinates` *(array, required)*: Array of `[lat, lon]` pairs or `[{latitude, longitude, speed?, direction?}]` objects.
- `intervalMs` *(number, optional)*: Milliseconds between each step (default: `2000ms` / 2s).
- `speed` *(number, optional)*: Default vehicle speed in km/h (default: `40`).
- `accOn` *(boolean, optional)*: Ignition status (default: `true` = driving).
- `loop` *(boolean, optional)*: If `true`, repeats the route indefinitely.

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Trip simulation started for device 867232054850970. Coordinates are streaming live to 'gps:update' every 2000ms. Database remains completely untouched.",
  "imei": "867232054850970",
  "totalPoints": 5,
  "intervalMs": 2000,
  "loop": false,
  "firstPoint": { "latitude": 4.888308, "longitude": 6.913855, "speed_kmh": 45, "direction": 42, "accOn": true },
  "lastPoint": { "latitude": 4.890500, "longitude": 6.915900, "speed_kmh": 55, "direction": 120, "accOn": true }
}
```

---

### 8.2 Stop Active Route Simulation

- **Endpoint**: `POST /api/gps/devices/simulate-trip/stop` (or `POST /api/gps/devices/:imei/simulate-trip/stop`)
- **Headers**: `Content-Type: application/json`

#### Request Body:
```json
{
  "imei": "867232054850970"
}
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Trip simulation stopped for device 867232054850970.",
  "imei": "867232054850970",
  "wasRunning": true
}
```

---

### 8.3 Single Batch Telemetry Simulator

- **Endpoint**: `POST /api/gps/simulate`
- **Request Body**:
```json
{
  "imei": "867232054850970",
  "accOn": true,
  "speed": 45.0,
  "latitude": 4.888188,
  "longitude": 6.913182,
  "direction": 170,
  "batteryLevel": 100,
  "steps": 1
}
```

---

## 9. FCM Push Notifications (Background & Closed App Alerts)

### 9.1 Register Mobile FCM Token
Call this endpoint upon mobile app launch or immediately after user authentication.

- **Endpoint**: `POST /api/gps/users/fcm-token`
- **Auth**: `Bearer <JWT>`
- **Request Body**:
```json
{
  "token": "dK83b_xR98Q:APA91bFw7...",
  "deviceType": "android"
}
```

### 9.2 Remove FCM Token (Logout)
- **Endpoint**: `DELETE /api/gps/users/fcm-token`
- **Auth**: `Bearer <JWT>`
- **Request Body**:
```json
{
  "token": "dK83b_xR98Q:APA91bFw7..."
}
```

---

### 9.3 Pure Push Notification Testing API (Zero Socket Events)
Use this API to test Firebase push notifications arriving on your phone when the app is in the background or completely closed, without triggering `gps:update` or `gps:alarm` WebSockets.

- **Endpoint**: `POST /api/gps/test/push` (or `POST /api/gps/test/fcm`)
- **Headers**: `Content-Type: application/json`

#### Test 1: Send Pure Alarm Push (By IMEI)
```json
{
  "imei": "867232054850970",
  "type": "ALARM",
  "alarms": ["SOS", "VIBRATION"]
}
```

#### Test 2: Send Pure Command Confirmation Push (By IMEI)
```json
{
  "imei": "867232054850970",
  "type": "COMMAND_CONFIRM",
  "cmdConfirmed": "S20",
  "details": "1,1"
}
```

#### Test 3: Send Pure Push Directly to Token
```json
{
  "token": "YOUR_PHONE_FCM_TOKEN_HERE",
  "title": "🚨 Pure Push Test",
  "body": "This notification was sent with 0 socket broadcasts!"
}
```

