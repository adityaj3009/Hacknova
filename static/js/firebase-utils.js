import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  get,
  getDatabase,
  onValue,
  push,
  ref,
  remove,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

/* ─── constants ─── */

const REQUIRED_FIREBASE_FIELDS = ["apiKey", "authDomain", "projectId", "appId", "databaseURL"];

const STATUS_META = {
  available: { label: "Available", className: "available", icon: "✅" },
  occupied:  { label: "Occupied",  className: "occupied",  icon: "🛏️" },
  cleaning:  { label: "Cleaning",  className: "cleaning",  icon: "🧹" },
  reserved:  { label: "Reserved",  className: "reserved",  icon: "📌" },
};

/* Average stay durations in hours by condition category */
const AVG_STAY_HOURS = {
  general:    72,
  surgery:   120,
  emergency:  48,
  icu:       168,
  maternity:  48,
};

const DEFAULT_CLEANING_MINUTES = 20;
const CONDITION_CATEGORIES = ["general", "surgery", "emergency", "icu", "maternity"];

let appInstance = null;
let authInstance = null;
let dbInstance = null;

/* ─── helpers ─── */

function activityLevelForStatus(status) {
  switch (status) {
    case "cleaning":  return "warning";
    case "reserved":  return "info";
    case "occupied":  return "info";
    default:          return "ok";
  }
}

function assertInitialized() {
  if (!authInstance || !dbInstance) {
    throw new Error("Firebase has not been initialized yet.");
  }
}

function normalizeConfig(config) {
  return config || {};
}

export function validateFirebaseConfig(config) {
  const safeConfig = normalizeConfig(config);
  return REQUIRED_FIREBASE_FIELDS.filter((field) => !safeConfig[field]);
}

export function initFirebase(config) {
  const missing = validateFirebaseConfig(config);
  if (missing.length) {
    throw new Error(
      `Firebase config is incomplete. Missing: ${missing.join(", ")}. Add these values to your .env file.`,
    );
  }

  if (!getApps().length) {
    appInstance = initializeApp(config);
  } else {
    appInstance = getApp();
  }

  authInstance = getAuth(appInstance);
  dbInstance = getDatabase(appInstance);

  return { app: appInstance, auth: authInstance, db: dbInstance };
}

/* ─── DOM helpers ─── */

export function renderFatalState(title, message, details = "") {
  const root = document.getElementById("app") || document.body;
  root.innerHTML = `
    <main class="auth-pane page-shell">
      <section class="auth-panel">
        <span class="eyebrow" style="background: rgba(220, 38, 38, 0.12); color: #8c1d1d;">Setup required</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="fatal-card">
          ${escapeHtml(details || "Check your Firebase environment variables and reload the app.")}
        </div>
      </section>
    </main>
  `;
}

export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? "";
}

export function setHtml(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = value ?? "";
}

export function cap(value = "") {
  if (!value) return "";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDateTime(timestamp) {
  if (!timestamp) return "Just now";
  const date = new Date(timestamp);
  return date.toLocaleString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(timestamp) {
  if (!timestamp) return "just now";
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDuration(minutes) {
  if (minutes <= 0) return "Ready now";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

export function showToast(message, type = "ok") {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  wrap.appendChild(node);
  window.setTimeout(() => node.remove(), 3200);
}

/* ─── auth ─── */

export function redirectForRole(role) {
  const map = {
    admin:  "/dashboard/admin",
    doctor: "/dashboard/doctor",
    staff:  "/dashboard/staff",
  };
  return map[role] || "/";
}

export function navigateToRole(role) {
  window.location.replace(redirectForRole(role));
}

export async function getProfile(db = dbInstance, uid) {
  const snapshot = await get(ref(db, `profiles/${uid}`));
  return snapshot.val();
}

export async function loginWithEmailPassword({ email, password }) {
  assertInitialized();
  const cred = await signInWithEmailAndPassword(authInstance, email, password);
  /* Return profile so caller can redirect immediately */
  const profile = await getProfile(dbInstance, cred.user.uid);
  return { cred, profile };
}

export async function registerWithEmailPassword({ name, email, password, role }) {
  assertInitialized();
  const credentials = await createUserWithEmailAndPassword(authInstance, email, password);
  await updateProfile(credentials.user, { displayName: name });
  await set(ref(dbInstance, `profiles/${credentials.user.uid}`), {
    uid: credentials.user.uid,
    name,
    email,
    role,
    createdAt: Date.now(),
  });
  await pushActivity(dbInstance, {
    title: "New user registered",
    copy: `${name} created a ${role} account.`,
    level: "info",
  });
  /* Return profile so caller can redirect to role dashboard */
  return { credentials, role };
}

export async function redirectAuthedUser() {
  assertInitialized();
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
      unsubscribe();
      if (!user) { resolve(false); return; }
      try {
        const profile = await getProfile(dbInstance, user.uid);
        if (!profile?.role) { await signOut(authInstance); resolve(false); return; }
        window.location.replace(redirectForRole(profile.role));
        resolve(true);
      } catch (error) {
        console.error(error);
        resolve(false);
      }
    });
  });
}

