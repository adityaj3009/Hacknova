import {
  buildBedCard,
  buildTopbar,
  computeAlerts,
  computeStats,
  computeWardStats,
  escapeHtml,
  formatDuration,
  getDoctorName,
  getSortedBeds,
  initFirebase,
  listenActivity,
  listenAlerts,
  listenBeds,
  listenDoctors,
  listenWaitingQueue,
  logout,
  renderActivityItems,
  renderAlertStrips,
  renderDoctorList,
  renderFatalState,
  renderPredictionSummary,
  renderWaitingQueue,
  requireAuth,
  seedBedsIfNeeded,
  seedDoctorsIfNeeded,
  setHtml,
  setText,
} from "./firebase-utils.js";

const state = {
  user: null,
  beds: {},
  activity: [],
  waitingQueue: [],
  managerAlerts: [],
  doctors: {},
};

function renderSummary() {
  const stats  = computeStats(state.beds);
  const alerts = computeAlerts(state.beds, state.waitingQueue, state.managerAlerts);

  setText("adminTotalBeds",    stats.total);
  setText("adminOccupiedBeds", stats.occupied);
  setText("adminAvailableBeds", stats.available);
  setText("adminCleaningBeds", stats.cleaning);
  setText("adminReservedBeds", stats.reserved);
  setText("adminWaiting",      state.waitingQueue.length);
  setText("adminOccupancy",    `${stats.occupancy}%`);
  setText("adminAlertCount",   alerts.length);

  setHtml("adminAlerts", renderAlertStrips(alerts));
}

