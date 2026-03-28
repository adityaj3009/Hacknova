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

/* ─── Doctor Registry ─── */
export const DOCTOR_REGISTRY = {
  "DR-001": { name: "Dr. Anil Kapoor",  specialization: "Cardiology",   ward: "Ward A" },
  "DR-002": { name: "Dr. Sneha Reddy",  specialization: "Neurology",    ward: "Ward A" },
  "DR-003": { name: "Dr. Vikram Mehta", specialization: "Surgery",      ward: "Ward B" },
  "DR-004": { name: "Dr. Priya Iyer",   specialization: "Maternity",    ward: "Ward B" },
  "DR-005": { name: "Dr. Rajan Nair",   specialization: "Emergency",    ward: "Ward C" },
  "DR-006": { name: "Dr. Kavita Shah",  specialization: "ICU",          ward: "Ward C" },
};

export function getDoctorById(doctorId) {
  return DOCTOR_REGISTRY[doctorId] || null;
}

export function getDoctorName(doctorId) {
  const doc = getDoctorById(doctorId);
  return doc ? doc.name : doctorId || "Unknown";
}

/* Allowed bed status transitions per role */
const VALID_TRANSITIONS = {
  manager: {
    occupied: ["cleaning"],
    cleaning: ["available"],
    available: ["occupied", "reserved"],
    reserved:  ["occupied", "available", "cleaning"],
  },
  staff: {
    occupied: ["cleaning"],
    cleaning: ["available"],
    available: ["occupied", "reserved"],
    reserved:  ["occupied", "available", "cleaning"],
  },
  doctor: {}, // doctors cannot change bed status
  admin:  {}, // admin is read-only
};

export function validateBedTransition(currentStatus, nextStatus, actorRole) {
  if (actorRole === "doctor" || actorRole === "admin") {
    throw new Error("You do not have permission to change bed status.");
  }
  const allowed = (VALID_TRANSITIONS[actorRole] || {})[currentStatus] || [];
  // Manager can also keep same status when just updating notes/patient info
  if (nextStatus !== currentStatus && !allowed.includes(nextStatus)) {
    throw new Error(
      `Invalid bed transition: ${currentStatus} → ${nextStatus}. ` +
      `Allowed: ${allowed.join(", ") || "none"}.`
    );
  }
}

/* Priority ordering for waiting queue */
const PRIORITY_ORDER = { emergency: 0, urgent: 1, normal: 2 };

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

function normalizeRole(role = "") {
  return role === "staff" ? "manager" : role;
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
    admin:   "/dashboard/admin",
    doctor:  "/dashboard/doctor",
    staff:   "/dashboard/manager",
    manager: "/dashboard/manager",
  };
  return map[normalizeRole(role)] || "/";
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
  const profile = await getProfile(dbInstance, cred.user.uid);
  return { cred, profile };
}

export async function registerWithEmailPassword({ name, email, password, role, doctorId }) {
  assertInitialized();
  const credentials = await createUserWithEmailAndPassword(authInstance, email, password);
  await updateProfile(credentials.user, { displayName: name });
  const normalizedRole = normalizeRole(role);
  const profileData = {
    uid: credentials.user.uid,
    name,
    email,
    role: normalizedRole,
    createdAt: Date.now(),
  };
  if (doctorId) profileData.doctorId = doctorId;
  await set(ref(dbInstance, `profiles/${credentials.user.uid}`), profileData);

  if (normalizedRole === "doctor" && doctorId) {
    const doctorMeta = getDoctorById(doctorId) || {};
    await update(ref(dbInstance, `doctors/${doctorId}`), {
      doctorId,
      uid: credentials.user.uid,
      name: doctorMeta.name || name,
      email,
      specialization: doctorMeta.specialization || "",
      ward: doctorMeta.ward || "",
    });
  }

  await pushActivity(dbInstance, {
    title: "New user registered",
    copy: `${name} created a ${normalizedRole} account.`,
    level: "info",
  });
  return { credentials, role: normalizedRole };
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
      const normalizedRole = normalizeRole(profile.role);

      if (allowRoles.length && !allowRoles.includes(normalizedRole)) {
        window.location.replace(redirectForRole(profile.role));
        return;
      }
      callback({
        user,
        uid: user.uid,
        name: profile.name || user.displayName || "Team member",
        email: profile.email || user.email || "",
        role: normalizedRole,
        doctorId: profile.doctorId || null,
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
      .sort((a, b) => {
        const pA = PRIORITY_ORDER[a.priority] ?? 2;
        const pB = PRIORITY_ORDER[b.priority] ?? 2;
        if (pA !== pB) return pA - pB;
        return (a.waitingSince || 0) - (b.waitingSince || 0);
      });
    callback(items);
  });
}

export function listenAlerts(db = dbInstance, callback) {
  return onValue(ref(db, "managerAlerts"), (snapshot) => {
    const raw = snapshot.val() || {};
    const items = Object.entries(raw)
      .map(([id, value]) => ({ id, ...value }))
      .filter((a) => !a.resolved)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(items);
  });
}