export function requireAuth(callback, options = {}) {
  assertInitialized();
  const { allowRoles = [], redirectIfMissing = true } = options;
  return onAuthStateChanged(authInstance, async (user) => {
    if (!user) {
      if (redirectIfMissing) window.location.replace("/");
      return;
    }
    try {
      const profile = await getProfile(dbInstance, user.uid);
      if (!profile?.role) {
        await signOut(authInstance);
        if (redirectIfMissing) window.location.replace("/");
        return;
      }
      if (allowRoles.length && !allowRoles.includes(profile.role)) {
        window.location.replace(redirectForRole(profile.role));
        return;
      }
      callback({
        user,
        uid: user.uid,
        name: profile.name || user.displayName || "Team member",
        email: profile.email || user.email || "",
        role: profile.role,
      });
    } catch (error) {
      console.error(error);
      showToast("Could not verify your session.", "err");
    }
  });
}

export async function logout() {
  assertInitialized();
  await signOut(authInstance);
  window.location.replace("/");
}

/* ─── realtime listeners ─── */

export function listenBeds(db = dbInstance, callback) {
  return onValue(ref(db, "beds"), (snapshot) => {
    callback(snapshot.val() || {});
  });
}

export function listenActivity(db = dbInstance, callback) {
  return onValue(ref(db, "activity"), (snapshot) => {
    const raw = snapshot.val() || {};
    const items = Object.entries(raw)
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(items);
  });
}

export function listenWaitingQueue(db = dbInstance, callback) {
  return onValue(ref(db, "waitingQueue"), (snapshot) => {
    const raw = snapshot.val() || {};
    const items = Object.entries(raw)
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => (a.waitingSince || 0) - (b.waitingSince || 0));
    callback(items);
  });
}

/* ─── waiting queue CRUD ─── */

export async function addToWaitingQueue(db = dbInstance, patient) {
  return push(ref(db, "waitingQueue"), {
    name: patient.name,
    condition: patient.condition || "general",
    waitingSince: Date.now(),
    notes: patient.notes || "",
  });
}

export async function removeFromWaitingQueue(db = dbInstance, patientId) {
  return remove(ref(db, `waitingQueue/${patientId}`));
}

/* ─── bed queries ─── */