function renderWardList() {
  const wards = computeWardStats(state.beds);
  const node  = document.getElementById("adminWardList");

  if (!wards.length) {
    node.innerHTML = '<div class="empty-state">No ward data available yet.</div>';
    return;
  }

  node.innerHTML = `
    <div class="ward-list">
      ${wards.map((ward) => `
        <article class="ward-item">
          <div class="item-head">
            <h4 class="item-title">${escapeHtml(ward.ward)}</h4>
            <span class="status-chip ${ward.occupancy >= 90 ? "critical" : ward.occupancy >= 80 ? "warning" : ward.occupancy >= 70 ? "cleaning" : "available"}">
              ${ward.occupancy}% occupied
            </span>
          </div>
          <div class="ward-stats">
            <div class="mini-stat"><strong>${ward.total}</strong><span>Total</span></div>
            <div class="mini-stat"><strong>${ward.occupied}</strong><span>Occupied</span></div>
            <div class="mini-stat"><strong>${ward.available}</strong><span>Available</span></div>
            <div class="mini-stat"><strong>${ward.cleaning}</strong><span>Cleaning</span></div>
            <div class="mini-stat"><strong>${ward.reserved}</strong><span>Reserved</span></div>
          </div>
          <div class="meter"><span style="width: ${ward.occupancy}%"></span></div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAnalytics() {
  const beds         = Object.values(state.beds);
  const now          = Date.now();
  const occupied     = beds.filter(b => b.status === "occupied");
  const cleaning     = beds.filter(b => b.status === "cleaning");
  const queue        = state.waitingQueue;

  // Average wait time
  const avgWait = queue.length
    ? Math.round(queue.reduce((s, p) => s + (now - (p.waitingSince || now)), 0) / queue.length / 60000)
    : 0;

  // Average cleaning time (elapsed for current cleaning beds)
  const avgCleaning = cleaning.length
    ? Math.round(cleaning.reduce((s, b) => s + (now - (b.cleaningStartedAt || now)), 0) / cleaning.length / 60000)
    : 0;

  // Beds with overdue discharge
  const overdueDischarge = occupied.filter(b => {
    if (!b.admittedAt) return false;
    const { AVG_STAY } = { AVG_STAY: { general:72, surgery:120, emergency:48, icu:168, maternity:48 } };
    const avgH = { general:72, surgery:120, emergency:48, icu:168, maternity:48 }[b.conditionCategory] || 72;
    return (now - b.admittedAt) > avgH * 3600000;
  }).length;

  // Avg bed occupancy
  const totalBeds = beds.length || 1;
  const occupancyRate = Math.round((occupied.length / totalBeds) * 100);

  const node = document.getElementById("adminAnalytics");
  node.innerHTML = `
    <div class="analytics-grid">
      <article class="analytics-card">
        <div class="analytics-icon">📊</div>
        <div class="analytics-info">
          <strong>${occupancyRate}%</strong>
          <span>Bed Occupancy Rate</span>
        </div>
        <div class="meter"><span style="width:${occupancyRate}%"></span></div>
      </article>
      <article class="analytics-card">
        <div class="analytics-icon">⏳</div>
        <div class="analytics-info">
          <strong>${avgWait} min</strong>
          <span>Avg. Patient Wait Time</span>
        </div>
      </article>
      <article class="analytics-card">
        <div class="analytics-icon">🧹</div>
        <div class="analytics-info">
          <strong>${avgCleaning} min</strong>
          <span>Avg. Cleaning Time</span>
        </div>
      </article>
      <article class="analytics-card ${overdueDischarge > 0 ? "analytics-warning" : ""}">
        <div class="analytics-icon">⚠️</div>
        <div class="analytics-info">
          <strong>${overdueDischarge}</strong>
          <span>Discharge Delays</span>
        </div>
      </article>
      <article class="analytics-card">
        <div class="analytics-icon">👥</div>
        <div class="analytics-info">
          <strong>${queue.length}</strong>
          <span>Patients in Queue</span>
        </div>
      </article>
      <article class="analytics-card">
        <div class="analytics-icon">🧹</div>
        <div class="analytics-info">
          <strong>${cleaning.length}</strong>
          <span>Beds Under Cleaning</span>
        </div>
      </article>
    </div>
  `;
}

function renderBeds() {
  const node = document.getElementById("adminBedGrid");
  const beds = getSortedBeds(state.beds);
  node.innerHTML = "";
  if (!beds.length) {
    node.innerHTML = '<div class="empty-state">No beds available for the live board yet.</div>';
    return;
  }
  beds.forEach((bed) => node.appendChild(buildBedCard(bed, false)));
}

function renderPredictions() {
  setHtml("adminPredictions", renderPredictionSummary(state.beds));
}

function renderActivity() {
  setHtml("adminActivity", renderActivityItems(state.activity));
}

function renderWaiting() {
  setHtml("adminWaitingQueue", renderWaitingQueue(state.waitingQueue, false));
}

function renderDoctors() {
  setHtml("adminDoctorList", renderDoctorList(state.doctors));
}

function refreshHeader() {
  const now = new Date();
  setText("adminGreeting", `Command center for ${state.user.name}`);
  setText("adminSubtitle",
    `${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
  );
}

function updateTimers() {
  const now = Date.now();
  document.querySelectorAll(".waiting-timer[data-since]").forEach((el) => {
    const since = parseInt(el.dataset.since, 10);
    if (!since) return;
    const waitMin = Math.round((now - since) / 60000);
    el.textContent = `${waitMin} min`;
    if (waitMin >= 30) el.classList.add("alert");
  });
}

function render() {
  renderSummary();
  renderWardList();
  renderBeds();
  renderPredictions();
  renderAnalytics();
}

async function initPage() {
  let db;
  try {
    ({ db } = initFirebase(window.WARDWATCH_CONFIG || {}));
  } catch (error) {
    renderFatalState("Firebase is not configured", error.message);
    return;
  }

  document.getElementById("logoutButton").addEventListener("click", logout);

  requireAuth(
    async (session) => {
      state.user = session;
      window.history.replaceState(null, "", window.location.href);
      window.history.pushState(null, "", window.location.href);
      window.addEventListener("popstate", () => {
        window.history.pushState(null, "", window.location.href);
      });
      buildTopbar(session.name, session.role);
      refreshHeader();
      await seedBedsIfNeeded(db);
      await seedDoctorsIfNeeded(db);

      listenBeds(db, (beds) => {
        state.beds = beds;
        render();
      });

      listenActivity(db, (activity) => {
        state.activity = activity;
        renderActivity();
      });

      listenWaitingQueue(db, (queue) => {
        state.waitingQueue = queue;
        renderWaiting();
        renderSummary();
        renderAnalytics();
      });

      listenAlerts(db, (alerts) => {
        state.managerAlerts = alerts;
        renderSummary();
      });

      listenDoctors(db, (doctors) => {
        state.doctors = doctors;
        renderDoctors();
      });

      window.setInterval(updateTimers, 1000);
      window.setInterval(() => {
        refreshHeader();
        renderAnalytics();
        renderPredictions();
      }, 30000);
    },
    { allowRoles: ["admin"] },
  );
}

document.addEventListener("DOMContentLoaded", initPage);