/* For doctor view: includes resolved medicine alerts so they can see 'Provided' status */
export function listenAllMedicineAlerts(db = dbInstance, callback) {
  return onValue(ref(db, "managerAlerts"), (snapshot) => {
    const raw = snapshot.val() || {};
    const items = Object.entries(raw)
      .map(([id, value]) => ({ id, ...value }))
      .filter((a) => a.type === "medicine")
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 20); // keep last 20 medicine prescriptions
    callback(items);
  });
}


export function listenDoctors(db = dbInstance, callback) {
  return onValue(ref(db, "doctors"), (snapshot) => {
    callback(snapshot.val() || {});
  });
}

/* ─── waiting queue CRUD ─── */

/* Pick the best matching doctor for a bed (same ward preferred, else any) */
function pickDoctorForBed(bed, docsObj) {
  const bedWard = (bed.ward || "").toLowerCase();
  // 1. patient already has a preferred doctor → honour it
  // 2. same-ward doctor
  // 3. any doctor
  const allDocs = Object.entries(docsObj);
  const sameWard = allDocs.filter(([, d]) => (d.ward || "").toLowerCase() === bedWard);
  if (sameWard.length) return sameWard[0][0];
  if (allDocs.length) return allDocs[0][0];
  return "DR-001";
}

export async function addToWaitingQueue(db = dbInstance, patient) {
  // First, check if there's any available bed
  const bedsSnap = await get(ref(db, "beds"));
  const beds = bedsSnap.val() || {};
  // Sort available beds: prefer smallest bed number
  const availableBeds = Object.values(beds)
    .filter(b => b.status === "available")
    .sort((a, b) => (a.ward || "").localeCompare(b.ward || "") || (a.number || 0) - (b.number || 0));

  if (availableBeds.length > 0) {
    // We have an available bed, admit immediately
    const targetBed = availableBeds[0];
    const bedId = targetBed.id;

    // Pick doctor — prefer same ward as bed
    const docSnap = await get(ref(db, "doctors"));
    const docsObj = docSnap.val() || DOCTOR_REGISTRY;
    const docId = patient.doctorId || pickDoctorForBed(targetBed, docsObj);

    const now = Date.now();
    await update(ref(db, `beds/${bedId}`), {
      status: "occupied",
      patientName: patient.name,
      assignedDoctor: docId,
      conditionCategory: patient.condition || "general",
      notes: patient.notes ? `[Auto-admitted] ${patient.notes}` : "Auto-admitted immediately.",
      updatedAt: now,
      admittedAt: now,
      cleaningStartedAt: 0,
      reservedFor: "",
      reservedDoctorId: "",
    });

    await pushActivity(db, {
      title: `Auto-admitted to ${bedId}`,
      copy: `${patient.name} admitted immediately (Priority: ${patient.priority || "normal"}). Bed: ${bedId}. Doctor: ${DOCTOR_REGISTRY[docId]?.name || docId}.`,
      level: "warning",
    });
    return null; // Don't add to queue
  }

  // No available bed — add to queue
  return push(ref(db, "waitingQueue"), {
    name: patient.name,
    condition: patient.condition || "general",
    priority: patient.priority || "normal",
    waitingSince: Date.now(),
    notes: patient.notes || "",
    doctorId: patient.doctorId || "",
  });
}

export async function removeFromWaitingQueue(db = dbInstance, patientId) {
  return remove(ref(db, `waitingQueue/${patientId}`));
}

export function getNextQueueSuggestion(queue = []) {
  if (!queue.length) return null;
  // Already sorted by priority then time
  return queue[0];
}

/* ─── alert CRUD (Manager only) ─── */

export async function addMedicineAlert(db = dbInstance, payload, actor) {
  const alertRef = await push(ref(db, "managerAlerts"), {
    type: "medicine",
    title: `💊 Medicine: ${payload.patientName}`,
    copy: `${payload.medicine} — ${payload.schedule}`,
    bedId: payload.bedId || "",
    doctorId: payload.doctorId || "",
    patientName: payload.patientName || "",
    medicine: payload.medicine || "",
    schedule: payload.schedule || "",
    prescribedAt: Date.now(),
    resolved: false,
    createdAt: Date.now(),
    createdBy: actor.name,
    createdByRole: actor.role,
  });
  await pushActivity(db, {
    title: "Medicine alert added",
    copy: `${actor.name} added medicine alert for ${payload.patientName}.`,
    level: "info",
  });
  return alertRef;
}

