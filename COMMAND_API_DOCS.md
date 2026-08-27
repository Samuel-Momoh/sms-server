# GPS Tracking Platform - Complete Command API Documentation

This document contains the complete REST API documentation for all **17 Shenzhen Cantrack Technology Co., Ltd (A/1 Protocol)** commands supported by the gateway server.

---

## Base Configuration

- **Base URL**: `http://<SERVER_IP>:3000` (or `https://<YOUR_DOMAIN>`)
- **API Prefix**: `/api/gps`
- **Authentication**: All endpoints require a JWT Bearer token:
  ```http
  Authorization: Bearer <JWT_TOKEN>
  Content-Type: application/json
  ```

---

## Quick Reference Table

| Command Code | Function | HTTP Endpoint |
| :--- | :--- | :--- |
| **`S1`** | Change Tracker Password | `POST /api/gps/devices/:imei/password` |
| **`S2`** | Set Center Phone Number | `POST /api/gps/devices/:imei/center-number` |
| **`S3`** | Set Admin / SOS Numbers | `POST /api/gps/devices/:imei/admin-numbers` |
| **`S18`** | Set Alarm Mode | `POST /api/gps/devices/:imei/alarm-mode` |
| **`S19`** | Configure Alarm Types | `POST /api/gps/devices/:imei/alarm-type` |
| **`S20`** | Remote Cut Fuel / Electricity | `POST /api/gps/devices/:imei/cut-fuel` |
| **`S20`** | Remote Restore Fuel / Electricity | `POST /api/gps/devices/:imei/restore-fuel` |
| **`S21`** | Set Geo-fence Alarm | `POST /api/gps/devices/:imei/geofence` |
| **`S23`** | Set Server IP & Port | `POST /api/gps/devices/:imei/ip-port` |
| **`S24`** | Set SIM APN Settings | `POST /api/gps/devices/:imei/apn` |
| **`S25`** | Factory Default Reset | `POST /api/gps/devices/:imei/factory-reset` |
| **`S26`** | Read Device State / Firmware | `POST /api/gps/devices/:imei/read-state` |
| **`S33`** | Set Overspeed Alarm Limit | `POST /api/gps/devices/:imei/overspeed` |
| **`S80`** | Check LBS Multi-Base Station Data | `POST /api/gps/devices/:imei/check-lbs` |
| **`D1`** | Set GPRS Upload Interval | `POST /api/gps/devices/:imei/interval` |
| **`D2`** | Fast Locate in LBS Mode | `POST /api/gps/devices/:imei/fast-locate` |
| **`R1`** | Reboot / Restart Tracker Hardware | `POST /api/gps/devices/:imei/restart` |
| **`WKMD`** | Set Working Mode | `POST /api/gps/devices/:imei/working-mode` |
| **`RAW`** | Send Custom Raw Command | `POST /api/gps/devices/:imei/raw` |

---

## Detailed Command Specifications

### 1. Change Password (`S1`)
Changes the tracker's internal 6-digit access password.

- **Endpoint**: `POST /api/gps/devices/:imei/password`
- **Protocol Command**: `*HQ,<IMEI>,S1,<HHMMSS>,<old_pwd>,<new_pwd>#`

#### Request Payload:
```json
{
  "oldPassword": "123456",
  "newPassword": "654321"
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S1,195243,123456,654321#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 2. Set Center Phone Number (`S2`)
Configures the master center control phone number on the tracker.

- **Endpoint**: `POST /api/gps/devices/:imei/center-number`
- **Protocol Command**: `*HQ,<IMEI>,S2,<HHMMSS>,<cnum_address>#`

#### Request Payload:
```json
{
  "number": "08012345678"
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S2,195243,08012345678#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 3. Set Admin / SOS Phone Numbers (`S3`)
Sets up to 5 authorized SOS numbers allowed to control and receive alarm calls/SMS.

- **Endpoint**: `POST /api/gps/devices/:imei/admin-numbers`
- **Protocol Command**: `*HQ,<IMEI>,S3,<HHMMSS>,<admin1>,<admin2>,...#`