export function getSortedBeds(beds = {}, options = {}) {
  const { ward = "all", search = "" } = options;
  const searchText = search.trim().toLowerCase();

  return Object.values(beds)
    .filter((bed) => (ward === "all" ? true : bed.ward === ward))
    .filter((bed) => {
      if (!searchText) return true;
      const haystack = [
        bed.id, bed.ward, bed.patientName, bed.assignedDoctor,
        bed.notes, bed.reservedFor, bed.conditionCategory,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(searchText);
    })
    .sort((a, b) => {
      if (a.ward !== b.ward) return a.ward.localeCompare(b.ward);
      return a.number - b.number;
    });
}

/* ─── seed data ─── */

function buildSeedBeds() {
  const wards = [
    { name: "Ward A", prefix: "A", capacity: 8 },
    { name: "Ward B", prefix: "B", capacity: 8 },
    { name: "Ward C", prefix: "C", capacity: 8 },
  ];
  const statusPattern = [
    "occupied", "available", "cleaning", "occupied",
    "reserved", "available", "occupied", "available",
  ];
  const conditionPattern = ["general", "surgery", "emergency", "icu", "maternity", "general", "surgery", "emergency"];
  const patientNames = [
    "Rahul Sharma", "Priya Patel", "Amit Kumar", "Sita Devi",
    "Vikram Singh", "Anita Gupta", "Rajesh Verma", "Meera Joshi",
  ];
  const doctorNames = [
    "Dr. Anil Kapoor", "Dr. Sneha Reddy", "Dr. Vikram Mehta", "Dr. Priya Iyer",
    "Dr. Rajan Nair", "Dr. Kavita Shah", "Dr. Suresh Rao", "Dr. Neha Gupta",
  ];
  const now = Date.now();
  const beds = {};

  wards.forEach((ward, wardIndex) => {
    for (let i = 1; i <= ward.capacity; i++) {
      const status = statusPattern[(i - 1 + wardIndex) % statusPattern.length];
      const bedId = `${ward.prefix}-${String(i).padStart(2, "0")}`;
      const condCat = conditionPattern[(i - 1 + wardIndex) % conditionPattern.length];
      const pIdx = (i - 1 + wardIndex) % patientNames.length;

      /* Randomize admission time: 1-48 hours ago for occupied beds */
      const admittedHoursAgo = (Math.random() * 47 + 1);
      const admittedAt = status === "occupied" ? now - admittedHoursAgo * 3600000 : 0;

      /* Cleaning started 5-25 min ago for cleaning beds */
      const cleaningMinsAgo = Math.random() * 20 + 5;
      const cleaningStartedAt = status === "cleaning" ? now - cleaningMinsAgo * 60000 : 0;

      beds[bedId] = {
        id: bedId,
        ward: ward.name,
        number: i,
        status,
        patientName: status === "occupied" ? patientNames[pIdx] : "",
        assignedDoctor: status === "occupied" ? doctorNames[pIdx] : "",
        reservedFor: status === "reserved" ? `Admission ${ward.prefix}${i}` : "",
        conditionCategory: status === "occupied" ? condCat : "",
        admittedAt,
        cleaningStartedAt,
        notes:
          status === "cleaning"
            ? "Housekeeping in progress — linen change."
            : status === "occupied"
              ? `Under observation. Category: ${cap(condCat)}.`
              : status === "reserved"
                ? "Reserved for incoming patient."
                : "Bed ready and sanitized.",
        updatedAt: now - i * 1800000,
        updatedByName: "System",
        updatedByRole: "admin",
      };
    }
  });

  return beds;
}

function buildSeedWaitingQueue() {
  const now = Date.now();
  return {
    w1: { name: "Rahul Mehra",   condition: "general",   waitingSince: now - 25 * 60000, notes: "Fever and body pain" },
    w2: { name: "Sita Kumari",   condition: "emergency",  waitingSince: now - 40 * 60000, notes: "Chest pain, needs urgent bed" },
    w3: { name: "Arvind Joshi",  condition: "surgery",    waitingSince: now - 15 * 60000, notes: "Post-op recovery bed needed" },
    w4: { name: "Priya Nair",    condition: "maternity",  waitingSince: now - 32 * 60000, notes: "Expected delivery" },
    w5: { name: "Karan Malhotra", condition: "icu",       waitingSince: now - 10 * 60000, notes: "Severe trauma" },
  };
}

export async function seedBedsIfNeeded(db = dbInstance) {
  const snapshot = await get(ref(db, "beds"));
  if (!snapshot.exists()) {
    await set(ref(db, "beds"), buildSeedBeds());
    await pushActivity(db, {
      title: "Beds seeded",
      copy: "WardWatch added starter beds so the dashboards can render immediately.",
      level: "info",
    });
  }

  /* Also seed waiting queue */
  const wqSnap = await get(ref(db, "waitingQueue"));
  if (!wqSnap.exists()) {
    await set(ref(db, "waitingQueue"), buildSeedWaitingQueue());
  }
}

/* ─── activity ─── */

export async function pushActivity(db = dbInstance, activity) {
  return push(ref(db, "activity"), {
    ...activity,
    createdAt: Date.now(),
  });
}

/* ─── bed update (optimized: direct update, no read-before-write for instant speed) ─── */

export async function updateBedRecord(db = dbInstance, bedId, patch, actor) {
  const bedRef = ref(db, `beds/${bedId}`);
  const snapshot = await get(bedRef);
  if (!snapshot.exists()) throw new Error("Bed record not found.");

  const current = snapshot.val();
  const nextStatus = patch.status || current.status;
  const now = Date.now();

  const nextRecord = {
    ...current,
    ...patch,
    status: nextStatus,
    notes: patch.notes ?? current.notes ?? "",
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
  };

  /* Auto-track timestamps for prediction engine */
  if (nextStatus === "occupied" && current.status !== "occupied") {
    nextRecord.admittedAt = now;
    nextRecord.cleaningStartedAt = 0;
  }
  if (nextStatus === "cleaning" && current.status !== "cleaning") {
    nextRecord.cleaningStartedAt = now;
  }
  if (nextStatus === "available") {
    nextRecord.patientName = "";
    nextRecord.assignedDoctor = "";
    nextRecord.reservedFor = "";
    nextRecord.conditionCategory = "";
    nextRecord.admittedAt = 0;
    nextRecord.cleaningStartedAt = 0;
  }
  if (nextStatus === "cleaning") {
    nextRecord.patientName = "";
    nextRecord.assignedDoctor = "";
    nextRecord.reservedFor = "";
  }
  if (nextStatus === "reserved") {
    nextRecord.patientName = "";
    nextRecord.assignedDoctor = "";
    nextRecord.cleaningStartedAt = 0;
  }
  if (nextStatus === "occupied") {
    nextRecord.reservedFor = "";
    nextRecord.cleaningStartedAt = 0;
  }

  /* Direct update — no read-modify-write blocking for multi-doctor support */
  await update(bedRef, nextRecord);
  await pushActivity(db, {
    title: `${bedId} → ${STATUS_META[nextStatus]?.label || nextStatus}`,
    copy: `${actor.name} updated ${bedId} in ${current.ward}.`,
    level: activityLevelForStatus(nextStatus),
  });
}

/* ─── stats ─── */

export function computeStats(beds = {}, options = {}) {
  const list = getSortedBeds(beds, options);
  const stats = { total: list.length, occupied: 0, available: 0, cleaning: 0, reserved: 0, occupancy: 0 };
  list.forEach((bed) => {
    if (typeof stats[bed.status] === "number") stats[bed.status] += 1;
  });
  stats.occupancy = stats.total ? Math.round((stats.occupied / stats.total) * 100) : 0;
  return stats;
}

export function getWardNames(beds = {}) {
  return [...new Set(Object.values(beds).map((bed) => bed.ward))].sort((a, b) => a.localeCompare(b));
}

export function computeWardStats(beds = {}) {
  return getWardNames(beds).map((ward) => {
    const stats = computeStats(beds, { ward });
    return { ward, ...stats };
  });
}

/* ─── 🧠 PREDICTION ENGINE ─── */

export function computeBedPrediction(bed) {
  const now = Date.now();
  const prediction = {
    vacancyMinutes: null,
    vacancyLabel: "",
    cleaningRemainingMinutes: null,
    cleaningLabel: "",
    totalReadyMinutes: null,
    totalReadyLabel: "",
    status: bed.status,
    urgency: "normal", // normal, soon, delayed
  };

  if (bed.status === "available") {
    prediction.totalReadyMinutes = 0;
    prediction.totalReadyLabel = "Ready now";
    prediction.urgency = "ready";
    return prediction;
  }

  if (bed.status === "occupied") {
    const cat = bed.conditionCategory || "general";
    const avgStayMs = (AVG_STAY_HOURS[cat] || AVG_STAY_HOURS.general) * 3600000;
    const admittedAt = bed.admittedAt || bed.updatedAt || now;
    const expectedDischarge = admittedAt + avgStayMs;
    const remainingMs = expectedDischarge - now;
    const remainingMin = Math.max(0, remainingMs / 60000);

    prediction.vacancyMinutes = remainingMin;
    prediction.vacancyLabel = remainingMin <= 0
      ? "Discharge overdue"
      : `Discharge in ${formatDuration(remainingMin)}`;

    /* Total ready = discharge + default cleaning */
    prediction.totalReadyMinutes = remainingMin + DEFAULT_CLEANING_MINUTES;
    prediction.totalReadyLabel = `Ready in ${formatDuration(remainingMin + DEFAULT_CLEANING_MINUTES)}`;

    if (remainingMin <= 60) prediction.urgency = "soon";
    if (remainingMin <= 0) prediction.urgency = "overdue";
    return prediction;
  }

  if (bed.status === "cleaning") {
    const startedAt = bed.cleaningStartedAt || bed.updatedAt || now;
    const elapsedMin = (now - startedAt) / 60000;
    const remainingMin = Math.max(0, DEFAULT_CLEANING_MINUTES - elapsedMin);

    prediction.cleaningRemainingMinutes = remainingMin;
    prediction.cleaningLabel = remainingMin <= 0
      ? "Cleaning overdue"
      : `Cleaning: ${Math.round(remainingMin)} min left`;

    prediction.totalReadyMinutes = remainingMin;
    prediction.totalReadyLabel = remainingMin <= 0
      ? "Should be ready"
      : `Ready in ${formatDuration(remainingMin)}`;

    if (remainingMin <= 5) prediction.urgency = "soon";
    if (remainingMin <= 0) prediction.urgency = "overdue";
    return prediction;
  }

  if (bed.status === "reserved") {
    prediction.totalReadyMinutes = Infinity;
    prediction.totalReadyLabel = "Reserved — can be reassigned";
    prediction.urgency = "reserved";
    return prediction;
  }

  return prediction;
}

export function computeAllPredictions(beds = {}) {
  const predictions = {};
  Object.entries(beds).forEach(([id, bed]) => {
    predictions[id] = computeBedPrediction(bed);
  });
  return predictions;
}

/* ─── 🚨 Emergency Mode: rank beds by readiness ─── */

export function getEmergencyRanking(beds = {}) {
  const now = Date.now();
  const ranked = Object.values(beds).map((bed) => {
    const pred = computeBedPrediction(bed);
    let readyMinutes = pred.totalReadyMinutes ?? Infinity;
    let label = "";
    let icon = "";
    let canReassign = false;

    if (bed.status === "available") {
      readyMinutes = 0;
      label = "✅ Ready now";
      icon = "ready";
    } else if (bed.status === "cleaning") {
      label = `🧹 Cleaning (${formatDuration(pred.cleaningRemainingMinutes || 0)} left)`;
      icon = "cleaning";
    } else if (bed.status === "occupied") {
      label = `🛏️ ${pred.vacancyLabel}`;
      icon = "occupied";
    } else if (bed.status === "reserved") {
      readyMinutes = 5; /* Can be reassigned quickly */
      label = "📌 Reserved (can be reassigned)";
      icon = "reserved";
      canReassign = true;
    }

    return {
      ...bed,
      prediction: pred,
      readyMinutes,
      label,
      icon,
      canReassign,
    };
  });

  return ranked.sort((a, b) => a.readyMinutes - b.readyMinutes);
}

/* ─── Smart suggestions ─── */

export function getSmartSuggestions(beds = {}) {
  const all = Object.values(beds);
  const predictions = all.map((bed) => ({
    bed,
    pred: computeBedPrediction(bed),
  }));

  const fastest = predictions
    .filter((p) => p.bed.status === "available")
    .map((p) => p.bed);

  const aboutToFree = predictions
    .filter((p) => p.bed.status === "occupied" && p.pred.vacancyMinutes !== null && p.pred.vacancyMinutes <= 120)
    .sort((a, b) => (a.pred.vacancyMinutes || 0) - (b.pred.vacancyMinutes || 0))
    .map((p) => ({ bed: p.bed, label: p.pred.vacancyLabel }));

  const causingDelay = predictions
    .filter((p) => p.bed.status === "cleaning" && p.pred.cleaningRemainingMinutes !== null && p.pred.cleaningRemainingMinutes <= 0)
    .map((p) => ({ bed: p.bed, label: "Cleaning overdue — causing delay" }));

  return { fastest, aboutToFree, causingDelay };
}

/* ─── Waiting queue helpers ─── */

export function computeWaitingAlerts(queue = []) {
  const now = Date.now();
  return queue.map((patient) => {
    const waitingMin = Math.round((now - (patient.waitingSince || now)) / 60000);
    const isAlert = waitingMin >= 30;
    return { ...patient, waitingMin, isAlert };
  });
}

/* ─── 🚨 Enhanced Alert System (with escalation flags) ─── */

export function computeAlerts(beds = {}, waitingQueue = []) {
  const alerts = [];
  const now = Date.now();

  /* Ward occupancy alerts */
  computeWardStats(beds).forEach((ward) => {
    if (ward.total && ward.occupancy >= 90) {
      alerts.push({
        type: "critical",
        title: `🔴 ${ward.ward}: ${ward.occupancy}% occupancy`,
        copy: `Critical capacity. Initiate discharge planning immediately.`,
        time: now,
        flag: "ESCALATION",
      });
    } else if (ward.total && ward.occupancy >= 80) {
      alerts.push({
        type: "warning",
        title: `⚠️ ${ward.ward}: ${ward.occupancy}% occupancy`,
        copy: `Ward nearing capacity. Monitor incoming admissions.`,
        time: now,
      });
    }
  });

  /* Per-bed alerts */
  Object.values(beds).forEach((bed) => {
    const ageMin = Math.round((now - (bed.updatedAt || now)) / 60000);

    /* Cleaning > 30 min */
    if (bed.status === "cleaning") {
      const cleaningAge = bed.cleaningStartedAt
        ? Math.round((now - bed.cleaningStartedAt) / 60000)
        : ageMin;
      if (cleaningAge >= 30) {
        alerts.push({
          type: "warning",
          title: `🧹 ${bed.id}: Cleaning > ${cleaningAge} min`,
          copy: `${bed.ward} — cleaning exceeds target. Escalate to housekeeping.`,
          time: bed.cleaningStartedAt || bed.updatedAt,
          flag: "ESCALATION",
        });
      }
    }

    /* Discharge delay > 2 hours */
    if (bed.status === "occupied" && bed.admittedAt) {
      const pred = computeBedPrediction(bed);
      if (pred.vacancyMinutes !== null && pred.vacancyMinutes <= 0) {
        const overdueMin = Math.abs(pred.vacancyMinutes);
        if (overdueMin >= 120) {
          alerts.push({
            type: "critical",
            title: `⏰ ${bed.id}: Discharge delay > 2 hrs`,
            copy: `${bed.ward} — patient overstaying by ${formatDuration(overdueMin)}. Review discharge.`,
            time: bed.admittedAt,
            flag: "ESCALATION",
          });
        }
      }
    }

    /* Reserved bed waiting > 60 min */
    if (bed.status === "reserved" && ageMin >= 60) {
      alerts.push({
        type: "info",
        title: `📌 ${bed.id}: Reserved for ${ageMin} min`,
        copy: `${bed.reservedFor || "Incoming patient"} has been waiting in ${bed.ward}.`,
        time: bed.updatedAt,
      });
    }
  });

  /* Waiting queue > 30 min */
  if (waitingQueue.length) {
    waitingQueue.forEach((patient) => {
      const waitMin = Math.round((now - (patient.waitingSince || now)) / 60000);
      if (waitMin >= 30) {
        alerts.push({
          type: "critical",
          title: `⏳ ${patient.name}: Waiting ${waitMin} min`,
          copy: `Patient in queue over 30 min. Condition: ${cap(patient.condition || "general")}.`,
          time: patient.waitingSince,
          flag: "ESCALATION",
        });
      }
    });
  }

  return alerts.sort((a, b) => {
    const priority = { critical: 0, warning: 1, info: 2 };
    if (priority[a.type] !== priority[b.type]) return priority[a.type] - priority[b.type];
    return (b.time || 0) - (a.time || 0);
  });
}

/* ─── rendering helpers ─── */

export function renderAlertStrips(alerts = []) {
  if (!alerts.length) {
    return `<div class="empty-state">No active alerts. Real-time updates will appear here.</div>`;
  }
  return `
    <div class="alert-list">
      ${alerts.map((alert) => `
        <article class="alert-item ${escapeHtml(alert.type)}">
          <div class="item-head">
            <h4 class="item-title">${escapeHtml(alert.title)}</h4>
            <div class="alert-badges">
              ${alert.flag ? `<span class="escalation-flag">${escapeHtml(alert.flag)}</span>` : ""}
              <span class="status-chip ${escapeHtml(alert.type)}">${escapeHtml(cap(alert.type))}</span>
            </div>
          </div>
          <p class="item-copy">${escapeHtml(alert.copy)}</p>
          <div class="item-time">${escapeHtml(relativeTime(alert.time))}</div>
        </article>
      `).join("")}
    </div>
  `;
}

export function renderActivityItems(items = []) {
  if (!items.length) {
    return `<div class="empty-state">No activity yet. Changes will stream in here live.</div>`;
  }
  return `
    <div class="activity-list">
      ${items.slice(0, 12).map((item) => `
        <article class="activity-item">
          <div>
            <h4 class="item-title">${escapeHtml(item.title || "Activity")}</h4>
            <p class="item-copy">${escapeHtml(item.copy || "Update received.")}</p>
            <div class="item-time">${escapeHtml(relativeTime(item.createdAt))}</div>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

export function renderWaitingQueue(queue = []) {
  const now = Date.now();
  if (!queue.length) {
    return `<div class="empty-state">No patients in queue. Add patients from the toolbar.</div>`;
  }
  return `
    <div class="waiting-list">
      ${queue.map((p) => {
        const waitMin = Math.round((now - (p.waitingSince || now)) / 60000);
        const isAlert = waitMin >= 30;
        return `
          <article class="waiting-item ${isAlert ? "waiting-alert" : ""}">
            <div class="waiting-info">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="waiting-condition">${escapeHtml(cap(p.condition || "general"))}</span>
              ${p.notes ? `<span class="waiting-notes">${escapeHtml(p.notes)}</span>` : ""}
            </div>
            <div class="waiting-timer-wrap">
              <span class="waiting-timer ${isAlert ? "alert" : ""}" data-since="${p.waitingSince || now}">
                ${waitMin} min
              </span>
              ${isAlert ? `<span class="waiting-alert-badge">⚠️ ALERT</span>` : ""}
            </div>
            <button class="btn btn-ghost btn-sm remove-waiting" type="button" data-id="${escapeHtml(p.id)}">✕</button>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

export function renderEmergencyPanel(beds = {}) {
  const ranked = getEmergencyRanking(beds);
  const top = ranked.slice(0, 8);

  return `
    <div class="emergency-ranking">
      ${top.map((bed, idx) => `
        <article class="emergency-bed-item ${bed.status}">
          <div class="emergency-rank">${idx + 1}</div>
          <div class="emergency-bed-info">
            <strong>${escapeHtml(bed.id)}</strong>
            <span class="emergency-ward">${escapeHtml(bed.ward)}</span>
          </div>
          <div class="emergency-label">${bed.label}</div>
          <div class="emergency-time">
            ${bed.readyMinutes === 0
              ? '<span class="ready-badge">READY</span>'
              : bed.readyMinutes === Infinity
                ? '<span class="reserved-badge">RESERVED</span>'
                : `<span class="time-badge">${formatDuration(bed.readyMinutes)}</span>`
            }
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

export function renderPredictionSummary(beds = {}) {
  const suggestions = getSmartSuggestions(beds);
  const parts = [];

  if (suggestions.fastest.length) {
    parts.push(`
      <div class="pred-section">
        <h4 class="pred-heading">✅ Available Now (${suggestions.fastest.length})</h4>
        <div class="pred-chips">
          ${suggestions.fastest.slice(0, 4).map((b) => `
            <span class="pred-chip available">${escapeHtml(b.id)} · ${escapeHtml(b.ward)}</span>
          `).join("")}
        </div>
      </div>
    `);
  }

  if (suggestions.aboutToFree.length) {
    parts.push(`
      <div class="pred-section">
        <h4 class="pred-heading">⏳ Freeing Up Soon</h4>
        <div class="pred-chips">
          ${suggestions.aboutToFree.slice(0, 4).map((s) => `
            <span class="pred-chip soon">${escapeHtml(s.bed.id)} → ${escapeHtml(s.label)}</span>
          `).join("")}
        </div>
      </div>
    `);
  }

  if (suggestions.causingDelay.length) {
    parts.push(`
      <div class="pred-section">
        <h4 class="pred-heading">🔴 Causing Delay</h4>
        <div class="pred-chips">
          ${suggestions.causingDelay.slice(0, 4).map((s) => `
            <span class="pred-chip delay">${escapeHtml(s.bed.id)} → ${escapeHtml(s.label)}</span>
          `).join("")}
        </div>
      </div>
    `);
  }

  if (!parts.length) {
    return `<div class="empty-state">No prediction data available yet.</div>`;
  }
  return parts.join("");
}

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.available;
}

/* ─── Enhanced bed card with inline predictions ─── */

export function buildBedCard(bed, interactive = true) {
  const meta = statusMeta(bed.status);
  const pred = computeBedPrediction(bed);
  const node = document.createElement("article");
  node.className = `bed-card ${meta.className}${interactive ? " is-interactive" : ""}`;
  if (interactive) {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
  }

  const details = [];
  if (bed.patientName) details.push(`<span class="pill">👤 ${escapeHtml(bed.patientName)}</span>`);
  if (bed.assignedDoctor) details.push(`<span class="pill">🩺 ${escapeHtml(bed.assignedDoctor)}</span>`);
  if (bed.reservedFor) details.push(`<span class="pill">📌 ${escapeHtml(bed.reservedFor)}</span>`);
  if (bed.conditionCategory) details.push(`<span class="pill condition">${escapeHtml(cap(bed.conditionCategory))}</span>`);

  /* Prediction line */
  let predLine = "";
  if (bed.status === "occupied" && pred.vacancyLabel) {
    predLine = `<div class="bed-prediction ${pred.urgency}">${escapeHtml(pred.vacancyLabel)}</div>`;
  } else if (bed.status === "cleaning" && pred.cleaningLabel) {
    predLine = `<div class="bed-prediction ${pred.urgency}">${escapeHtml(pred.cleaningLabel)}</div>`;
  } else if (bed.status === "available") {
    predLine = `<div class="bed-prediction ready">✅ Ready now</div>`;
  } else if (bed.status === "reserved") {
    predLine = `<div class="bed-prediction reserved">📌 Can be reassigned</div>`;
  }

  /* Ready time line */
  let readyLine = "";
  if (bed.status !== "available" && pred.totalReadyMinutes !== null && pred.totalReadyMinutes !== Infinity) {
    readyLine = `<div class="bed-ready-time">🎯 ${escapeHtml(pred.totalReadyLabel)}</div>`;
  }

  node.innerHTML = `
    <div class="bed-card-top">
      <div>
        <p class="bed-label">${escapeHtml(bed.ward)}</p>
        <h4 class="bed-name">${escapeHtml(bed.id)}</h4>
      </div>
      <span class="status-chip ${escapeHtml(meta.className)}">${escapeHtml(meta.label)}</span>
    </div>
    ${predLine}
    ${readyLine}
    <div class="bed-meta">
      <span>${escapeHtml(bed.notes || "No note added.")}</span>
      <span class="mono">Updated ${escapeHtml(relativeTime(bed.updatedAt))}</span>
    </div>
    <div class="pill-row">${details.join("")}</div>
  `;

  return node;
}

export function buildTopbar(name, role) {
  setText("uName", name);
  setText("roleBadge", cap(role));
  setText("uAvatar", (name || "U").trim().charAt(0).toUpperCase());
}

export function populateWardFilter(selectId, wards = []) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const currentValue = select.value || "all";
  select.innerHTML = [
    `<option value="all">All wards</option>`,
    ...wards.map((w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`),
  ].join("");
  select.value = wards.includes(currentValue) || currentValue === "all" ? currentValue : "all";
}

export function statusOptions(selected = "available") {
  return Object.entries(STATUS_META)
    .map(([value, meta]) =>
      `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(meta.label)}</option>`,
    )
    .join("");
}

export function conditionCategoryOptions(selected = "") {
  const opts = [
    `<option value="">— None —</option>`,
    ...CONDITION_CATEGORIES.map((cat) =>
      `<option value="${cat}"${cat === selected ? " selected" : ""}>${escapeHtml(cap(cat))}</option>`
    ),
  ];
  return opts.join("");
}

export { CONDITION_CATEGORIES };
