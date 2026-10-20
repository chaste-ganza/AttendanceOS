# Docker deployment

The Compose stack has three services:

- `nginx` is the only service published to the host. It serves the frontend at `/` and proxies `/api/` to Flask.
- `frontend` builds the Vite app and serves its static files with Nginx, including client-side route fallback.
- `backend` runs Flask and stores SQLite data in the persistent `attendance_data` volume.

## Start

```sh
docker compose up --build -d
```

Open <http://localhost:8080>. The port can be changed with `HTTP_PORT`, for example `HTTP_PORT=80 docker compose up --build -d`. Check the backend through the proxy at <http://localhost:8080/api/health>.

Stop the services with `docker compose down`. This keeps the SQLite volume. To intentionally remove the stored data as well, use `docker compose down --volumes`.

## Optional RFID reader

The default stack starts without a serial device, and the API reports the reader as offline. On Linux, connect the reader and start with the hardware override:

```sh
RFID_DEVICE=/dev/ttyUSB0 docker compose -f compose.yaml -f compose.rfid.yaml up --build -d
```

Set `RFID_DEVICE` to the host device path when it differs. The override passes that device into the backend container as `/dev/ttyUSB0`.

## Application data and authentication

The browser uses relative `/api/...` requests. Nginx proxies them to Flask, which reads and writes the SQLite database in the persistent `attendance_data` volume. Vite uses a development proxy to Flask, so the browser remains same-origin in both modes. Authentication is a signed HttpOnly Flask session cookie; set a strong, stable `FLASK_SECRET_KEY` before using real data and set `SESSION_COOKIE_SECURE=1` when serving HTTPS.

Teacher registration and login are API-backed. Password reset email requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PUBLIC_BASE_URL`; the API reports an error if mail is not configured. There is no Google sign-in integration.

The default stack has no serial reader and reports it offline. Attendance scans and card assignment require a connected reader configured with the RFID override above. No simulated scan is provided by the dashboard.
