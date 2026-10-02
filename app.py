"""Colour Debt 3D - main server file.

I made this game using Python Flask for the backend and
HTML/CSS/Three.js for the frontend.

How to run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5000 in browser.

All game rules (levels, coins, shop, abilities, daily reward
and save system) are written here in Python. The 3D part runs
in the browser and talks to this file using /api/* links.
"""
import json
import os
import re
import sqlite3
from datetime import date, timedelta

from flask import Flask, jsonify, render_template, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "colour-debt-3d-dev-secret")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAVE_FILE = os.path.join(BASE_DIR, "save_data.json")  # legacy: single-user file (migrate only)
USERS_DIR = os.path.join(BASE_DIR, "users")
DB_FILE = os.path.join(BASE_DIR, "game.db")  # SQLite database - all player data lives here now
os.makedirs(USERS_DIR, exist_ok=True)


# ---------------------------------------------------------
# Database
# Earlier every player had their own users/<name>.json file,
# but sir said that is not a real database - a new browser or
# device cannot see those files. So now I keep every account
# in one SQLite file (game.db) in the users table. Same data
# as before, only the storage changed from files to DB rows.
# ---------------------------------------------------------
def get_db():
    # I open a fresh connection per call and close it myself,
    # so the Flask dev server (threaded) never shares one cursor.
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    # I create the users table once. One row = one player account.
    # safe_name (lowercase, file-safe) is the key so "Rahul" and
    # "rahul" stay one account, like the old users/*.json files.
    # Owned skins are stored as JSON text in one column.
    con = get_db()
    con.execute(
        """CREATE TABLE IF NOT EXISTS users (
            safe_name TEXT PRIMARY KEY,
            username TEXT,
            password_hash TEXT,
            coins INTEGER DEFAULT 0,
            diamonds INTEGER DEFAULT 0,
            levels_completed INTEGER DEFAULT 0,
            unlocked_easy INTEGER DEFAULT 0,
            unlocked_medium INTEGER DEFAULT 0,
            unlocked_hard INTEGER DEFAULT 0,
            owned_skins TEXT DEFAULT '["classic"]',
            selected_skin TEXT DEFAULT 'classic',
            owned_emojis TEXT DEFAULT '["none"]',
            selected_emoji TEXT DEFAULT 'none',
            ability_colorbomb INTEGER DEFAULT 0,
            ability_slowmo INTEGER DEFAULT 0,
            ability_lifeplus INTEGER DEFAULT 0,
            music_on INTEGER DEFAULT 1,
            vibration_on INTEGER DEFAULT 1,
            seen_training INTEGER DEFAULT 0,
            last_login_date TEXT,
            login_streak INTEGER DEFAULT 0
        )"""
    )
    # Player feedback: one row per submitted rating/comment.
    con.execute(
        """CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            safe_name TEXT NOT NULL,
            username TEXT,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            message TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    # Old game.db files were made before the emoji columns existed,
    # so I add them here. If they already exist this does nothing.
    for col, default in (("owned_emojis", '\'["none"]\''), ("selected_emoji", "'none'")):
        try:
            con.execute("ALTER TABLE users ADD COLUMN %s TEXT DEFAULT %s" % (col, default))
        except Exception:
            pass
    con.commit()
    con.close()


def _row_to_save(row):
    # I convert one DB row back into the same profile dict the
    # rest of the code already uses, so nothing else must change.
    try:
        skins = json.loads(row["owned_skins"] or '["classic"]')
    except (json.JSONDecodeError, TypeError):
        skins = ["classic"]
    # Emoji face for the player ball: bought in shop with coins,
    # then the selected one is drawn on the white ball in 3D.
    try:
        emojis = json.loads(row["owned_emojis"] or '["none"]')
    except (json.JSONDecodeError, TypeError, KeyError, IndexError):
        emojis = ["none"]
    try:
        face = row["selected_emoji"] or "none"
    except (KeyError, IndexError):
        face = "none"
    return {
        "username": row["username"],
        "password_hash": row["password_hash"],
        "coins": row["coins"] or 0,
        "diamonds": row["diamonds"] or 0,
        "levelsCompletedCount": row["levels_completed"] or 0,
        "unlockedLevel": {
            "EASY": row["unlocked_easy"] or 0,
            "MEDIUM": row["unlocked_medium"] or 0,
            "HARD": row["unlocked_hard"] or 0,
        },
        "ownedSkins": skins,
        "selectedSkin": row["selected_skin"] or "classic",
        "ownedEmojis": emojis,
        "selectedEmoji": face,
        "abilityCounts": {
            "colorbomb": row["ability_colorbomb"] or 0,
            "slowmo": row["ability_slowmo"] or 0,
            "lifeplus": row["ability_lifeplus"] or 0,
        },
        "musicOn": bool(row["music_on"]),
        "vibrationOn": bool(row["vibration_on"]),
        "seenTraining": bool(row["seen_training"]),
        "lastLoginDate": row["last_login_date"],
        "loginStreak": row["login_streak"] or 0,
    }


def _save_to_db(saved):
    # I write the profile dict into the DB row (insert or update).
    safe = _safe_username(saved.get("username") or session.get("username") or "")
    if not safe:
        return
    con = get_db()
    con.execute(
        """INSERT INTO users (safe_name, username, password_hash, coins, diamonds,
            levels_completed, unlocked_easy, unlocked_medium, unlocked_hard,
            owned_skins, selected_skin, owned_emojis, selected_emoji,
            ability_colorbomb, ability_slowmo,
            ability_lifeplus, music_on, vibration_on, seen_training,
            last_login_date, login_streak)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(safe_name) DO UPDATE SET
            username=excluded.username, password_hash=excluded.password_hash,
            coins=excluded.coins, diamonds=excluded.diamonds,
            levels_completed=excluded.levels_completed,
            unlocked_easy=excluded.unlocked_easy,
            unlocked_medium=excluded.unlocked_medium,
            unlocked_hard=excluded.unlocked_hard,
            owned_skins=excluded.owned_skins,
            selected_skin=excluded.selected_skin,
            owned_emojis=excluded.owned_emojis,
            selected_emoji=excluded.selected_emoji,
            ability_colorbomb=excluded.ability_colorbomb,
            ability_slowmo=excluded.ability_slowmo,
            ability_lifeplus=excluded.ability_lifeplus,
            music_on=excluded.music_on, vibration_on=excluded.vibration_on,
            seen_training=excluded.seen_training,
            last_login_date=excluded.last_login_date,
            login_streak=excluded.login_streak""",
        (safe, saved.get("username"), saved.get("password_hash"),
         saved.get("coins", 0), saved.get("diamonds", 0),
         saved.get("levelsCompletedCount", 0),
         saved.get("unlockedLevel", {}).get("EASY", 0),
         saved.get("unlockedLevel", {}).get("MEDIUM", 0),
         saved.get("unlockedLevel", {}).get("HARD", 0),
         json.dumps(saved.get("ownedSkins", ["classic"])),
         saved.get("selectedSkin", "classic"),
         json.dumps(saved.get("ownedEmojis", ["none"])),
         saved.get("selectedEmoji", "none"),
         saved.get("abilityCounts", {}).get("colorbomb", 0),
         saved.get("abilityCounts", {}).get("slowmo", 0),
         saved.get("abilityCounts", {}).get("lifeplus", 0),
         1 if saved.get("musicOn", True) else 0,
         1 if saved.get("vibrationOn", True) else 0,
         1 if saved.get("seenTraining", False) else 0,
         saved.get("lastLoginDate"), saved.get("loginStreak", 0)),
    )
    con.commit()
    con.close()


def migrate_to_db():
    # One-time move: I copy every old users/*.json file plus the
    # legacy save_data.json into the DB, then the game never reads
    # the files again. Old progress (coins, levels) is kept as-is.
    init_db()
    con = get_db()
    count = con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    con.close()
    if count > 0:
        return  # already moved, nothing to do
    try:
        files = [f for f in os.listdir(USERS_DIR) if f.endswith(".json")]
    except OSError:
        files = []
    for f in files:
        try:
            with open(os.path.join(USERS_DIR, f), encoding="utf-8") as fh:
                data = json.load(fh)
            merged = default_save()
            merged.update(data)
            if not merged.get("username"):
                merged["username"] = f[:-5]
            _save_to_db(merged)
        except (json.JSONDecodeError, OSError):
            continue
    try:
        with open(SAVE_FILE, encoding="utf-8") as fh:
            old = json.load(fh)
        if old.get("username") and not _db_user_exists(old["username"]):
            merged = default_save()
            merged.update(old)
            _save_to_db(merged)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass


def _db_get_user(username):
    # I fetch one account from the DB, or None if it is new.
    safe = _safe_username(username)
    if not safe:
        return None
    con = get_db()
    row = con.execute("SELECT * FROM users WHERE safe_name = ?", (safe,)).fetchone()
    con.close()
    return _row_to_save(row) if row else None


def _db_user_exists(username):
    return _db_get_user(username) is not None

# ---------------------------------------------------------
# Game data
# I kept all the main numbers here at the top so balancing
# the game later is easy. Levels, prices and rewards are all
# in these lists only, no hard-coded values in functions.
# ---------------------------------------------------------
COLOURS_HEX = {"RED": 0xE5484D, "BLUE": 0x3B82F6, "GREEN": 0x2FBF71, "YELLOW": 0xF5C93B}
COLOURS_CSS = {"RED": "#e5484d", "BLUE": "#3b82f6", "GREEN": "#2fbf71", "YELLOW": "#f5c93b"}
COLOUR_NAMES = list(COLOURS_HEX.keys())

LEVELS = [
    {"color": c, "targetScore": t}
    for c, t in [
        ("RED", 5), ("BLUE", 7), ("GREEN", 9), ("YELLOW", 11),
        ("RED", 13), ("BLUE", 15), ("GREEN", 17), ("YELLOW", 19),
        ("RED", 21), ("BLUE", 24), ("GREEN", 27), ("YELLOW", 30),
        ("RED", 33), ("BLUE", 36), ("GREEN", 39), ("YELLOW", 42),
        ("RED", 45), ("BLUE", 48), ("GREEN", 51), ("YELLOW", 54),
        ("RED", 57), ("BLUE", 60), ("GREEN", 63), ("YELLOW", 66),
        ("RED", 69),
    ]
]

DIFFICULTY = {
    "EASY": {"speed": 0.045, "spawnMs": 1100},
    "MEDIUM": {"speed": 0.070, "spawnMs": 850},
    "HARD": {"speed": 0.100, "spawnMs": 600},
}

STARTING_LIVES = 5
CONTINUE_COST = 150
COIN_REWARD = {"EASY": 10, "MEDIUM": 15, "HARD": 20}
LEVELS_PER_DIAMOND = 5  # 1 diamond every 5 level completions
TRAINING_LEVEL = {"color": "RED", "targetScore": 3}

SKINS = [
    {"id": "classic", "name": "Classic", "cost": 0, "currency": "coin", "desc": "Plain cube"},
    {"id": "gem", "name": "Gem", "cost": 30, "currency": "coin", "desc": "Faceted gem shape"},
    {"id": "striped", "name": "Striped", "cost": 50, "currency": "coin", "desc": "Candy stripe pattern"},
    {"id": "star", "name": "Star", "cost": 80, "currency": "coin", "desc": "Star-shaped block"},
    {"id": "crystal", "name": "Crystal", "cost": 3, "currency": "diamond", "desc": "Glassy icosahedron crystal"},
    {"id": "rainbow", "name": "Rainbow", "cost": 5, "currency": "diamond", "desc": "Glowing knot — rarest design"},
]

EMOJIS = [
    # Face drawn on the white player ball. "none" = plain ball (free, default).
    # Rest are bought with coins from the shop, then selected to use.
    {"id": "none", "name": "No Face", "icon": "⚪", "cost": 0, "desc": "Plain white ball"},
    {"id": "smile", "name": "Smile", "icon": "😊", "cost": 20, "desc": "Happy face on your ball"},
    {"id": "cool", "name": "Cool", "icon": "😎", "cost": 40, "desc": "Sunglasses face on your ball"},
    {"id": "star", "name": "Star Eyes", "icon": "🤩", "cost": 60, "desc": "Star-eyes face on your ball"},
    {"id": "fire", "name": "Fire", "icon": "🔥", "cost": 80, "desc": "Fire face on your ball"},
    {"id": "crown", "name": "Crown", "icon": "👑", "cost": 100, "desc": "King crown on your ball"},
]

ABILITIES = [
    {"id": "colorbomb", "name": "Color Bomb", "cost": 40, "duration": 6000, "icon": "🎨",
     "desc": "For 6s, every falling block becomes the target colour"},
    {"id": "slowmo", "name": "Slow Motion", "cost": 35, "duration": 6000, "icon": "🐢",
     "desc": "For 6s, falling blocks move slower"},
    {"id": "lifeplus", "name": "+1 Life", "cost": 40, "duration": 0, "icon": "❤️",
     "desc": "Adds 1 life. Max 5 lives."},
]

DAILY_REWARDS = [
    {"day": 1, "type": "coin", "amount": 5},
    {"day": 2, "type": "coin", "amount": 8},
    {"day": 3, "type": "coin", "amount": 10},
    {"day": 4, "type": "coin", "amount": 12},
    {"day": 5, "type": "coin", "amount": 15},
    {"day": 6, "type": "coin", "amount": 18},
    {"day": 7, "type": "ability", "options": ["colorbomb", "slowmo", "lifeplus"]},
]


# ---------------------------------------------------------
# Save system
# Earlier I saved everything in browser localStorage, but that
# gets deleted easily. So now each player gets their own file
# in the users/ folder, like users/rahul.json. This function
# returns a fresh blank profile for a new player.
# ---------------------------------------------------------
def default_save():
    return {
        "username": None,
        "password_hash": None,
        "coins": 0,
        "diamonds": 0,
        "levelsCompletedCount": 0,
        "unlockedLevel": {"EASY": 0, "MEDIUM": 0, "HARD": 0},
        "ownedSkins": ["classic"],
        "selectedSkin": "classic",
        "ownedEmojis": ["none"],
        "selectedEmoji": "none",
        "abilityCounts": {"colorbomb": 0, "slowmo": 0, "lifeplus": 0},
        "musicOn": True,
        "vibrationOn": True,
        "seenTraining": False,
        "lastLoginDate": None,
        "loginStreak": 0,
    }


def _safe_username(name):
    # I clean the name here so it is safe to use as a file name.
    # Only letters, numbers, _ and - are kept, max 16 characters.
    # Example: "Rahul 123!" becomes "rahul123".
    import re
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", (name or "").strip().lower())
    return cleaned[:16]


def _user_file(username):
    # Old helper from the file-based save system. I keep it only so
    # migrate_to_db() can still find users/<name>.json one last time.
    # The game itself now reads/writes game.db, never these files.
    return os.path.join(USERS_DIR, _safe_username(username) + ".json")


def load_save():
    # This loads the logged-in player's row from the game.db database.
    # Flask session remembers the name after login. If nobody is
    # logged in, I just return a blank profile without saving it.
    username = session.get("username")
    if not username:
        return default_save()
    found = _db_get_user(username)
    if found:
        found["username"] = username  # I trust the login name as the real name
        return found
    fresh = default_save()
    fresh["username"] = username
    return fresh


def write_save(data):
    # This saves the player's data into their game.db database row.
    # I call this after every change (coins, level clear, shop buy etc.)
    # so nothing is lost even if the server restarts.
    username = data.get("username") or session.get("username")
    if not username:
        return  # nobody logged in, so there is nothing to save
    safe = _safe_username(username)
    if not safe:
        return
    data["username"] = session.get("username", username)
    _save_to_db(data)


# ---------------------------------------------------------
# Daily reward logic
# I check lastLoginDate here. If the player came yesterday,
# the streak goes up by 1. If they missed a day, the streak
# starts again from day 1. Simple date compare, nothing else.
# ---------------------------------------------------------
def daily_reward_status(saved):
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    if saved.get("lastLoginDate") == today:
        return {"pending": False, "day": saved.get("loginStreak", 0) or 0}
    if not saved.get("lastLoginDate"):
        return {"pending": True, "day": 1}
    if saved.get("lastLoginDate") == yesterday:
        streak = (saved.get("loginStreak", 0) or 0) + 1
        return {"pending": True, "day": 1 if streak > 7 else streak}
    return {"pending": True, "day": 1}  # missed a day, so I restart the streak


def initial_screen(saved):
    # I decide the first screen on page load or second visit here.
    # New name = NAME_ENTRY, training not done = TRAINING,
    # daily reward left = DAILY_REWARD, else the difficulty menu.
    # So on the second visit the player lands straight on
    # Select Difficulty (START) once training + reward are done.
    if not saved.get("username"):
        return "NAME_ENTRY"
    if not saved.get("seenTraining"):
        return "TRAINING"
    if daily_reward_status(saved)["pending"]:
        return "DAILY_REWARD"
    return "START"


def public_state(saved):
    # I pack everything the browser needs into one object here:
    # the player's progress plus the static game config (levels,
    # prices, rewards). The browser asks for this on every reload.
    daily = daily_reward_status(saved)
    return {
        "username": saved["username"],
        "coins": saved["coins"],
        "diamonds": saved["diamonds"],
        "levelsCompletedCount": saved["levelsCompletedCount"],
        "unlockedLevel": saved["unlockedLevel"],
        "ownedSkins": saved["ownedSkins"],
        "selectedSkin": saved["selectedSkin"],
        "ownedEmojis": saved.get("ownedEmojis", ["none"]),
        "selectedEmoji": saved.get("selectedEmoji", "none"),
        "emojis": EMOJIS,
        "abilityCounts": saved["abilityCounts"],
        "musicOn": saved["musicOn"],
        "vibrationOn": saved["vibrationOn"],
        "dailyRewardPending": daily["pending"],
        "dailyRewardDay": daily["day"],
        "seenTraining": bool(saved.get("seenTraining")),
        "initialScreen": initial_screen(saved),
        # static config the frontend needs
        "levels": LEVELS,
        "difficulty": DIFFICULTY,
        "skins": SKINS,
        "abilities": ABILITIES,
        "dailyRewards": DAILY_REWARDS,
        "coinReward": COIN_REWARD,
        "continueCost": CONTINUE_COST,
        "startingLives": STARTING_LIVES,
        "trainingLevel": TRAINING_LEVEL,
        "coloursCss": COLOURS_CSS,
    }


# ---------------------------------------------------------
# Pages
# ---------------------------------------------------------
@app.route("/")
def index():
    # Home page - this loads templates/index.html with all screens
    return render_template("index.html")


@app.route("/assets/<path:filename>")
def assets(filename):
    # I serve the background music file from the assets/ folder here
    return send_from_directory(os.path.join(BASE_DIR, "assets"), filename)


# ---------------------------------------------------------
# API - the browser calls these links to save/load data
# ---------------------------------------------------------
@app.route("/api/state")
def api_state():
    # Browser asks "what is my full progress?" on every page load
    return jsonify(public_state(load_save()))


@app.route("/api/name", methods=["POST"])
def api_name():
    # I create a new account here. One name = one DB row.
    # If the name already exists in game.db, I stop here with an
    # error so nobody can open someone else's account by typing
    # the name. Password is saved only as a hash (never plain text).
    # Old players log in from the name list using /api/login.
    body = request.json or {}
    name = body.get("name", "").strip()
    password = body.get("password", "")
    if len(name) < 2:
        return jsonify({"ok": False, "error": "Please enter at least 2 characters."}), 400
    if not _safe_username(name):
        return jsonify({"ok": False, "error": "Please use only a-z, 0-9, _ or - in the name."}), 400
    if len(password) < 4:
        return jsonify({"ok": False, "error": "Please set a password of at least 4 characters."}), 400
    if _db_user_exists(name):
        return jsonify({"ok": False, "error": "This name is already taken! If you played before, enter your password below and press Login."}), 409
    session["username"] = name
    saved = load_save()
    saved["username"] = name
    saved["password_hash"] = generate_password_hash(password)
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/login", methods=["POST"])
def api_login():
    # Old players log in from here with name + password.
    # I only open the DB row if it already exists - I never create
    # a new account from this link, only /api/name does that.
    # Clicking someone else's name is useless without their password.
    # Because the check is name + password against the database,
    # the same ID opens from any browser or device (after hosting).
    body = request.json or {}
    name = body.get("name", "").strip()
    password = body.get("password", "")
    if not _safe_username(name):
        return jsonify({"ok": False, "error": "Name not found. New players please register above with a password."}), 404
    file_data = _db_get_user(name)
    if not file_data:
        return jsonify({"ok": False, "error": "Name not found. New players please register above with a password."}), 404
    stored = file_data.get("username") or name
    stored_hash = file_data.get("password_hash")
    if not stored_hash:
        # Very old account made before passwords existed: set the
        # password on first login so it becomes protected from now on.
        if len(password) < 4:
            return jsonify({"ok": False, "error": "This is an old account without a password. Please enter a new password (min 4 characters) to secure it."}), 401
        session["username"] = stored
        saved = load_save()
        saved["username"] = stored
        saved["password_hash"] = generate_password_hash(password)
        write_save(saved)
        return jsonify({"ok": True, "state": public_state(saved)})
    if not password or not check_password_hash(stored_hash, password):
        return jsonify({"ok": False, "error": "Wrong password! Only the account owner can login."}), 401
    session["username"] = stored
    saved = load_save()
    saved["username"] = stored
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    # I clear the session here so another player can log in
    # on the same browser. Each player's file stays separate.
    session.pop("username", None)
    return jsonify({"ok": True, "state": public_state(default_save())})


@app.route("/api/users")
def api_users():
    # I send only the names here (not the full data) so the
    # login screen can show the list of existing players.
    # Names come from the game.db database, not the old files.
    try:
        con = get_db()
        rows = con.execute("SELECT username FROM users").fetchall()
        con.close()
        return jsonify({"ok": True, "users": sorted([r["username"] for r in rows])})
    except OSError:
        return jsonify({"ok": True, "users": []})


@app.route("/api/training-seen", methods=["POST"])
def api_training_seen():
    saved = load_save()
    saved["seenTraining"] = True
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/level-complete", methods=["POST"])
def api_level_complete():
    # I run this when the browser says a level was cleared.
    # I check the level number myself here (not trusting the
    # browser blindly), then add coins and unlock the next level.
    # Every 5th completed level also gives 1 diamond.
    body = request.json or {}
    difficulty = body.get("difficulty", "EASY")
    level = int(body.get("level", 0))
    if difficulty not in DIFFICULTY or not (0 <= level < len(LEVELS)):
        return jsonify({"ok": False, "error": "Bad level."}), 400
    saved = load_save()
    saved["unlockedLevel"][difficulty] = max(saved["unlockedLevel"][difficulty], min(level + 1, len(LEVELS) - 1))
    reward = COIN_REWARD[difficulty]
    saved["coins"] += reward
    saved["levelsCompletedCount"] += 1
    got_diamond = (saved["levelsCompletedCount"] % LEVELS_PER_DIAMOND == 0)
    if got_diamond:
        saved["diamonds"] += 1
    write_save(saved)
    return jsonify({"ok": True, "reward": reward, "gotDiamond": got_diamond,
                    "state": public_state(saved)})


@app.route("/api/continue", methods=["POST"])
def api_continue():
    # After game over the player can pay 150 coins to keep playing.
    # I check the balance first so coins can never go negative.
    saved = load_save()
    if saved["coins"] < CONTINUE_COST:
        return jsonify({"ok": False, "error": "Not enough coins."}), 400
    saved["coins"] -= CONTINUE_COST
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/shop/buy-skin", methods=["POST"])
def api_buy_skin():
    # Player buys a new skin design from the shop here.
    # I check the price in coins or diamonds first, then cut
    # the balance and mark the skin as owned + selected.
    skin_id = (request.json or {}).get("skin_id")
    skin = next((s for s in SKINS if s["id"] == skin_id), None)
    if not skin:
        return jsonify({"ok": False, "error": "Unknown skin."}), 400
    saved = load_save()
    if skin_id in saved["ownedSkins"]:
        return jsonify({"ok": True, "state": public_state(saved)})
    balance = saved["diamonds"] if skin["currency"] == "diamond" else saved["coins"]
    if balance < skin["cost"]:
        return jsonify({"ok": False, "error": "Not enough funds."}), 400
    if skin["currency"] == "diamond":
        saved["diamonds"] -= skin["cost"]
    else:
        saved["coins"] -= skin["cost"]
    saved["ownedSkins"].append(skin_id)
    saved["selectedSkin"] = skin_id
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/shop/select-skin", methods=["POST"])
def api_select_skin():
    # Player picks which owned skin to wear. I allow only skins
    # they already bought, otherwise anyone could wear anything.
    skin_id = (request.json or {}).get("skin_id")
    saved = load_save()
    if skin_id not in saved["ownedSkins"]:
        return jsonify({"ok": False, "error": "Skin not owned."}), 400
    saved["selectedSkin"] = skin_id
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/shop/buy-emoji", methods=["POST"])
def api_buy_emoji():
    # Player buys an emoji face for the white player ball with coins.
    # Buying also selects it at once, like skins do.
    emoji_id = (request.json or {}).get("emoji_id")
    emo = next((e for e in EMOJIS if e["id"] == emoji_id), None)
    if not emo:
        return jsonify({"ok": False, "error": "Unknown emoji."}), 400
    saved = load_save()
    if emoji_id in saved.get("ownedEmojis", ["none"]):
        return jsonify({"ok": True, "state": public_state(saved)})
    if saved["coins"] < emo["cost"]:
        return jsonify({"ok": False, "error": "Not enough coins."}), 400
    saved["coins"] -= emo["cost"]
    saved.setdefault("ownedEmojis", ["none"]).append(emoji_id)
    saved["selectedEmoji"] = emoji_id
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/shop/select-emoji", methods=["POST"])
def api_select_emoji():
    # Player picks which owned emoji face shows on the ball.
    # Only faces they already bought are allowed.
    emoji_id = (request.json or {}).get("emoji_id")
    saved = load_save()
    if emoji_id not in saved.get("ownedEmojis", ["none"]):
        return jsonify({"ok": False, "error": "Emoji not owned."}), 400
    saved["selectedEmoji"] = emoji_id
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/shop/buy-ability", methods=["POST"])
def api_buy_ability():
    # Player buys one ability use with coins. Each buy adds
    # +1 to their count, using it later is handled separately.
    ab_id = (request.json or {}).get("ability_id")
    ab = next((a for a in ABILITIES if a["id"] == ab_id), None)
    if not ab:
        return jsonify({"ok": False, "error": "Unknown ability."}), 400
    saved = load_save()
    if saved["coins"] < ab["cost"]:
        return jsonify({"ok": False, "error": "Not enough coins."}), 400
    saved["coins"] -= ab["cost"]
    saved["abilityCounts"][ab_id] = saved["abilityCounts"].get(ab_id, 0) + 1
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/ability/consume", methods=["POST"])
def api_consume_ability():
    # When the player presses an ability button during a level,
    # the browser calls here and I cut 1 from their owned count.
    ab_id = (request.json or {}).get("ability_id")
    saved = load_save()
    if saved["abilityCounts"].get(ab_id, 0) <= 0:
        return jsonify({"ok": False, "error": "None owned."}), 400
    saved["abilityCounts"][ab_id] -= 1
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


@app.route("/api/daily-reward/claim", methods=["POST"])
def api_claim_daily():
    # Player claims today's reward here. I check it is really
    # pending first, so refreshing the page can't give double coins.
    import random
    saved = load_save()
    status = daily_reward_status(saved)
    if not status["pending"]:
        return jsonify({"ok": False, "error": "Already claimed today."}), 400
    day = status["day"]
    reward = DAILY_REWARDS[day - 1]
    granted = None
    if reward["type"] == "coin":
        saved["coins"] += reward["amount"]
        granted = {"type": "coin", "amount": reward["amount"]}
    else:
        pick = random.choice(reward["options"])
        saved["abilityCounts"][pick] = saved["abilityCounts"].get(pick, 0) + 1
        granted = {"type": "ability", "ability": pick}
    saved["loginStreak"] = day
    saved["lastLoginDate"] = date.today().isoformat()
    write_save(saved)
    return jsonify({"ok": True, "granted": granted, "state": public_state(saved)})


# ---------------------------------------------------------
# Admin panel
# Sir ne database batavva mate: /admin page par login karke
# badha players, temna coins/levels juo, coins aapo, password
# reset karo, progress reset karo ya account delete karo.
# Badha change game.db ma thay chhe, etle user na game ma
# (reload / next action par) tarat dekhay chhe. Game na nava
# update (nava level/skin) pan server thi j aave chhe, etle
# badha users ne reload par mali jay chhe.
# Password: ADMIN_PASSWORD env var, else "admin123" (demo mate).
# ---------------------------------------------------------
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")


def _require_admin():
    # Har admin API par check: login vagar 403 error.
    if not session.get("is_admin"):
        return jsonify({"ok": False, "error": "Admin login needed."}), 403
    return None


@app.route("/api/feedback", methods=["POST"])
def api_feedback():
    """Save a player's 1-5 star rating and optional text feedback."""
    username = session.get("username")
    if not username:
        return jsonify({"ok": False, "error": "Please log in first."}), 401

    body = request.json or {}
    try:
        rating = int(body.get("rating", 0))
    except (TypeError, ValueError):
        rating = 0

    message = str(body.get("message", "") or "").strip()
    if rating < 1 or rating > 5:
        return jsonify({"ok": False, "error": "Please select a rating from 1 to 5 stars."}), 400
    if len(message) > 500:
        return jsonify({"ok": False, "error": "Feedback must be 500 characters or less."}), 400

    safe = _safe_username(username)
    con = get_db()
    # Backward compatibility for databases created before feedback was added.
    con.execute("""CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        safe_name TEXT NOT NULL,
        username TEXT,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        message TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    con.execute(
        "INSERT INTO feedback (safe_name, username, rating, message) VALUES (?, ?, ?, ?)",
        (safe, username, rating, message),
    )
    con.commit()
    con.close()
    return jsonify({"ok": True, "message": "Thanks! Your feedback was submitted."})


@app.route("/admin")
def admin_page():
    # Admin website - templates/admin.html khule chhe.
    return render_template("admin.html")


@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    # Admin password check. Sahi hoy to session ma is_admin=True.
    import hmac
    body = request.json or {}
    if hmac.compare_digest(str(body.get("password", "")), ADMIN_PASSWORD):
        session["is_admin"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Wrong admin password."}), 401


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    session.pop("is_admin", None)
    return jsonify({"ok": True})


@app.route("/api/admin/overview")
def api_admin_overview():
    # Stats dashboard: total users, coins, diamonds, top players.
    denied = _require_admin()
    if denied:
        return denied
    con = get_db()
    rows = con.execute("SELECT * FROM users").fetchall()
    con.close()
    users = [_row_to_save(r) for r in rows]
    top = sorted(users, key=lambda u: (u["levelsCompletedCount"], u["coins"]), reverse=True)[:5]
    return jsonify({
        "ok": True,
        "totalUsers": len(users),
        "totalCoins": sum(u["coins"] for u in users),
        "totalDiamonds": sum(u["diamonds"] for u in users),
        "totalLevelsCompleted": sum(u["levelsCompletedCount"] for u in users),
        "topPlayers": [{"username": u["username"], "coins": u["coins"],
                        "levelsCompletedCount": u["levelsCompletedCount"]} for u in top],
    })


@app.route("/api/admin/feedback")
def api_admin_feedback():
    """Return all player feedback for the admin dashboard."""
    denied = _require_admin()
    if denied:
        return denied
    con = get_db()
    # Make the feedback table available even when an older game.db is used.
    con.execute("""CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        safe_name TEXT NOT NULL,
        username TEXT,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        message TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    con.commit()
    rows = con.execute(
        "SELECT id, safe_name, username, rating, message, created_at "
        "FROM feedback ORDER BY id DESC"
    ).fetchall()
    summary = con.execute(
        "SELECT COUNT(*) AS total, COALESCE(AVG(rating), 0) AS average FROM feedback"
    ).fetchone()
    con.close()
    return jsonify({
        "ok": True,
        "total": summary["total"],
        "average": round(float(summary["average"] or 0), 2),
        "feedback": [dict(r) for r in rows],
    })


@app.route("/api/admin/feedback/<int:feedback_id>", methods=["DELETE"])
def api_admin_delete_feedback(feedback_id):
    """Allow admin to remove a feedback entry."""
    denied = _require_admin()
    if denied:
        return denied
    con = get_db()
    cur = con.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,))
    con.commit()
    con.close()
    if cur.rowcount == 0:
        return jsonify({"ok": False, "error": "Feedback not found."}), 404
    return jsonify({"ok": True})


