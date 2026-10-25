# Compose deployment (podman + docker)

The Compose stack has three services and one persistent volume:

- `nginx` serves the frontend at `/` and proxies `/api/` to Flask on host port 8080 by default.
- `frontend` builds the Vite app and serves its static files with Nginx, including client-side route fallback. It is also directly published on host port 3000 and proxies `/api/` to Flask.
- `backend` runs Flask and stores SQLite data in the persistent `attendance_data` volume.
- **RFID hardware wiring:** the reader is bring-your-own and browser-side. No serial device is passed into the containers; the teacher's browser opens the USB serial port with the Web Serial API. The compose files document this in the `backend` service with a commented-out `devices:` block that only applies if you deliberately run the backend on the host with the USB reader attached.

Both compose files start the same services and publish the frontend on port 3000 and the gateway on port 8080 by default. `compose.yaml` is for Podman Compose and mounts the Nginx config with the SELinux `:ro,Z` option; `compose.docker.yaml` is for Docker Compose and omits that option.

Use separate project names so the two stacks can coexist:

## Start

Both stacks are independent; pick one. The default gateway is `http://localhost:8080` and the frontend is also exposed directly on `http://localhost:3000`.

```sh
podman compose -f compose.yaml up --build -d
docker compose -f compose.docker.yaml up --build -d
```

Open <http://localhost:8080> through the gateway or <http://localhost:3000> directly through the frontend. The gateway port can be changed with `HTTP_PORT`, for example `HTTP_PORT=80 docker compose -f compose.docker.yaml up --build -d`. Check the backend through either proxy at `/api/health`.

Stop a stack with its matching compose down command. Both keep the `attendance_data` volume by default. To intentionally wipe stored data, add `--volumes`.

```sh
podman compose -f compose.yaml down
podman compose -f compose.yaml down --volumes

docker compose -f compose.docker.yaml down
docker compose -f compose.docker.yaml down --volumes
```

## RFID reader (bring your own)

Every teacher connects their own reader, and no serial device is passed to the containers. The reader is opened by the browser through the Web Serial API, so the board plugs into the computer running the browser, not into the backend host:

1. Flash `firmware/rfid_reader/rfid_reader.ino` to an ESP8266/Arduino with an MFRC522 reader.
2. Plug the board into your computer over USB.
3. Open AttendanceOS in Chrome or Edge on a desktop computer and click **Connect reader**. The browser asks which serial port to use.
4. Close the Arduino IDE serial monitor — only one program can hold the port.

The authorisation is remembered per browser and port, so a reload reconnects automatically. Any number of teachers can connect their own readers in their own browsers; the server only ever receives UID strings over `POST /api/scan` and never opens a serial port.

Web Serial requires a secure context: serve the app over `https://` or use `http://localhost`. Firefox and Safari do not support it.

## Application data and authentication

The browser uses relative `/api/...` requests. Nginx proxies them to Flask, which reads and writes the SQLite database in the persistent `attendance_data` volume. Vite uses a development proxy to Flask, so the browser remains same-origin in both modes. Authentication is a signed HttpOnly Flask session cookie; set a strong, stable `FLASK_SECRET_KEY` before using real data and set `SESSION_COOKIE_SECURE=1` when serving HTTPS.

Teacher registration and login are API-backed. Password reset email requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PUBLIC_BASE_URL`; the API reports an error if mail is not configured. There is no Google sign-in integration.

The stack never touches RFID hardware. Attendance scans and card assignment require the teacher to connect their own reader from the browser as described above; the API stores whatever UID arrives through `POST /api/scan` and `/api/cards/confirm`. No simulated scan is provided by the dashboard.