export async function addUrgentAlert(db = dbInstance, payload, actor) {
  const alertRef = await push(ref(db, "managerAlerts"), {
    type: "urgent",
    title: `🆘 Urgent: ${payload.patientName}`,
    copy: payload.description || "Urgent help needed.",
    bedId: payload.bedId || "",
    doctorId: payload.doctorId || "",
    patientName: payload.patientName || "",
    resolved: false,
    createdAt: Date.now(),
    createdBy: actor.name,
    createdByRole: actor.role,
  });
  await pushActivity(db, {
    title: "Urgent alert raised",
    copy: `${actor.name} raised urgent alert for ${payload.patientName}.`,
    level: "warning",
  });
  return alertRef;
}

export async function resolveAlert(db = dbInstance, alertId) {
  const alertRef = ref(db, `managerAlerts/${alertId}`);
  const snap = await get(alertRef);
  if (snap.exists()) {
    const alertData = snap.val();
    if (alertData.type === "medicine" && alertData.bedId) {
      const bedRef = ref(db, `beds/${alertData.bedId}`);
      const bedSnap = await get(bedRef);
      if (bedSnap.exists()) {
        const bedData = bedSnap.val();
        const timeStr = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        const medName = alertData.copy.split("—")[0].trim();
        const newNote = bedData.notes
          ? `${bedData.notes}\n[System] Medicine ${medName} administered at ${timeStr}.`
          : `[System] Medicine ${medName} administered at ${timeStr}.`;
        await update(bedRef, { notes: newNote });
      }
    }
  }
  await update(alertRef, { resolved: true, resolvedAt: Date.now() });
}

/* Mark medicine as provided — manager action */
export async function markMedicineProvided(db = dbInstance, alertId, actor) {
  const alertRef = ref(db, `managerAlerts/${alertId}`);
  const snap = await get(alertRef);
  if (!snap.exists()) throw new Error("Alert not found.");
  const alertData = snap.val();
  if (alertData.type !== "medicine") throw new Error("Not a medicine alert.");

  const now = Date.now();
  const timeStr = new Date(now).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const medicineName = (alertData.medicine || String(alertData.copy || "").split("â€”")[0] || "Medicine").trim();

  // Update bed notes to record administration
  if (alertData.bedId) {
    const bedRef = ref(db, `beds/${alertData.bedId}`);
    const bedSnap = await get(bedRef);
    if (bedSnap.exists()) {
      const bedData = bedSnap.val();
      const medName = alertData.copy.split("—")[0].trim();
      const newNote = bedData.notes
        ? `${bedData.notes}\n[${timeStr}] ${medicineName} administered by ${actor.name}.`
        : `[${timeStr}] ${medicineName} administered by ${actor.name}.`;
      await update(bedRef, { notes: newNote, updatedAt: now });
    }
  }

  // Mark alert as resolved with provider info
  await update(alertRef, {
    resolved: true,
    resolvedAt: now,
    providedAt: now,
    resolvedBy: actor.name,
    resolvedByRole: actor.role,
    doctorNotifiedAt: now,
  });

  await pushActivity(db, {
    title: `💊 Medicine provided — ${alertData.patientName || "Patient"}`,
    copy: `${actor.name} administered ${alertData.copy.split("—")[0].trim()} at ${timeStr}.`,
    level: "ok",
  });
}

/* ─── bed reservation (Manager only) ─── */

export async function reserveBed(db = dbInstance, bedId, reservation, actor) {
  const bedRef = ref(db, `beds/${bedId}`);
  const snapshot = await get(bedRef);
  if (!snapshot.exists()) throw new Error("Bed not found.");

  const current = snapshot.val();
  if (current.status !== "available") {
    throw new Error(`Bed ${bedId} is not available. Current status: ${current.status}.`);
  }

  const now = Date.now();
  await update(bedRef, {
    status: "reserved",
    reservedFor: reservation.patientName,
    reservedDoctorId: reservation.doctorId,
    reservationTime: reservation.reservationTime || now,
    notes: `Reserved for ${reservation.patientName} under ${reservation.doctorId}.`,
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
    patientName: "",
    assignedDoctor: "",
    cleaningStartedAt: 0,
  });

  await pushActivity(db, {
    title: `${bedId} reserved`,
    copy: `${actor.name} reserved ${bedId} for ${reservation.patientName} (${reservation.doctorId}).`,
    level: "info",
  });
}

/* ─── patient transfer (Manager only) ─── */