#### Request Payload:
```json
{
  "numbers": [
    "08012345678",
    "08098765432"
  ]
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S3,195243,08012345678,08098765432#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 4. Set Alarm Mode (`S18`)
Configures how the device reacts when an alarm condition triggers.
- `0`: Close alarm
- `1`: Send SMS to admin numbers
- `2`: Call center number

- **Endpoint**: `POST /api/gps/devices/:imei/alarm-mode`
- **Protocol Command**: `*HQ,<IMEI>,S18,<HHMMSS>,<S>#`

#### Request Payload:
```json
{
  "mode": 1
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S18,195243,1#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 5. Configure Alarm Types (`S19`)
Enables or disables specific internal alarm triggers:
- `alarmType`: `0` (Power Cut), `1` (ACC Ignition), `2` (Low Battery), `3` (Vibration), `4` (Tamper/Removal)
- `enable`: `true` (Open/Enable) or `false` (Close/Disable)

- **Endpoint**: `POST /api/gps/devices/:imei/alarm-type`
- **Protocol Command**: `*HQ,<IMEI>,S19,<HHMMSS>,<N>,<E>#`

#### Request Payload:
```json
{
  "alarmType": 1,
  "enable": true
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S19,195243,1,1#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 6. Engine Cut Fuel / Electricity (`S20`)
Disables fuel pump relay to stop vehicle engine.

- **Endpoint**: `POST /api/gps/devices/:imei/cut-fuel`
- **Alternative**: `POST /api/gps/command/:imei/cut_fuel`
- **Protocol Command**:
  - Static Cut: `*HQ,<IMEI>,S20,<HHMMSS>,1,1#`
  - Dynamic Pulse Cut: `*HQ,<IMEI>,S20,<HHMMSS>,1,3,10,3,5,5,3,5,3,5,3,5#`

#### Request Payload (Static Cut - Default):
```json
{}
```

#### Request Payload (Dynamic Pulse Cut):
```json
{
  "dynamic": true
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S20,195243,1,1#",
  "message": "Command sent to tracker 867232054850970"
}
```

#### Expected Tracker Reply:
```text
*HQ,867232054850970,V4,S20,DONE,195243,195142,A,0453.2985,N,00654.8313,E,0.00,0,270826,F7FEFBFF#
```

---

### 7. Engine Restore Fuel / Electricity (`S20`)
Re-enables fuel pump relay to allow vehicle restart.

- **Endpoint**: `POST /api/gps/devices/:imei/restore-fuel`
- **Alternative**: `POST /api/gps/devices/:imei/resume-fuel` or `POST /api/gps/command/:imei/resume_fuel`
- **Protocol Command**: `*HQ,<IMEI>,S20,<HHMMSS>,1,0#`

#### Request Payload:
```json
{}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S20,195317,1,0#",
  "message": "Command sent to tracker 867232054850970"
}
```

#### Expected Tracker Reply:
```text
*HQ,867232054850970,V4,S20,OK,195317,195142,A,0453.2985,N,00654.8313,E,0.00,0,270826,FFFEFBFF#
```

---

### 8. Set Geo-fence Alarm (`S21`)
Sets a circular radius fence around the current location.
- `radiusMeters`: Radius in meters (`0` disables fence).
- `mode`: `1` (Alarm exiting fence), `2` (Alarm entering fence), `3` (Alarm on both).

- **Endpoint**: `POST /api/gps/devices/:imei/geofence`
- **Protocol Command**: `*HQ,<IMEI>,S21,<HHMMSS>,<radius>,<mode>#`

#### Request Payload:
```json
{
  "radiusMeters": 1000,
  "mode": 1
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S21,195243,1000,1#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 9. Set Server IP & Port (`S23`)
Configures the tracker's destination telemetry server IP and port.

- **Endpoint**: `POST /api/gps/devices/:imei/ip-port`
- **Protocol Command**: `*HQ,<IMEI>,S23,<HHMMSS>,<IP_with_commas>,<Port>#`

#### Request Payload:
```json
{
  "ip": "140.238.88.183",
  "port": 5022
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S23,195243,140,238,88,183,5022#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 10. Set SIM Card APN (`S24`)
Configures cellular APN credentials on the tracker.

- **Endpoint**: `POST /api/gps/devices/:imei/apn`
- **Protocol Command**: `*HQ,<IMEI>,S24,<HHMMSS>,<APN>,<User>,<Pwd>#`

