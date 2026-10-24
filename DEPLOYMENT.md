# Docker deployment

The Compose stack has three services:

- `nginx` serves the frontend at `/` and proxies `/api/` to Flask on host port 8080 by default.
- `frontend` builds the Vite app and serves its static files with Nginx, including client-side route fallback. It is also directly published on host port 3000 and proxies `/api/` to Flask.
- `backend` runs Flask and stores SQLite data in the persistent `attendance_data` volume.

Use `compose.yaml` with Podman Compose. For Docker Compose, use the Docker-specific file:

```sh
docker compose -f compose.docker.yaml up --build -d
```

Both files start the same services and publish the frontend on port 3000 and the gateway on port 8080 by default. The Docker file omits the Podman SELinux relabel option on the Nginx configuration mount.

## Start

```sh
docker compose -f compose.docker.yaml up --build -d
```

Open <http://localhost:8080> through the gateway or <http://localhost:3000> directly through the frontend. The gateway port can be changed with `HTTP_PORT`, for example `HTTP_PORT=80 docker compose -f compose.docker.yaml up --build -d`. Check the backend through either proxy at `/api/health`.

Stop the services with `docker compose -f compose.docker.yaml down`. This keeps the SQLite volume. To intentionally remove the stored data as well, use `docker compose -f compose.docker.yaml down --volumes`.

## Optional RFID reader

The default stack starts without a serial device, and the API reports the reader as offline. On Linux, connect the reader and start with the hardware override:

```sh
RFID_DEVICE=/dev/ttyUSB0 docker compose -f compose.docker.yaml -f compose.rfid.yaml up --build -d
```

Set `RFID_DEVICE` to the host device path when it differs. The override passes that device into the backend container as `/dev/ttyUSB0`.

For Podman, use `podman compose -f compose.yaml -f compose.rfid.yaml up --build -d` with the same `RFID_DEVICE` setting.

## Application data and authentication

The browser uses relative `/api/...` requests. Nginx proxies them to Flask, which reads and writes the SQLite database in the persistent `attendance_data` volume. Vite uses a development proxy to Flask, so the browser remains same-origin in both modes. Authentication is a signed HttpOnly Flask session cookie; set a strong, stable `FLASK_SECRET_KEY` before using real data and set `SESSION_COOKIE_SECURE=1` when serving HTTPS.

Teacher registration and login are API-backed. Password reset email requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PUBLIC_BASE_URL`; the API reports an error if mail is not configured. There is no Google sign-in integration.

The default stack has no serial reader and reports it offline. Attendance scans and card assignment require a connected reader configured with the RFID override above. No simulated scan is provided by the dashboard.
