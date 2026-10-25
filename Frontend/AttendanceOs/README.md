# AttendanceOS

AttendanceOS is a classroom attendance dashboard for managing teachers, classes, students, RFID cards, timetable slots, sessions, and attendance. The React application reads and writes data through the Flask API; SQLite is the persistent store.

## Run the full application

From the repository root, start the frontend, Flask API, and Nginx gateway:

```sh
docker compose up --build -d
```

Open <http://localhost:8080>, create a teacher account, and create the initial classes, students, and timetable entries. The SQLite database is kept in the `attendance_data` volume. See [DEPLOYMENT.md](../../DEPLOYMENT.md) for connecting your own RFID reader and for configuration.

## Run the frontend in Vite development mode

Requirements: Node.js 20.19+ or 22.12+ and npm. Start Flask on port 5000, then run:

```sh
npm install
npm run dev
```

Vite proxies relative `/api` requests to `http://127.0.0.1:5000` by default. Set `VITE_API_PROXY_TARGET` when the Flask service runs elsewhere. The browser uses same-origin requests in both development and Compose; it does not require a CORS policy.

## Account and password reset

Teacher accounts and password hashes are stored by Flask in SQLite. Password reset requires SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and optionally `SMTP_USE_TLS`) and `PUBLIC_BASE_URL`. Without SMTP, the API returns a configuration error and the UI reports it.

Set a stable, secret `FLASK_SECRET_KEY` for deployments so signed login cookies remain valid across container restarts. Set `SESSION_COOKIE_SECURE=1` when the app is served over HTTPS.

## RFID reader

Each teacher brings their own ESP8266/Arduino + MFRC522 reader and connects it from the browser: plug it into the computer running the browser, open the app in Chrome or Edge, and click **Connect reader**. The browser talks to the board over Web Serial and posts card UIDs to the API, which validates them; the server never opens a serial port. See [DEPLOYMENT.md](../../DEPLOYMENT.md) for firmware and deployment notes.

## Commands

```sh
npm run lint
npm run build
npm run preview
```

## Main routes

- `/` — attendance dashboard
- `/sessions` and `/sessions/:id` — create, open, close, and review sessions
- `/timetable` — weekly class slots
- `/rfid-cards` — assign and manage RFID cards
- `/students/:id` — student attendance details
- `/settings` — classes, reader status, and appearance preferences