@app.route("/api/admin/users")
def api_admin_users():
    # Badha players ni list (password hash vagar - security mate).
    denied = _require_admin()
    if denied:
        return denied
    con = get_db()
    rows = con.execute("SELECT * FROM users ORDER BY username").fetchall()
    con.close()
    out = []
    for r in rows:
        s = _row_to_save(r)
        s.pop("password_hash", None)
        out.append(s)
    return jsonify({"ok": True, "users": out})


@app.route("/api/admin/give", methods=["POST"])
def api_admin_give():
    # Koi player ne coins/diamonds aapo (demo / prize mate).
    # Minus pan aapi sako, pan balance 0 thi niche nahi jay.
    denied = _require_admin()
    if denied:
        return denied
    body = request.json or {}
    saved = _db_get_user(body.get("username", ""))
    if not saved:
        return jsonify({"ok": False, "error": "User not found."}), 404
    try:
        coins = int(body.get("coins", 0))
        diamonds = int(body.get("diamonds", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Coins/diamonds must be numbers."}), 400
    saved["coins"] = max(0, saved["coins"] + coins)
    saved["diamonds"] = max(0, saved["diamonds"] + diamonds)
    _save_to_db(saved)
    return jsonify({"ok": True, "coins": saved["coins"], "diamonds": saved["diamonds"]})


@app.route("/api/admin/reset-progress", methods=["POST"])
def api_admin_reset_progress():
    # Player ni progress zero karo (account + password rahe chhe).
    # Testing/demo mate: level 1 thi farithi ramva de.
    denied = _require_admin()
    if denied:
        return denied
    body = request.json or {}
    saved = _db_get_user(body.get("username", ""))
    if not saved:
        return jsonify({"ok": False, "error": "User not found."}), 404
    saved["coins"] = 0
    saved["diamonds"] = 0
    saved["levelsCompletedCount"] = 0
    saved["unlockedLevel"] = {"EASY": 0, "MEDIUM": 0, "HARD": 0}
    saved["ownedSkins"] = ["classic"]
    saved["selectedSkin"] = "classic"
    saved["ownedEmojis"] = ["none"]
    saved["selectedEmoji"] = "none"
    saved["abilityCounts"] = {"colorbomb": 0, "slowmo": 0, "lifeplus": 0}
    saved["loginStreak"] = 0
    saved["lastLoginDate"] = None
    _save_to_db(saved)
    return jsonify({"ok": True})


@app.route("/api/admin/set-password", methods=["POST"])
def api_admin_set_password():
    # Player bhuli gayo hoy to admin navo password set kare.
    denied = _require_admin()
    if denied:
        return denied
    body = request.json or {}
    saved = _db_get_user(body.get("username", ""))
    if not saved:
        return jsonify({"ok": False, "error": "User not found."}), 404
    new_pw = body.get("new_password", "")
    if len(new_pw) < 4:
        return jsonify({"ok": False, "error": "Min 4 characters."}), 400
    saved["password_hash"] = generate_password_hash(new_pw)
    _save_to_db(saved)
    return jsonify({"ok": True})


@app.route("/api/admin/delete", methods=["POST"])
def api_admin_delete():
    # Nakama / test account delete karo. DB row + juno json file banne.
    denied = _require_admin()
    if denied:
        return denied
    body = request.json or {}
    safe = _safe_username(body.get("username", ""))
    if not safe:
        return jsonify({"ok": False, "error": "User not found."}), 404
    con = get_db()
    cur = con.execute("DELETE FROM users WHERE safe_name = ?", (safe,))
    con.commit()
    con.close()
    if cur.rowcount == 0:
        return jsonify({"ok": False, "error": "User not found."}), 404
    try:
        os.remove(os.path.join(USERS_DIR, safe + ".json"))
    except OSError:
        pass
    return jsonify({"ok": True})


@app.route("/api/settings", methods=["POST"])
def api_settings():
    # Simple ON/OFF save for music and vibration from Settings screen.
    body = request.json or {}
    saved = load_save()
    if "musicOn" in body:
        saved["musicOn"] = bool(body["musicOn"])
    if "vibrationOn" in body:
        saved["vibrationOn"] = bool(body["vibrationOn"])
    write_save(saved)
    return jsonify({"ok": True, "state": public_state(saved)})


init_db()
migrate_to_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