export async function transferPatient(db = dbInstance, fromBedId, toBedId, transferType, actor) {
  const fromRef = ref(db, `beds/${fromBedId}`);
  const toRef   = ref(db, `beds/${toBedId}`);

  const [fromSnap, toSnap] = await Promise.all([get(fromRef), get(toRef)]);
  if (!fromSnap.exists()) throw new Error(`Source bed ${fromBedId} not found.`);
  if (!toSnap.exists())   throw new Error(`Target bed ${toBedId} not found.`);

  const from = fromSnap.val();
  const to   = toSnap.val();

  if (from.status !== "occupied") {
    throw new Error(`Source bed ${fromBedId} is not occupied.`);
  }
  if (to.status !== "available" && to.status !== "reserved") {
    throw new Error(`Target bed ${toBedId} is not available for transfer.`);
  }

  const now = Date.now();
  await update(toRef, {
    status: "occupied",
    patientName: from.patientName,
    assignedDoctor: from.assignedDoctor,
    conditionCategory: from.conditionCategory,
    notes: `Transferred from ${fromBedId} (${transferType}).`,
    admittedAt: from.admittedAt || now,
    cleaningStartedAt: 0,
    reservedFor: "",
    reservedDoctorId: "",
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
  });

  await update(fromRef, {
    status: "cleaning",
    patientName: "",
    assignedDoctor: "",
    conditionCategory: "",
    reservedFor: "",
    reservedDoctorId: "",
    notes: `Patient transferred to ${toBedId}. Cleaning in progress.`,
    cleaningStartedAt: now,
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
  });

  await pushActivity(db, {
    title: `Patient transferred ${fromBedId} → ${toBedId}`,
    copy: `${actor.name}: ${transferType} — ${from.patientName || "Patient"}.`,
    level: "warning",
  });
}

/* ─── bed queries ─── */

