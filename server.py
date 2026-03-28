"""WardWatch Flask server."""

import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, redirect, render_template, send_from_directory, url_for

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env", override=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.getenv("SECRET_KEY", "wardwatch-secret")

FIREBASE_CONFIG = {
    "apiKey": os.getenv("FIREBASE_API_KEY"),
    "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN"),
    "projectId": os.getenv("FIREBASE_PROJECT_ID"),
    "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET"),
    "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID"),
    "appId": os.getenv("FIREBASE_APP_ID"),
    "measurementId": os.getenv("FIREBASE_MEASUREMENT_ID"),
    "databaseURL": os.getenv("FIREBASE_DATABASE_URL"),
}


@app.route("/")
def index():
    """Render the login screen."""
    return render_template("login.html", config=FIREBASE_CONFIG)


@app.route("/signup")
def signup():
    """Render the signup screen."""
    return render_template("signup.html", config=FIREBASE_CONFIG)


@app.route("/singup")
def signup_legacy():
    """Redirect the legacy misspelled route."""
    return redirect(url_for("signup"))


@app.route("/dashboard/doctor")
def doctor_dashboard():
    """Render the doctor dashboard."""
    return render_template("doctor.html", config=FIREBASE_CONFIG)


@app.route("/dashboard/manager")
def manager_dashboard():
    """Render the manager (ward manager) dashboard."""
    return render_template("manager.html", config=FIREBASE_CONFIG)


@app.route("/dashboard/staff")
def staff_dashboard_legacy():
    """Redirect legacy staff route to manager dashboard."""
    return redirect(url_for("manager_dashboard"))


@app.route("/dashboard/admin")
def admin_dashboard():
    """Render the admin dashboard."""
    return render_template("admin.html", config=FIREBASE_CONFIG)


@app.route("/photos/<path:filename>")
def photos(filename):
    """Serve photo files (logo, etc.)."""
    return send_from_directory(str(BASE_DIR / "photos"), filename)


@app.route("/static/<path:filename>")
def static_files(filename):
    """Serve static files."""
    return send_from_directory("static", filename)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("DEBUG", "True").lower() == "true"
    print(f"\nWardWatch server starting at http://{host}:{port}\n")
    app.run(host=host, port=port, debug=debug)
