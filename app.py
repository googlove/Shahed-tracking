"""
Небо — спільний трекер повітряних цілей.

Легкий Flask-бекенд: зберігає активні цілі (Shahed/Geran/реактивний Shahed/
ракети) у SQLite, віддає їх через REST API і миттєво розсилає будь-які
зміни всім підключеним клієнтам через WebSocket (Flask-SocketIO), щоб
користувачі з різних областей бачили правки одне одного без перезавантаження.

Запуск:
    pip install -r requirements.txt
    python app.py
Відкрити: http://localhost:5000
"""
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone

from flask import Flask, g, jsonify, render_template, request
from flask_socketio import SocketIO

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "tracker.db")

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
# threading-режим — не потребує eventlet/gevent, працює "з коробки"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Орієнтовні центри областей України (для позначення "куди може залетіти").
# Це не межі областей, а довідкові точки — достатньо, щоб показати
# область-кандидата на мапі; за потреби легко замінити на повні полігони.
OBLASTS = [
    {"name": "АР Крим", "lat": 45.30, "lng": 34.40},
    {"name": "Вінницька область", "lat": 49.23, "lng": 28.47},
    {"name": "Волинська область", "lat": 50.75, "lng": 25.34},
    {"name": "Дніпропетровська область", "lat": 48.46, "lng": 34.98},
    {"name": "Донецька область", "lat": 48.02, "lng": 37.80},
    {"name": "Житомирська область", "lat": 50.25, "lng": 28.66},
    {"name": "Закарпатська область", "lat": 48.30, "lng": 23.40},
    {"name": "Запорізька область", "lat": 47.84, "lng": 35.14},
    {"name": "Івано-Франківська область", "lat": 48.92, "lng": 24.71},
    {"name": "Київська область", "lat": 50.45, "lng": 30.52},
    {"name": "м. Київ", "lat": 50.4501, "lng": 30.5234},
    {"name": "Кіровоградська область", "lat": 48.51, "lng": 32.26},
    {"name": "Луганська область", "lat": 48.57, "lng": 39.31},
    {"name": "Львівська область", "lat": 49.84, "lng": 24.03},
    {"name": "Миколаївська область", "lat": 46.97, "lng": 31.99},
    {"name": "Одеська область", "lat": 46.48, "lng": 30.72},
    {"name": "Полтавська область", "lat": 49.59, "lng": 34.55},
    {"name": "Рівненська область", "lat": 50.62, "lng": 26.25},
    {"name": "Сумська область", "lat": 50.91, "lng": 34.80},
    {"name": "Тернопільська область", "lat": 49.55, "lng": 25.59},
    {"name": "Харківська область", "lat": 49.99, "lng": 36.23},
    {"name": "Херсонська область", "lat": 46.64, "lng": 32.61},
    {"name": "Хмельницька область", "lat": 49.42, "lng": 26.99},
    {"name": "Черкаська область", "lat": 49.44, "lng": 32.06},
    {"name": "Чернівецька область", "lat": 48.29, "lng": 25.94},
    {"name": "Чернігівська область", "lat": 51.50, "lng": 31.29},
]

# Довідкові (приблизні, публічно відомі) швидкості — лише як стартові
# значення для форми; користувач завжди може їх відредагувати вручну.
TYPE_DEFAULTS = {
    "shahed":      {"label": "Shahed-136",        "speed_kmh": 180},
    "geran":       {"label": "Герань-2",           "speed_kmh": 180},
    "jet_shahed":  {"label": "Реактивний Shahed",  "speed_kmh": 500},
    "missile":     {"label": "Крилата ракета",     "speed_kmh": 800},
    "ballistic":   {"label": "Балістична ракета",  "speed_kmh": 3500},
}

# ---------------------------------------------------------------------------
# Білі списки допустимих значень. Це відкрита система без входу в
# акаунт, тож БУДЬ-ЯКЕ поле, що потрапляє в HTML/атрибути на фронтенді,
# мусить бути або суворо звіреним зі словником (type/status/область),
# або обрізаним по довжині й заекранованим на клієнті (escapeHtml).
# ---------------------------------------------------------------------------
ALLOWED_TYPES = set(TYPE_DEFAULTS)
ALLOWED_STATUSES = {"active", "downed", "impact", "lost"}
ALLOWED_OBLASTS = {o["name"] for o in OBLASTS}

MAX_LABEL_LEN = 80
MAX_NAME_LEN = 120
MAX_NOTE_LEN = 500
MAX_AUTHOR_LEN = 40

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value, max_len):
    """Тримує вхідний рядок текстовим і коротким. Це НЕ санітизація
    проти XSS сама по собі — рендеринг на клієнті все одно зобов'язаний
    використовувати textContent/escapeHtml. Це лише страховка від
    надто довгих чи "сирих" рядків з керуючими символами."""
    if value is None:
        return ""
    s = _CONTROL_CHARS.sub("", str(value)).strip()
    return s[:max_len]