export function getSortedBeds(beds = {}, options = {}) {
  const { ward = "all", search = "", doctorId = null } = options;
  const searchText = search.trim().toLowerCase();

  return Object.values(beds)
    .filter((bed) => (ward === "all" ? true : bed.ward === ward))
    .filter((bed) => {
      if (!doctorId) return true;
      return bed.assignedDoctor === doctorId || bed.reservedDoctorId === doctorId;
    })
    .filter((bed) => {
      if (!searchText) return true;
      const haystack = [
        bed.id, bed.ward, bed.patientName, bed.assignedDoctor,
        bed.notes, bed.reservedFor, bed.conditionCategory, bed.reservedDoctorId,
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

  // Beds per doctor: each doctor gets ~4 beds
  const doctorBedMap = {
    "A-01": "DR-001", "A-02": "DR-001", "A-03": "DR-001", "A-04": "DR-001",
    "A-05": "DR-002", "A-06": "DR-002", "A-07": "DR-002", "A-08": "DR-002",
    "B-01": "DR-003", "B-02": "DR-003", "B-03": "DR-003", "B-04": "DR-003",
    "B-05": "DR-004", "B-06": "DR-004", "B-07": "DR-004", "B-08": "DR-004",
    "C-01": "DR-005", "C-02": "DR-005", "C-03": "DR-005", "C-04": "DR-005",
    "C-05": "DR-006", "C-06": "DR-006", "C-07": "DR-006", "C-08": "DR-006",
  };

  const statusPattern = [
    "occupied", "available", "cleaning", "occupied",
    "reserved", "available", "occupied", "available",
  ];
  const conditionPattern = ["general", "surgery", "emergency", "icu", "maternity", "general", "surgery", "emergency"];
  const patientNames = [
    "Rahul Sharma", "Priya Patel", "Amit Kumar", "Sita Devi",
    "Vikram Singh", "Anita Gupta", "Rajesh Verma", "Meera Joshi",
  ];
  const now = Date.now();
  const beds = {};

  wards.forEach((ward, wardIndex) => {
    for (let i = 1; i <= ward.capacity; i++) {
      const status = statusPattern[(i - 1 + wardIndex) % statusPattern.length];
      const bedId = `${ward.prefix}-0${i}`;
      const condCat = conditionPattern[(i - 1 + wardIndex) % conditionPattern.length];
      const pIdx = (i - 1 + wardIndex) % patientNames.length;
      const doctorId = doctorBedMap[bedId] || "DR-001";
      const doctorName = DOCTOR_REGISTRY[doctorId]?.name || doctorId;

      const admittedHoursAgo = (Math.random() * 47 + 1);
      const admittedAt = status === "occupied" ? now - admittedHoursAgo * 3600000 : 0;

      const cleaningMinsAgo = Math.random() * 20 + 5;
      const cleaningStartedAt = status === "cleaning" ? now - cleaningMinsAgo * 60000 : 0;

      beds[bedId] = {
        id: bedId,
        ward: ward.name,
        number: i,
        status,
        patientName: status === "occupied" ? patientNames[pIdx] : "",
        assignedDoctor: status === "occupied" ? doctorId : "",
        reservedFor: status === "reserved" ? `Admission ${ward.prefix}${i}` : "",
        reservedDoctorId: status === "reserved" ? doctorId : "",
        conditionCategory: status === "occupied" ? condCat : "",
        admittedAt,
        cleaningStartedAt,
        notes:
          status === "cleaning"
            ? "Housekeeping in progress — linen change."
            : status === "occupied"
              ? `Under observation. Category: ${cap(condCat)}. Dr: ${doctorName}`
              : status === "reserved"
                ? `Reserved for incoming patient under ${doctorId}.`
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
    w1: { name: "Rahul Mehra",    condition: "general",   priority: "normal",    waitingSince: now - 25 * 60000, notes: "Fever and body pain", doctorId: "DR-001" },
    w2: { name: "Sita Kumari",    condition: "emergency",  priority: "emergency", waitingSince: now - 40 * 60000, notes: "Chest pain, needs urgent bed", doctorId: "DR-005" },
    w3: { name: "Arvind Joshi",   condition: "surgery",    priority: "urgent",    waitingSince: now - 15 * 60000, notes: "Post-op recovery bed needed", doctorId: "DR-003" },
    w4: { name: "Priya Nair",     condition: "maternity",  priority: "urgent",    waitingSince: now - 32 * 60000, notes: "Expected delivery", doctorId: "DR-004" },
    w5: { name: "Karan Malhotra", condition: "icu",        priority: "emergency", waitingSince: now - 10 * 60000, notes: "Severe trauma", doctorId: "DR-006" },
  };
}

function buildSeedDoctors() {
  const doctors = {};
  Object.entries(DOCTOR_REGISTRY).forEach(([id, info]) => {
    doctors[id] = { ...info, doctorId: id };
  });
  return doctors;
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

  const wqSnap = await get(ref(db, "waitingQueue"));
  if (!wqSnap.exists()) {
    await set(ref(db, "waitingQueue"), buildSeedWaitingQueue());
  }
}

export async function seedDoctorsIfNeeded(db = dbInstance) {
  const snapshot = await get(ref(db, "doctors"));
  if (!snapshot.exists()) {
    await set(ref(db, "doctors"), buildSeedDoctors());
  }
}

/* ─── activity ─── */

export async function pushActivity(db = dbInstance, activity) {
  return push(ref(db, "activity"), {
    ...activity,
    createdAt: Date.now(),
  });
}

/* ─── bed update (Manager-enforced lifecycle) ─── */

export async function updateBedRecord(db = dbInstance, bedId, patch, actor) {
  const bedRef = ref(db, `beds/${bedId}`);
  const snapshot = await get(bedRef);
  if (!snapshot.exists()) throw new Error("Bed record not found.");

  const current = snapshot.val();
  let nextStatus = patch.status || current.status;
  const now = Date.now();
  const nextPatientName = String(patch.patientName ?? current.patientName ?? "").trim();
  const nextReservedFor = String(patch.reservedFor ?? current.reservedFor ?? "").trim();
  const chosenDoctorId = String(
    patch.doctorId ?? patch.assignedDoctor ?? patch.reservedDoctorId ?? current.assignedDoctor ?? current.reservedDoctorId ?? "",
  ).trim();

  // Enforce lifecycle validation for all roles
  if (nextStatus !== current.status) {
    validateBedTransition(current.status, nextStatus, actor.role);
  }

  const nextRecord = {
    ...current,
    ...patch,
    status: nextStatus,
    notes: patch.notes ?? current.notes ?? "",
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
  };
  delete nextRecord.doctorId;

  /* Auto-track timestamps for prediction engine */
  if (nextStatus === "occupied" && current.status !== "occupied") {
    nextRecord.admittedAt = now;
    nextRecord.cleaningStartedAt = 0;
  }
  if (nextStatus === "cleaning" && current.status !== "cleaning") {
    nextRecord.cleaningStartedAt = now;
  }
  
  if (nextStatus === "available") {
    // Check auto-admit from queue
    const queueSnap = await get(ref(db, "waitingQueue"));
    const queueRaw = queueSnap.val() || {};
    const queueItems = Object.entries(queueRaw).map(([id, val]) => ({id, ...val}))
      .sort((a, b) => {
        const pA = PRIORITY_ORDER[a.priority] ?? 2;
        const pB = PRIORITY_ORDER[b.priority] ?? 2;
        if (pA !== pB) return pA - pB;
        return (a.waitingSince || 0) - (b.waitingSince || 0);
      });

    if (queueItems.length > 0) {
      // Auto-admit the highest-priority patient
      const nextPatient = queueItems[0];
      const docSnap = await get(ref(db, "doctors"));
      const docsObj = docSnap.val() || DOCTOR_REGISTRY;
      // Smart doctor assignment: prefer same ward as bed
      const docId = nextPatient.doctorId || pickDoctorForBed(current, docsObj);

      // Override status to occupied
      nextStatus = "occupied";
      patch.status = "occupied";
      nextRecord.status = "occupied";

      nextRecord.patientName = nextPatient.name;
      nextRecord.assignedDoctor = docId;
      nextRecord.conditionCategory = nextPatient.condition || "general";
      nextRecord.notes = nextPatient.notes
        ? `[Auto-admitted from queue] ${nextPatient.notes}`
        : "Auto-admitted from waiting queue.";
      nextRecord.reservedFor = "";
      nextRecord.reservedDoctorId = "";
      nextRecord.patientStatus = "";
      nextRecord.admittedAt = now;
      nextRecord.cleaningStartedAt = 0;
      nextRecord.reservationTime = 0;

      // Remove from queue
      await remove(ref(db, `waitingQueue/${nextPatient.id}`));

      await pushActivity(db, {
        title: `Auto-admitted to ${bedId}`,
        copy: `${nextPatient.name} auto-admitted from queue (Priority: ${nextPatient.priority}). Doctor: ${DOCTOR_REGISTRY[docId]?.name || docId}.`,
        level: "warning",
      });
    } else {
      nextRecord.patientName = "";
      nextRecord.assignedDoctor = "";
      nextRecord.reservedFor = "";
      nextRecord.reservedDoctorId = "";
      nextRecord.conditionCategory = "";
      nextRecord.patientStatus = "";
      nextRecord.admittedAt = 0;
      nextRecord.cleaningStartedAt = 0;
      nextRecord.reservationTime = 0;
    }
  }
  if (nextStatus === "cleaning") {
    nextRecord.patientName = "";
    nextRecord.assignedDoctor = "";
    nextRecord.reservedFor = "";
    nextRecord.reservedDoctorId = "";
    nextRecord.conditionCategory = "";
    nextRecord.patientStatus = "";
    nextRecord.admittedAt = 0;
    nextRecord.reservationTime = 0;
  }
  if (nextStatus === "reserved") {
    const reservedFor = nextReservedFor || nextPatientName;
    if (!reservedFor) throw new Error("Reserved beds need an incoming patient name.");
    if (!chosenDoctorId) throw new Error("Reserved beds need a doctor assignment.");
    nextRecord.patientName = "";
    nextRecord.assignedDoctor = "";
    nextRecord.reservedFor = reservedFor;
    nextRecord.reservedDoctorId = chosenDoctorId;
    nextRecord.conditionCategory = "";
    nextRecord.patientStatus = "";
    nextRecord.admittedAt = 0;
    nextRecord.cleaningStartedAt = 0;
    nextRecord.reservationTime = current.reservationTime || now;
  }
  if (nextStatus === "occupied") {
    const occupiedPatientName = nextPatientName || nextReservedFor;
    if (!occupiedPatientName) throw new Error("Occupied beds must have a patient name.");
    if (!chosenDoctorId) throw new Error("Occupied beds must be assigned to a doctor.");
    const patientChanged = current.status !== "occupied" || current.patientName !== occupiedPatientName;
    nextRecord.patientName = occupiedPatientName;
    nextRecord.assignedDoctor = chosenDoctorId;
    nextRecord.reservedFor = "";
    nextRecord.reservedDoctorId = "";
    nextRecord.cleaningStartedAt = 0;
    nextRecord.reservationTime = 0;
    if (patientChanged) {
      nextRecord.patientStatus = "";
    }
  }

  await update(bedRef, nextRecord);
  await pushActivity(db, {
    title: `${bedId} → ${STATUS_META[nextStatus]?.label || nextStatus}`,
    copy: `${actor.name} (${normalizeRole(actor.role)}) updated ${bedId} in ${current.ward}.`,
    level: activityLevelForStatus(nextStatus),
  });
}

/* ─── Doctor-specific bed update (only notes + patient status, no bed status change) ─── */
export async function updatePatientStatus(db = dbInstance, bedId, patch, actor) {
  if (actor.role !== "doctor") throw new Error("Only doctors can update patient status.");
  const bedRef = ref(db, `beds/${bedId}`);
  const snapshot = await get(bedRef);
  if (!snapshot.exists()) throw new Error("Bed record not found.");

  const current = snapshot.val();
  // Check this is the doctor's bed
  if (current.assignedDoctor && current.assignedDoctor !== actor.doctorId) {
    throw new Error("You can only update your own patients.");
  }

  const now = Date.now();
  const nextRecord = {
    ...current,
    notes: patch.notes ?? current.notes ?? "",
    patientStatus: patch.patientStatus || current.patientStatus || "",
    updatedAt: now,
    updatedByName: actor.name,
    updatedByRole: actor.role,
  };

  await update(bedRef, nextRecord);
  await pushActivity(db, {
    title: `Patient status updated — ${bedId}`,
    copy: `Dr. ${actor.name}: ${patch.patientStatus || "Notes updated"} for ${current.patientName || "patient"}.`,
    level: "info",
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
    urgency: "normal",
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

    const date = new Date(expectedDischarge);
    const timeStr = date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const isToday = new Date().toDateString() === date.toDateString();

    prediction.vacancyMinutes = remainingMin;
    prediction.vacancyLabel = remainingMin <= 0
      ? "Discharge overdue"
      : `Est. discharge: ${isToday ? 'Today' : date.toLocaleDateString("en-IN", { month: "short", day: "numeric" })} ${timeStr}`;

    prediction.totalReadyMinutes = remainingMin + DEFAULT_CLEANING_MINUTES;
    prediction.totalReadyLabel = `Bed available in ${formatDuration(remainingMin + DEFAULT_CLEANING_MINUTES)}`;

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
      ? "Bed available now"
      : `Bed available in ${formatDuration(remainingMin)}`;

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
      readyMinutes = 5;
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

/* ─── Smart suggestions (visible to all roles) ─── */

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

/* ─── 🚨 Enhanced Alert System (System-generated) ─── */

export function computeAlerts(beds = {}, waitingQueue = [], managerAlerts = []) {
  const alerts = [];
  const now = Date.now();

  /* Manager-added alerts (medicine, urgent help, etc.) */
  managerAlerts.forEach((alert) => {
    alerts.push({
      type: alert.type === "urgent" ? "critical" : "warning",
      title: alert.title,
      copy: alert.copy,
      time: alert.createdAt,
      flag: alert.type === "urgent" ? "URGENT" : "MEDICINE",
      managerId: alert.id,
      sourceType: alert.type,
      doctorId: alert.doctorId || "",
      bedId: alert.bedId || "",
      patientName: alert.patientName || "",
      resolvable: alert.type !== "medicine",
    });
  });

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
          flag: "CLEANING DELAY",
          doctorId: bed.assignedDoctor || bed.reservedDoctorId || "",
          bedId: bed.id,
          patientName: bed.patientName || bed.reservedFor || "",
        });
      }
    }

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
            doctorId: bed.assignedDoctor || "",
            bedId: bed.id,
            patientName: bed.patientName || "",
          });
        }
      }
    }

    if (bed.status === "reserved" && ageMin >= 60) {
      alerts.push({
        type: "info",
        title: `📌 ${bed.id}: Reserved for ${ageMin} min`,
        copy: `${bed.reservedFor || "Incoming patient"} has been waiting in ${bed.ward}.`,
        time: bed.updatedAt,
        flag: "BED RESERVED",
        doctorId: bed.reservedDoctorId || "",
        bedId: bed.id,
        patientName: bed.reservedFor || "",
      });
    }
  });

  /* Waiting queue > 30 min */
  if (waitingQueue.length) {
    waitingQueue.forEach((patient) => {
      const waitMin = Math.round((now - (patient.waitingSince || now)) / 60000);
      if (waitMin >= 30) {
        alerts.push({
          type: patient.priority === "emergency" ? "critical" : "warning",
          title: `⏳ ${patient.name}: Waiting ${waitMin} min`,
          copy: `Patient in queue over 30 min. Priority: ${cap(patient.priority || "normal")}.`,
          time: patient.waitingSince,
          flag: patient.priority === "emergency" ? "EMERGENCY" : "WAIT EXCEEDED",
          doctorId: patient.doctorId || "",
          patientName: patient.name || "",
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

export function renderAlertStrips(alerts = [], canResolve = false) {
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
              ${canResolve && alert.managerId ? `<button class="btn btn-ghost btn-sm resolve-alert" data-id="${escapeHtml(alert.managerId)}">✓ Resolve</button>` : ""}
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
      ${items.slice(0, 15).map((item) => `
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

export function renderWaitingQueue(queue = [], canManage = false) {
  const now = Date.now();
  if (!queue.length) {
    return `<div class="empty-state">No patients in queue.</div>`;
  }
  const priorityClass = { emergency: "priority-emergency", urgent: "priority-urgent", normal: "priority-normal" };
  const priorityLabel = { emergency: "🔴 Emergency", urgent: "🟡 Urgent", normal: "🟢 Normal" };

  return `
    <div class="waiting-list">
      ${queue.map((p) => {
        const waitMin = Math.round((now - (p.waitingSince || now)) / 60000);
        const isAlert = waitMin >= 30;
        const pClass = priorityClass[p.priority] || "priority-normal";
        const pLabel = priorityLabel[p.priority] || "🟢 Normal";
        const doctorName = getDoctorName(p.doctorId);
        return `
          <article class="waiting-item ${isAlert ? "waiting-alert" : ""}">
            <div class="waiting-info">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="priority-badge ${pClass}">${pLabel}</span>
              <span class="waiting-condition">${escapeHtml(cap(p.condition || "general"))}</span>
              ${p.doctorId ? `<span class="doctor-id-chip">🩺 ${escapeHtml(p.doctorId)} — ${escapeHtml(doctorName)}</span>` : ""}
              ${p.notes ? `<span class="waiting-notes">${escapeHtml(p.notes)}</span>` : ""}
            </div>
            <div class="waiting-timer-wrap">
              <span class="waiting-timer ${isAlert ? "alert" : ""}" data-since="${p.waitingSince || now}">
                ${waitMin} min
              </span>
              ${isAlert ? `<span class="waiting-alert-badge">⚠️ ALERT</span>` : ""}
            </div>
            ${canManage ? `<button class="btn btn-ghost btn-sm remove-waiting" type="button" data-id="${escapeHtml(p.id)}">✕</button>` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

export function renderEmergencyPanel(beds = {}, waitingQueue = []) {
  const ranked = getEmergencyRanking(beds);
  const top = ranked.slice(0, 8);
  const now = Date.now();

  const criticalQueue = waitingQueue.filter((p) => {
    const waitMin = Math.round((now - (p.waitingSince || now)) / 60000);
    return waitMin >= 30 || p.condition === "emergency" || p.condition === "icu" || p.priority === "emergency";
  }).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  const criticalHtml = criticalQueue.length ? `
    <div class="emergency-critical-section" style="margin-bottom: 24px;">
      <h4 style="color: var(--red); margin: 0 0 12px; font-weight: 800; display: flex; align-items: center; gap: 8px;">
        <span class="spinner" style="border-color: rgba(220, 38, 38, 0.3); border-top-color: var(--red); width: 14px; height: 14px;"></span>
        Critical Patients Waiting
      </h4>
      <div class="waiting-list">
        ${criticalQueue.slice(0, 4).map(p => `
          <article class="waiting-item waiting-alert" style="padding: 12px 16px;">
            <div class="waiting-info">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="priority-badge priority-${escapeHtml(p.priority || "normal")}">${escapeHtml(cap(p.priority || "normal"))}</span>
              <span class="waiting-condition">${escapeHtml(cap(p.condition))} — ${escapeHtml(p.notes || "No notes")}</span>
            </div>
            <div class="waiting-timer-wrap">
              <span class="waiting-timer alert">${Math.round((now - (p.waitingSince || now)) / 60000)} min</span>
            </div>
          </article>
        `).join("")}
      </div>
    </div>
  ` : '';

  return `
    ${criticalHtml}
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
          ${suggestions.fastest.slice(0, 6).map((b) => `
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
        <h4 class="pred-heading">🔴 Cleaning Overdue</h4>
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

export function renderDoctorList(doctors = {}) {
  const list = Object.values(doctors);
  if (!list.length) {
    return `<div class="empty-state">No doctors registered yet.</div>`;
  }
  return `
    <div class="doctor-list">
      ${list.map((doc) => `
        <article class="doctor-card">
          <div class="doctor-card-avatar">${escapeHtml((doc.name || "DR").replace(/^Dr\.?\s+/i, "").charAt(0).toUpperCase())}</div>
          <div class="doctor-card-info">
            <strong>${escapeHtml(doc.name)}</strong>
            <span class="doctor-id-chip">${escapeHtml(doc.doctorId)}</span>
            <span class="doctor-spec">${escapeHtml(doc.specialization)}</span>
            <span class="doctor-ward">${escapeHtml(doc.ward)}</span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.available;
}

/* ─── Enhanced bed card ─── */

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
  if (bed.assignedDoctor) {
    const docName = getDoctorName(bed.assignedDoctor);
    details.push(`<span class="pill doctor-id-chip">🩺 ${escapeHtml(bed.assignedDoctor)} — ${escapeHtml(docName)}</span>`);
  }
  if (bed.reservedFor) details.push(`<span class="pill">📌 ${escapeHtml(bed.reservedFor)}</span>`);
  if (bed.reservedDoctorId) details.push(`<span class="pill doctor-id-chip">🩺 Reserved: ${escapeHtml(bed.reservedDoctorId)}</span>`);
  if (bed.conditionCategory) details.push(`<span class="pill condition">${escapeHtml(cap(bed.conditionCategory))}</span>`);

  let predLine = "";
  if (bed.status === "occupied" && pred.vacancyLabel) {
    predLine = `<div class="bed-prediction ${pred.urgency}">${escapeHtml(pred.vacancyLabel)}</div>`;
  } else if (bed.status === "cleaning" && pred.cleaningLabel) {
    predLine = `<div class="bed-prediction ${pred.urgency}">${escapeHtml(pred.cleaningLabel)}</div>`;
  } else if (bed.status === "available") {
    predLine = `<div class="bed-prediction ready">✅ Ready now</div>`;
  } else if (bed.status === "reserved") {
    predLine = `<div class="bed-prediction reserved">📌 Reserved — awaiting patient</div>`;
  }

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
  const roleLabel = cap(normalizeRole(role));
  setText("roleBadge", roleLabel);
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

export function statusOptionsForManager(selected = "available") {
  // Full lifecycle options for manager
  return Object.entries(STATUS_META)
    .map(([value, meta]) =>
      `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(meta.label)}</option>`,
    )
    .join("");
}

export function statusOptions(selected = "available") {
  return statusOptionsForManager(selected);
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

export function doctorIdOptions(selected = "") {
  const opts = [
    `<option value="">— Select Doctor ID —</option>`,
    ...Object.entries(DOCTOR_REGISTRY).map(([id, doc]) =>
      `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(id)} — ${escapeHtml(doc.name)}</option>`
    ),
  ];
  return opts.join("");
}

export { CONDITION_CATEGORIES };