#### Request Payload:
```json
{
  "apn": "CMNET",
  "username": "",
  "password": ""
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S24,195243,CMNET,,#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 11. Factory Reset (`S25`)
Restores device to factory default settings.

- **Endpoint**: `POST /api/gps/devices/:imei/factory-reset`
- **Protocol Command**: `*HQ,<IMEI>,S25,<HHMMSS>#`

#### Request Payload:
```json
{}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S25,195243#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 12. Read Device State (`S26`)
Queries device parameters, battery level, signal, or firmware version.
- `queryType`: `0` (Basic info), `1` (Software version), `2` (Other)

- **Endpoint**: `POST /api/gps/devices/:imei/read-state`
- **Protocol Command**: `*HQ,<IMEI>,S26,<HHMMSS>,<W>#`

#### Request Payload:
```json
{
  "queryType": 0
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S26,195243,0#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 13. Overspeed Limit Alarm (`S33`)
Sets maximum speed threshold. Triggers overspeed alarm when exceeded.
- `speedKmh`: Speed limit in km/h (`0` to disable alarm).

- **Endpoint**: `POST /api/gps/devices/:imei/overspeed`
- **Protocol Command**: `*HQ,<IMEI>,S33,<HHMMSS>,<speed>#`

#### Request Payload:
```json
{
  "speedKmh": 80
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S33,195243,80#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 14. Check LBS Multi-Base Station (`S80`)
Requests cell tower base station identifiers.
- `baseCount`: Number of base stations to check (e.g. `3`).

- **Endpoint**: `POST /api/gps/devices/:imei/check-lbs`
- **Protocol Command**: `*HQ,<IMEI>,S80,<HHMMSS>,<Base_Number>#`

#### Request Payload:
```json
{
  "baseCount": 3
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S80,195243,3#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 15. Set GPRS Upload Interval (`D1`)
Controls how often the tracker sends GPS coordinates over GPRS.

- **Endpoint**: `POST /api/gps/devices/:imei/interval`
- **Protocol Command**: `*HQ,<IMEI>,D1,<HHMMSS>,<interval>#`

#### Request Payload:
```json
{
  "intervalSeconds": 30
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,D1,195243,30#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 16. Fast Locate in LBS Mode (`D2`)
Forces the device to turn on GPS mode immediately for `M` seconds when in low-power LBS mode.

- **Endpoint**: `POST /api/gps/devices/:imei/fast-locate`
- **Protocol Command**: `*HQ,<IMEI>,D2,<HHMMSS>,<M>#`

#### Request Payload:
```json
{
  "openGpsSeconds": 180
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,D2,195243,180#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 17. Restart / Reboot Hardware (`R1`)
Remotely restarts the tracker's CPU and cellular modem.

- **Endpoint**: `POST /api/gps/devices/:imei/restart`
- **Protocol Command**: `*HQ,<IMEI>,R1,<HHMMSS>#`

#### Request Payload:
```json
{}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,R1,195243#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 18. Set Working Mode (`WKMD`)
Changes power and reporting mode:
- `0`: Real-time tracking mode (GPS on, uploads every 10s).
- `1`: LBS power saving mode (Sleeps, uploads every 600s).
- `2`: Intelligent mode (Sleeps when stationary, wakes on vibration, uploads every 5m).

- **Endpoint**: `POST /api/gps/devices/:imei/working-mode`
- **Protocol Command**: `*HQ,<IMEI>,WKMD,<HHMMSS>,<N>#`

#### Request Payload:
```json
{
  "mode": 0
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,WKMD,195243,0#",
  "message": "Command sent to tracker 867232054850970"
}
```

---

### 19. Send Raw ASCII Command (`RAW`)
Allows sending any raw custom Cantrack ASCII command directly over the TCP socket.

- **Endpoint**: `POST /api/gps/devices/:imei/raw`

#### Request Payload:
```json
{
  "rawCommand": "*HQ,867232054850970,S20,195243,1,1#"
}
```

#### Response (`200 OK`):
```json
{
  "success": true,
  "queued": false,
  "command": "*HQ,867232054850970,S20,195243,1,1#",
  "message": "Raw command dispatched to device 867232054850970"
}
```