def clean_number(value, lo=None, hi=None):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def clean_oblast_list(values):
    if not isinstance(values, list):
        return []
    return [v for v in values if v in ALLOWED_OBLASTS][:30]


# Дуже проста антизловживна перевірка без зовнішніх залежностей: не
# більш як один запис на зміну щосекунди з однієї IP-адреси. Для
# публічного продакшн-розгортання замініть на Flask-Limiter/Redis і
# додайте модерацію — див. README.md.
_last_write_by_ip = {}
MIN_SECONDS_BETWEEN_WRITES = 1.0


def rate_limited():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr) or "unknown"
    now = time.monotonic()
    last = _last_write_by_ip.get(ip, 0)
    if now - last < MIN_SECONDS_BETWEEN_WRITES:
        return True
    _last_write_by_ip[ip] = now
    return False


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            label TEXT,
            launch_lat REAL,
            launch_lng REAL,
            launch_name TEXT,
            direction_deg REAL,
            speed_kmh REAL,
            launched_at TEXT,
            current_lat REAL,
            current_lng REAL,
            status TEXT DEFAULT 'active',
            predicted_oblasts TEXT DEFAULT '[]',
            notes_log TEXT DEFAULT '[]',
            created_by TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def serialize(row):
    return {
        "id": row["id"],
        "type": row["type"],
        "label": row["label"],
        "launch_lat": row["launch_lat"],
        "launch_lng": row["launch_lng"],
        "launch_name": row["launch_name"],
        "direction_deg": row["direction_deg"],
        "speed_kmh": row["speed_kmh"],
        "launched_at": row["launched_at"],
        "current_lat": row["current_lat"],
        "current_lng": row["current_lng"],
        "status": row["status"],
        "predicted_oblasts": json.loads(row["predicted_oblasts"] or "[]"),
        "notes_log": json.loads(row["notes_log"] or "[]"),
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def meta():
    return jsonify({"oblasts": OBLASTS, "type_defaults": TYPE_DEFAULTS})


@app.route("/api/tracks", methods=["GET"])
def list_tracks():
    db = get_db()
    rows = db.execute("SELECT * FROM tracks ORDER BY created_at DESC").fetchall()
    return jsonify([serialize(r) for r in rows])


@app.route("/api/tracks", methods=["POST"])
def create_track():
    if rate_limited():
        return jsonify({"error": "Забагато запитів, зачекайте секунду"}), 429

    data = request.get_json(force=True) or {}
    ttype = data.get("type")
    if ttype not in ALLOWED_TYPES:
        return jsonify({"error": "Невідомий тип цілі", "allowed": sorted(ALLOWED_TYPES)}), 400

    launch_lat = clean_number(data.get("launch_lat"), -90, 90)
    launch_lng = clean_number(data.get("launch_lng"), -180, 180)
    if launch_lat is None or launch_lng is None:
        return jsonify({"error": "Потрібна точка пуску (широта/довгота)"}), 400

    ts = now_iso()
    author = clean_text(data.get("created_by"), MAX_AUTHOR_LEN) or "Анонім"
    notes_log = []
    note_text = clean_text(data.get("note"), MAX_NOTE_LEN)
    if note_text:
        notes_log.append({"author": author, "text": note_text, "ts": ts})

    cur_lat = clean_number(data.get("current_lat", launch_lat), -90, 90)
    cur_lng = clean_number(data.get("current_lng", launch_lng), -180, 180)

    db = get_db()
    cur = db.execute(
        """INSERT INTO tracks
           (type, label, launch_lat, launch_lng, launch_name, direction_deg,
            speed_kmh, launched_at, current_lat, current_lng, status,
            predicted_oblasts, notes_log, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ttype,
            clean_text(data.get("label"), MAX_LABEL_LEN) or TYPE_DEFAULTS[ttype]["label"],
            launch_lat,
            launch_lng,
            clean_text(data.get("launch_name"), MAX_NAME_LEN),
            clean_number(data.get("direction_deg"), 0, 359) or 0,
            clean_number(data.get("speed_kmh"), 1, 20000) or TYPE_DEFAULTS[ttype]["speed_kmh"],
            clean_text(data.get("launched_at"), 40) or ts,
            cur_lat,
            cur_lng,
            "active",
            json.dumps(clean_oblast_list(data.get("predicted_oblasts", [])), ensure_ascii=False),
            json.dumps(notes_log, ensure_ascii=False),
            author,
            ts,
            ts,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM tracks WHERE id=?", (cur.lastrowid,)).fetchone()
    track = serialize(row)
    socketio.emit("track_created", track)
    return jsonify(track), 201


@app.route("/api/tracks/<int:track_id>", methods=["PATCH"])
def update_track(track_id):
    if rate_limited():
        return jsonify({"error": "Забагато запитів, зачекайте секунду"}), 429

    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Ціль не знайдено"}), 404

    fields, values = [], []

    if "label" in data:
        fields.append("label=?"); values.append(clean_text(data["label"], MAX_LABEL_LEN))
    if "launch_name" in data:
        fields.append("launch_name=?"); values.append(clean_text(data["launch_name"], MAX_NAME_LEN))
    if "direction_deg" in data:
        n = clean_number(data["direction_deg"], 0, 359)
        if n is None:
            return jsonify({"error": "direction_deg має бути числом 0-359"}), 400
        fields.append("direction_deg=?"); values.append(n)
    if "speed_kmh" in data:
        n = clean_number(data["speed_kmh"], 1, 20000)
        if n is None:
            return jsonify({"error": "speed_kmh має бути додатним числом"}), 400
        fields.append("speed_kmh=?"); values.append(n)
    if "current_lat" in data:
        n = clean_number(data["current_lat"], -90, 90)
        if n is None:
            return jsonify({"error": "current_lat поза межами"}), 400
        fields.append("current_lat=?"); values.append(n)
    if "current_lng" in data:
        n = clean_number(data["current_lng"], -180, 180)
        if n is None:
            return jsonify({"error": "current_lng поза межами"}), 400
        fields.append("current_lng=?"); values.append(n)
    if "status" in data:
        if data["status"] not in ALLOWED_STATUSES:
            return jsonify({"error": "Невідомий статус", "allowed": sorted(ALLOWED_STATUSES)}), 400
        fields.append("status=?"); values.append(data["status"])
    if "predicted_oblasts" in data:
        fields.append("predicted_oblasts=?")
        values.append(json.dumps(clean_oblast_list(data["predicted_oblasts"]), ensure_ascii=False))

    if not fields:
        return jsonify({"error": "Немає полів для оновлення"}), 400

    ts = now_iso()
    fields.append("updated_at=?")
    values.append(ts)
    values.append(track_id)

    db.execute(f"UPDATE tracks SET {', '.join(fields)} WHERE id=?", values)
    db.commit()
    row = db.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    track = serialize(row)
    socketio.emit("track_updated", track)
    return jsonify(track)


@app.route("/api/tracks/<int:track_id>/note", methods=["POST"])
def add_note(track_id):
    if rate_limited():
        return jsonify({"error": "Забагато запитів, зачекайте секунду"}), 429

    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Ціль не знайдено"}), 404

    notes = json.loads(row["notes_log"] or "[]")
    ts = now_iso()
    text = clean_text(data.get("text"), MAX_NOTE_LEN)
    if text:
        notes.insert(0, {
            "author": clean_text(data.get("author"), MAX_AUTHOR_LEN) or "Анонім",
            "text": text,
            "ts": ts,
        })
    notes = notes[:200]

    predicted = row["predicted_oblasts"]
    if "predicted_oblasts" in data:
        predicted = json.dumps(clean_oblast_list(data["predicted_oblasts"]), ensure_ascii=False)

    db.execute(
        "UPDATE tracks SET notes_log=?, predicted_oblasts=?, updated_at=? WHERE id=?",
        (json.dumps(notes, ensure_ascii=False), predicted, ts, track_id),
    )
    db.commit()
    row = db.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    track = serialize(row)
    socketio.emit("track_updated", track)
    return jsonify(track)


@app.route("/api/tracks/<int:track_id>", methods=["DELETE"])
def delete_track(track_id):
    if rate_limited():
        return jsonify({"error": "Забагато запитів, зачекайте секунду"}), 429
    db = get_db()
    db.execute("DELETE FROM tracks WHERE id=?", (track_id,))
    db.commit()
    socketio.emit("track_deleted", {"id": track_id})
    return jsonify({"ok": True})


init_db()  # виконується завжди при імпорті модуля — не лише при `python app.py`,
           # а й під gunicorn/flask run, інакше таблиці ніколи не створяться.

if __name__ == "__main__":
    # Render/Fly/Railway тощо задають порт через змінну середовища PORT
    # і надсилають трафік саме на нього; локально лишається 5000.
    port = int(os.environ.get("PORT", 5000))
    # debug вимкнено за замовчуванням: вбудований дебагер Flask/Werkzeug
    # дозволяє виконання довільного коду й не повинен бути доступним
    # нікому, крім вас, на localhost. Для локальної розробки можна
    # тимчасово увімкнути: FLASK_DEBUG=1 python app.py
    debug_mode = os.environ.get("FLASK_DEBUG") == "1"
    # allow_unsafe_werkzeug: без eventlet/gevent Flask-SocketIO 5.x
    # відмовляється стартувати на хостингу (Render, Fly тощо), вважаючи
    # це "продакшном". Для нашого масштабу (волонтерський моніторинг,
    # не тисячі одночасних з'єднань) вбудований сервер — прийнятний
    # компроміс; при потребі в реальному масштабуванні замініть на
    # eventlet/gevent + gunicorn (див. README, розділ "Розгортання").
    socketio.run(app, host="0.0.0.0", port=port, debug=debug_mode,
                 allow_unsafe_werkzeug=True)
